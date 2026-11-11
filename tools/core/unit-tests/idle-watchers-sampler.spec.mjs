/**
 * idle-watchers-sampler.spec.mjs — unit tests of tools/core/idle.mjs, watchers.mjs and metrics-sampler.mjs.
 *
 * What:    Idle checks with fake Kafka lag and scrapes (idle after the flat period; RefusedError on timeout;
 *          null when a reading fails), the watcher runner (outcomes collected even when a watcher fails),
 *          stall and counter-reset detection, the append-as-you-go sample log, and the metrics sampler writing
 *          service-metrics.json with null + one warning for an absent metric.
 * How:     node --test tools/core/unit-tests/idle-watchers-sampler.spec.mjs
 * Needs:   Nothing (fake clock, fake scrape, fake Kafka).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parsePrometheusText } from '../clients/prometheus-text.mjs';
import { RefusedError } from '../errors.mjs';
import { readMatcherBacklog, waitForMatcherIdle, waitForStepSlaIdle } from '../idle.mjs';
import { startMetricsSampler } from '../metrics-sampler.mjs';
import {
  createSampleLog,
  createStallDetector,
  isCounterReset,
  startWatchers,
} from '../watchers.mjs';
import { defaultValues, localEnvironment, tempDir } from './helpers.mjs';

const environment = localEnvironment();
const settings = defaultValues();

/** A fake clock and sleep that advances it. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

/** ctx with a fake Kafka lag sequence and matcher counter sequence. */
function matcherCtx(lags, processed) {
  let i = 0;
  return {
    environment,
    settings,
    kafkaAdmin: { getGroupLag: async () => ({ total: lags[Math.min(i, lags.length - 1)] }) },
    scrape: async () => {
      const value = processed[Math.min(i++, processed.length - 1)];
      return parsePrometheusText(`cce_events_matched_total{status="MATCHED"} ${value}\n`);
    },
  };
}

test('readMatcherBacklog: lag from Kafka + processed from counters; null when a reading fails', async () => {
  assert.deepEqual(await readMatcherBacklog(matcherCtx([7], [100])), { lag: 7, processed: 100 });
  const warnings = [];
  const broken = {
    environment,
    kafkaAdmin: {
      getGroupLag: async () => {
        throw new Error('down');
      },
    },
    scrape: async () => {
      throw new Error('down');
    },
    logger: { warn: (m) => warnings.push(m) },
  };
  assert.deepEqual(await readMatcherBacklog(broken), { lag: null, processed: null });
  assert.equal(warnings.length, 2);
});

test('waitForMatcherIdle: idle once lag is 0 and processed stays flat for the flat period', async () => {
  const clock = fakeClock();
  const ctx = matcherCtx(
    [50, 10, 0, 0, 0, 0, 0, 0, 0, 0],
    [100, 140, 150, 150, 150, 150, 150, 150, 150, 150],
  );
  const { waitedSeconds } = await waitForMatcherIdle(ctx, {
    flatSeconds: 10,
    timeoutSeconds: 120,
    pollSeconds: 5,
    ...clock,
  });
  assert.ok(waitedSeconds >= 10 && waitedSeconds <= 30, String(waitedSeconds));
});

test('waitForMatcherIdle: still busy after IDLE_TIMEOUT → RefusedError (exit 2)', async () => {
  const clock = fakeClock();
  const ctx = matcherCtx([5], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await assert.rejects(
    waitForMatcherIdle(ctx, { flatSeconds: 10, timeoutSeconds: 20, pollSeconds: 5, ...clock }),
    RefusedError,
  );
});

test('waitForStepSlaIdle: due alarms <= 0 for the flat period', async () => {
  const clock = fakeClock();
  const dues = [3, 0, 0, 0, 0];
  let i = 0;
  const ctx = {
    settings,
    scrape: async () =>
      parsePrometheusText(`cce_sla_transitions_due ${dues[Math.min(i++, dues.length - 1)]}\n`),
  };
  const { waitedSeconds } = await waitForStepSlaIdle(ctx, {
    flatSeconds: 10,
    timeoutSeconds: 60,
    pollSeconds: 5,
    ...clock,
  });
  assert.equal(waitedSeconds, 15);
});

test('startWatchers collects every outcome; a failing watcher becomes an outcome with an error', async () => {
  const good = () => ({
    name: 'good',
    start: async () => {},
    stop: async () => {},
    whenDone: async () => ({ name: 'good', samples: [1], thresholds: [], breaking: {}, load: {} }),
  });
  const bad = () => ({
    name: 'bad',
    start: async () => {
      throw new Error('cannot start');
    },
    stop: async () => {},
    whenDone: async () => ({}),
  });
  const run = startWatchers([good, bad], { logger: { warn: () => {} } });
  const outcomes = await run.whenDone();
  assert.equal(outcomes[0].name, 'good');
  assert.deepEqual(outcomes[1], {
    name: 'bad',
    file: null,
    samples: [],
    thresholds: [],
    breaking: {},
    load: {},
    error: 'cannot start',
  });
  await run.stopAll();
});

test('stall detector: backlog > 10 and no progress for STALL_TIMEOUT → stalled; counter decrease = reset', () => {
  const stall = createStallDetector({ stallSeconds: 30 });
  assert.equal(stall.update({ atMs: 0, backlog: 500, progress: 10 }), false);
  assert.equal(stall.update({ atMs: 20_000, backlog: 500, progress: 10 }), false);
  assert.equal(stall.update({ atMs: 30_000, backlog: 500, progress: 10 }), true);
  const quiet = createStallDetector({ stallSeconds: 30 });
  quiet.update({ atMs: 0, backlog: 5, progress: 1 });
  assert.equal(
    quiet.update({ atMs: 60_000, backlog: 5, progress: 1 }),
    false,
    'tiny backlog is not a stall',
  );
  assert.equal(isCounterReset(100, 3), true);
  assert.equal(isCounterReset(100, 100), false);
  assert.equal(isCounterReset(null, 3), false);
});

test('sample log rewrites watch-<name>.json after every sample (an abort keeps the data)', () => {
  const dir = tempDir();
  const log = createSampleLog({ name: 'backlog', resultsDir: dir, intervalSeconds: 5 });
  log.add({ backlog: 10 });
  const file = path.join(dir, 'watch-backlog.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).samples.length, 1);
  log.finish({ caughtUp: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).outcome, { caughtUp: true });
});

test('metrics sampler: one sample per target and round, null + one warning for an absent metric', async () => {
  const writes = [];
  const sampler = startMetricsSampler({
    targets: [{ subject: 'matcher', url: 'http://m/actuator/prometheus' }],
    intervalSeconds: 3600,
    file: '/unused/service-metrics.json',
    metrics: [
      { key: 'hikariPending', name: 'hikaricp_connections_pending', agg: 'sum', unit: 'requests' },
      { key: 'missing', name: 'not_there', agg: 'sum', unit: '' },
    ],
    scrape: async () => parsePrometheusText('hikaricp_connections_pending 2\n'),
    write: (file, data) => writes.push(structuredClone(data)),
  });
  await sampler.stop();
  const last = writes.at(-1);
  assert.equal(last.samples.length, 1);
  assert.deepEqual(last.samples[0].metrics, { hikariPending: 2, missing: null });
  assert.equal(last.samples[0].service, 'matcher');
  assert.deepEqual(last.warnings, [
    'matcher: metric missing not found at http://m/actuator/prometheus',
  ]);
});
