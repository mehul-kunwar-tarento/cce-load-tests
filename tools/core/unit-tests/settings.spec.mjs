/**
 * settings.spec.mjs — unit tests of tools/core/settings.mjs (plan §3.2, §3.3).
 *
 * What:    Precedence (defaults → environment → env vars → --set), pinned value types (durations in seconds,
 *          LEVELS as numbers, unset = null), the *_EVENTS → *_DURATION derivation (spec R9: LOAD_EVENTS=1000 →
 *          LOAD_DURATION 20 s, derived; exact totals such as 1,000 at 80/s = 12.5 s), ratio range checks,
 *          auto values, reserved settings, RUN_ID rules and the 50-character event-id check, and that
 *          "$comment" is never a setting.
 * How:     node --test tools/core/unit-tests/settings.spec.mjs   (or npm test)
 * Needs:   config/settings/defaults.json, config/environments/local.json, lib/ pure modules.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefusedError } from '../errors.mjs';
import { readJsonFile } from '../json-file.mjs';
import {
  DEFAULTS_FILE,
  loadSettingDefinitions,
  parseSetArgs,
  printSettings,
  resolveSettings,
  settingsForResult,
} from '../settings.mjs';
import { localEnvironment } from './helpers.mjs';

const environment = localEnvironment();
const NOW = new Date('2026-11-05T14:22:33');
const resolve = (input = {}) => resolveSettings({ environment, env: {}, now: NOW, ...input });

/** Every name of the plan §3.2 table. */
const PLAN_SETTINGS =
  `RUN_ID PLAN_DEFINITION_SET DATASET EVENT_ACTION_ID EVENT_SOURCE FACILITY_ID NOTE PEAK_RATE
EXPECTED_HEADROOM SMOKE_RATE SMOKE_DURATION SMOKE_EVENTS LOAD_RATE LOAD_DURATION LOAD_EVENTS STRESS_RATE
STRESS_DURATION STRESS_EVENTS WARM_UP_RATE WARM_UP_DURATION LEVELS LEVEL_DURATION MATCHER_FLOOD_RATE
MATCHER_FLOOD_DURATION MATCHER_FLOOD_EVENTS STEP_SLA_STORM_ALARMS STEP_SLA_FIRST_RING_DELAY STEP_SLA_SEED_MODE
STEP_SLA_ACTION_ID STEP_SLA_SEED_MISSED_ALARMS STEP_SLA_PEAK_ALARM_RATE MAX_VUS KAFKA_PRE_ALLOCATED_VUS KAFKA_MAX_VUS
HTTP_P95_LIMIT_MS HTTP_MAX_FAILED_RATE MIN_CHECKS_RATE MAX_DROPPED_RATE BREAKPOINT_MAX_DROPPED K6_LIMIT_P95_MS
RATE_SHORTFALL_TOLERANCE MATCHER_MAX_BACKLOG MATCHER_MAX_CATCH_UP MATCHER_MAX_KAFKA_WRITE_ERRORS
MATCHER_MAX_DEAD_LETTERS STEP_SLA_MAX_WAIT STEP_SLA_STORM_MAX_CATCH_UP WATCH_INTERVAL CATCH_UP_LIMIT
BREAKPOINT_CATCH_UP_LIMIT STALL_TIMEOUT IDLE_FLAT_DURATION IDLE_TIMEOUT ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS EVENT_MODE
WORKLOAD_PROFILE REPORT_WINDOW BREAK_CONSECUTIVE_WINDOWS SKIP_PREFLIGHT MONITORING_REQUIRED PROMETHEUS_REMOTE_WRITE
K6_TREND_STATS MIN_FREE_DISK_GB CLEANUP_LEGACY_V1 CLEANUP_BATCH_SIZE CLEANUP_LOCK_TIMEOUT CLEANUP_PAUSE
CLEANUP_MIN_SAFE_WAL_GB CLEANUP_TEMP_INDEX PROTOCOL_REFRESH_WAIT PLAN_DEFINITION_VERSION_SUFFIX BASELINE
BASELINE_TOLERANCE BASELINE_MIN_RUNS`.split(/\s+/);

