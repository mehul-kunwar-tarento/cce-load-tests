/**
 * summary.js — marks when k6 really started, and writes k6's end-of-test summary as JSON (K6)
 *
 * What:    1. markK6Start(): every test's setup() returns { k6StartedAtMs: Date.now() }. setup() runs
 *             after all VUs are created and right before the scenarios start, so this is "time 0" of the
 *             phase plan (the k6 clock contract, lib/README.md).
 *          2. writeSummary(): k6 calls handleSummary(data) at the end; we save the raw summary plus a
 *             `context` block to results/<dir>/k6-summary.json (the only k6 output Node reads) and print
 *             a short own text. No remote jslib import, so it works offline.
 * How:     In every test file:
 *            export function setup() { return markK6Start(); }
 *            export function handleSummary(data) { return writeSummary(data, context); }
 * Needs:   The run context (resultsDirInContainer, runId, subject, testType, phasePlan). It imports
 *          nothing from k6, so Node can unit-test it.
 * Outputs: { '<resultsDirInContainer>/k6-summary.json': JSON text, stdout: short text }.
 */

import { isDummyRule } from './thresholds.js';

/**
 * Notes the moment the scenarios start. Use as (or inside) setup().
 * Why: scenario startTimes count from the end of setup(), and init time (thousands of VUs, one Kafka
 * producer each) can take long, so the docker start time is not "time 0".
 * @returns {{k6StartedAtMs:number}}
 */
export function markK6Start() {
  return { k6StartedAtMs: Date.now() };
}

/**
 * Builds the handleSummary output: the JSON file and the console text.
 * Why: Node builds result.json from this JSON only (never from k6's text output).
 * @param {object} data k6 handleSummary data (metrics, state, setup_data, root_group, options)
 * @param {object} context run context (plan §3.5)
 * @returns {Record<string, string>}
 */
export function writeSummary(data, context) {
  const startedMs = data && data.setup_data ? data.setup_data.k6StartedAtMs : undefined;
  const output = {
    ...data,
    context: {
      runId: context.runId,
      subject: context.subject,
      testType: context.testType,
      phasePlan: context.phasePlan,
      // ISO time of "time 0"; null when setup() did not return markK6Start() (Node then estimates).
      k6StartedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
      // Total k6 run time; null (never missing) when k6 did not report it.
      testRunDurationMs:
        data && data.state && Number.isFinite(data.state.testRunDurationMs)
          ? data.state.testRunDurationMs
          : null,
    },
  };
  return {
    [`${context.resultsDirInContainer}/k6-summary.json`]: JSON.stringify(output, null, 2),
    stdout: summaryText(data, context),
  };
}

/**
 * A short plain-text summary for the console (the full report comes from result.json later).
 * Why: the tester sees at once how many events went out, the latency and which rules failed.
 * @param {object} data k6 handleSummary data
 * @param {object} context run context
 * @returns {string}
 */
export function summaryText(data, context) {
  const metrics = (data && data.metrics) || {};
  const value = (key, stat) =>
    metrics[key] && metrics[key].values ? metrics[key].values[stat] : undefined;
  const lines = [`k6 finished: ${context.subject} ${context.testType}, run ${context.runId}`];
  const sent = value('events_sent', 'count');
  const accepted = value('events_accepted', 'count');
  if (sent !== undefined)
    lines.push(`  events sent ${sent}, accepted ${accepted === undefined ? 0 : accepted}`);
  if (value('http_reqs', 'count') !== undefined) {
    lines.push(
      `  HTTP requests ${value('http_reqs', 'count')}, p95 ${round(value('http_req_duration', 'p(95)'))} ms, ` +
        `failed ${round((value('http_req_failed', 'rate') || 0) * 100)}%`,
    );
  }
  if (value('kafka_writer_message_count', 'count') !== undefined) {
    lines.push(
      `  Kafka messages ${value('kafka_writer_message_count', 'count')}, ` +
        `write errors ${value('kafka_writer_error_count', 'count') || 0}`,
    );
  }
  lines.push(`  dropped iterations ${value('dropped_iterations', 'count') || 0}`);

  // Count pass/fail rules, leaving out the summary-forcing dummy rules.
  const failed = [];
  let passed = 0;
  for (const [key, metric] of Object.entries(metrics)) {
    for (const [rule, outcome] of Object.entries(metric.thresholds || {})) {
      if (isDummyRule(rule)) continue;
      // handleSummary gives { ok: boolean }; tolerate a plain boolean too.
      const ok = typeof outcome === 'object' && outcome !== null ? outcome.ok : outcome;
      if (ok) passed += 1;
      else failed.push(`${key} ${rule}`);
    }
  }
  lines.push(`  thresholds: ${passed} passed, ${failed.length} failed`);
  for (const rule of failed) lines.push(`    FAILED ${rule}`);
  lines.push(
    `  JSON: ${context.resultsDirInContainer}/k6-summary.json (report: result.json, report.md)`,
  );
  return `${lines.join('\n')}\n`;
}

/** Two decimals for display; why: "12.35 ms" reads better than 12.348912. */
function round(number) {
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 'n/a';
}
