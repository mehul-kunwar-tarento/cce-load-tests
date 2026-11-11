/**
 * run-report.mjs — turns ONE result.json into the concise run report (report.md and console), plan §8.1.
 *
 * What:    The team lead's first review point (R1): after every test, a short report that someone who
 *          was not there can read — expectation vs result, how many events went through the service in
 *          the measured interval (accepted / processed / handled, not just sent; core/events-through.mjs)
 *          and at what rate, every pass/fail rule, when the service started breaking and what
 *          broke, whether it caught up, the staircase levels, data checks, dropped iterations and the
 *          conditions of the run. It reads result.json ONLY (never logs, text or Markdown), so the
 *          numbers in the report are exactly the numbers saved for baselines and series reports.
 *          Diagnostics (service metrics such as DB-pool waits) are labelled "(diagnostic)": they explain,
 *          they never decide.
 * How:     import { renderRunReport } from './run-report.mjs';
 *          const markdown = renderRunReport(result); — CLI: node tools/cli.mjs report results/<dir>
 * Needs:   A result.json object (plan §5.2), already checked with validateResult.
 * Outputs: Markdown text (the caller writes report.md and prints it).
 */
import {
  NOT_AVAILABLE,
  formatBytes,
  formatClock,
  formatDate,
  formatNumber,
  formatPercent,
  formatRate,
  formatSeconds,
  markdownTable,
} from '../core/format.mjs';
import { throughOf, throughWords } from '../core/events-through.mjs';

/** Display names of the known subjects (others are title-cased from the subject). */
const DISPLAY_NAMES = { collector: 'Collector', matcher: 'Matcher', 'step-sla': 'Step SLA' };

/**
 * Human name of a subject, e.g. 'step-sla' → 'Step SLA'.
 * Why: reports are read by people; later modules (adaptors) get a readable name without a table entry.
 * @param {string} subject
 * @returns {string}
 */
