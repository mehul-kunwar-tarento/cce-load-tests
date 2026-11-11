/**
 * baseline-metrics.mjs — which metrics of a result go into baselines: the service module decides.
 *
 * What:    Each service module says which numbers of its results are worth tracking over time
 *          (baselineMetrics(result), plan §6.4/§8.3: e.g. collector load p95, matcher backlog, Step SLA
 *          wait). This helper finds the module of every result's subject through the service registry and
 *          falls back to generic metrics (p95, average rate, breakpoint figures) when no module exists,
 *          with a warning, so baselines still work for subjects whose folder is not installed.
 * How:     const metricsFor = await createMetricsFor({ results, modulesRoot, warnings });
 *          metricsFor(result) → [{ key, label, unit, better, value }]
 * Needs:   tools/core/service-registry.mjs (service folders under modulesRoot).
 * Outputs: A function result → metric list.
 */
import { listServiceModules } from '../core/service-registry.mjs';
import { defaultBaselineMetrics } from './baseline-store.mjs';

/**
 * Builds the metricsFor function for a set of results.
 * @param {{results: object[], modulesRoot?: string, warnings: string[], modules?: object[]}} input
 *   modules: injected by unit tests instead of scanning modulesRoot
 * @returns {Promise<(result:object) => object[]>}
 */
export async function createMetricsFor({ results, modulesRoot, warnings, modules = null }) {
  const available = modules ?? (await listServiceModules(modulesRoot ? { root: modulesRoot } : {}));
  const bySubject = new Map(available.map((module) => [module.subject, module]));
  const warned = new Set();
  for (const result of results) {
    if (!bySubject.get(result.subject)?.baselineMetrics && !warned.has(result.subject)) {
      warned.add(result.subject);
      warnings.push(
        `no service module with baselineMetrics for ${result.subject}: generic metrics used`,
      );
    }
  }
  return (result) => {
    const module = bySubject.get(result.subject);
    return module?.baselineMetrics
      ? module.baselineMetrics(result)
      : defaultBaselineMetrics(result);
  };
}