test('defaults.json defines every setting of plan §3.2 with all required fields', () => {
  const definitions = loadSettingDefinitions();
  assert.deepEqual(Object.keys(definitions).sort(), [...PLAN_SETTINGS].sort());
  for (const [name, d] of Object.entries(definitions)) {
    for (const field of ['default', 'type', 'unit', 'appliesTo', 'description', 'toBeConfirmed']) {
      assert.ok(field in d, `${name} lacks ${field}`);
    }
  }
});

test('"$comment" of defaults.json is never a setting', () => {
  assert.ok('$comment' in readJsonFile(DEFAULTS_FILE), 'the file carries a header');
  const resolved = resolve();
  assert.ok(!('$comment' in resolved.values));
  assert.ok(!('$comment' in settingsForResult(resolved)));
});

test('precedence: defaults < environment < env var < --set', () => {
  const env = { ...environment, settings: { LOAD_RATE: 60 } };
  assert.equal(resolveSettings({ environment: env, env: {}, now: NOW }).values.LOAD_RATE, 60);
  const fromVar = resolveSettings({ environment: env, env: { LOAD_RATE: '70' }, now: NOW });
  assert.equal(fromVar.values.LOAD_RATE, 70);
  assert.equal(fromVar.sources.LOAD_RATE, 'env-var');
  const fromCli = resolveSettings({
    environment: env,
    env: { LOAD_RATE: '70' },
    overrides: { LOAD_RATE: '80' },
    now: NOW,
  });
  assert.equal(fromCli.values.LOAD_RATE, 80);
  assert.equal(fromCli.sources.LOAD_RATE, 'cli');
  assert.equal(resolve().sources.LOAD_RATE, 'default');
});

test('MIN_FREE_DISK_GB comes from safety.minFreeDiskGb unless an env var or --set gives it', () => {
  const env = { ...environment, safety: { ...environment.safety, minFreeDiskGb: 33 } };
  assert.equal(
    resolveSettings({ environment: env, env: {}, now: NOW }).values.MIN_FREE_DISK_GB,
    33,
  );
  assert.equal(
    resolveSettings({ environment: env, env: { MIN_FREE_DISK_GB: '5' }, now: NOW }).values
      .MIN_FREE_DISK_GB,
    5,
  );
});

test('value types are pinned (durations in seconds, LEVELS numbers, unset null, booleans)', () => {
  const { values } = resolve({ overrides: { CLEANUP_PAUSE: '200ms', SKIP_PREFLIGHT: '1' } });
  assert.equal(values.LOAD_DURATION, 600);
  assert.equal(values.WARM_UP_DURATION, 60);
  assert.equal(values.CLEANUP_PAUSE, 0.2);
  assert.deepEqual(values.LEVELS, [200, 400, 800, 1600, 3200, 6400]);
  assert.equal(values.LOAD_EVENTS, null);
  assert.equal(values.SKIP_PREFLIGHT, true);
  assert.equal(values.MAX_DROPPED_RATE, 0.001);
  assert.equal(values.CLEANUP_TEMP_INDEX, 'auto');
  assert.equal(typeof values.LOAD_RATE, 'number');
});

test('bad values are refused loudly (no silent 0 for a garbage duration)', () => {
  assert.throws(() => resolve({ overrides: { LOAD_DURATION: 'ten minutes' } }), RefusedError);
  assert.throws(() => resolve({ overrides: { LOAD_RATE: '2.5' } }), RefusedError);
  assert.throws(() => resolve({ overrides: { LEVELS: '400,200' } }), /ascending/);
  assert.throws(() => resolve({ overrides: { SKIP_PREFLIGHT: 'maybe' } }), RefusedError);
  assert.throws(() => resolve({ overrides: { CLEANUP_TEMP_INDEX: 'sometimes' } }), RefusedError);
});

