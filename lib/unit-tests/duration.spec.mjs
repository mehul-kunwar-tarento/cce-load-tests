/**
 * duration.spec.mjs — unit tests of lib/duration.js
 *
 * What:    Checks that durations are parsed exactly (and garbage is refused, unlike v1's silent 0) and
 *          formatted for people and for k6.
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22 (node:test); no services.
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatDuration, toK6Duration } from '../duration.js';

test('parseDuration accepts every documented form', () => {
  assert.equal(parseDuration('500ms'), 0.5);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('1m30s'), 90);
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration('0s'), 0);
  assert.equal(parseDuration('200ms'), 0.2);
  assert.equal(parseDuration(' 30s '), 30);
  assert.equal(parseDuration(600), 600);
});

test('parseDuration throws on garbage, including the empty string', () => {
  for (const bad of [
    '',
    '   ',
    '10 min',
    '10x',
    'm',
    '1m1m',
    '-5s',
    'abc',
    null,
    undefined,
    {},
    -1,
    NaN,
  ]) {
    assert.throws(
      () => parseDuration(bad),
      /Invalid duration/,
      `should refuse ${JSON.stringify(bad)}`,
    );
  }
});

test('formatDuration reads like a tester writes', () => {
  assert.equal(formatDuration(600), '10m 0s');
  assert.equal(formatDuration(30), '30s');
  assert.equal(formatDuration(5400), '1h 30m 0s');
  assert.equal(formatDuration(0.2), '200ms');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(90.5), '1m 30.5s');
});

test('toK6Duration gives whole seconds or milliseconds', () => {
  assert.equal(toK6Duration(600), '600s');
  assert.equal(toK6Duration(0), '0s');
  assert.equal(toK6Duration(0.2), '200ms');
  assert.equal(toK6Duration(59.5), '59500ms');
  assert.throws(() => toK6Duration(-1));
});

test('toK6Duration uses microseconds when milliseconds are not exact (event totals at high rates)', () => {
  // (1,001 − 0.5) events at 2,000/s = 0.50025 s; k6 accepts "us" (checked with k6 inspect).
  assert.equal(toK6Duration(1.50025), '1500250us');
  assert.equal(toK6Duration(20.01), '20010ms');
});
