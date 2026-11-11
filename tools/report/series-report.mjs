/**
 * series-report.mjs — one summary over several runs: per service, then the whole flow (plan §8.2, R1.4).
 *
 * What:    After a set of runs (e.g. load + stress + breakpoint of every service), the team lead wants one
 *          page: what we expected, what each service withstood, when and why it broke, the breaking
 *          points (× peak), the weakest link of the whole flow (a failed load/stress run at or below the
 *          expected rate overrules a breakpoint figure: "below expectation"), whether the data was correct,
 *          and a bottom line. This module reads the runs' result.json files ONLY (JSON in, JSON + Markdown out;
 *          v1 grepped Markdown), picks the latest run of each service and test type, and writes
 *          summary.json (kind cce-performance-summary) and summary.md. Folders without result.json (old
 *          v1 outputs, cleanup folders) are ignored; tests that did not run show "not run".
 * How:     import { writeSeriesReport } from './series-report.mjs';
 *          writeSeriesReport({ dirs, out }) — CLI: node tools/cli.mjs report --series results/a results/b …
 *          (or --latest 6, or --since 2026-11-05)
 * Needs:   result.json files (plan §5.2).
 * Outputs: summary.json + summary.md in the --out folder; the summary object.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  NOT_AVAILABLE,
  formatClock,
  formatDate,
  formatNumber,
  formatSeconds,
  markdownTable,
  toIsoWithOffset,
} from '../core/format.mjs';
import { throughOf } from '../core/events-through.mjs';
import { readJson, writeGeneratedJson } from '../core/results.mjs';
import { toRepoRelative } from '../core/paths.mjs';
import { displayName, settingValue, timesPeak } from './run-report.mjs';

/** summary.json schema version and kind. */
export const SUMMARY_SCHEMA_VERSION = '1.0.0';

/** The in-scope services, always listed (with "not run" when missing), in flow order. */
export const CORE_SUBJECTS = ['collector', 'matcher', 'step-sla'];

/** Test types summarised per service. */
const TEST_TYPES = ['smoke', 'load', 'stress', 'breakpoint'];

/** Header written into summary.json (plan §2.4: tool-written JSON carries a generated $comment). */
const SUMMARY_COMMENT =
  'What: series summary of several CCE performance runs (per service, then the whole flow), generated from ' +
  'their result.json files. How: written by `node tools/cli.mjs report --series …`; summary.md next to it is ' +
  'the readable form. Needs: nothing (regenerate it instead of editing). Outputs: read by people and tools; ' +
  'loaders drop this $comment.';

/**
 * Reads the result.json of each folder; folders without one are skipped (and listed as ignored).
 * Why: plan §8.2 — v1 folders in results/ are evidence, not results.
 * @param {string[]} dirs
 * @returns {{entries: Array<{dir:string, result:object}>, ignored:string[]}}
 */
export function readSeriesEntries(dirs) {
  const entries = [];
  const ignored = [];
  for (const dir of dirs) {
    const file = path.join(dir, 'result.json');
    if (!fs.existsSync(file)) {
      ignored.push(dir);
      continue;
    }
    entries.push({ dir, result: readJson(file) });
  }
  return { entries, ignored };
}

/** Descriptions of what broke, without the diagnostics; why: the series tables state decisions only. */
function decidingWhatBroke(result) {
  return (result.breaking?.whatBroke ?? [])
    .filter((item) => item.source !== 'service-metrics')
    .map((item) => item.description);
}

/**
 * One run reduced to the numbers the series report shows.
 * Why: the summary JSON stays small and stable even when result.json grows.
 * @param {string} dir
 * @param {object} result
 * @param {string} [root] for repository-relative folder names
 */
