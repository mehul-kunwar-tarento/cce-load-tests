/**
 * fakes.mjs — stand-ins for Kafka, the matcher's metrics page, Postgres and the clock in unit tests.
 *
 * What:    The matcher tests must be checked without any running service (D14). These fakes behave like
 *          the real clients just enough for the watcher, the data checks and the module:
 *            createFakeClock      a clock that only moves when the code under test "sleeps"
 *            createFakeTimes      ctx.times of the k6 clock contract, made ready at a chosen fake moment
 *            createFakeKafkaAdmin consumer lag and dead-letter offsets as functions of the fake time
 *            createFakeScrape     the matcher's /actuator/prometheus text as a function of the fake time
 *            createFakePgPool     answers the data-check SQL from fixed rows, recording every statement
 *            defaultSettings      ResolvedSettings.values at the plan §3.2 defaults (durations in seconds)
 * How:     import { createFakeClock, … } from './fakes.mjs';  (only *.spec.mjs files in this folder use it)
 * Needs:   ../shared.mjs (Prometheus text parser, phase plan).
 * Outputs: Plain objects and functions; nothing touches the network or the disk.
 */
import { buildPhasePlan, parsePrometheusText } from '../shared.mjs';

/** Fake "now" of every test: 2026-11-05 14:22:33 local time. */
export const T0 = new Date('2026-11-05T08:52:33.000Z').getTime();

/**
 * Settings at the plan §3.2 defaults, typed as ResolvedSettings.values (durations in seconds).
 * Why: the module reads every limit from settings; tests override single values.
 * @param {Record<string, unknown>} [overrides]
 */
export function defaultSettings(overrides = {}) {
  return {
    RUN_ID: '20261105-142233',
    PLAN_DEFINITION_SET: 'emr-service',
    DATASET: 'ebuzima-emr',
    EVENT_ACTION_ID: 'visit-encounter',
    EVENT_SOURCE: 'loadtest-emr',
    FACILITY_ID: 'LOADTEST-FACILITY-01',
    PEAK_RATE: 50,
    EXPECTED_HEADROOM: 4,
    SMOKE_RATE: 1,
    SMOKE_DURATION: 30,
    SMOKE_EVENTS: null,
    LOAD_RATE: 50,
    LOAD_DURATION: 600,
    LOAD_EVENTS: null,
    STRESS_RATE: 200,
    STRESS_DURATION: 600,
    STRESS_EVENTS: null,
    WARM_UP_RATE: 10,
    WARM_UP_DURATION: 60,
    MATCHER_FLOOD_RATE: 2000,
    MATCHER_FLOOD_DURATION: 60,
    MATCHER_FLOOD_EVENTS: null,
    KAFKA_PRE_ALLOCATED_VUS: 100,
    KAFKA_MAX_VUS: 500,
    MAX_VUS: 2000,
    MIN_CHECKS_RATE: 0.99,
    MAX_DROPPED_RATE: 0.001,
    MATCHER_MAX_BACKLOG: 1000,
    MATCHER_MAX_CATCH_UP: 30,
    MATCHER_MAX_KAFKA_WRITE_ERRORS: 0,
    MATCHER_MAX_DEAD_LETTERS: 0,
    WATCH_INTERVAL: 5,
    CATCH_UP_LIMIT: 120,
    BREAKPOINT_CATCH_UP_LIMIT: 900,
    STALL_TIMEOUT: 30,
    IDLE_FLAT_DURATION: 30,
    IDLE_TIMEOUT: 300,
    REPORT_WINDOW: 10,
    BREAK_CONSECUTIVE_WINDOWS: 2,
    RATE_SHORTFALL_TOLERANCE: 0.05,
    K6_LIMIT_P95_MS: 100,
    ...overrides,
  };
}

/** Local test environment (the kafka block the watcher and data checks read). */
export const ENVIRONMENT = Object.freeze({
  name: 'local',
  kind: 'local',
  kafka: {
    brokers: ['localhost:29092'],
    inboundTopic: 'cce.events.inbound',
    deadLetterTopic: 'cce.events.inbound.dlq',
    matcherConsumerGroup: 'cce-matcher-service',
    expectedPartitions: 25,
  },
});

/**
 * A clock that moves only when `sleep` is called, and fires scheduled callbacks on the way.
 * Why: a 10-minute stress run is simulated in milliseconds, deterministically.
 */
export function createFakeClock(start = T0) {
  const clock = { ms: start, events: [] };
  /** Runs callbacks whose time has come, in time order. */
  const fire = () => {
    clock.events.sort((a, b) => a.atMs - b.atMs);
    while (clock.events.length && clock.events[0].atMs <= clock.ms) clock.events.shift().fn();
  };
  return {
    now: () => clock.ms,
    /** Advances the fake time; scheduled events fire at their moment. */
    async sleep(ms) {
      const target = clock.ms + ms;
      for (const event of [...clock.events].sort((a, b) => a.atMs - b.atMs)) {
        if (event.atMs > target) break;
        clock.ms = Math.max(clock.ms, event.atMs);
        fire();
      }
      clock.ms = target;
      fire();
    },
    /** Calls fn when the fake time reaches atMs. */
    at(atMs, fn) {
      clock.events.push({ atMs, fn });
      fire();
    },
    /** Seconds since T0 (for writing time-based scripts). */
    elapsed: () => (clock.ms - start) / 1000,
  };
}

