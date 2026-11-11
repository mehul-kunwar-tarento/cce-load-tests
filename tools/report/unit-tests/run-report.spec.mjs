/**
 * run-report.spec.mjs — unit tests of tools/report/run-report.mjs (plan §8.1, R1).
 *
 * What:    The run report rendered from fixture result.json files: header, expectation vs result with the
 *          events that went through in the measured interval, thresholds with TBC markers, when it started
 *          breaking and what broke (diagnostics marked), "not caught up" with numbers (never a catch-up time),
 *          data checks, dropped iterations against the rule, conditions; the breakpoint line (held/broke × peak,
 *          vs expected), the levels table, the "at least X/s (k6 limit)" wording; and that the report code never
 *          reads text, logs or Markdown (SC-002).
 * How:     node --test tools/report/unit-tests/run-report.spec.mjs
 * Needs:   fixtures/results/.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { displayName, renderRunReport } from '../run-report.mjs';

const load = (name) =>
  JSON.parse(
    fs.readFileSync(new URL(`./fixtures/results/${name}/result.json`, import.meta.url), 'utf8'),
  );

test('matcher stress (plan §5.2 example): every section with the fixture numbers', () => {
  const report = renderRunReport(load('matcher-stress-20261105-142233'));
  assert.match(report, /^# Matcher stress — FAILED\n/);
  assert.match(
    report,
    /Run 20261105-142233 · local · plan-definition set overlapping-4 \(4 plan definitions\) · 2026-11-05 \d\d:\d\d:\d\d–\d\d:\d\d:\d\d \(12m 22\.1s\)/,
  );
  assert.match(
    report,
    /Expected: Withstand 200 events\/s \(4 × peak 50\/s\) for 10m.*\(to be confirmed from UAT\/Dev data\)/,
  );
  assert.match(
    report,
    /Result: 108,524 events went through \(processed by the service\) in 12m 0s: 10m 0s of sending \+ 2m 0s of catch-up \(average 150\.73\/s, warm-up excluded, target 200\/s\)\. 119,998 sent in the measured interval; 120,598 sent in all phases; 109,124 processed by the service in all phases; 11,474 still waiting\. FAILED: /,
  );
  // "Went through" is what the service took, never what k6 sent (R1).
  assert.doesNotMatch(report, /119,998 events went through/);
  assert.doesNotMatch(report, /FAILED: Failed:/);
  assert.match(
    report,
    /\| Events waiting in Kafka never above 1,000 \(to be confirmed\) \| 1,000 events \| 28,810 events \| FAILED \|/,
  );
  assert.match(
    report,
    /Started breaking at \d\d:\d\d:\d\d \(31s into the measured phase\) at 200\/s\./,
  );
  assert.match(report, /- up to 28,811 events waiting \(rule < 1,000\)/);
  assert.match(
    report,
    /- matcher DB pool: requests waiting for a connection from 14:24:02 \(diagnostic\)/,
  );
  assert.match(report, /Caught up: no — 11,474 events still waiting after 2m 0s\./);
  assert.match(
    report,
    /\| Every event sent is in matcher_event_log \(matcher\.logged-equals-sent\) \| equals 120,598 \| 120,598 \| passed \|/,
  );
  assert.match(report, /2 of 120,600 \(0\.002%, allowed ≤ 0\.1% = 120\) — within the rule\./);
  assert.match(report, /- Plan-definition set: overlapping-4, fan-out 4, effective fan-out 4/);
  assert.match(
    report,
    /- Settings changed from defaults: PLAN_DEFINITION_SET=overlapping-4 \(cli\)/,
  );
  assert.match(
    report,
    /- Preflight: passed-with-warnings; warnings: autovacuum: 1 vacuum in progress/,
  );
  assert.doesNotMatch(report, /null|undefined|NaN/);
});

test('collector breakpoint: held/broke × peak vs expected, levels table, per-level rules summarised', () => {
  const report = renderRunReport(load('collector-breakpoint-20261105-142233'));
  assert.match(report, /^# Collector breakpoint — PASSED/);
  assert.match(
    report,
    /Breakpoint: held up to 1,600\/s \(32× peak\), broke at 3,200\/s \(64× peak\) — expected ≥ 200\/s: above\./,
  );
  assert.match(
    report,
    /\| 3,200\/s \| 64× peak \| 79,400 \| 192,000 \| 812\.5 ms \| 0\.4% \| broke: p95 812\.5 ms \(rule < 500 ms\) \|/,
  );
  assert.match(
    report,
    /\| 6,400\/s \| 128× peak \| 0 \| 384,000 \| n\/a \| n\/a \| not-reached \|/,
  );
  assert.match(report, /18 per-level rules .* see the levels table/);
  assert.match(
    report,
    /\| Staircase held at least 200\/s \(4 × peak\) \(to be confirmed\) \| 200\/s \| 1,600\/s \| passed \|/,
  );
});

test('k6 limit wording: "at least X/s (k6 limit)" and "not a service failure"', () => {
  const result = load('collector-breakpoint-20261105-142233');
  result.breaking.k6Limited = true;
  result.status = 'failed';
  result.statusReason =
    'k6 could not send on time (k6 limit): a load-generator limit, not a service failure';
  const report = renderRunReport(result);
  assert.match(
    report,
    /Breakpoint: at least 1,600\/s \(k6 limit: the load generator, not the service, stopped the climb\)/,
  );
  assert.match(
    report,
    /The service was not the limit: the load generator \(k6\) could not send faster\./,
  );
});

test('a load run that passed has no breaking section; a seeded run says dropped iterations do not apply', () => {
  assert.doesNotMatch(
    renderRunReport(load('collector-load-20261105-120000')),
    /## When it started breaking/,
  );
  const storm = renderRunReport(load('step-sla-breakpoint-20261105-160000'));
  assert.match(storm, /Not applicable \(no k6 load generator in this test\)\./);
  assert.match(
    storm,
    /Breakpoint: drain rate 826\.4 alarms\/s \(5\.5× peak\) — expected ≥ 600\/s: above\./,
  );
  assert.match(storm, /Caught up: yes, 2m 1s after sending stopped\./);
  // A storm has no sending interval: never "went through in 0s".
  assert.match(
    storm,
    /Result: 100,000 alarms rang at once; all handled in 2m 1s \(average 826\.45\/s, target 600\/s\)\./,
  );
  assert.doesNotMatch(storm, /in 0s/);
});

test('collector: "went through" = accepted (HTTP 2xx); sent and not accepted are secondary figures', () => {
  const report = renderRunReport(load('collector-breakpoint-20261105-142233'));
  assert.match(
    report,
    /Result: 259,034 events went through \(accepted by the service, HTTP 2xx\) in 4m 25\.8s \(average 974\.73\/s, warm-up excluded, target 200\/s\)\. 259,390 sent in the measured interval \(356 not accepted\); 259,990 sent in all phases\./,
  );
});

test('a result with the saved "went through" fields is reported as saved; the sent basis says so', () => {
  const result = load('matcher-stress-20261105-142233');
  result.load = {
    ...result.load,
    eventsProcessed: null,
    eventsThrough: 119998,
    throughBasis: 'sent',
    throughSeconds: 600,
    averageRate: 199.99,
  };
  assert.match(
    renderRunReport(result),
    /Result: 119,998 events went through \(sent by k6; the service's own count is not available\) in 10m 0s \(average 199\.99\/s/,
  );
});

test('display names', () => {
  assert.equal(displayName('step-sla'), 'Step SLA');
  assert.equal(displayName('openhim-adaptor'), 'Openhim Adaptor');
});

test('report code reads JSON only: no file reading, no log or Markdown parsing (SC-002)', () => {
  for (const file of ['../run-report.mjs', '../series-report.mjs']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /readFileSync|createReadStream|k6\.log/, file);
  }
  const series = fs.readFileSync(new URL('../series-report.mjs', import.meta.url), 'utf8');
  assert.match(series, /readJson\(file\)/, 'series input is result.json through readJson');
});