export function summariseRun(dir, result, root) {
  const load = result.load ?? {};
  const breaking = result.breaking ?? {};
  // "Went through" = what the service took (accepted / processed / handled), the same figure as the
  // run report (core/events-through.mjs); what k6 sent is kept next to it.
  const through = throughOf(result);
  const requiredChecks = (result.dataChecks ?? []).filter((check) => check.severity !== 'info');
  return {
    dir: root ? toRepoRelative(path.resolve(dir), root) : dir,
    runId: result.runId,
    status: result.status,
    statusReason: result.statusReason,
    startedAt: result.startedAt,
    unit: load.unit ?? 'events',
    eventsThrough: through.eventsThrough,
    throughBasis: through.throughBasis,
    throughSeconds: through.throughSeconds,
    eventsSent: load.measuredEventsSent ?? load.eventsSent ?? null,
    eventsProcessed: load.eventsProcessed ?? null,
    measuredSeconds: load.measuredSeconds ?? null,
    averageRate: through.averageRate,
    targetRate: result.expectation?.targetRate ?? load.targetRate ?? null,
    peakRate: result.expectation?.peakRate ?? settingValue(result, 'PEAK_RATE'),
    startedBreakingAt: breaking.startedBreakingAt ?? null,
    secondsIntoMeasure: breaking.secondsIntoMeasure ?? null,
    whatBroke: decidingWhatBroke(result),
    heldUpTo: breaking.heldUpTo ?? null,
    brokeAtRate: breaking.brokeAtRate ?? null,
    k6Limited: Boolean(breaking.k6Limited),
    drainRate: breaking.drainRate ?? null,
    caughtUp: breaking.caughtUp ?? null,
    remainingBacklog: breaking.remainingBacklog ?? null,
    stepSlaPeakAlarmRate: settingValue(result, 'STEP_SLA_PEAK_ALARM_RATE'),
    dataChecksPassed: requiredChecks.every((check) => check.passed),
    failedDataChecks: requiredChecks.filter((check) => !check.passed).map((check) => check.id),
    baselineWorse: (result.baselineComparison?.rows ?? [])
      .filter((row) => row.verdict === 'worse')
      .map((row) => row.key),
    runsOfThisType: 1,
  };
}

/** Condition fingerprint of a run; why: runs measured under different conditions must be flagged. */
function conditionFacts(result) {
  const c = result.conditions ?? {};
  return {
    environment: c.environment?.name ?? null,
    host: c.host ? `${c.host.hostname} (${c.host.cpus} CPUs)` : null,
    k6Image: c.host?.k6Image ?? null,
    planDefinitionSet: c.planDefinitionSet
      ? `${c.planDefinitionSet.name} (fan-out ${c.planDefinitionSet.fanOut})`
      : null,
    dataset: c.dataset?.name ?? null,
    suiteCommit: c.suite?.gitCommit ?? null,
  };
}

/**
 * The capacity number of a service's breakpoint run in its own unit, with words.
 * Why: collector = held-up-to rate (events/s), matcher and Step SLA = drain rate (events/s, alarms/s).
 * @param {string} subject
 * @param {object|null} run summariseRun() of the breakpoint run
 */
function capacityOf(subject, run) {
  if (!run) return null;
  if (typeof run.heldUpTo === 'number' || typeof run.brokeAtRate === 'number') {
    return {
      rate: run.heldUpTo ?? 0,
      atLeast: run.k6Limited,
      kind: 'held-up-to',
      unit: `${run.unit}/s`,
    };
  }
  if (typeof run.drainRate === 'number') {
    return { rate: run.drainRate, atLeast: false, kind: 'drain-rate', unit: `${run.unit}/s` };
  }
  return null;
}

/**
 * Builds the summary object (summary.json) from result entries.
 * Why: the Markdown is rendered from this object only, so both always agree.
 * @param {Array<{dir:string, result:object}>} entries
 * @param {{root?:string, now?:Date, ignored?:string[]}} [options]
 * @returns {object}
 */
