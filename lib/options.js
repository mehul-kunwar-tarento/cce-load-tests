// Picks the k6 options for a profile, so every test runs the same scenarios with the same rules.
//   smoke   smoke only (30 s)
//   full    smoke, then load (the default)
//   stress  smoke, then the stress staircase
import { smokeScenario, smokeThresholds } from './smoke.js';
import { loadScenario, loadThresholds } from './load.js';
import { stressScenarios, stressThresholds } from './stress.js';

const PROFILES = {
  smoke: {
    scenarios: { smoke: smokeScenario },
    thresholds: { ...loadThresholds, ...smokeThresholds },
  },
  full: {
    scenarios: { smoke: smokeScenario, load: loadScenario },
    thresholds: { ...loadThresholds, ...smokeThresholds },
  },
  stress: {
    scenarios: { smoke: smokeScenario, ...stressScenarios },
    thresholds: { ...stressThresholds, ...smokeThresholds },
  },
};

export function optionsFor(profile) {
  if (!PROFILES[profile]) {
    throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}, not ${profile}`);
  }
  return PROFILES[profile];
}
