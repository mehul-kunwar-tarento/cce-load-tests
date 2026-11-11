/**
 * conditions.mjs — records the conditions a result was measured under (plan §5.2 "conditions").
 *
 * What:    The same test gives different numbers on another machine, with more data in the database
 *          or with more ACTIVE plan definitions. Before every run this module captures: the machine
 *          (host name, CPUs, memory, OS, Node, k6 image), the suite version (git commit and whether
 *          files were changed — read-only git commands only), the data volume (database size and row
 *          counts from statistics) and a snapshot of the plan-definition set (ACTIVE versions, ids,
 *          mandatory steps, other ACTIVE plan definitions that also match the test events).
 * How:     const conditions = await captureConditions({ environment, settings, planDefinitionSet, pgPool, protocolApi });
 * Needs:   pg pool (optional), A3's tools/plan-definitions/active.mjs (imported lazily; tolerated when
 *          absent with a warning), git on PATH (optional).
 * Outputs: Conditions object (environment, host, suite, planDefinitionSet, dataVolume); warnings pushed
 *          into the given array.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { toIsoWithOffset } from './format.mjs';
import { REPO_ROOT } from './paths.mjs';
import { DATA_VOLUME_SQL } from './run-sql.mjs';
import { queryRows } from './clients/postgres.mjs';

const execFileAsync = promisify(execFile);

/**
 * Host facts.
 * Why: laptop numbers are only comparable on the same machine (baseline condition warnings).
 * @param {{k6Image?:string}} [options]
 */
export function readHostInfo({ k6Image = null } = {}) {
  return {
    hostname: os.hostname(),
    cpus: os.cpus().length,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    os: `${os.platform()} ${os.release()}`,
    node: process.version,
    k6Image,
    k6Version: null,
  };
}

/**
 * Current commit and whether the working tree has changes — READ-ONLY git (D1).
 * Why: a result must say which version of the tests produced it.
 * @param {{repoRoot?:string, run?:(cmd:string, args:string[], o:object) => Promise<{stdout:string}>}} [options]
 * @returns {Promise<{gitCommit:string|null, gitDirty:boolean|null}>}
 */
export async function readGitState({ repoRoot = REPO_ROOT, run = execFileAsync } = {}) {
  try {
    const { stdout: commit } = await run('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
    });
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: repoRoot });
    return { gitCommit: commit.trim() || null, gitDirty: status.trim() !== '' };
  } catch {
    // Not a git checkout (e.g. a copied folder) or git not installed.
    return { gitCommit: null, gitDirty: null };
  }
}

/**
 * Imports A3's ACTIVE plan-definition reader, or null when it does not exist yet.
 * Why: A2 and A3 are built in parallel; conditions must still work (with a warning) without it.
 */
async function importActiveModule() {
  try {
    return await import(new URL('../plan-definitions/active.mjs', import.meta.url));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('active.mjs'))
      return null;
    throw error;
  }
}

/**
 * Combines the set's definitions with what is ACTIVE in the environment.
 * Why: plan §5.2 — the result names each plan definition with its status and id, the other ACTIVE ones,
 * and the effective fan-out the data checks expect.
 * @param {object|null} planDefinitionSet loaded set ({name, fanOut, planDefinitions:[{url, version, canonical, name, mandatorySteps}]})
 * @param {Array<{id, url, version, canonical, status, updatedAt}>|null} active
 * @param {{otherMatches?: Array<{canonical:string, matchesDatasetEvents:boolean|null, note?:string|null}>, stepSlaSeedMode?:string|null, loadTestMarker?:boolean|null}} [extra]
 *        otherMatches from preflight: true = matches the events the run sends; null with a note = unknown
 *        (e.g. a condition-only trigger); only `true` counts in the effective fan-out.
 */