export function buildSeriesSummary(entries, { root, now = new Date(), ignored = [] } = {}) {
  // Latest run per (subject, test type), counting how many runs of that type were given.
  const latest = new Map();
  for (const { dir, result } of entries) {
    const key = `${result.subject}|${result.testType}`;
    const run = summariseRun(dir, result, root);
    const previous = latest.get(key);
    if (!previous || new Date(result.startedAt) >= new Date(previous.run.startedAt)) {
      latest.set(key, {
        run: { ...run, runsOfThisType: (previous?.run.runsOfThisType ?? 0) + 1 },
        result,
      });
    } else {
      previous.run.runsOfThisType += 1;
    }
  }
  const subjects = [...new Set([...CORE_SUBJECTS, ...entries.map((e) => e.result.subject)])];
  // The expectation comes from the most recent run's settings (all runs should agree; differences are flagged).
  const byNewest = [...entries].sort(
    (a, b) => new Date(b.result.startedAt) - new Date(a.result.startedAt),
  );
  const newest = byNewest[0]?.result ?? null;
  // A setting from the newest run that recorded it (every real result records all settings).
  const latestSetting = (name) => {
    for (const { result } of byNewest) {
      const value = settingValue(result, name);
      if (value !== null) return value;
    }
    return null;
  };
  const peakRate = latestSetting('PEAK_RATE');
  const headroom = latestSetting('EXPECTED_HEADROOM');
  const expectation = {
    peakRate,
    loadTarget: latestSetting('LOAD_RATE'),
    stressTarget: latestSetting('STRESS_RATE'),
    headroom,
    breakpointTarget:
      typeof peakRate === 'number' && typeof headroom === 'number' ? peakRate * headroom : null,
    stepSlaPeakAlarmRate: latestSetting('STEP_SLA_PEAK_ALARM_RATE'),
    toBeConfirmed: true,
  };

  const services = subjects.map((subject) => {
    const entry = { subject, displayName: displayName(subject) };
    for (const testType of TEST_TYPES)
      entry[testType] = latest.get(`${subject}|${testType}`)?.run ?? null;
    entry.service =
      latest.get(`${subject}|load`)?.result.service ??
      [...latest.values()].find((v) => v.result.subject === subject)?.result.service ??
      null;
    entry.capacity = capacityOf(subject, entry.breakpoint);
    // Step SLA rates are alarms/s, so its expected rate is the Step SLA peak alarm rate × headroom.
    const expectedRate =
      subject === 'step-sla'
        ? typeof expectation.stepSlaPeakAlarmRate === 'number' && typeof headroom === 'number'
          ? expectation.stepSlaPeakAlarmRate * headroom
          : null
        : expectation.breakpointTarget;
    entry.failedRuns = failedRunsInConflict(subject, latest, entry.capacity, expectedRate);
    return entry;
  });

  // Whole flow: an end-to-end result wins; otherwise the weakest link of collector held-up-to and matcher drain rate.
  const endToEnd = services.find((s) => s.subject === 'end-to-end');
  const collector = services.find((s) => s.subject === 'collector')?.capacity ?? null;
  const matcher = services.find((s) => s.subject === 'matcher')?.capacity ?? null;
  const links = [
    collector && { subject: 'collector', ...collector },
    matcher && { subject: 'matcher', ...matcher },
  ].filter(Boolean);
  const weakest = links.length ? links.reduce((a, b) => (b.rate < a.rate ? b : a)) : null;
  // Failed load/stress runs of the flow's services at or below their capacity or the expectation: a
  // breakpoint figure alone must never say "above" while the same service failed a sustained run.
  const flowFailedRuns = services
    .filter((s) => s.subject === 'collector' || s.subject === 'matcher')
    .flatMap((s) => s.failedRuns.map((failed) => ({ subject: s.subject, ...failed })));
  const belowExpectation = flowFailedRuns.some((failed) => failed.belowExpectation);
  const wholeFlow = {
    endToEnd: endToEnd?.load ?? endToEnd?.stress ?? null,
    verdict: endToEnd
      ? null
      : belowExpectation
        ? 'below-expectation'
        : flowFailedRuns.length
          ? 'conflict'
          : weakest && typeof expectation.breakpointTarget === 'number'
            ? weakest.rate >= expectation.breakpointTarget
              ? 'above-expectation'
              : 'below-expectation'
            : null,
    failedRuns: flowFailedRuns,
    weakestLink: weakest
      ? {
          subject: weakest.subject,
          rate: weakest.rate,
          unit: 'events/s',
          atLeast: weakest.atLeast,
          multipleOfPeak:
            typeof peakRate === 'number' && peakRate > 0 ? weakest.rate / peakRate : null,
        }
      : null,
    links,
    note: endToEnd
      ? 'From the end-to-end module result.'
      : 'Estimate: the slower of the collector (held up to) and the matcher (drain rate), overruled by any ' +
        'failed collector or matcher load/stress run at or below that rate or the expectation. Step SLA ' +
        '(alarms/s) is not part of this estimate: it is judged on its own in the breaking points. The ' +
        'end-to-end module is not built yet.',
  };

  const allRuns = [...latest.values()].map((v) => v.run);
  const failedChecks = allRuns.flatMap((run) =>
    run.failedDataChecks.map((id) => `${run.dir}: ${id}`),
  );
  const countType = (type) => {
    const runs = services.map((s) => s[type]).filter(Boolean);
    return { passed: runs.filter((run) => run.status === 'passed').length, total: runs.length };
  };

  // Conditions: the newest run's facts, plus a warning for every fact that differs between runs.
  const facts = entries.map((e) => ({ dir: e.dir, facts: conditionFacts(e.result) }));
  const conditionsDiffer = [];
  for (const name of [
    'environment',
    'host',
    'k6Image',
    'planDefinitionSet',
    'dataset',
    'suiteCommit',
  ]) {
    const values = [...new Set(facts.map((f) => f.facts[name]).filter((v) => v !== null))];
    if (values.length > 1)
      conditionsDiffer.push(`${name} differs between runs: ${values.join(' / ')}`);
  }

  return {
    $comment: SUMMARY_COMMENT,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    kind: 'cce-performance-summary',
    generatedAt: toIsoWithOffset(now),
    runs: entries.map(({ dir, result }) => ({
      dir: root ? toRepoRelative(path.resolve(dir), root) : dir,
      runId: result.runId,
      subject: result.subject,
      testType: result.testType,
      status: result.status,
    })),
    ignoredFolders: ignored.map((dir) => (root ? toRepoRelative(path.resolve(dir), root) : dir)),
    expectation,
    services,
    wholeFlow,
    dataCorrectness: { allRequiredPassed: failedChecks.length === 0, failed: failedChecks },
    bottomLine: {
      load: countType('load'),
      stress: countType('stress'),
      breakpoint: countType('breakpoint'),
      capacity: services
        .filter((s) => s.capacity)
        .map((s) => ({
          subject: s.subject,
          ...s.capacity,
          target: s.breakpoint?.targetRate ?? null,
          failedRuns: s.failedRuns,
        })),
      baselineWorse: allRuns.flatMap((run) => run.baselineWorse.map((key) => `${run.dir}: ${key}`)),
    },
    conditions: newest ? conditionFacts(newest) : null,
    conditionsDiffer,
  };
}

