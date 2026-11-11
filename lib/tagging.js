/**
 * tagging.js — labels everything an iteration records with its phase, staircase level and window (K6)
 *
 * What:    k6 metrics can carry tags. We tag each iteration's requests and checks with:
 *            phase  = smoke | warm-up | measure
 *            level  = the staircase rate, e.g. 800 (breakpoint staircase only)
 *            window = the report window index, e.g. 3 (measured phase only)
 *          so thresholds and the summary have numbers per level and per window (plan §4.2, §6.9).
 *          This generalises v1's tagLevel() (the first version's lib/breakpoint.js).
 * How:     First line of every iteration:  const tag = tagIteration(context);
 *          then use tag.phaseIndex for the patient id (lib/test-data.js).
 * Needs:   k6 (k6/execution); the run context's phasePlan (lib/run-context.js).
 * Outputs: Sets exec.vu.metrics.tags; returns { phaseIndex, phase, level, window }.
 */

import exec from 'k6/execution';
import { levelAt, windowIndexAt } from './windows.js';

/** Small margin so an iteration started exactly at a phase's end still counts as inside it. */
const EDGE_SECONDS = 1e-3;

/**
 * Tags the current iteration and says which phase, level and window it belongs to.
 * Why: per-level and per-window thresholds only see requests tagged this way. The moment is measured
 * from the scenario's own start: elapsed = (now − scenario start) + phase.startSeconds, i.e. seconds
 * since the k6 start, the same clock as the phase plan (k6 clock contract, lib/README.md).
 * @param {object} context run context with phasePlan
 * @returns {{phaseIndex:number, phase:string|null, level:number|null, window:number|null}}
 */
export function tagIteration(context) {
  const tags = exec.vu.metrics.tags;
  const plan = context.phasePlan;
  // Scenario names are phase names (lib/scenarios.js), so the scenario tells the phase directly.
  const phaseIndex = plan.phases.findIndex((phase) => phase.name === exec.scenario.name);
  if (phaseIndex < 0) {
    // Not a load scenario (e.g. a helper scenario): clear tags a reused VU may still carry.
    delete tags.level;
    delete tags.window;
    return { phaseIndex: -1, phase: null, level: null, window: null };
  }
  const phase = plan.phases[phaseIndex];
  const sinceScenarioStart = (Date.now() - exec.scenario.startTime) / 1000;
  // Clamp into the phase: an iteration k6 started late (busy VU) still belongs to this phase.
  const elapsed = Math.min(
    Math.max(sinceScenarioStart + phase.startSeconds, phase.startSeconds),
    phase.startSeconds + phase.durationSeconds - EDGE_SECONDS,
  );
  tags.phase = phase.name;

  const level = phase.kind === 'staircase' ? levelAt(plan, elapsed) : null;
  if (level === null) delete tags.level;
  else tags.level = String(level);

  const window = phase.name === plan.measuredPhase ? windowIndexAt(plan, elapsed) : null;
  if (window === null) delete tags.window;
  else tags.window = String(window);

  return { phaseIndex, phase: phase.name, level, window };
}
