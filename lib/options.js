// Picks the k6 options for a profile, so every test runs the same scenarios with the same rules.
//   smoke   smoke only (30 s)
//   full    smoke, then load: the expected peak, 50/s for 10 min (the default)
//   stress  smoke, then stress: 4× the peak, 200/s for 10 min
//   breakpoint  smoke, then a staircase 200 → 6400/s, 1 min per level, until the service breaks (HTTP tests)
import { smokeScenario, smokeThresholds } from './smoke.js';
import { loadScenario, loadThresholds } from './load.js';
import { stressScenario, stressAbort } from './stress.js';
import { breakpointScenario, breakpointThresholds } from './breakpoint.js';

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
  breakpoint: {
    scenarios: { smoke: smokeScenario, breakpoint: breakpointScenario },
    thresholds: { ...smokeThresholds, ...breakpointThresholds },
    summaryTrendStats: ['avg', 'med', 'p(95)', 'max'],
  },
};

export function optionsFor(profile) {
  if (!PROFILES[profile]) {
    throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}, not ${profile}`);
  }
  return PROFILES[profile];
}
