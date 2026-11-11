/**
 * service-module.spec.mjs — unit tests of the collector's service module (shape, test files, expectation,
 * sampled metrics, idle wait).
 *
 * What:    Checks the plug-in contract of plan §6.4 without running anything: the registry accepts the
 *          module, every test type points at an existing k6 script INSIDE this folder (module-relative URL),
 *          the expectation sentences carry the default numbers, the sampled metrics use plain names and exact
 *          labels, and waitForIdle waits for the matcher (fake Kafka lag + fake scrape) and gives up after
 *          IDLE_TIMEOUT with a refusal.
 * How:     npm test   (or: node --test "cce-collector-service/**\/*.spec.mjs")
 * Needs:   Node 22; ../service-module.mjs, ../shared.mjs; no network, no database.
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import collector, { COLLECTOR_SAMPLED_METRICS, TEST_TYPES } from '../service-module.mjs';
import { validateServiceModule } from '../shared.mjs';
import {
  createFakeKafkaAdmin,
  defaultSettings,
  FAKE_ENVIRONMENT,
  parsedMetrics,
} from './test-helpers.mjs';

/** Absolute path of the cce-collector-service folder (one level up from unit-tests/). */
const FOLDER = fileURLToPath(new URL('..', import.meta.url));

describe('collector service module: shape', () => {
  it('passes the registry shape check', () => {
    assert.deepEqual(validateServiceModule(collector), []);
  });

  it('has the identity and requirements of plan §2.1 and §6.4', () => {
    assert.equal(collector.service, 'cce-collector-service');
    assert.equal(collector.subject, 'collector');
    assert.equal(collector.idCode, 'col');
    assert.equal(collector.kind, 'k6');
    assert.equal(collector.breakpointKind, 'staircase');
    assert.deepEqual([...collector.testTypes], ['smoke', 'load', 'stress', 'breakpoint']);
    assert.deepEqual(collector.requires.services, ['collector']);
    assert.equal(collector.requires.postgres, true);
    assert.equal(collector.requires.protocol, true);
    // true so the run has a Kafka admin for the matcher lag (plan.md deviation 1).
    assert.equal(collector.requires.kafka, true);
  });
});

describe('collector service module: testFile', () => {
  for (const testType of TEST_TYPES) {
    it(`${testType}: a URL of an existing script inside the folder`, () => {
      const url = collector.testFile(testType);
      assert.ok(url instanceof URL);
      assert.equal(url.protocol, 'file:');
      const file = fileURLToPath(url);
      assert.ok(file.startsWith(FOLDER), `${file} is outside ${FOLDER}`);
      assert.ok(file.endsWith(`/tests/collector-${testType}.test.js`));
      assert.ok(fs.existsSync(file), `${file} does not exist`);
      // Each script asserts its own test type (refuses a run context for another one).
      assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`testType: '${testType}'`));
    });
  }

  it('refuses an unknown test type', () => {
    assert.throws(() => collector.testFile('soak'), /no soak test/);
  });
});

describe('collector service module: expectation', () => {
  it('load = 1 × peak at the default 50/s for 10 minutes', () => {
    const e = collector.expectation({ testType: 'load', settings: defaultSettings('load') });
    assert.equal(e.targetRate, 50);
    assert.equal(e.peakRate, 50);
    assert.equal(e.multipleOfPeak, 1);
    assert.equal(e.unit, 'events');
    assert.equal(e.toBeConfirmed, true);
    assert.match(e.summary, /Withstand 50 events\/s \(1 × peak 50\/s\) for 10m/);
    assert.match(e.summary, /p95 < 500 ms/);
    assert.match(e.summary, /dropped < 0\.1%/);
  });

  it('stress = 4 × peak (200/s)', () => {
    const e = collector.expectation({ testType: 'stress', settings: defaultSettings('stress') });
    assert.equal(e.targetRate, 200);
    assert.equal(e.multipleOfPeak, 4);
  });

  it('breakpoint target = EXPECTED_HEADROOM × peak and names the staircase', () => {
    const e = collector.expectation({
      testType: 'breakpoint',
      settings: defaultSettings('breakpoint'),
    });
    assert.equal(e.targetRate, 200);
    assert.match(e.summary, /200 → 400 → 800 → 1,600 → 3,200 → 6,400\/s/);
    assert.match(e.summary, /1m 0s per level/);
  });

  it('smoke = SMOKE_RATE for SMOKE_DURATION', () => {
    const e = collector.expectation({ testType: 'smoke', settings: defaultSettings('smoke') });
    assert.equal(e.targetRate, 1);
    assert.match(e.summary, /1 events\/s for 30s/);
  });

  it('refuses an unknown test type', () => {
    assert.throws(
      () => collector.expectation({ testType: 'soak', settings: defaultSettings('load') }),
      /no soak test/,
    );
  });
});