/** "above" / "below (short by N/s)" against a target; why: every capacity is judged against the expectation. */
function versusTarget(rate, target) {
  if (typeof rate !== 'number' || typeof target !== 'number') return NOT_AVAILABLE;
  return rate >= target
    ? `above ${formatNumber(target)}/s`
    : `below ${formatNumber(target)}/s (short by ${formatNumber(target - rate)}/s)`;
}

/**
 * Failed load/stress runs of a subject that contradict its capacity or the expectation.
 * Why: a breakpoint (capacity) figure alone could say "above 200/s" while the same service failed its
 *      200/s stress run; such a run is reported with the capacity (R1: expectation vs result).
 *      A failed run counts when its target rate is at or below the expected rate ("belowExpectation":
 *      the service did not withstand what we expected) or at or below the measured capacity (a conflict).
 * @param {string} subject
 * @param {Map<string, {run:object, result:object}>} latest latest run per "subject|testType"
 * @param {object|null} capacity capacityOf() of the subject's breakpoint run
 * @param {number|null} expectedRate rate the subject should withstand (peak × headroom), in its own unit
 * @returns {Array<{testType:string, runId:string, targetRate:number, unit:string, belowExpectation:boolean, sameConditions:boolean|null}>}
 */
function failedRunsInConflict(subject, latest, capacity, expectedRate) {
  const breakpointResult = latest.get(`${subject}|breakpoint`)?.result ?? null;
  const out = [];
  for (const testType of ['load', 'stress']) {
    const found = latest.get(`${subject}|${testType}`);
    const run = found?.run;
    if (!run || run.status !== 'failed' || typeof run.targetRate !== 'number') continue;
    const belowExpectation = typeof expectedRate === 'number' && run.targetRate <= expectedRate;
    const belowCapacity = Boolean(capacity) && run.targetRate <= capacity.rate;
    if (!belowExpectation && !belowCapacity) continue;
    // Same conditions = same environment and plan-definition set as the breakpoint run (null: no breakpoint run).
    let sameConditions = null;
    if (breakpointResult) {
      const a = conditionFacts(found.result);
      const b = conditionFacts(breakpointResult);
      sameConditions =
        a.environment === b.environment && a.planDefinitionSet === b.planDefinitionSet;
    }
    out.push({
      testType,
      runId: run.runId,
      targetRate: run.targetRate,
      unit: `${run.unit}/s`,
      belowExpectation,
      sameConditions,
    });
  }
  return out;
}

