/**
 * validate.spec.mjs — unit tests of tools/plan-definitions/validate.mjs (offline protocol-service rules)
 *
 * What:    The shipped sets must pass, and every rule copied from the protocol service must reject the
 *          mistake it exists for: duplicate/missing ids, unknown action type, trigger without data or
 *          condition, unreadable codeFilter path, unknown FHIR resource type, tolerance-days on a 'could'
 *          step or on a group, group rules, fire-event extensions, "$comment" left in; and the set rules:
 *          duplicate url+version, missing files, incompatible dataset.
 * How:     npm test   (or: node --test tools/plan-definitions/unit-tests/validate.spec.mjs)
 * Needs:   test-data/ (A1) for the shipped sets; everything else is built inline.
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadPlanDefinitionSet } from '../sets.mjs';
import { FIRE_EVENT_TYPE, STEP_TYPE, TOLERANCE_DAYS_URL } from '../triggers.mjs';
import { validatePlanDefinition, validateSet } from '../validate.mjs';

const stepType = { coding: [{ ...STEP_TYPE }] };
/** A step that the validator accepts: typed, with a trigger on Encounter.type. */
const step = (id, extra = {}) => ({
  id,
  type: stepType,
  requiredBehavior: 'could',
  trigger: [
    {
      type: 'named-event',
      data: [{ type: 'Encounter', codeFilter: [{ path: 'type', code: [{ display: 'X' }] }] }],
    },
  ],
  ...extra,
});
/** A valid PlanDefinition around the given actions. */
const plan = (actions) => ({
  resourceType: 'PlanDefinition',
  url: 'http://x/p',
  version: '1.0.0',
  action: actions,
});
/** Validate and return the errors joined, for regex assertions. */
const errorsOf = (json) => validatePlanDefinition(json).join('\n');

describe('validatePlanDefinition', () => {
  it('accepts a minimal valid plan definition', () => {
    assert.deepEqual(
      validatePlanDefinition(
        plan([
          step('a'),
          step('b', {
            requiredBehavior: 'must',
            extension: [{ url: TOLERANCE_DAYS_URL, valueInteger: 1 }],
          }),
        ]),
      ),
      [],
    );
  });

  it('rejects tolerance-days on a could step (negative case)', () => {
    assert.match(
      errorsOf(plan([step('a', { extension: [{ url: TOLERANCE_DAYS_URL, valueInteger: 1 }] })])),
      /Optional action 'a'.*tolerance-days/,
    );
  });

  it('rejects duplicate and missing action ids at any level', () => {
    assert.match(errorsOf(plan([step('a', { action: [step('a')] })])), /Duplicate action id 'a'/);
    assert.match(errorsOf(plan([step('')])), /missing a required id/);
  });

  it('rejects an action without step or fire-event type coding', () => {
    assert.match(
      errorsOf(plan([{ ...step('a'), type: { coding: [{ system: 'x', code: 'step' }] } }])),
      /type coding 'step' or 'fire-event'/,
    );
  });

  it('rejects a trigger with neither data nor condition', () => {
    assert.match(
      errorsOf(plan([step('a', { trigger: [{ type: 'named-event' }] })])),
      /no data\[\] and no condition/,
    );
    // A condition alone is fine.
    assert.equal(
      errorsOf(
        plan([
          step('a', { trigger: [{ type: 'named-event', condition: { expression: 'true' } }] }),
        ]),
      ),
      '',
    );
  });

  it('rejects a codeFilter path that is not one top-level field', () => {
    const bad = step('a', {
      trigger: [
        {
          data: [
            { type: 'Encounter', codeFilter: [{ path: 'type.coding', code: [{ code: 'X' }] }] },
          ],
        },
      ],
    });
    assert.match(errorsOf(plan([bad])), /codeFilter.path 'type.coding'/);
  });

  it('rejects an unknown FHIR resource type', () => {
    const bad = step('a', { trigger: [{ data: [{ type: 'Encountr' }] }] });
    assert.match(errorsOf(plan([bad])), /unknown FHIR resource type.*Encountr/);
  });

  it('applies the group rules: no trigger, no tolerance-days, must contain a step, no fire-event child', () => {
    const group = {
      id: 'g',
      type: stepType,
      groupingBehavior: 'logical-group',
      trigger: [{ data: [{ type: 'Encounter' }] }],
      extension: [{ url: TOLERANCE_DAYS_URL, valueInteger: 1 }],
      action: [{ id: 'f', type: { coding: [{ ...FIRE_EVENT_TYPE }] } }],
    };
    const text = errorsOf(plan([step('a'), group]));
    assert.match(text, /Group 'g' has a trigger/);
    assert.match(text, /Group 'g' declares tolerance-days/);
    assert.match(text, /Group 'g' contains no step/);
    assert.match(text, /fire-event action 'f'/);
  });

  it('requires both intelligence extensions on a complete fire-event action', () => {
    const fire = {
      id: 'f',
      type: { coding: [{ ...FIRE_EVENT_TYPE }] },
      definitionCanonical: 'http://x/ad',
      condition: [{ kind: 'applicability', expression: { expression: 'true' } }],
    };
    const text = errorsOf(plan([step('a'), fire]));
    assert.match(text, /missing required extension: intelligence-severity/);
    assert.match(text, /missing required extension: intelligence-destination/);
  });

  it('rejects a "$comment" left inside the resource', () => {
    assert.match(errorsOf({ ...plan([step('a')]), $comment: 'x' }), /\$comment/);
  });
});

describe('validateSet', () => {
  it('passes every shipped set with its dataset', async () => {
    for (const [name, dataset] of [
      ['emr-service', 'ebuzima-emr'],
      ['kenya-sha-emr-service', 'tiberbu-emr'],
    ]) {
      const set = await loadPlanDefinitionSet(name);
      assert.deepEqual(validateSet(set, { dataset }), [], name);
    }
  });

  it('rejects duplicate url+version, missing files and an incompatible dataset', async () => {
    const set = await loadPlanDefinitionSet('emr-service');
    const doubled = { ...set, planDefinitions: [set.planDefinitions[0], set.planDefinitions[0]] };
    assert.match(validateSet(doubled).join('\n'), /duplicate url\+version/);
    assert.match(validateSet(set, { fileExists: () => false }).join('\n'), /file not found/);
    assert.match(
      validateSet(set, { dataset: 'other-dataset' }).join('\n'),
      /not compatible with dataset 'other-dataset'/,
    );
    assert.match(
      validateSet({ name: 'empty', planDefinitions: [] }).join('\n'),
      /no plan definitions/,
    );
  });
});
