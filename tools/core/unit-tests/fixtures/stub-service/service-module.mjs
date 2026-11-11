/**
 * service-module.mjs (stub) — a fake service module for wave-A tests and dry runs.
 *
 * What:    The real service modules (collector, matcher, Step SLA) are built later (wave B). This
 *          stub has the same shape (plan §6.4) with trivial behaviour, so the runner, settings and
 *          reports can be tested now: subject 'stub', id code 'stb', kind 'k6', staircase breakpoint.
 * How:     node tools/cli.mjs settings local stub load --modules-root tools/core/unit-tests/fixtures
 *          node tools/cli.mjs run local stub load --dry-run --modules-root tools/core/unit-tests/fixtures
 * Needs:   Nothing; it never connects to anything.
 * Outputs: A service module object (default export).
 */

export default {
  service: 'stub-service',
  subject: 'stub',
  idCode: 'stb',
  displayName: 'Stub',
  kind: 'k6',
  breakpointKind: 'staircase',
  testTypes: ['smoke', 'load', 'stress', 'breakpoint'],
  // Nothing to check before a run: the stub needs no service, database or Kafka.
  requires: { services: [], postgres: false, kafka: false, protocol: false },

  /** The k6 script of a test type; why: the runner maps this URL to /tests/… in the container. */
  testFile(testType) {
    return new URL(`./tests/stub-${testType}.test.js`, import.meta.url);
  },

  /** Expectation in plain words (R1.3); why: every report states it next to the result. */
  expectation({ testType, settings }) {
    const peak = settings.PEAK_RATE;
    const target =
      testType === 'stress'
        ? settings.STRESS_RATE
        : testType === 'smoke'
          ? settings.SMOKE_RATE
          : testType === 'breakpoint'
            ? settings.EXPECTED_HEADROOM * peak
            : settings.LOAD_RATE;
    return {
      summary: `Stub ${testType}: withstand ${target} events/s`,
      targetRate: target,
      peakRate: peak,
      multipleOfPeak: target / peak,
      unit: 'events',
      toBeConfirmed: true,
    };
  },

  sampledMetrics: [],

  /** No database: one informational check that always passes. */
  async dataChecks() {
    return [
      {
        id: 'stub.nothing-to-check',
        description: 'The stub stores nothing',
        expected: 0,
        actual: 0,
        comparison: 'equals',
        passed: true,
        severity: 'info',
      },
    ];
  },

  /** No module-specific rules. */
  evaluate() {
    return { thresholds: [], breaking: {}, load: {}, notes: [] };
  },

  /** One metric for baseline tests: the measured p95. */
  baselineMetrics(result) {
    return [
      {
        key: `stub.${result.testType}.p95Ms`,
        label: `Stub ${result.testType} p95`,
        unit: 'ms',
        better: 'lower',
        value: result.latency?.p95 ?? null,
      },
    ];
  },
};
