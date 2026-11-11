/**
 * thresholds.js — the pass/fail rules (k6 "thresholds") of every k6 test, and their plain-words form (PURE)
 *
 * What:    A threshold is a rule k6 checks on a metric, e.g. "95% of requests answered within 500 ms"
 *          (`http_req_duration: p(95)<500`). This module builds every rule of a test from the phase plan
 *          and the settings (plan §4.2): latency, errors, checks, dropped iterations, per-level rules for
 *          staircases (which stop the test at the first broken level), Kafka write errors, and "dummy"
 *          rules that only make per-phase / per-window numbers appear in the k6 summary for the report.
 * How:     import { buildThresholds, describeThreshold, isDummyRule } from '../lib/thresholds.js';
 *          Used by lib/scenarios.js (k6 options) and tools/core/k6-summary.mjs (report words).
 * Needs:   PhasePlan (lib/phase-plan.js) and settings = ResolvedSettings.values (plan §3.3).
 * Outputs: A k6 `thresholds` object; descriptions as { metric, rule, description, unit }.
 */

import { requireNumber, requireInteger } from './settings-guard.js';
import { measuredPhaseOf } from './phase-plan.js';

/** Rules that can never fail; they exist only so k6 puts that sub-metric in its summary. */
export const DUMMY_RULES = ['count>=0', 'p(95)>=0', 'rate>=0'];

/** Abort rules wait this long before judging, so a level has collected enough requests first (v1). */
const ABORT_DELAY = '10s';

/** Stress safety stop (v1): over 10% errors means the service is down; stop hammering it. */
const STRESS_ABORT_FAILED_RATE = 0.1;

/**
 * Dropped iterations allowed for a run: floor(planned × MAX_DROPPED_RATE) (D9; e.g. 30000 × 0.001 = 30).
 * Why: v1 demanded 0 dropped, so 11 dropped out of 30,020 failed a run the service handled fine.
 * @param {number} plannedEvents events the schedule plans to send (all phases)
 * @param {number} maxDroppedRate allowed share, e.g. 0.001
 * @returns {number}
 */
export function allowedDropped(plannedEvents, maxDroppedRate) {
  // Tiny epsilon: 120600 × 0.001 is 120.60000000000001 in floating point; floor must still give 120.
  return Math.floor(plannedEvents * maxDroppedRate + 1e-9);
}

/**
 * True for a summary-forcing rule that never fails and is never reported.
 * Why: the report and the "failed thresholds" list must ignore these helper rules.
 * @param {string|{threshold:string}} rule
 * @returns {boolean}
 */
export function isDummyRule(rule) {
  const text = typeof rule === 'string' ? rule : rule && rule.threshold;
  if (typeof text !== 'string') return false;
  return DUMMY_RULES.includes(text.replace(/\s+/g, ''));
}

/**
 * Builds the k6 thresholds of one test (plan §4.2).
 * Why: one place decides every rule, read from the same settings Node prints and saves.
 * @param {{phasePlan: import('./phase-plan.js').PhasePlan, settings: Record<string, unknown>, kind: 'http'|'kafka'}} input
 * @returns {Record<string, Array<string|{threshold:string, abortOnFail?:boolean, delayAbortEval?:string}>>}
 */
