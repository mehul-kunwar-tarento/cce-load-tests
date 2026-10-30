// Picks the k6 options for a profile, so every test runs the same scenarios with the same rules.
//   smoke   smoke only (30 s)
//   full    smoke, then load: the expected peak, 50/s for 10 min (the default)
//   stress  smoke, then a staircase of rising rates, 1 min each (stress.js): the breaking point as traffic grows
//   flood   smoke, then 2,000/s for 1 min (flood.js): the service's exact maximum
import { smokeScenario, smokeThresholds } from './smoke.js';
import { loadScenario, loadThresholds } from './load.js';
import { stressScenarios } from './stress.js';
import { floodScenario } from './flood.js';

// The same pass rules for every profile: the shared ones plus the smoke's stop-at-once.
const thresholds = { ...loadThresholds, ...smokeThresholds };

const PROFILES = {
  smoke: {
    scenarios: { smoke: smokeScenario },
    thresholds: thresholds,
  },
  full: {
    scenarios: { smoke: smokeScenario, load: loadScenario },
    thresholds: thresholds,
  },
  stress: {
    scenarios: { smoke: smokeScenario, ...stressScenarios },
    thresholds: thresholds,
  },
  flood: {
    scenarios: { smoke: smokeScenario, flood: floodScenario },
    thresholds: thresholds,
  },
};

export function optionsFor(profile) {
  if (!PROFILES[profile]) {
    throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}, not ${profile}`);
  }
  return PROFILES[profile];
}