/**
 * ctx.times of the k6 clock contract (plan §6.3), resolved when `markReady` is called.
 * @returns {object} { k6StartedAt, measureStart, sendEnd, sendEndedEarly, source, ready, markReady, setFromStart }
 */
export function createFakeTimes() {
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  const times = {
    k6StartedAt: null,
    measureStart: null,
    sendEnd: null,
    sendEndedEarly: false,
    source: null,
    warnings: [],
    ready,
    markReady: () => markReady(),
    /** Sets the instants as the k6 clock would from the k6 start and the phase plan. */
    setFromStart(k6StartMs, phasePlan) {
      const measured = phasePlan.phases.find((p) => p.name === phasePlan.measuredPhase);
      const measureStartMs = k6StartMs + measured.startSeconds * 1000;
      times.k6StartedAt = new Date(k6StartMs).toISOString();
      times.measureStart = new Date(measureStartMs).toISOString();
      times.sendEnd = new Date(measureStartMs + measured.durationSeconds * 1000).toISOString();
      times.source = 'k6-rest-api';
    },
  };
  return times;
}

/**
 * Fake kafkajs admin wrapper (tools/core/clients/kafka-admin.mjs shape).
 * @param {{lagAt:(seconds:number) => number|Error, dlqAt?:(seconds:number) => number|Error, clock:object}} input
 */
export function createFakeKafkaAdmin({ lagAt, dlqAt = () => 0, clock }) {
  const calls = [];
  const value = (fn, label) => {
    const result = fn(clock.elapsed());
    if (result instanceof Error) throw result;
    calls.push(label);
    return result;
  };
  return {
    calls,
    async getGroupLag({ groupId, topic }) {
      calls.push(`lag ${groupId} ${topic}`);
      return { total: value(lagAt, 'lag'), partitions: [] };
    },
    async getTopicEndOffsetTotal(topic) {
      calls.push(`end ${topic}`);
      return value(dlqAt, 'dlq');
    },
  };
}

/**
 * Prometheus text of the matcher at a moment.
 * @param {{matched:number|null, zeroMatch?:number, duplicates?:number, processingSum?:number,
 *          processingCount?:number, processingMax?:number, errors?:number}} counters null matched = metric absent
 * @returns {string}
 */
export function matcherMetricsText({
  matched,
  zeroMatch = 0,
  duplicates = 0,
  processingSum = 0,
  processingCount = 0,
  processingMax = 0.02,
  errors = 0,
}) {
  const lines = [
    '# HELP cce_events_matched_total Events that matched',
    '# TYPE cce_events_matched_total counter',
  ];
  if (matched !== null) {
    // Two series: the v1 regex read only the first one; sumMetric adds both.
    lines.push(
      `cce_events_matched_total{application="cce-matcher-service",status="matched"} ${matched}`,
    );
    lines.push(
      `cce_events_matched_total{application="cce-matcher-service",status="zero_match"} ${zeroMatch}`,
    );
    lines.push(`cce_events_duplicate_total{application="cce-matcher-service"} ${duplicates}`);
  }
  lines.push(`cce_events_processing_duration_seconds_sum ${processingSum}`);
  lines.push(`cce_events_processing_duration_seconds_count ${processingCount}`);
  lines.push(`cce_events_processing_duration_seconds_max ${processingMax}`);
  lines.push(`cce_consumer_inbound_errors_total ${errors}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Fake ctx.scrape(subject): parses the text a function returns for the current fake time.
 * @param {{countersAt:(seconds:number) => object|Error, clock:object}} input
 */
export function createFakeScrape({ countersAt, clock }) {
  return async (subject) => {
    if (subject !== 'matcher') throw new Error(`unexpected scrape of ${subject}`);
    const counters = countersAt(clock.elapsed());
    if (counters instanceof Error) throw counters;
    return parsePrometheusText(matcherMetricsText(counters));
  };
}

/**
 * Fake pg pool answering the matcher data-check SQL; records every statement and its parameters.
 * Why: queryRows with a statement_timeout runs BEGIN / SET LOCAL / query / COMMIT on the client given.
 * @param {{events:object, enrolments:object, steps:object}} rows the single row each query returns
 */
export function createFakePgPool(rows) {
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] };
      if (sql.includes('FROM matcher_event_log')) return { rows: [rows.events] };
      if (sql.includes('FROM step_instance')) return { rows: [rows.steps] };
      if (sql.includes('FROM protocol_instance')) return { rows: [rows.enrolments] };
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
}

/** Phase plan of a test type at the given settings (the same code k6 and the runner use). */
export function phasePlanFor(testType, settings = defaultSettings()) {
  return buildPhasePlan({ testType, settings, breakpointKind: 'flood' });
}

/** A logger that keeps what it was told; why: tests assert on warnings without console noise. */
export function createQuietLogger() {
  const lines = { info: [], warn: [] };
  return {
    lines,
    info: (message) => lines.info.push(message),
    warn: (message) => lines.warn.push(message),
  };
}
