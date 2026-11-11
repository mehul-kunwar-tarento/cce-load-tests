/**
 * helpers.mjs — fakes shared by the Step SLA unit tests (not a test file itself).
 *
 * What:    The Step SLA code talks to Postgres (seeding, data checks), to Step SLA's metrics page (watcher)
 *          and to the clock. These fakes stand in for all three so the tests never connect anywhere (D14):
 *            fakePgPool     records every SQL statement and its parameters, answers from a function
 *            fakeScrape     returns parsed Prometheus text built from a list of counter readings
 *            fakeClock      now()/sleep() pair where sleeping advances time instantly
 *            buildCtx       a run ctx (plan §6.4) with settings resolved exactly as `run` resolves them
 * How:     import { buildCtx, fakePgPool, fakeClock } from './helpers.mjs';
 * Needs:   ../shared.mjs (settings resolution, environment), config/ and test-data/ of the repository.
 * Outputs: Helper functions only; temporary folders under the OS temp directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stepSlaModule from '../service-module.mjs';
import {
  createTimes,
  loadEnvironment,
  parsePrometheusText,
  prepareRunSettings,
} from '../shared.mjs';

/** A fixed run start, so automatic run ids and UUIDv7 floors are predictable. */
export const RUN_START = new Date('2026-11-05T14:22:33+05:30');

/**
 * A fake pg Pool whose single client records statements in order.
 * Why: seeding must run on ONE client in ONE transaction; the recording proves it.
 * @param {(sql:string, params:unknown[]) => {rows:object[]}|undefined} respond
 */
export function fakePgPool(respond = () => undefined) {
  const statements = [];
  let connects = 0;
  let releases = 0;
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      const answer = respond(sql, params);
      if (answer instanceof Error) throw answer;
      return answer ?? { rows: [] };
    },
    release() {
      releases += 1;
    },
  };
  return {
    statements,
    get connects() {
      return connects;
    },
    get releases() {
      return releases;
    },
    async connect() {
      connects += 1;
      return client;
    },
  };
}

/** A clock whose sleep() advances time instantly; why: a 10-minute watch runs in milliseconds. */
export function fakeClock(startMs) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    set(ms) {
      nowMs = ms;
    },
  };
}

/**
 * Prometheus text of Step SLA's metrics for one reading (null values are left out = "metric absent").
 * Why: the watcher parses real exposition text in production; the tests feed it the same format.
 */
export function stepSlaMetricsText({ due, applied, skipped = 0, cycles, batchesFailed = 0 }) {
  const line = (name, value) =>
    value === null || value === undefined
      ? ''
      : `${name}{application="cce-step-sla-service"} ${value}\n`;
  return (
    line('cce_sla_transitions_due', due) +
    line('cce_sla_transitions_applied_total', applied) +
    line('cce_sla_transitions_skipped_total', skipped) +
    line('cce_sla_evaluator_cycles_total', cycles) +
    line('cce_sla_evaluator_batches_failed_total', batchesFailed)
  );
}

/**
 * A scrape function answering from a reading function of the current time.
 * @param {(nowMs:number) => object|Error} readingAt
 * @param {() => number} now
 */
export function fakeScrape(readingAt, now) {
  return async (subject) => {
    if (subject !== 'step-sla') throw new Error(`unexpected scrape of ${subject}`);
    const reading = readingAt(now());
    if (reading instanceof Error) throw reading;
    return parsePrometheusText(stepSlaMetricsText(reading));
  };
}

/** A fresh temporary folder; why: tests never write into the repository. */
export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cce-step-sla-test-'));
}

/**
 * Resolves the settings of a Step SLA test exactly like `run` does (files only, no network).
 * @param {string} testType
 * @param {Record<string, string>} [overrides] --set values
 */
export async function resolveStepSla(testType, overrides = {}) {
  return prepareRunSettings({
    environment: loadEnvironment('local'),
    module: stepSlaModule,
    testType,
    overrides,
    env: {},
    now: RUN_START,
  });
}

/**
 * A run ctx for one test type (plan §6.4), with fakes for everything external.
 * @param {string} testType
 * @param {{overrides?:object, pgPool?:object, scrape?:Function, resultsDir?:string}} [options]
 */
export async function buildCtx(
  testType,
  { overrides = {}, pgPool = null, scrape = null, resultsDir } = {},
) {
  const setup = await resolveStepSla(testType, overrides);
  const values = setup.resolved.values;
  const dir = resultsDir ?? tempDir();
  const runId = values.RUN_ID;
  const aborts = [];
  const logged = [];
  return {
    environment: loadEnvironment('local'),
    settings: values,
    resolved: setup.resolved,
    phasePlan: setup.resolved.derived.phasePlan,
    runId,
    prefix: `LOADTEST-${runId}-`,
    selector: `LOADTEST-${runId}-sla-`,
    resultsDir: dir,
    context: {
      runId,
      testType,
      startedAt: RUN_START.toISOString(),
      phasePlan: setup.resolved.derived.phasePlan,
    },
    pgPool,
    kafkaAdmin: null,
    scrape,
    logger: {
      info: (m) => logged.push(['info', m]),
      warn: (m) => logged.push(['warn', m]),
      error: (m) => logged.push(['error', m]),
    },
    logged,
    times: createTimes(),
    planDefinitionSet: {
      ...setup.planDefinitionSet,
      expectedRows: setup.setContext?.expectedRows ?? null,
    },
    writeJson: (name, value) =>
      fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`),
    abortLoad: (reason) => aborts.push(reason),
    aborts,
  };
}