export function snapshotPlanDefinitionSet(planDefinitionSet, active, extra = {}) {
  if (!planDefinitionSet) return null;
  const activeByCanonical = new Map(
    (active ?? []).map((pd) => [pd.canonical ?? `${pd.url}|${pd.version}`, pd]),
  );
  const planDefinitions = (planDefinitionSet.planDefinitions ?? []).map((pd) => {
    const canonical = pd.canonical ?? `${pd.url}|${pd.version}`;
    const found = activeByCanonical.get(canonical);
    return {
      name: pd.name ?? null,
      url: pd.url ?? null,
      version: pd.version ?? null,
      canonical,
      status: found?.status ?? (active ? 'missing' : null),
      id: found?.id ?? null,
      updatedAt: found?.updatedAt ?? null,
      mandatorySteps: pd.mandatorySteps ?? [],
    };
  });
  const own = new Set(planDefinitions.map((pd) => pd.canonical));
  const matches = new Map((extra.otherMatches ?? []).map((m) => [m.canonical, m]));
  const otherActivePlanDefinitions = (active ?? [])
    .filter((pd) => !own.has(pd.canonical ?? `${pd.url}|${pd.version}`))
    .map((pd) => {
      const canonical = pd.canonical ?? `${pd.url}|${pd.version}`;
      return {
        canonical,
        status: pd.status ?? 'ACTIVE',
        matchesDatasetEvents: matches.get(canonical)?.matchesDatasetEvents ?? null,
        note: matches.get(canonical)?.note ?? null,
      };
    });
  const fanOut = planDefinitionSet.fanOut ?? planDefinitions.length;
  return {
    name: planDefinitionSet.name,
    fanOut,
    planDefinitions,
    otherActivePlanDefinitions,
    // Other ACTIVE definitions that match the test events also create enrolments (plan §5.2).
    effectiveFanOut:
      fanOut + otherActivePlanDefinitions.filter((pd) => pd.matchesDatasetEvents === true).length,
    loadTestMarker: extra.loadTestMarker ?? null,
    stepSlaSeedMode: extra.stepSlaSeedMode ?? null,
  };
}

/**
 * Captures every condition of plan §5.2 that is known before the run.
 * @param {object} input
 * @param {object} input.environment
 * @param {Record<string, any>} input.settings ResolvedSettings.values
 * @param {object|null} [input.planDefinitionSet] loaded set (A3 loadPlanDefinitionSet), or null
 * @param {object|null} [input.pgPool]
 * @param {object|null} [input.protocolApi]
 * @param {string|null} [input.subject]
 * @param {Array<{canonical:string, matchesDatasetEvents:boolean}>} [input.otherMatches] from preflight's overlap check
 * @param {string[]} [input.warnings] receives warnings
 * @param {object} [input.deps] { readGit, importActive, now } for tests
 * @returns {Promise<object>}
 */
export async function captureConditions({
  environment,
  settings,
  planDefinitionSet = null,
  pgPool = null,
  protocolApi = null,
  subject = null,
  otherMatches = [],
  warnings = [],
  deps = {},
}) {
  const {
    readGit = readGitState,
    importActive = importActiveModule,
    now = () => new Date(),
  } = deps;
  const conditions = {
    environment: {
      name: environment.name,
      kind: environment.kind,
      configFile: environment.configFile ?? null,
      serviceUrls: Object.fromEntries(
        Object.entries(environment.services ?? {}).map(([key, s]) => [key, s.baseUrl]),
      ),
    },
    host: readHostInfo({ k6Image: environment.k6?.image ?? null }),
    suite: await readGit(),
    planDefinitionSet: null,
    dataVolume: null,
  };

  // Data volume: statistics only (cheap), never a count(*) scan.
  if (pgPool) {
    try {
      const [row] = await queryRows(pgPool, DATA_VOLUME_SQL, [], { statementTimeoutMs: 30000 });
      conditions.dataVolume = {
        capturedAt: toIsoWithOffset(now()),
        dbSizeBytes: row?.db_size_bytes === undefined ? null : Number(row.db_size_bytes),
        rows: row?.rows ?? {},
      };
    } catch (error) {
      warnings.push(`data volume not recorded: ${error.message}`);
    }
  }

  // Plan-definition set snapshot (A3's active.mjs, imported lazily).
  let active = null;
  if (planDefinitionSet && (protocolApi || pgPool)) {
    const activeModule = await importActive();
    if (!activeModule?.getActivePlanDefinitions) {
      warnings.push(
        'tools/plan-definitions/active.mjs not available: ACTIVE plan definitions not recorded',
      );
    } else {
      try {
        active = await activeModule.getActivePlanDefinitions(environment, { protocolApi, pgPool });
      } catch (error) {
        warnings.push(`ACTIVE plan definitions not recorded: ${error.message}`);
      }
    }
  }
  conditions.planDefinitionSet = snapshotPlanDefinitionSet(planDefinitionSet, active, {
    otherMatches,
    stepSlaSeedMode: subject === 'step-sla' ? (settings.STEP_SLA_SEED_MODE ?? null) : null,
    loadTestMarker: planDefinitionSet?.loadTestMarker ?? null,
  });
  return conditions;
}
