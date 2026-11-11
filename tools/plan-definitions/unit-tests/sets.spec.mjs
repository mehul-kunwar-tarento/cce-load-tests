/**
 * sets.spec.mjs — unit tests of tools/plan-definitions/sets.mjs (set loading, write safety, load-test marker)
 *
 * What:    Loading: the shipped sets give the right url/version/canonical, fan-out and mandatory steps; the
 *          version suffix is applied; "$comment" is stripped at every depth; unknown or badly named sets are
 *          refused. Write safety (plan §7.3): allowPlanDefinitionChanges false refuses load, retire AND
 *          delete; dev/uat need a version suffix or a /loadtest/ url; prod-like environments are refused.
 *          Marker: added once by load, recognised on stored definitions.
 * How:     npm test   (or: node --test tools/plan-definitions/unit-tests/sets.spec.mjs)
 * Needs:   test-data/ (A1); temporary folders for the "$comment" case.
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RefusedError } from '../../core/errors.mjs';
import {
  LOADTEST_MARKER,
  assertPlanDefinitionWriteAllowed,
  hasLoadTestMarker,
  listPlanDefinitionSets,
  loadPlanDefinitionSet,
  stripCommentsDeep,
  withLoadTestMarker,
} from '../sets.mjs';

/** Environment objects for the write-safety rules. */
const env = (kind, allow = true, name = kind) => ({
  name,
  kind,
  safety: { allowPlanDefinitionChanges: allow },
});

describe('loadPlanDefinitionSet', () => {
  it('lists the shipped sets', () => {
    assert.deepEqual(listPlanDefinitionSets(), ['emr-service', 'kenya-sha-emr-service']);
  });

  it('loads kenya-sha-emr-service: one definition, 5 mandatory steps, its own dataset', async () => {
    const set = await loadPlanDefinitionSet('kenya-sha-emr-service');
    assert.equal(set.fanOut, 1);
    assert.equal(set.exclusive, false);
    assert.deepEqual(set.compatibleDatasets, ['tiberbu-emr']);
    const [pd] = set.planDefinitions;
    assert.equal(pd.url, 'http://openphc.org/PlanDefinition/kenya-sha-emr-service-protocol');
    assert.equal(pd.canonical, `${pd.url}|${pd.version}`);
    assert.deepEqual(pd.mandatorySteps, [
      'consent-request',
      'consent-verification',
      'visit-encounter',
      'patient-check-in',
      'diagnosis',
    ]);
  });

  it('loads emr-service: one definition, 3 mandatory steps, its own dataset', async () => {
    const set = await loadPlanDefinitionSet('emr-service');
    assert.equal(set.fanOut, 1);
    assert.deepEqual(set.compatibleDatasets, ['ebuzima-emr']);
    assert.deepEqual(set.planDefinitions[0].mandatorySteps, [
      'vitals-recording',
      'consultation',
      'diagnosis',
    ]);
  });

  it('refuses a set entry with "variant" (variants were removed)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sets-'));
    fs.mkdirSync(path.join(root, 'plan-definition-sets', 'old'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'plan-definition-sets', 'old', 'set.json'),
      JSON.stringify({
        name: 'old',
        planDefinitions: [{ file: 'plan-definitions/p.json', variant: 'v.overrides.json' }],
      }),
    );
    await assert.rejects(loadPlanDefinitionSet('old', { testDataRoot: root }), /variant/);
  });

  it('appends PLAN_DEFINITION_VERSION_SUFFIX to every version', async () => {
    const set = await loadPlanDefinitionSet('emr-service', { versionSuffix: '-loadtest' });
    assert.match(set.planDefinitions[0].version, /-loadtest$/);
    assert.match(set.planDefinitions[0].canonical, /\|.*-loadtest$/);
    assert.equal(set.planDefinitions[0].json.version, set.planDefinitions[0].version);
  });

  it('strips "$comment" at every depth (the protocol service would reject it)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sets-'));
    fs.mkdirSync(path.join(root, 'plan-definition-sets', 'tiny'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plan-definitions'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'plan-definitions', 'p.json'),
      JSON.stringify({
        $comment: 'top',
        resourceType: 'PlanDefinition',
        url: 'u',
        version: '1',
        action: [{ $comment: 'nested', id: 'a' }],
      }),
    );
    fs.writeFileSync(
      path.join(root, 'plan-definition-sets', 'tiny', 'set.json'),
      JSON.stringify({
        $comment: 'set',
        name: 'tiny',
        planDefinitions: [{ file: 'plan-definitions/p.json' }],
      }),
    );
    const set = await loadPlanDefinitionSet('tiny', { testDataRoot: root });
    assert.equal(JSON.stringify(set.planDefinitions[0].json).includes('$comment'), false);
    assert.deepEqual(stripCommentsDeep({ $comment: 1, a: [{ $comment: 2, b: 3 }] }), {
      a: [{ b: 3 }],
    });
  });

  it('loads a run recorded with the old name "single" as emr-service (same plan definition)', async () => {
    const set = await loadPlanDefinitionSet('single');
    assert.equal(set.name, 'emr-service');
    assert.equal(set.planDefinitions[0].file, 'plan-definitions/emr-service-protocol.json');
    await assert.rejects(loadPlanDefinitionSet('overlapping-4'), /Unknown plan-definition set/);
  });

  it('refuses unknown and badly named sets', async () => {
    await assert.rejects(loadPlanDefinitionSet('no-such-set'), RefusedError);
    await assert.rejects(loadPlanDefinitionSet('../etc'), RefusedError);
  });
});

