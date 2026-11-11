/**
 * triggers.spec.mjs — unit tests of tools/plan-definitions/triggers.mjs (how CCE reads plan definitions/events)
 *
 * What:    Pins the copies of CCE logic the overlap check relies on: trigger_index rows of a plan definition
 *          (code, or display when the code is absent; a type-only row for a trigger without codeFilter), the
 *          code triples the matcher extracts from an event (EventCodesExtractor), and matchTuples, which
 *          always includes the ('', '', '') resource-type-only row. Also mandatory steps and groups.
 * How:     npm test   (or: node --test tools/plan-definitions/unit-tests/triggers.spec.mjs)
 * Needs:   test-data/ (A1) for the dataset/plan-definition match.
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { repoPath } from '../../core/paths.mjs';
import { loadPlanDefinitionSet } from '../sets.mjs';
import {
  STEP_TYPE,
  extractEventCodes,
  findResources,
  mandatorySteps,
  matchTuples,
  triggerIndexRows,
} from '../triggers.mjs';

const stepType = { coding: [{ ...STEP_TYPE }] };

describe('triggerIndexRows', () => {
  it('indexes code (or display) per coding and a type-only row for a trigger without codeFilter', () => {
    const json = {
      action: [
        {
          id: 'a',
          type: stepType,
          trigger: [
            {
              data: [
                {
                  type: 'Encounter',
                  codeFilter: [
                    { path: 'type', code: [{ display: 'VISIT' }, { system: 's', code: 'C' }] },
                  ],
                },
              ],
            },
          ],
        },
        { id: 'b', type: stepType, trigger: [{ data: [{ type: 'Observation' }] }] },
        // A group's own trigger is never indexed.
        {
          id: 'g',
          type: stepType,
          groupingBehavior: 'logical-group',
          trigger: [{ data: [{ type: 'Condition' }] }],
          action: [],
        },
      ],
    };
    assert.deepEqual(triggerIndexRows(json), [
      {
        resourceType: 'Encounter',
        path: 'type',
        codeSystem: '',
        codeValue: 'VISIT',
        actionId: 'a',
      },
      { resourceType: 'Encounter', path: 'type', codeSystem: 's', codeValue: 'C', actionId: 'a' },
      { resourceType: 'Observation', path: '', codeSystem: '', codeValue: '', actionId: 'b' },
    ]);
  });
});

describe('extractEventCodes', () => {
  it('reads top-level fields like the matcher: text, codings, bare Coding, identifiers in arrays', () => {
    const codes = extractEventCodes({
      resourceType: 'Encounter',
      id: 'x',
      status: 'finished',
      type: [{ coding: [{ display: 'VISIT' }] }],
      class: { system: 'v3', code: 'AMB' },
      identifier: [{ system: 'mrn', value: '42' }],
    });
    assert.deepEqual(codes, [
      { path: 'status', system: '', code: 'finished' },
      { path: 'type', system: '', code: 'VISIT' },
      { path: 'class', system: 'v3', code: 'AMB' },
      { path: 'identifier', system: 'mrn', code: '42' },
    ]);
  });
});

describe('matchTuples', () => {
  it('includes the resource-type-only row, numbered per event', () => {
    const tuples = matchTuples({
      resources: [
        { resourceType: 'Encounter', type: [{ coding: [{ display: 'VISIT' }] }] },
        { resourceType: 'Encounter', type: [{ coding: [{ display: 'VISIT' }] }] },
      ],
    });
    assert.deepEqual(tuples, [
      { eventNo: 0, resourceType: 'Encounter', path: '', codeSystem: '', codeValue: '' },
      { eventNo: 0, resourceType: 'Encounter', path: 'type', codeSystem: '', codeValue: 'VISIT' },
      { eventNo: 1, resourceType: 'Encounter', path: '', codeSystem: '', codeValue: '' },
      { eventNo: 1, resourceType: 'Encounter', path: 'type', codeSystem: '', codeValue: 'VISIT' },
    ]);
  });

  it('never adds the trigger rows of plan definitions (only what events carry)', () => {
    const tuples = matchTuples({ resources: [], planDefinitions: [{ action: [] }] });
    assert.deepEqual(tuples, []);
  });

  it('the visit-encounter template hits the base plan definition trigger', async () => {
    const dataset = JSON.parse(
      fs.readFileSync(repoPath('test-data', 'datasets', 'ebuzima-emr', 'dataset.json'), 'utf8'),
    );
    const [pd] = (await loadPlanDefinitionSet('emr-service')).planDefinitions;
    const fromEvents = new Set(
      matchTuples({ resources: findResources(dataset.eventTemplates['visit-encounter']) }).map(
        ({ eventNo: _eventNo, ...t }) => JSON.stringify(t),
      ),
    );
    const visitRow = triggerIndexRows(pd.json).find((r) => r.actionId === 'visit-encounter');
    // The trigger row minus its action id is the tuple an event must produce.
    const tuple = { ...visitRow };
    delete tuple.actionId;
    assert.ok(
      fromEvents.has(JSON.stringify(tuple)),
      'the visit-encounter template must match its trigger',
    );
  });
});

describe('mandatorySteps', () => {
  it('lists must steps, never groups', () => {
    const json = {
      action: [
        { id: 'a', type: stepType, requiredBehavior: 'must' },
        {
          id: 'g',
          type: stepType,
          groupingBehavior: 'logical-group',
          requiredBehavior: 'must',
          action: [{ id: 'c', type: stepType, requiredBehavior: 'must' }],
        },
        { id: 'b', type: stepType, requiredBehavior: 'could' },
      ],
    };
    assert.deepEqual(mandatorySteps(json), ['a', 'c']);
  });
});