/** "stress at 200/s failed" for each failed run; prefix with the service name when `withName`. */
function failedRunsText(failedRuns, withName = false) {
  return failedRuns
    .map(
      (f) =>
        `${withName ? `${displayName(f.subject)} ` : ''}${f.testType} at ${formatNumber(f.targetRate)}/s failed` +
        (f.sameConditions === false ? ' (under different conditions)' : ''),
    )
    .join('; ');
}

/**
 * A capacity judged against its target AND the failed sustained runs of the same service.
 * Why: "above 200/s" from a breakpoint run is wrong when the 200/s stress run failed (finding R1).
 */
function capacityVerdict(rate, target, failedRuns = [], withName = false) {
  const base = versusTarget(rate, target);
  if (!failedRuns.length) return base;
  const what = failedRunsText(failedRuns, withName);
  return failedRuns.some((f) => f.belowExpectation)
    ? `below expectation (${what}; the breakpoint run alone: ${base})`
    : `${base}, but ${what} — conflicting results, check the run reports`;
}

/** Status word for a table cell, "not run" when the run is missing. */
function statusCell(run) {
  return run ? run.status.toUpperCase() : 'not run';
}

/** "259,034 events accepted" — the through figure with its basis; why: says what the number counts. */
function throughCell(run) {
  if (!run) return 'not run';
  if (run.eventsThrough === null || run.eventsThrough === undefined) return NOT_AVAILABLE;
  const basis = run.throughBasis === 'sent' ? 'sent (no service count)' : (run.throughBasis ?? '');
  return `${formatNumber(run.eventsThrough)} ${run.unit} ${basis}`.trim();
}

/** What k6 sent in the measured interval (secondary figure). */
function sentCell(run) {
  if (!run) return NOT_AVAILABLE;
  return typeof run.eventsSent === 'number' ? formatNumber(run.eventsSent) : NOT_AVAILABLE;
}

/**
 * Renders summary.md from the summary object (plan §8.2 sections 1–8).
 * Why: the Markdown is a view of summary.json; it is never read back by code.
 * @param {object} summary buildSeriesSummary()
 * @returns {string}
 */