test('ratios are range-checked: 0 … 1, and never a k6 rule that can never pass', () => {
  for (const name of ['MIN_CHECKS_RATE', 'HTTP_MAX_FAILED_RATE', 'MAX_DROPPED_RATE']) {
    assert.throws(() => resolve({ overrides: { [name]: '1.5' } }), /a ratio is between 0 and 1/);
    assert.throws(() => resolve({ overrides: { [name]: '-0.01' } }), /a ratio is between 0 and 1/);
  }
  // Boundaries that are fine.
  assert.equal(resolve({ overrides: { MAX_DROPPED_RATE: '0' } }).values.MAX_DROPPED_RATE, 0);
  assert.equal(resolve({ overrides: { MAX_DROPPED_RATE: '1' } }).values.MAX_DROPPED_RATE, 1);
  assert.equal(resolve({ overrides: { MIN_CHECKS_RATE: '0' } }).values.MIN_CHECKS_RATE, 0);
  // `rate>1` and `rate<0` can never pass.
  assert.throws(() => resolve({ overrides: { MIN_CHECKS_RATE: '1' } }), /can never pass/);
  assert.throws(() => resolve({ overrides: { HTTP_MAX_FAILED_RATE: '0' } }), /can never pass/);
  // "1" typed as "1 %": allowed (a ratio), but the tester is told the rule can never fail.
  const lenient = resolve({ overrides: { HTTP_MAX_FAILED_RATE: '1' } });
  assert.match(lenient.warnings.join(' '), /HTTP_MAX_FAILED_RATE=1 .* 1 % is 0\.01/);
});

test('an unknown --set name is an error; an unknown env var is ignored', () => {
  assert.throws(() => resolve({ overrides: { LOAD_RAT: '1' } }), /Unknown setting LOAD_RAT/);
  assert.doesNotThrow(() =>
    resolveSettings({ environment, env: { SOMETHING_ELSE: 'x' }, now: NOW }),
  );
});

test('spec R9: LOAD_EVENTS=1000 at 50/s → LOAD_DURATION 20 s, source derived', () => {
  const resolved = resolve({
    subject: 'stub',
    testType: 'load',
    breakpointKind: 'staircase',
    overrides: { LOAD_EVENTS: '1000' },
  });
  assert.equal(resolved.values.LOAD_DURATION, 20);
  assert.equal(resolved.sources.LOAD_DURATION, 'derived');
  assert.equal(resolved.derived.phasePlan.plannedMeasuredEvents, 1000);
  assert.deepEqual(resolved.warnings, []);
});

test('events win over an explicit duration, with a warning', () => {
  const resolved = resolve({ overrides: { STRESS_EVENTS: '1000', STRESS_DURATION: '1m' } });
  assert.equal(resolved.values.STRESS_DURATION, 5); // 1000 / 200
  assert.match(resolved.warnings.join(' '), /STRESS_EVENTS wins/);
});

test('an event total is sent exactly: LOAD_EVENTS=1000 at 80/s → 12.5 s, 1,000 planned (not 1,040)', () => {
  const resolved = resolve({
    subject: 'stub',
    testType: 'load',
    breakpointKind: 'staircase',
    overrides: { LOAD_EVENTS: '1000', LOAD_RATE: '80' },
  });
  assert.equal(resolved.values.LOAD_DURATION, 12.5);
  assert.equal(resolved.derived.phasePlan.plannedMeasuredEvents, 1000);
  assert.deepEqual(resolved.warnings, []);
  // A total that does not divide evenly (1000 / 3 s) still plans exactly 1,000.
  const thirds = resolve({
    subject: 'stub',
    testType: 'stress',
    breakpointKind: 'staircase',
    overrides: { STRESS_EVENTS: '1000', STRESS_RATE: '3' },
  });
  assert.equal(thirds.derived.phasePlan.plannedMeasuredEvents, 1000);
  assert.deepEqual(thirds.warnings, []);
});