describe('collector service module: sampled metrics', () => {
  it('lists the collector metrics with plain names and exact labels (no wildcards)', () => {
    const names = COLLECTOR_SAMPLED_METRICS.map((m) => m.name);
    assert.deepEqual(names.sort(), [
      'cce_collector_events_accepted_total',
      'cce_collector_events_duplicate_total',
      'cce_collector_events_received_total',
      'cce_collector_kafka_publish_failure_total',
      'http_server_requests_seconds_count',
      'http_server_requests_seconds_max',
      'http_server_requests_seconds_sum',
    ]);
    for (const metric of COLLECTOR_SAMPLED_METRICS) {
      assert.match(metric.name, /^[a-z_]+$/, `${metric.name} must be a plain metric name`);
      assert.ok(['sum', 'max'].includes(metric.agg));
      assert.equal(typeof metric.unit, 'string');
      for (const value of Object.values(metric.labels ?? {})) {
        assert.doesNotMatch(value, /[*|~]|\.\*/, `label value ${value} must be exact`);
      }
      if (metric.name.startsWith('http_server_requests'))
        assert.deepEqual(metric.labels, { uri: '/v1/events' });
    }
    assert.equal(new Set(COLLECTOR_SAMPLED_METRICS.map((m) => m.key)).size, names.length);
  });

  it('uses the PEAK_SIGNALS key for Kafka publish failures', () => {
    const failures = COLLECTOR_SAMPLED_METRICS.find(
      (m) => m.name === 'cce_collector_kafka_publish_failure_total',
    );
    assert.equal(failures.key, 'kafkaPublishFailures');
  });

  it('is what the module exposes to the runner', () => {
    assert.equal(collector.sampledMetrics, COLLECTOR_SAMPLED_METRICS);
  });
});

describe('collector service module: waitForIdle (matcher idle first)', () => {
  /** A ctx whose matcher has the given lags and a constant processed counter. */
  function idleCtx(lags, settings = {}) {
    return {
      environment: FAKE_ENVIRONMENT,
      settings: { IDLE_FLAT_DURATION: 0, IDLE_TIMEOUT: 5, WATCH_INTERVAL: 0, ...settings },
      kafkaAdmin: createFakeKafkaAdmin(lags),
      scrape: async (subject) => {
        assert.equal(subject, 'matcher'); // the collector waits for the MATCHER
        return parsedMetrics({ cce_events_matched_total: 120, cce_events_duplicate_total: 3 });
      },
      logger: { info() {}, warn() {} },
    };
  }

  it('returns once the matcher lag is 0 and its counter is flat', async () => {
    const ctx = idleCtx([0]);
    const outcome = await collector.waitForIdle(ctx);
    assert.equal(typeof outcome.waitedSeconds, 'number');
    assert.deepEqual(ctx.kafkaAdmin.calls[0], {
      groupId: 'cce-matcher-service',
      topic: 'cce.events.inbound',
    });
  });

  it('refuses (exit 2) when the matcher is still busy after IDLE_TIMEOUT', async () => {
    const ctx = idleCtx([500]);
    let clock = 0;
    await assert.rejects(
      collector.waitForIdle(ctx, {
        sleep: async () => {},
        now: () => (clock += 1000), // one second per poll
      }),
      (error) => error.name === 'RefusedError' && /IDLE_TIMEOUT/.test(error.message),
    );
  });
});