export function renderSeriesReport(summary) {
  const e = summary.expectation;
  const lines = [
    `# CCE performance — series summary (${formatDate(summary.generatedAt)})`,
    '',
    `${summary.runs.length} run(s): ${summary.runs.map((r) => `${r.subject} ${r.testType} ${r.runId} (${r.status})`).join(', ') || 'none'}.`,
  ];
  if (summary.ignoredFolders?.length) {
    lines.push(`Ignored (no result.json): ${summary.ignoredFolders.join(', ')}.`);
  }

  lines.push(
    '',
    '## 1. What we expect',
    '',
    `- Peak: ${formatNumber(e.peakRate)} events/s (design figure, to be confirmed from UAT/Dev data).`,
    `- Load: ${formatNumber(e.loadTarget)} events/s = 1 × peak; stress: ${formatNumber(e.stressTarget)} events/s = ${formatNumber(e.headroom)} × peak (to be confirmed).`,
    `- Breaking points: each service should hold at least ${formatNumber(e.breakpointTarget)}/s (${formatNumber(e.headroom)} × peak); Step SLA in alarms/s against ${formatNumber(e.stepSlaPeakAlarmRate)} alarms/s at peak (STEP_SLA_PEAK_ALARM_RATE).`,
    '- Rules per service: see each run report (thresholds marked "to be confirmed" are not agreed yet).',
  );

  lines.push('', '## 2. Load', '');
  lines.push(
    markdownTable(
      ['Service', 'Through', 'Sent', 'In', 'Average rate', 'Result', 'Notes'],
      summary.services.map((s) => {
        const run = s.load;
        return [
          s.displayName,
          throughCell(run),
          sentCell(run),
          run ? formatSeconds(run.throughSeconds ?? run.measuredSeconds) : NOT_AVAILABLE,
          run && typeof run.averageRate === 'number'
            ? `${formatNumber(run.averageRate)}/s (target ${formatNumber(run.targetRate)}/s)`
            : NOT_AVAILABLE,
          statusCell(run),
          run ? (run.status === 'passed' ? '' : run.statusReason) : '',
        ];
      }),
    ),
  );

  lines.push('', '## 3. Stress', '');
  lines.push(
    markdownTable(
      ['Service', 'Through', 'Sent', 'Started breaking', 'What broke', 'Result'],
      summary.services.map((s) => {
        const run = s.stress;
        const when = run?.startedBreakingAt
          ? `${formatClock(run.startedBreakingAt)} (${formatSeconds(run.secondsIntoMeasure)} in)`
          : run
            ? 'did not break'
            : NOT_AVAILABLE;
        return [
          s.displayName,
          throughCell(run),
          sentCell(run),
          when,
          run?.whatBroke.length ? run.whatBroke.join('; ') : run ? 'nothing' : NOT_AVAILABLE,
          statusCell(run),
        ];
      }),
    ),
  );

  lines.push('', '## 4. Breaking points', '');
  lines.push(
    markdownTable(
      ['Service', 'Held up to', 'Broke at', 'When', '× peak', 'Vs expected'],
      summary.services.map((s) => {
        const run = s.breakpoint;
        if (!run)
          return [
            s.displayName,
            'not run',
            NOT_AVAILABLE,
            NOT_AVAILABLE,
            NOT_AVAILABLE,
            NOT_AVAILABLE,
          ];
        // Step SLA rates are alarms/s: compare with the Step SLA peak alarm rate, never the events/s peak.
        const peak = s.subject === 'step-sla' ? run.stepSlaPeakAlarmRate : run.peakRate;
        const target =
          s.subject === 'step-sla' && typeof peak === 'number' && typeof e.headroom === 'number'
            ? peak * e.headroom
            : run.targetRate;
        if (s.capacity?.kind === 'drain-rate') {
          return [
            s.displayName,
            `drain rate ${formatNumber(run.drainRate)} ${run.unit}/s`,
            NOT_AVAILABLE,
            run.startedBreakingAt ? formatClock(run.startedBreakingAt) : NOT_AVAILABLE,
            timesPeak(run.drainRate, peak),
            versusTarget(run.drainRate, target),
          ];
        }
        const held = run.k6Limited
          ? `at least ${formatNumber(run.heldUpTo ?? run.brokeAtRate)}/s (k6 limit)`
          : run.heldUpTo === null
            ? 'no level held'
            : `${formatNumber(run.heldUpTo)}/s`;
        return [
          s.displayName,
          held,
          run.brokeAtRate === null ? 'did not break' : `${formatNumber(run.brokeAtRate)}/s`,
          run.startedBreakingAt ? formatClock(run.startedBreakingAt) : NOT_AVAILABLE,
          timesPeak(run.heldUpTo, peak),
          versusTarget(run.heldUpTo, target),
        ];
      }),
    ),
  );

  const flow = summary.wholeFlow;
  lines.push('', '## 5. Whole flow', '');
  if (flow.weakestLink) {
    const w = flow.weakestLink;
    lines.push(
      `Weakest link: ${displayName(w.subject)} at ${w.atLeast ? 'at least ' : ''}${formatNumber(w.rate)} events/s (${formatNumber(w.multipleOfPeak, 1)} × peak) — ${capacityVerdict(w.rate, e.breakpointTarget, flow.failedRuns ?? [], true)}.`,
    );
  } else {
    lines.push('Weakest link: not known yet (needs the collector and matcher breakpoint runs).');
    if (flow.failedRuns?.some((f) => f.belowExpectation)) {
      lines.push(`Below expectation: ${failedRunsText(flow.failedRuns, true)}.`);
    }
  }
  lines.push(flow.note);

  lines.push('', '## 6. Data correctness', '');
  lines.push(
    summary.dataCorrectness.allRequiredPassed
      ? 'Every required data check passed (sent = stored = processed = enrolled).'
      : `Required data checks FAILED: ${summary.dataCorrectness.failed.join('; ')}.`,
  );

  const b = summary.bottomLine;
  lines.push('', '## 7. Bottom line', '');
  lines.push(
    `- Load passed ${b.load.passed}/${b.load.total}; stress passed ${b.stress.passed}/${b.stress.total}; breakpoint runs ${b.breakpoint.total}.`,
  );
  for (const cap of b.capacity) {
    lines.push(
      `- ${displayName(cap.subject)}: ${cap.atLeast ? 'at least ' : ''}${formatNumber(cap.rate)} ${cap.unit} (${cap.kind}) — ${capacityVerdict(cap.rate, cap.target, cap.failedRuns ?? [])}.`,
    );
  }
  lines.push(
    b.baselineWorse.length
      ? `- Worse than baseline: ${b.baselineWorse.join(', ')}.`
      : '- Baselines: no metric worse than its baseline (or none compared).',
  );

  lines.push('', '## 8. Conditions', '');
  const c = summary.conditions ?? {};
  lines.push(
    `Environment ${c.environment ?? NOT_AVAILABLE}; host ${c.host ?? NOT_AVAILABLE}; k6 image ${c.k6Image ?? NOT_AVAILABLE}; plan-definition set ${c.planDefinitionSet ?? NOT_AVAILABLE}; dataset ${c.dataset ?? NOT_AVAILABLE}; suite commit ${c.suiteCommit ?? NOT_AVAILABLE}.`,
  );
  if (summary.conditionsDiffer.length) {
    lines.push('', 'WARNING: the runs were not measured under the same conditions:');
    for (const warning of summary.conditionsDiffer) lines.push(`- ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reads the folders, builds the summary and writes summary.json + summary.md into `out`.
 * Why: the one entry point of `report --series`.
 * @param {{dirs:string[], out:string, root?:string, now?:Date}} input
 * @returns {{summary:object, markdown:string, files:{json:string, markdown:string}}}
 */
export function writeSeriesReport({ dirs, out, root, now = new Date() }) {
  const { entries, ignored } = readSeriesEntries(dirs);
  const summary = buildSeriesSummary(entries, { root, now, ignored });
  const markdown = renderSeriesReport(summary);
  fs.mkdirSync(out, { recursive: true });
  const jsonFile = path.join(out, 'summary.json');
  const markdownFile = path.join(out, 'summary.md');
  // eslint-disable-next-line no-unused-vars
  const { $comment, ...body } = summary;
  writeGeneratedJson(jsonFile, SUMMARY_COMMENT, body);
  fs.writeFileSync(markdownFile, markdown);
  return { summary, markdown, files: { json: jsonFile, markdown: markdownFile } };
}
