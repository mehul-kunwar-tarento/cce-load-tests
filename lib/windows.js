/**
 * windows.js — which report window and which staircase level a moment of the test belongs to (PURE)
 *
 * What:    The measured phase is cut into equal "report windows" (e.g. 10 s each). k6 tags every
 *          request with its window number, so the summary has numbers per window and the report can say
 *          "it started breaking 31 s into the measured phase". For staircases, each request is also
 *          tagged with its level (e.g. 800/s). These helpers do the arithmetic for k6 and for Node.
 * How:     import { windowIndexAt, levelAt, windowBounds } from '../lib/windows.js';
 * Needs:   A PhasePlan from lib/phase-plan.js (windowSeconds, windowCount, phases).
 * Outputs: Window indexes (0-based), level rates, window start/end seconds.
 */

import { measuredPhaseOf } from './phase-plan.js';

/**
 * How many seconds the windows cover: the measured phase, or for a 0-second phase (Step SLA storm) the
 * catch-up period the windows were sized for.
 * Why: a storm rings everything at once; what matters is how the backlog drains afterwards.
 * @param {import('./phase-plan.js').PhasePlan} phasePlan
 * @returns {number}
 */
export function windowCoverSeconds(phasePlan) {
  const measured = measuredPhaseOf(phasePlan);
  return measured.durationSeconds > 0
    ? measured.durationSeconds
    : phasePlan.windowCount * phasePlan.windowSeconds;
}

/**
 * Index of the report window running at a moment, or null outside the measured phase.
 * Why: k6 tags each iteration with it (lib/tagging.js); Node maps watcher samples onto the same windows.
 * @param {import('./phase-plan.js').PhasePlan} phasePlan
 * @param {number} elapsedSeconds seconds since the k6 start (end of setup())
 * @returns {number|null}
 */
export function windowIndexAt(phasePlan, elapsedSeconds) {
  const measured = measuredPhaseOf(phasePlan);
  const intoMeasure = elapsedSeconds - measured.startSeconds;
  if (intoMeasure < 0 || intoMeasure >= windowCoverSeconds(phasePlan)) return null;
  // Clamp: the last window may be shorter than windowSeconds, but it is still the last window.
  return Math.min(Math.floor(intoMeasure / phasePlan.windowSeconds), phasePlan.windowCount - 1);
}

/**
 * Rate of the staircase level running at a moment (e.g. 800), or null when no staircase level runs.
 * Why: per-level thresholds ("held 1600/s, broke at 3200/s") need every request tagged with its level.
 * @param {import('./phase-plan.js').PhasePlan} phasePlan
 * @param {number} elapsedSeconds seconds since the k6 start
 * @returns {number|null}
 */
export function levelAt(phasePlan, elapsedSeconds) {
  const measured = measuredPhaseOf(phasePlan);
  if (measured.kind !== 'staircase') return null;
  const level = measured.levels.find(
    (l) => elapsedSeconds >= l.startSeconds && elapsedSeconds < l.startSeconds + l.durationSeconds,
  );
  return level ? level.rate : null;
}

/**
 * Start and end of one report window.
 * Why: the report turns "window 3" into "from 30 s to 40 s into the measured phase" and, with the
 * measured-phase start time, into a clock time.
 * @param {import('./phase-plan.js').PhasePlan} phasePlan
 * @param {number} index 0-based window index
 * @returns {{startSeconds:number, endSeconds:number, absoluteStartSeconds:number, absoluteEndSeconds:number}}
 *   startSeconds/endSeconds: since the measured phase started; absolute*: since the k6 start.
 */
export function windowBounds(phasePlan, index) {
  if (!Number.isInteger(index) || index < 0 || index >= phasePlan.windowCount) {
    throw new Error(
      `Window ${index} does not exist (this plan has ${phasePlan.windowCount} windows)`,
    );
  }
  const measured = measuredPhaseOf(phasePlan);
  const startSeconds = index * phasePlan.windowSeconds;
  // The last window ends with the measured phase, even if that makes it shorter.
  const endSeconds = Math.min(
    startSeconds + phasePlan.windowSeconds,
    windowCoverSeconds(phasePlan),
  );
  return {
    startSeconds,
    endSeconds,
    absoluteStartSeconds: measured.startSeconds + startSeconds,
    absoluteEndSeconds: measured.startSeconds + endSeconds,
  };
}