export function buildThresholds({ phasePlan, settings, kind }) {
  if (kind !== 'http' && kind !== 'kafka')
    throw new Error(`Unknown test kind "${kind}": use http or kafka`);
  if (phasePlan.breakpointKind === 'none') {
    throw new Error(
      'Step SLA (breakpointKind "none") is seeded, not driven by k6: it has no k6 thresholds',
    );
  }
  const thresholds = {};
  // add() appends, so two rules on the same metric key end up in one array (k6's format).
  const add = (key, rule) => {
    if (!thresholds[key]) thresholds[key] = [];
    thresholds[key].push(rule);
  };
  const measured = measuredPhaseOf(phasePlan);
  const M = `scenario:${measured.name}`; // filter of the measured scenario ("measure" or "smoke")
  const minChecks = requireNumber(settings, 'MIN_CHECKS_RATE');
  const isSmoke = measured.name === 'smoke';
  const isStaircase = measured.kind === 'staircase';

  // Warm-up sanity: if the warm-up's checks fail, stop at once instead of measuring a broken setup.
  if (phasePlan.phases.some((phase) => phase.name === 'warm-up')) {
    add('checks{scenario:warm-up}', { threshold: `rate>${minChecks}`, abortOnFail: true });
  }

  if (kind === 'http' && isStaircase) {
    addStaircaseRules(add, measured, settings, minChecks);
  } else if (kind === 'http') {
    const p95 = requireNumber(settings, 'HTTP_P95_LIMIT_MS');
    const failed = requireNumber(settings, 'HTTP_MAX_FAILED_RATE');
    add(`http_req_duration{${M}}`, `p(95)<${p95}`);
    add(`http_req_failed{${M}}`, `rate<${failed}`);
    // Smoke: stop at the first failed check (v1), a smoke run proves the setup, not the capacity.
    add(
      `checks{${M}}`,
      isSmoke ? { threshold: `rate>${minChecks}`, abortOnFail: true } : `rate>${minChecks}`,
    );
    addDroppedRule(add, phasePlan, settings);
    if (phasePlan.testType === 'stress') {
      // Safety stop: the measured phase at > 10% errors means the service is down.
      add(`http_req_failed{${M}}`, {
        threshold: `rate<${STRESS_ABORT_FAILED_RATE}`,
        abortOnFail: true,
        delayAbortEval: ABORT_DELAY,
      });
    }
  } else {
    // Kafka (matcher): k6 only writes to Kafka; backlog and catch-up are judged by the Node watcher.
    add(
      'kafka_writer_error_count',
      `count<=${requireInteger(settings, 'MATCHER_MAX_KAFKA_WRITE_ERRORS', { min: 0 })}`,
    );
    add(
      `checks{${M}}`,
      isSmoke ? { threshold: `rate>${minChecks}`, abortOnFail: true } : `rate>${minChecks}`,
    );
    addDroppedRule(add, phasePlan, settings);
    if (isStaircase) {
      // A Kafka staircase is not planned today; still record what each level sent.
      for (const level of measured.levels) add(`iterations{level:${level.rate}}`, 'count>=0');
    }
  }

  // Measured-phase event counts (lib/event-metrics.js) always appear in the summary.
  add(`events_sent{${M}}`, 'count>=0');
  add(`events_accepted{${M}}`, 'count>=0');

  // Per-window numbers for "when it started breaking" (plan §6.9).
  for (let i = 0; i < phasePlan.windowCount; i += 1) {
    add(`iterations{window:${i}}`, 'count>=0');
    add(`checks{window:${i}}`, 'rate>=0');
    if (kind === 'http') {
      add(`http_req_duration{window:${i}}`, 'p(95)>=0');
      add(`http_req_failed{window:${i}}`, 'rate>=0');
    }
  }
  return thresholds;
}

/**
 * Turns one rule into plain words for reports, e.g.
 * ('http_req_duration{scenario:measure}', 'p(95)<500') → "95% of requests answered within 500 ms (measured phase)".
 * Why: the report is read by people who were not there and may be new to k6.
 * @param {string} metricKey e.g. 'http_req_failed{level:400}'
 * @param {string|{threshold:string, abortOnFail?:boolean}} rule
 * @returns {{metric:string, rule:string, description:string, unit:string}}
 */
