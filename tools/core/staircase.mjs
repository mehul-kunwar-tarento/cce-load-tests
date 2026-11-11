/**
 * staircase.mjs — finer staircase levels between "held" and "broke" (plan §6.2 --refine-from, §6.9).
 *
 * What:    A breakpoint staircase doubles the rate (200, 400, 800, …), so it says "held 400/s, broke at
 *          800/s". A second run with finer levels between the two narrows it down. That run warms up at
 *          the last good level (D11): v1 restarted the fine staircase cold, which made it break early.
 * How:     import { computeFineLevels, refineFromResult } from './staircase.mjs';
 *          computeFineLevels(400, 800) → [500, 600, 700]
 * Needs:   A breakpoint result.json with breaking.heldUpTo and breaking.brokeAtRate.
 * Outputs: Level lists and the settings overrides for the refined run.
 */
import { RefusedError } from './errors.mjs';

/**
 * Levels strictly between a good and a bad rate.
 * Why: step = max(50, floor((bad − good) / 4 / 50) × 50): about four levels, in round steps of 50.
 * @param {number} good highest rate that held
 * @param {number} bad lowest rate that broke
 * @returns {number[]}
 */
export function computeFineLevels(good, bad) {
  if (!(Number.isFinite(good) && Number.isFinite(bad) && bad > good && good >= 0)) {
    throw new RefusedError(`Cannot refine between ${good}/s and ${bad}/s: need held < broke`);
  }
  const step = Math.max(50, Math.floor((bad - good) / 4 / 50) * 50);
  const levels = [];
  for (let rate = good + step; rate < bad; rate += step) levels.push(rate);
  return levels;
}

/**
 * Settings for a refined staircase from a previous breakpoint result.
 * Why: `run … breakpoint --refine-from <dir>` sets LEVELS and WARM_UP_RATE unless the tester set them.
 * @param {object} result previous result.json
 * @returns {{LEVELS:string, WARM_UP_RATE:string, refinedFrom:{runId:string, heldUpTo:number, brokeAtRate:number}}}
 */
export function refineFromResult(result) {
  if (result?.testType !== 'breakpoint')
    throw new RefusedError('--refine-from needs a breakpoint result');
  const good = result.breaking?.heldUpTo;
  const bad = result.breaking?.brokeAtRate;
  if (!Number.isFinite(good))
    throw new RefusedError('That run held no level: lower LEVELS instead of refining');
  if (!Number.isFinite(bad))
    throw new RefusedError('That run never broke: raise LEVELS instead of refining');
  const levels = computeFineLevels(good, bad);
  if (!levels.length) throw new RefusedError(`No level fits between ${good}/s and ${bad}/s`);
  return {
    LEVELS: levels.join(','),
    WARM_UP_RATE: String(good),
    refinedFrom: { runId: result.runId, heldUpTo: good, brokeAtRate: bad },
  };
}
