/**
 * test-helpers.mjs — small fakes and fixture loaders shared by this folder's unit tests.
 *
 * What:    The unit tests never connect to anything (D14). This file gives them: the fixture k6 summaries,
 *          settings resolved the real way (resolveSettings) from the fixtures' overrides, a fake Postgres pool
 *          that records every statement and answers from a function, a fake Kafka admin and a fake metrics
 *          scrape for the matcher backlog.
 * How:     import { readFixture, fixtureSettings, createFakePool } from './test-helpers.mjs';
 * Needs:   ./fixtures/*.json; ../shared.mjs.
 * Outputs: Helper functions; no tests of its own.
 */
import fs from 'node:fs';
import { resolveSettings } from '../shared.mjs';

/** Start of every fixture run (the generator used the same instant). */
export const FIXTURE_START = new Date('2026-11-05T10:00:00.000Z');

/**
 * Reads a JSON fixture of ./fixtures/.
 * Why: one place that knows where fixtures live; each test gets its own copy it may change.
 * @param {string} name e.g. 'k6-summary-load-passed.json'
 * @returns {any}
 */
export function readFixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/**
 * Settings resolved like a real run, from the overrides the fixtures were generated with.
 * Why: the tests follow config/settings/defaults.json instead of a hand-written copy of it.
 * @param {string} testType 'load' | 'breakpoint' | 'smoke' | 'stress'
 * @param {Record<string, string>} [extra] more --set style overrides
 * @returns {{values:object, phasePlan:object}}
 */
export function fixtureSettings(testType, extra = {}) {
  const overrides = readFixture('settings-overrides.json');
  const resolved = resolveSettings({
    subject: 'collector',
    testType,
    breakpointKind: 'staircase',
    overrides: { ...overrides.common, ...(overrides[testType] ?? {}), ...extra },
    env: {},
    idCode: 'col',
    now: FIXTURE_START,
  });
  return { resolved, values: resolved.values, phasePlan: resolved.derived.phasePlan };
}

/**
 * Settings at the shipped defaults (no overrides) for a test type.
 * Why: expectation texts are checked against the real default numbers (50/s, 10m, …).
 */
export function defaultSettings(testType) {
  const resolved = resolveSettings({
    subject: 'collector',
    testType,
    breakpointKind: 'staircase',
    env: {},
    idCode: 'col',
    now: FIXTURE_START,
  });
  return resolved.values;
}

/**
 * A fake pg.Pool: connect() hands out a client whose query() records (sql, params) and answers with
 * `answer(sql, params)` → rows (default []).
 * Why: queryRows uses a dedicated client with BEGIN / SET LOCAL statement_timeout / COMMIT; the test can
 * check every statement, the bound parameters and that no LIKE scan is used.
 * @param {(sql:string, params:unknown[]) => object[]} [answer]
 */
export function createFakePool(answer = () => []) {
  const statements = [];
  let released = 0;
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      return { rows: answer(sql, params) ?? [] };
    },
    release() {
      released += 1;
    },
  };
  return {
    statements,
    get released() {
      return released;
    },
    async connect() {
      return client;
    },
  };
}

/**
 * Prometheus text already parsed, as tools/core/clients/prometheus-text.mjs returns it.
 * Why: readMatcherBacklog sums cce_events_matched_total and cce_events_duplicate_total from this shape.
 * @param {Record<string, number>} values metric name → value (one series each, no labels)
 */
export function parsedMetrics(values) {
  return new Map(Object.entries(values).map(([name, value]) => [name, [{ labels: {}, value }]]));
}

/**
 * A fake Kafka admin whose consumer-group lag follows `lags` (last value repeats).
 * Why: the matcher backlog (idle wait, backlog-left check) is the matcher group's lag.
 * @param {number[]|Error} lags
 */
export function createFakeKafkaAdmin(lags) {
  let call = 0;
  const calls = [];
  return {
    calls,
    async getGroupLag(input) {
      calls.push(input);
      if (lags instanceof Error) throw lags;
      const total = lags[Math.min(call, lags.length - 1)];
      call += 1;
      return { total, partitions: [] };
    },
  };
}

/** The environment block the matcher-backlog helpers read (names from config/environments/local.json). */
export const FAKE_ENVIRONMENT = Object.freeze({
  name: 'local',
  kind: 'local',
  kafka: { inboundTopic: 'cce.events.inbound', matcherConsumerGroup: 'cce-matcher-service' },
});