export function displayName(subject) {
  if (DISPLAY_NAMES[subject]) return DISPLAY_NAMES[subject];
  return String(subject ?? 'unknown')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Value of a saved setting ({NAME: {value, source}}), or null; why: reports quote the limits in force. */
export function settingValue(result, name) {
  return result?.conditions?.settings?.[name]?.value ?? null;
}

/** "×4" style multiple of the peak, or n/a; why: every rate in a report is related to the expected peak. */
export function timesPeak(rate, peak) {
  if (typeof rate !== 'number' || typeof peak !== 'number' || peak <= 0) return NOT_AVAILABLE;
  return `${formatNumber(rate / peak, 1)}× peak`;
}

/**
 * A number with its unit for the thresholds table (ms, ratio as %, counts with separators).
 * Why: "500 ms", "1%" and "1,000 events" read better than raw numbers.
 * @param {number|null} value
 * @param {string} unit
 */
function withUnit(value, unit) {
  if (value === null || value === undefined) return NOT_AVAILABLE;
  if (typeof value !== 'number') return String(value);
  if (unit === 'ratio') return formatPercent(value);
  if (unit === 'ms') return `${formatNumber(value)} ms`;
  if (unit === 's' || unit === 'seconds') return formatSeconds(value);
  if (unit === 'events/s' || unit === 'alarms/s') return `${formatNumber(value)}/s`;
  return unit && unit !== 'count' ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}

/** The status word of the header; why: one place maps statuses to the words people scan for. */
function statusWord(status) {
  return String(status ?? 'error').toUpperCase();
}

/**
 * Header lines: title, run line with environment, set, clock times and duration.
 * Why: the first two lines must say what ran, where, when and how it ended.
 */
function renderHeader(result) {
  const env = result.conditions?.environment?.name ?? NOT_AVAILABLE;
  const set = result.conditions?.planDefinitionSet;
  const setText = set
    ? `plan-definition set ${set.name}${typeof set.fanOut === 'number' ? ` (${set.fanOut} plan definition${set.fanOut === 1 ? '' : 's'})` : ''}`
    : 'no plan-definition set recorded';
  const when = `${formatDate(result.startedAt)} ${formatClock(result.startedAt)}–${formatClock(result.endedAt)}`;
  return [
    `# ${displayName(result.subject)} ${result.testType} — ${statusWord(result.status)}`,
    '',
    `Run ${result.runId} · ${env} · ${setText} · ${when} (${formatSeconds(result.durationSeconds)})`,
    '',
    `> ${result.statusReason}`,
  ];
}

/**
 * "X events went through (<basis>) in Y (average Z/s …). <sent> sent …" for the result line.
 * Why: R1.1 — how much load went through the SERVICE in the configured interval and at what rate
 *      (warm-up excluded). "Went through" is what the service took (events-through.mjs): accepted (HTTP
 *      2xx), processed (Kafka, incl. the catch-up) or handled (seeded alarms); what k6 sent is the
 *      secondary figure. A storm (the Step SLA breakpoint: every seeded alarm rings at the same moment)
 *      has no sending interval (measuredSeconds 0), so it says "rang at once; all handled in <catch-up>".
 */
function loadSentence(result) {
  const load = result.load ?? {};
  const unit = load.unit ?? 'events';
  const t = throughOf(result);
  if (t.eventsThrough === null || t.eventsThrough === undefined) {
    return `No ${unit} count available (the load did not run or produced no summary).`;
  }
  const sentMeasured = load.measuredEventsSent ?? load.eventsSent ?? null;
  // measuredSeconds 0 = everything at once (storm): an interval of "0s" would read as nothing went through.
  const atOnce = load.measuredSeconds === 0;
  let main;
  if (atOnce) {
    main = `${formatNumber(sentMeasured ?? t.eventsThrough)} ${unit} ${stormOutcome(result.breaking ?? {}, unit)}`;
  } else {
    let interval = '';
    if (typeof t.throughSeconds === 'number') {
      const catchUp =
        typeof load.measuredSeconds === 'number' ? t.throughSeconds - load.measuredSeconds : 0;
      interval =
        catchUp > 0
          ? ` in ${formatSeconds(t.throughSeconds)}: ${formatSeconds(load.measuredSeconds)} of sending + ${formatSeconds(catchUp)} of catch-up`
          : ` in ${formatSeconds(t.throughSeconds)}`;
    }
    main = `${formatNumber(t.eventsThrough)} ${unit} went through (${throughWords(t.throughBasis, unit)})${interval}`;
  }
  const details = [];
  if (typeof t.averageRate === 'number') details.push(`average ${formatRate(t.averageRate)}`);
  if (result.phases?.some((phase) => phase.name === 'warm-up')) details.push('warm-up excluded');
  if (typeof load.targetRate === 'number') details.push(`target ${formatRate(load.targetRate)}`);
  let sentence = `${main}${details.length ? ` (${details.join(', ')})` : ''}.`;
  // Secondary figures: what was sent, and the service's own count over all phases.
  const extra = [];
  if (!atOnce && t.throughBasis !== 'sent' && typeof sentMeasured === 'number') {
    const notAccepted =
      t.throughBasis === 'accepted' && sentMeasured > t.eventsThrough
        ? ` (${formatNumber(sentMeasured - t.eventsThrough)} not accepted)`
        : '';
    extra.push(`${formatNumber(sentMeasured)} sent in the measured interval${notAccepted}`);
  }
  if (typeof load.eventsSent === 'number' && load.eventsSent !== sentMeasured) {
    extra.push(`${formatNumber(load.eventsSent)} sent in all phases`);
  }
  if (typeof load.eventsProcessed === 'number' && load.eventsProcessed !== t.eventsThrough) {
    extra.push(`${formatNumber(load.eventsProcessed)} processed by the service in all phases`);
  }
  if (
    !atOnce &&
    ['processed', 'handled'].includes(t.throughBasis) &&
    result.breaking?.caughtUp === false &&
    typeof result.breaking.remainingBacklog === 'number'
  ) {
    extra.push(`${formatNumber(result.breaking.remainingBacklog)} still waiting`);
  }
  if (extra.length) sentence += ` ${extra.join('; ')}.`;
  return sentence;
}

/**
 * "rang at once; all handled in 2m 1s" (or "… not all handled: N still waiting after T") for a storm.
 * Why: the storm's interval is the time the service needed to handle everything, not a sending time.
 */
function stormOutcome(breaking, unit) {
  if (breaking.caughtUp === true && typeof breaking.catchUpSeconds === 'number') {
    return `rang at once; all handled in ${formatSeconds(breaking.catchUpSeconds)}`;
  }
  if (breaking.caughtUp === false) {
    return `rang at once; not all handled: ${formatNumber(breaking.remainingBacklog)} ${unit} still waiting after ${formatSeconds(breaking.gaveUpAfterSeconds)}`;
  }
  return 'rang at once';
}

/** Expectation vs result section (R1.3). */
function renderExpectation(result) {
  const expectation = result.expectation ?? {};
  const tbc = expectation.toBeConfirmed ? ' (to be confirmed from UAT/Dev data)' : '';
  // statusReason may already start with "Failed: …"; the status word is said once.
  const reason = String(result.statusReason ?? '').replace(
    /^(passed|failed|aborted|error)\s*:\s*/i,
    '',
  );
  let verdict = `${statusWord(result.status)}: ${reason}`;
  if (result.breaking?.k6Limited) {
    verdict += ' The service was not the limit: the load generator (k6) could not send faster.';
  }
  return [
    '## Expectation vs result',
    '',
    `Expected: ${expectation.summary ?? 'no expectation recorded'}${tbc}`,
    '',
    `Result: ${loadSentence(result)} ${verdict}`,
  ];
}

/** Thresholds section: one row per rule with limit, actual and result (TBC marked). */
function renderThresholds(result) {
  // Per-level rules of a staircase are shown in the levels table instead (one row per level).
  const isLevelRule = (threshold) =>
    threshold.informational && /[{,]level:/.test(threshold.metric ?? '');
  const levelRules = (result.thresholds ?? []).filter(isLevelRule);
  const rows = (result.thresholds ?? [])
    .filter((t) => !isLevelRule(t))
    .map((threshold) => [
      `${threshold.description}${threshold.toBeConfirmed ? ' (to be confirmed)' : ''}${
        threshold.informational && !/not a verdict/.test(threshold.description)
          ? ' (informational)'
          : ''
      }`,
      withUnit(threshold.limit, threshold.unit),
      withUnit(threshold.actual, threshold.unit),
      threshold.passed ? 'passed' : threshold.informational ? 'noted' : 'FAILED',
    ]);
  if (!rows.length) return ['## Thresholds', '', 'No pass/fail rules were evaluated.'];
  const lines = ['## Thresholds', '', markdownTable(['Rule', 'Limit', 'Actual', 'Result'], rows)];
  if (levelRules.length) {
    lines.push(
      '',
      `${levelRules.length} per-level rules (p95, errors, checks per staircase level) find the breaking point; see the levels table.`,
    );
  }
  return lines;
}

/** True when the report must explain breaking (stress, breakpoint, failed/aborted or anything broke). */
function needsBreakingSection(result) {
  return (
    ['stress', 'breakpoint'].includes(result.testType) ||
    ['failed', 'aborted'].includes(result.status) ||
    Boolean(result.breaking?.broke)
  );
}

/**
 * The breakpoint line: held up to / broke at vs expected, or the drain rate for queue services.
 * Why: plan §8.1 — "held up to X/s, broke at Y/s (× peak) — expected ≥ T/s: above | below (short by N/s)".
 */
function breakpointLine(result) {
  const breaking = result.breaking ?? {};
  const peak = result.expectation?.peakRate ?? settingValue(result, 'PEAK_RATE');
  const target = result.expectation?.targetRate;
  const unit = result.load?.unit === 'alarms' ? 'alarms' : 'events';
  const versus = (rate) => {
    if (typeof target !== 'number' || typeof rate !== 'number') return '';
    return rate >= target
      ? ` — expected ≥ ${formatNumber(target)}/s: above`
      : ` — expected ≥ ${formatNumber(target)}/s: below (short by ${formatNumber(target - rate)}/s)`;
  };
  if (breaking.heldUpTo !== null || breaking.brokeAtRate !== null) {
    if (breaking.k6Limited) {
      const atLeast = breaking.heldUpTo ?? breaking.brokeAtRate;
      return `Breakpoint: at least ${formatNumber(atLeast)}/s (k6 limit: the load generator, not the service, stopped the climb)${versus(atLeast)}.`;
    }
    const held =
      breaking.heldUpTo === null
        ? 'held no level'
        : `held up to ${formatNumber(breaking.heldUpTo)}/s (${timesPeak(breaking.heldUpTo, peak)})`;
    const broke =
      breaking.brokeAtRate === null
        ? 'never broke (raise LEVELS to find the limit)'
        : `broke at ${formatNumber(breaking.brokeAtRate)}/s (${timesPeak(breaking.brokeAtRate, peak)})`;
    return `Breakpoint: ${held}, ${broke}${versus(breaking.heldUpTo ?? 0)}.`;
  }
  if (typeof breaking.drainRate === 'number') {
    return `Breakpoint: drain rate ${formatNumber(breaking.drainRate)} ${unit}/s (${timesPeak(breaking.drainRate, peak)})${versus(breaking.drainRate)}.`;
  }
  return null;
}

/** Levels table of a staircase: level · × peak · sent · planned · p95 · errors · result. */
function renderLevels(result) {
  if (!Array.isArray(result.levels) || !result.levels.length) return [];
  const peak = result.expectation?.peakRate ?? settingValue(result, 'PEAK_RATE');
  const rows = result.levels.map((level) => [
    `${formatNumber(level.rate)}/s`,
    timesPeak(level.rate, peak),
    formatNumber(level.requests),
    formatNumber(level.plannedEvents),
    level.p95Ms === null ? NOT_AVAILABLE : `${formatNumber(level.p95Ms)} ms`,
    formatPercent(level.failedRate),
    `${level.result}${level.reasons?.length ? `: ${level.reasons.join('; ')}` : ''}`,
  ]);
  return [
    '',
    markdownTable(['Level', '× peak', 'Sent', 'Planned', 'p95', 'Errors', 'Result'], rows),
  ];
}

/** "When it started breaking" section (R1.2). */
function renderBreaking(result) {
  if (!needsBreakingSection(result)) return [];
  const breaking = result.breaking ?? {};
  const lines = ['## When it started breaking', ''];
  if (breaking.startedBreakingAt) {
    const into =
      typeof breaking.secondsIntoMeasure === 'number'
        ? ` (${formatSeconds(breaking.secondsIntoMeasure)} into the measured phase)`
        : '';
    const rate =
      typeof breaking.rateAtBreak === 'number' ? ` at ${formatNumber(breaking.rateAtBreak)}/s` : '';
    lines.push(`Started breaking at ${formatClock(breaking.startedBreakingAt)}${into}${rate}.`);
  } else {
    lines.push(
      breaking.broke
        ? 'The run failed, but no moment of breaking could be placed in the measured phase.'
        : 'It did not break during the measured phase.',
    );
  }
  const whatBroke = breaking.whatBroke ?? [];
  if (whatBroke.length) {
    lines.push('', 'What broke:');
    for (const item of whatBroke) {
      // Service-metric entries explain the break; they never decide the verdict.
      const diagnostic =
        item.source === 'service-metrics' && !/diagnostic/.test(item.description)
          ? ' (diagnostic)'
          : '';
      lines.push(`- ${item.description}${diagnostic}`);
    }
  }
  if (breaking.caughtUp === true) {
    lines.push(
      '',
      `Caught up: yes, ${formatSeconds(breaking.catchUpSeconds)} after sending stopped.`,
    );
  } else if (breaking.caughtUp === false) {
    // Never a catch-up time when it did not catch up (fixes the v1 give-up bug, D19).
    lines.push(
      '',
      `Caught up: no — ${formatNumber(breaking.remainingBacklog)} ${result.load?.unit ?? 'events'} still waiting after ${formatSeconds(
        breaking.gaveUpAfterSeconds,
      )}.`,
    );
  }
  if (result.testType === 'breakpoint') {
    const line = breakpointLine(result);
    if (line) lines.push('', line);
  }
  lines.push(...renderLevels(result));
  return lines;
}

/** Data checks table (sent vs stored vs processed). */
function renderDataChecks(result) {
  const checks = result.dataChecks ?? [];
  if (!checks.length) return ['## Data checks', '', 'No data checks ran.'];
  const rows = checks.map((check) => [
    `${check.description} (${check.id})${check.severity === 'info' ? ' — info' : ''}`,
    `${check.comparison} ${formatNumber(check.expected)}`,
    formatNumber(check.actual),
    check.passed ? 'passed' : check.severity === 'info' ? 'noted' : 'FAILED',
  ]);
  return ['## Data checks', '', markdownTable(['Check', 'Expected', 'Actual', 'Result'], rows)];
}

/** Dropped iterations section (D9): exact count, share, allowed and whether it decided the verdict. */
function renderDropped(result) {
  const load = result.load ?? {};
  if (load.eventsDropped === null || load.eventsDropped === undefined) {
    return ['## Dropped iterations', '', 'Not applicable (no k6 load generator in this test).'];
  }
  const maxRate = settingValue(result, 'MAX_DROPPED_RATE');
  const within = load.droppedAllowed === null || load.eventsDropped <= load.droppedAllowed;
  const allowed =
    typeof maxRate === 'number'
      ? `allowed ≤ ${formatPercent(maxRate)} = ${formatNumber(load.droppedAllowed)}`
      : `allowed ${formatNumber(load.droppedAllowed)}`;
  return [
    '## Dropped iterations',
    '',
    `${formatNumber(load.eventsDropped)} of ${formatNumber(load.plannedEvents)} (${formatPercent(
      load.droppedRate,
    )}, ${allowed}) — ${within ? 'within the rule' : 'broke the rule'}.` +
      (load.eventsDropped > 0 && result.breaking?.k6Limited
        ? ' The service answered fast: k6 could not send on time (k6 limit).'
        : ''),
  ];
}

/** Settings that differ from their defaults (env file, env var, --refine-from or --set). */
function changedSettings(result) {
  return Object.entries(result.conditions?.settings ?? {})
    .filter(([, entry]) => ['environment', 'env-var', 'refine-from', 'cli'].includes(entry?.source))
    .map(
      ([name, entry]) =>
        `${name}=${Array.isArray(entry.value) ? entry.value.join(',') : entry.value} (${entry.source})`,
    );
}

/** Conditions section: environment, host, commit, plan definitions, dataset, data volume, settings, preflight. */
function renderConditions(result) {
  const c = result.conditions ?? {};
  const lines = ['## Conditions', ''];
  const env = c.environment;
  if (env)
    lines.push(
      `- Environment: ${env.name} (${env.kind})${env.configFile ? `, ${env.configFile}` : ''}`,
    );
  const host = c.host;
  if (host) {
    lines.push(
      `- Host: ${host.hostname ?? NOT_AVAILABLE}, ${host.cpus ?? NOT_AVAILABLE} CPUs, ${formatNumber(host.memoryGb)} GB, ${host.os ?? ''}; k6 image ${host.k6Image ?? NOT_AVAILABLE}`,
    );
  }
  if (c.suite) {
    lines.push(
      `- Suite commit: ${c.suite.gitCommit ?? 'unknown'}${c.suite.gitDirty ? ' (with uncommitted changes)' : ''}`,
    );
  }
  const set = c.planDefinitionSet;
  if (set) {
    lines.push(
      `- Plan-definition set: ${set.name}, fan-out ${formatNumber(set.fanOut)}, effective fan-out ${formatNumber(set.effectiveFanOut)}`,
    );
    for (const pd of set.planDefinitions ?? []) {
      lines.push(
        `  - ${pd.canonical} — ${pd.status ?? 'status not checked'}, ${(pd.mandatorySteps ?? []).length} mandatory step(s)`,
      );
    }
    const others = set.otherActivePlanDefinitions ?? [];
    lines.push(
      others.length
        ? `- Other ACTIVE plan definitions: ${others.map((o) => `${o.canonical}${o.matchesDatasetEvents ? ' (matches test events)' : o.note ? ` (${o.note})` : ''}`).join(', ')}`
        : '- Other ACTIVE plan definitions: none recorded',
    );
    if (set.stepSlaSeedMode) lines.push(`- Step SLA seed mode: ${set.stepSlaSeedMode}`);
  }
  if (c.dataset) {
    lines.push(
      `- Dataset: ${c.dataset.name}, source ${c.dataset.source ?? NOT_AVAILABLE}, facility ${c.dataset.facilityId ?? NOT_AVAILABLE}, action ${c.dataset.actionId ?? NOT_AVAILABLE}`,
    );
  }
  if (c.dataVolume) {
    const rows = Object.entries(c.dataVolume.rows ?? {})
      .map(([table, count]) => `${table} ${formatNumber(count)}`)
      .join(', ');
    lines.push(
      `- Data volume at start: database ${formatBytes(c.dataVolume.dbSizeBytes)}${rows ? `; rows: ${rows}` : ''}`,
    );
  }
  const changed = changedSettings(result);
  lines.push(`- Settings changed from defaults: ${changed.length ? changed.join(', ') : 'none'}`);
  if (c.preflight) {
    const warnings = c.preflight.warnings ?? [];
    lines.push(
      `- Preflight: ${c.preflight.skipped ? 'SKIPPED (SKIP_PREFLIGHT=true)' : c.preflight.status}${warnings.length ? `; warnings: ${warnings.join('; ')}` : ''}`,
    );
  }
  if (c.note) lines.push(`- Note: ${c.note}`);
  return lines;
}

/** Baseline comparison table (when the run was compared with a baseline). */
export function renderBaselineSection(comparison) {
  if (!comparison) return [];
  const rows = (comparison.rows ?? []).map((row) => [
    row.label ?? row.key,
    row.baseline === null
      ? NOT_AVAILABLE
      : `${withUnit(row.baseline, row.unit)}${row.baselineRuns ? ` (mean of ${row.baselineRuns})` : ''}`,
    row.note ?? withUnit(row.current, row.unit),
    row.deltaPercent === null || row.deltaPercent === undefined
      ? NOT_AVAILABLE
      : `${formatNumber(row.deltaPercent, 1)}%`,
    row.verdict,
  ]);
  const lines = [
    '## Baseline comparison',
    '',
    `Baseline ${comparison.baseline}${comparison.provisional ? ' (PROVISIONAL: fewer runs than required)' : ''}, tolerance ±${formatNumber(comparison.tolerance)}% (informational: never changes the verdict).`,
    '',
    markdownTable(['Metric', 'Baseline', 'This run', 'Change', 'Verdict'], rows),
  ];
  if (comparison.warnings?.length) {
    lines.push('', 'Conditions differ from the baseline:');
    for (const warning of comparison.warnings) lines.push(`- ${warning}`);
  }
  return lines;
}

/**
 * Renders the whole report (plan §8.1 section order).
 * Why: the one function behind report.md, the console summary after a run and `report <dir>`.
 * @param {object} result result.json
 * @param {{baselineComparison?: object|null}} [options] a comparison read from baseline-comparison.json
 * @returns {string} Markdown
 */
export function renderRunReport(result, { baselineComparison = null } = {}) {
  const sections = [
    renderHeader(result),
    renderExpectation(result),
    renderThresholds(result),
    renderBreaking(result),
    renderDataChecks(result),
    renderDropped(result),
    renderConditions(result),
    renderBaselineSection(result.baselineComparison ?? baselineComparison),
  ];
  const notes = [
    ...(result.warnings ?? []).map((w) => `- Warning: ${w}`),
    ...(result.notes ?? []).map((n) => `- ${n}`),
  ];
  if (notes.length) sections.push(['## Notes', '', ...notes]);
  return `${sections
    .filter((lines) => lines.length)
    .map((lines) => lines.join('\n'))
    .join('\n\n')}\n`;
}
