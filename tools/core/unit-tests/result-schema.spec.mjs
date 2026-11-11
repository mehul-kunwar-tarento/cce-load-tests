/**
 * result-schema.spec.mjs — unit tests of tools/core/result-schema.mjs (plan §5.2, §5.5, §5.6).
 *
 * What:    validateResult accepts the §5.2 matcher stress fixture and reports missing/mistyped fields;
 *          validatePreflight and validateCleanup check statuses ("verified" needs every after = 0); the JSON
 *          Schema file of result.json is valid JSON with its native $comment header.
 * How:     node --test tools/core/unit-tests/result-schema.spec.mjs
 * Needs:   tools/report/unit-tests/fixtures/results/matcher-stress-20261105-142233/result.json.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonFile } from '../json-file.mjs';
import { repoPath } from '../paths.mjs';
import { validateCleanup, validatePreflight, validateResult } from '../result-schema.mjs';

const example = () =>
  readJsonFile(
    repoPath('tools/report/unit-tests/fixtures/results/matcher-stress-20261105-142233/result.json'),
  );

test('the §5.2 matcher stress example is a valid result', () => {
  assert.deepEqual(validateResult(example()), []);
});

test('missing fields, wrong types, bad times and duplicate ids are reported', () => {
  const result = example();
  delete result.latency;
  result.status = 'ok';
  result.startedAt = '2026-11-05 14:22';
  result.thresholds.push({ ...result.thresholds[0] });
  const problems = validateResult(result).join('\n');
  assert.match(problems, /latency is missing/);
  assert.match(problems, /status must be one of/);
  assert.match(problems, /startedAt must be an ISO-8601 time with offset/);
  assert.match(problems, /ids must be unique/);
  assert.deepEqual(validateResult(null), ['result must be a JSON object']);
});

test('validatePreflight: a failed required check needs status failed', () => {
  const preflight = {
    schemaVersion: '1.0.0',
    kind: 'cce-preflight',
    environment: 'local',
    startedAt: '2026-11-05T14:22:33Z',
    status: 'passed',
    checks: [{ id: 'postgres', title: 'Postgres', severity: 'required', status: 'fail' }],
  };
  assert.match(validatePreflight(preflight).join(), /status must be failed/);
  assert.deepEqual(validatePreflight({ ...preflight, status: 'failed' }), []);
});

test('validateCleanup: verified needs every table after = 0', () => {
  const cleanup = {
    schemaVersion: '1.0.0',
    kind: 'cce-cleanup',
    environment: 'local',
    mode: 'delete',
    scope: { runId: '20261105-142233', all: false, selectors: [] },
    startedAt: '2026-11-05T15:00:00+05:30',
    status: 'verified',
    guards: [],
    tables: [{ order: 3, table: 'deviation', exists: true, before: 420, after: 1 }],
    totals: {},
  };
  assert.match(validateCleanup(cleanup).join(), /verified needs every table after = 0/);
  cleanup.tables[0].after = 0;
  assert.deepEqual(validateCleanup(cleanup), []);
});

test('tools/results/result.schema.json is a JSON Schema with a native $comment header', () => {
  const schema = readJsonFile(repoPath('tools/results/result.schema.json'));
  assert.match(schema.$schema, /json-schema\.org/);
  for (const label of ['What:', 'How:', 'Needs:', 'Outputs:'])
    assert.ok(schema.$comment.includes(label));
  // Every top-level field validateResult insists on is documented as required.
  for (const field of [
    'timing',
    'load',
    'breaking',
    'conditions',
    'artifacts',
    'baselineComparison',
  ])
    assert.ok(schema.required.includes(field));
});