export function describeThreshold(metricKey, rule) {
  const text = (typeof rule === 'string' ? rule : rule.threshold).replace(/\s+/g, '');
  const abort = typeof rule === 'object' && rule !== null && rule.abortOnFail === true;
  const [, metric, filter] = /^([^{]+)(?:\{(.*)\})?$/.exec(metricKey) || [null, metricKey, null];
  const [, stat, op, rawLimit] = /^([a-z]+(?:\([\d.]+\))?)(<=|>=|==|!=|<|>)(.+)$/.exec(text) || [];
  const limit = Number(rawLimit);
  const scope = describeScope(filter);
  const words = OP_WORDS[op] || op || '';

  let description;
  let unit = '';
  if (isDummyRule(text)) {
    description = `${metric}${scope}: recorded for the report (not a pass/fail rule)`;
  } else if (metric === 'http_req_duration') {
    unit = 'ms';
    const share = /^p\(([\d.]+)\)$/.exec(stat);
    description = share
      ? `${share[1]}% of requests answered ${op.startsWith('<') ? 'within' : `in ${words}`} ${fmt(limit)} ms${scope}`
      : `request time ${stat} ${words} ${fmt(limit)} ms${scope}`;
  } else if (metric === 'http_req_failed') {
    unit = 'ratio';
    description = `${words} ${pct(limit)} of requests failed (HTTP error or no answer)${scope}`;
  } else if (metric === 'checks') {
    unit = 'ratio';
    description = `${words} ${pct(limit)} of the test's checks passed${scope}`;
  } else if (metric === 'dropped_iterations') {
    unit = 'events';
    description = `${words} ${fmt(limit)} events k6 could not send on time (dropped iterations)${scope}`;
  } else if (metric === 'kafka_writer_error_count') {
    unit = 'errors';
    description = `${words} ${fmt(limit)} Kafka write errors${scope}`;
  } else {
    unit = stat === 'rate' ? 'ratio' : stat === 'count' ? 'count' : '';
    description = `${metric} ${stat} ${words} ${fmt(limit)}${scope}`;
  }
  if (abort) description += ' — stops the test when broken';
  return { metric: metricKey, rule: text, description, unit };
}

// --- helpers ----------------------------------------------------------------------------------

/** Words for comparison operators, so rules read like sentences. */
const OP_WORDS = {
  '<': 'under',
  '<=': 'at most',
  '>': 'over',
  '>=': 'at least',
  '==': 'exactly',
  '!=': 'not',
};

/**
 * Per-level rules of the HTTP staircase (ported from the first version's lib/breakpoint.js).
 * Why: each level is judged on its own with the load rules; abortOnFail stops the run at the first
 * broken level so the report reads "held X/s, broke at Y/s".
 */
function addStaircaseRules(add, measured, settings, minChecks) {
  const p95 = requireNumber(settings, 'HTTP_P95_LIMIT_MS');
  const failed = requireNumber(settings, 'HTTP_MAX_FAILED_RATE');
  const perLevel = (threshold) => ({ threshold, abortOnFail: true, delayAbortEval: ABORT_DELAY });
  for (const { rate } of measured.levels) {
    add(`http_req_duration{level:${rate}}`, perLevel(`p(95)<${p95}`));
    add(`http_req_failed{level:${rate}}`, perLevel(`rate<${failed}`));
    add(`checks{level:${rate}}`, perLevel(`rate>${minChecks}`));
    // Requests actually sent at this level (target = rate × level seconds), for the report.
    add(`iterations{level:${rate}}`, 'count>=0');
  }
  // Dropped iterations carry no level tag, so they count over the whole run: this many means k6
  // itself cannot keep the rate, and the report then says "at least X/s (k6 limit)".
  add('dropped_iterations', {
    threshold: `count<${requireInteger(settings, 'BREAKPOINT_MAX_DROPPED', { min: 1 })}`,
    abortOnFail: true,
  });
}

/** The dropped-iterations rule of load-type tests (D9); why: k6 must really send at the set rate. */
function addDroppedRule(add, phasePlan, settings) {
  const rate = requireNumber(settings, 'MAX_DROPPED_RATE', { min: 0 });
  add('dropped_iterations', `count<=${allowedDropped(phasePlan.plannedEvents, rate)}`);
}

/** Words for a sub-metric filter such as "scenario:measure" or "level:400"; why: readable reports. */
function describeScope(filter) {
  if (!filter) return '';
  const [tag, value] = filter.split(':');
  if (tag === 'scenario' && value === 'measure') return ' (measured phase)';
  if (tag === 'scenario') return ` (${value} phase)`;
  if (tag === 'level') return ` at level ${value}/s`;
  if (tag === 'window') return ` in report window ${value}`;
  return ` (${filter})`;
}

/** A ratio as a percentage without float noise, e.g. 0.01 → "1%"; why: people read percentages. */
function pct(ratio) {
  return `${Math.round(ratio * 100 * 1000) / 1000}%`;
}

/**
 * A number with thousands separators, e.g. 30000 → "30,000"; why: big counts stay readable.
 * Done by hand because k6's JavaScript engine has no locale data for toLocaleString.
 */
function fmt(value) {
  if (!Number.isFinite(value)) return String(value);
  const [whole, fraction] = String(value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
