/**
 * run-id.spec.mjs — unit tests of tools/core/run-id.mjs (plan §2.3).
 *
 * What:    Run id rules (default d8-d6 accepted, hyphen in a custom id refused), selectors that end with the id
 *          code (so one run never matches another), the UUIDv7 floor and the seeded-id SQL expression.
 * How:     node --test tools/core/unit-tests/run-id.spec.mjs
 * Needs:   Nothing.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefusedError } from '../errors.mjs';
import {
  UUID_V7_SQL,
  createRunId,
  isDefaultRunId,
  runIdEarliestStart,
  runIdStart,
  runSelectors,
  testDataPrefix,
  uuidV7Floor,
  validateRunId,
} from '../run-id.mjs';

test('createRunId is yyyymmdd-hhmmss in local time', () => {
  assert.equal(createRunId(new Date(2026, 10, 5, 14, 22, 33)), '20261105-142233');
});

test('validateRunId: d8-d6 and 1-20 letters/digits accepted; hyphens, underscores, 21 chars refused', () => {
  for (const ok of ['20261105-142233', 'baseline1', '1103003810', 'A'])
    assert.doesNotThrow(() => validateRunId(ok));
  for (const bad of ['test-2', 'a_b', '20261105-1422', 'x'.repeat(21), '', 'a%b', null]) {
    assert.throws(() => validateRunId(bad), RefusedError, String(bad));
  }
});

test('isDefaultRunId and runIdStart: only default ids carry a start time', () => {
  assert.equal(isDefaultRunId('20261105-142233'), true);
  assert.equal(isDefaultRunId('1103003810'), false, 'v1 ids are legacy/custom');
  assert.deepEqual(runIdStart('20261105-142233'), new Date(2026, 10, 5, 14, 22, 33));
  assert.equal(runIdStart('baseline1'), null);
  assert.equal(runIdStart('20261305-142233'), null, 'month 13 is not a date');
  // Earliest instant in any time zone: the clock read as UTC, minus 14 h; independent of this machine's zone.
  assert.equal(runIdEarliestStart('20261105-142233').toISOString(), '2026-11-05T00:22:33.000Z');
  assert.equal(runIdEarliestStart('baseline1'), null);
  assert.equal(runIdEarliestStart('20261305-142233'), null);
});

test('runSelectors end with the id code, so test never matches test2 and 20261105 never matches 20261105-142233', () => {
  assert.equal(testDataPrefix('abc'), 'LOADTEST-abc-');
  assert.deepEqual(runSelectors('20261105-142233'), [
    'LOADTEST-20261105-142233-col-',
    'LOADTEST-20261105-142233-mat-',
    'LOADTEST-20261105-142233-sla-',
  ]);
  const [testSelector] = runSelectors('test', ['col']);
  assert.ok(!'LOADTEST-test2-col-0-1-1'.startsWith(testSelector));
  const [dateSelector] = runSelectors('20261105', ['col']);
  assert.ok(!'LOADTEST-20261105-142233-col-0-1-1'.startsWith(dateSelector));
  assert.throws(() => runSelectors('bad-id'), RefusedError);
});

test('uuidV7Floor: 48-bit millisecond timestamp, version 7, variant bits, rest zero', () => {
  const floor = uuidV7Floor(new Date(0x0192f3a12b3c));
  assert.equal(floor, '0192f3a1-2b3c-7000-8000-000000000000');
  assert.match(uuidV7Floor(Date.now()), /^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/);
  // Later moments sort higher as text, which is what `id >= floor` relies on.
  assert.ok(uuidV7Floor(1_800_000_000_000) > uuidV7Floor(1_700_000_000_000));
  assert.throws(() => uuidV7Floor('not a date'));
});

test('UUID_V7_SQL builds a v7 UUID from clock_timestamp() and random bits', () => {
  assert.match(UUID_V7_SQL, /clock_timestamp\(\)/);
  assert.match(UUID_V7_SQL, /gen_random_uuid\(\)/);
  assert.match(UUID_V7_SQL, /::uuid$/);
});