test('MATCHER_FLOOD_EVENTS → MATCHER_FLOOD_DURATION = events / MATCHER_FLOOD_RATE', () => {
  const resolved = resolve({
    subject: 'matcher',
    testType: 'breakpoint',
    breakpointKind: 'flood',
    overrides: { MATCHER_FLOOD_EVENTS: '5001' },
  });
  assert.equal(resolved.values.MATCHER_FLOOD_DURATION, 2.5005); // 5001 / 2000
  assert.equal(resolved.sources.MATCHER_FLOOD_DURATION, 'derived');
  assert.equal(resolved.derived.phasePlan.phases.at(-1).durationSeconds, 2.5005);
  assert.equal(resolved.derived.phasePlan.plannedMeasuredEvents, 5001);
});

test('STEP_SLA_MAX_WAIT=auto is 2 × the Step SLA poll interval; PEAK_ALARM_RATE=auto uses the set', () => {
  const resolved = resolve({ setContext: { expectedRows: { dueAlarms: 3 } } });
  assert.equal(resolved.values.STEP_SLA_MAX_WAIT, 10);
  assert.equal(resolved.sources.STEP_SLA_MAX_WAIT, 'derived');
  assert.equal(resolved.values.STEP_SLA_PEAK_ALARM_RATE, 150);
  assert.equal(resolve().values.STEP_SLA_PEAK_ALARM_RATE, null, 'unresolvable without the set');
});

test('reserved settings are refused: EVENT_MODE=journey, WORKLOAD_PROFILE', () => {
  assert.throws(() => resolve({ overrides: { EVENT_MODE: 'journey' } }), /not implemented yet/);
  assert.throws(
    () => resolve({ overrides: { WORKLOAD_PROFILE: 'x.json' } }),
    /not implemented yet/,
  );
});

test('RUN_ID: automatic yyyymmdd-hhmmss; custom ids without hyphen; event ids fit 50 characters', () => {
  const auto = resolve();
  assert.equal(auto.values.RUN_ID, '20261105-142233');
  assert.equal(auto.sources.RUN_ID, 'derived');
  assert.equal(
    resolve({ overrides: { RUN_ID: '20261106-101010' } }).values.RUN_ID,
    '20261106-101010',
  );
  assert.equal(resolve({ overrides: { RUN_ID: 'baseline1' } }).values.RUN_ID, 'baseline1');
  assert.throws(() => resolve({ overrides: { RUN_ID: 'test-2' } }), RefusedError);
  assert.throws(() => resolve({ overrides: { RUN_ID: 'a_b' } }), RefusedError);
  assert.throws(() => resolve({ overrides: { RUN_ID: 'x'.repeat(21) } }), RefusedError);
  const longest = resolve({
    subject: 'collector',
    testType: 'load',
    breakpointKind: 'staircase',
    overrides: { RUN_ID: 'x'.repeat(20) },
  });
  assert.ok(longest.derived.longestEventIdLength <= 50);
});

test('without subject/test type there is no phase plan (cleanup, preflight)', () => {
  assert.equal(resolve().derived.phasePlan, null);
});

test('printSettings shows value, source and TBC; settingsForResult keeps value + source', () => {
  const resolved = resolve({
    subject: 'collector',
    testType: 'load',
    breakpointKind: 'staircase',
    overrides: { LOAD_EVENTS: '1000' },
  });
  const text = printSettings(resolved);
  assert.match(text, /\| LOAD_DURATION \| 20s \| derived \|/);
  assert.match(text, /\| PEAK_RATE \| 50 \| default \| TBC \|/);
  assert.match(text, /warm-up/);
  assert.doesNotMatch(
    text,
    /CLEANUP_BATCH_SIZE/,
    'cleanup-only settings are not relevant to a run',
  );
  assert.deepEqual(settingsForResult(resolved).LOAD_DURATION, { value: 20, source: 'derived' });
});

test('parseSetArgs splits on the first "=" and refuses a pair without a name', () => {
  assert.deepEqual(parseSetArgs(['NOTE=a=b', 'LOAD_RATE=5']), { NOTE: 'a=b', LOAD_RATE: '5' });
  assert.throws(() => parseSetArgs(['=5']), RefusedError);
});