describe('assertPlanDefinitionWriteAllowed (plan §7.3 rules 1–2)', async () => {
  const plain = await loadPlanDefinitionSet('emr-service');
  const suffixed = await loadPlanDefinitionSet('emr-service', { versionSuffix: '-loadtest' });

  it('refuses load, retire and delete when safety.allowPlanDefinitionChanges is false', () => {
    for (const action of ['load', 'retire', 'delete']) {
      assert.throws(
        () =>
          assertPlanDefinitionWriteAllowed({
            environment: env('local', false),
            set: plain,
            action,
          }),
        /allowPlanDefinitionChanges/,
      );
    }
  });

  it('refuses dev/uat without a version suffix, allows them with one', () => {
    for (const kind of ['dev', 'uat']) {
      assert.throws(
        () =>
          assertPlanDefinitionWriteAllowed({ environment: env(kind), set: plain, action: 'load' }),
        /PLAN_DEFINITION_VERSION_SUFFIX/,
      );
      assert.doesNotThrow(() =>
        assertPlanDefinitionWriteAllowed({
          environment: env(kind),
          set: suffixed,
          action: 'retire',
        }),
      );
    }
  });

  it('allows dev/uat when every url contains /loadtest/', () => {
    const loadtestUrls = {
      ...plain,
      planDefinitions: plain.planDefinitions.map((p) => ({ ...p, url: 'http://x/loadtest/p' })),
    };
    assert.doesNotThrow(() =>
      assertPlanDefinitionWriteAllowed({
        environment: env('dev'),
        set: loadtestUrls,
        action: 'load',
      }),
    );
  });

  it('allows local with the safety flag, refuses anything that looks like prod', () => {
    assert.doesNotThrow(() =>
      assertPlanDefinitionWriteAllowed({ environment: env('local'), set: plain, action: 'load' }),
    );
    assert.throws(
      () =>
        assertPlanDefinitionWriteAllowed({
          environment: env('local', true, 'prod-copy'),
          set: plain,
          action: 'load',
        }),
      RefusedError,
    );
    assert.throws(
      () =>
        assertPlanDefinitionWriteAllowed({ environment: env('prod'), set: plain, action: 'load' }),
      RefusedError,
    );
  });
});

describe('load-test marker (plan §7.3 rule 3)', () => {
  it('adds meta.tag once and recognises it', () => {
    const json = {
      resourceType: 'PlanDefinition',
      meta: { tag: [{ system: 'other', code: 'x' }] },
    };
    const marked = withLoadTestMarker(withLoadTestMarker(json));
    assert.equal(marked.meta.tag.length, 2);
    assert.deepEqual(marked.meta.tag[1], LOADTEST_MARKER);
    assert.equal(hasLoadTestMarker(marked), true);
    assert.equal(hasLoadTestMarker(json), false);
    assert.equal(hasLoadTestMarker(null), false);
    assert.equal(json.meta.tag.length, 1, 'the input is not modified');
  });
});
