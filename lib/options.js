// Picks the k6 options for a profile, so every test runs the same scenarios with the same rules.
//   smoke   smoke only (30 s)
//   full    smoke, then load: the expected peak, 50/s for 10 min (the default)
//   stress  smoke, then stress: 4× the peak, 200/s for 10 min
import { smokeScenario, smokeThresholds } from './smoke.js';
import { loadScenario, loadThresholds } from './load.js';
import { stressScenario, stressAbort } from './stress.js';

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
    scenarios: { smoke: smokeScenario, stress: stressScenario },
    thresholds: { ...loadThresholds, ...smokeThresholds, ...stressAbort },
  },
};

export function optionsFor(profile) {
  if (!PROFILES[profile]) {
    throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}, not ${profile}`);
  }
  return PROFILES[profile];
}
