/**
 * plan-definitions.mjs — CLI command `plan-definitions`: validate, generate, check, load and retire the
 *                        plan definitions of a plan-definition set
 *
 * What:    The plan definitions that are ACTIVE decide how much work every event causes in the matcher (an
 *          event matching 4 plan definitions enrols the patient 4 times). A "plan-definition set"
 *          (test-data/plan-definition-sets/<name>/set.json) is therefore a test parameter. Sub-commands:
 *            (--set <name> below is the short form of --plan-definition-set <name>; --set NAME=value
 *             overrides a setting, as in every other command)
 *            validate [--set <name>]       offline: protocol-service load rules, files, dataset (all sets if none named)
 *            generate --set <name> [--out] offline: write the JSON as it would be loaded to .cache/plan-definitions/generated/<set>/
 *            status <env> --set <name>     read-only: ACTIVE / RETIRED / missing per plan definition, load-test marker, ledger
 *            load <env> --set <name>       post the missing ones (with the load-test marker), then wait PROTOCOL_REFRESH_WAIT
 *            retire <env> --set <name>     retire the set's ACTIVE ones that carry the marker (typed yes; irreversible)
 *            delete <env> --set <name>     delete the set's ones that carry the marker (409 = still used: run cleanup first)
 *            list-active <env>             every ACTIVE plan definition of the environment (protocol API, else database)
 *          Writes are gated (plan §7.3): safety.allowPlanDefinitionChanges must be true; on dev/uat a version
 *          suffix (PLAN_DEFINITION_VERSION_SUFFIX) or a /loadtest/ url is required; retire/delete never touch a
 *          definition outside the named set or without the load-test marker.
 * How:     node tools/cli.mjs plan-definitions validate --set emr-service
 *          node tools/cli.mjs plan-definitions load local --set emr-service
 *          scripts/manage-plan-definitions.sh status local --set emr-service
 * Needs:   test-data/ (A1); for env sub-commands config/environments/<env>.json and the protocol service
 *          (services.protocol); list-active falls back to Postgres when the DB password env var is set.
 * Outputs: Printed tables; generated JSON files; ledger .cache/plan-definitions/<env>-ledger.json for writes.
 *          Exit code 0 done, 1 validation failed, 2 refused, 3 tool error.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseCommandArgs } from '../core/command-args.mjs';
import { loadEnvironment } from '../core/environment.mjs';
import { datasetForRun } from '../core/run-setup.mjs';
import { EXIT, RefusedError, UsageError } from '../core/errors.mjs';
import { parseSetArgs, resolveSettings } from '../core/settings.mjs';
import { getActivePlanDefinitions } from '../plan-definitions/active.mjs';
import { DEFAULT_CACHE_DIR, appendLedger, readLedger } from '../plan-definitions/ledger.mjs';
import { ProtocolApiError, createProtocolApi } from '../plan-definitions/protocol-api.mjs';
import {
  DEFAULT_TEST_DATA_ROOT,
  assertPlanDefinitionWriteAllowed,
  hasLoadTestMarker,
  listPlanDefinitionSets,
  loadPlanDefinitionSet,
  withLoadTestMarker,
} from '../plan-definitions/sets.mjs';
import { validateSet } from '../plan-definitions/validate.mjs';

export const description =
  'Validate, generate, check, load, retire or delete the plan definitions of a plan-definition set';
export const usage = `Usage: plan-definitions <sub-command> …

  validate [--set <name>]            offline check of one set (or every set)
  generate --set <name> [--out <dir>] write the generated plan definitions (default .cache/plan-definitions/generated/<set>/)
  status <env> --set <name>          ACTIVE / RETIRED / missing, load-test marker, ledger (read-only)
  load <env> --set <name>            load the missing ones, then wait PROTOCOL_REFRESH_WAIT for the matcher
  retire <env> --set <name> [--yes]  retire the set's ACTIVE ones loaded by this tool (irreversible for url+version)
  delete <env> --set <name> [--yes]  delete the set's ones loaded by this tool (only when no instance uses them)
  list-active <env>                  every ACTIVE plan definition of the environment

  --plan-definition-set <name>  the plan-definition set (short form: --set <name>)
  --set NAME=value      override a setting, as in every other command, e.g.
                        --set PLAN_DEFINITION_VERSION_SUFFIX=-loadtest (a --set value with "=" is a setting,
                        one without is the set name; --setting NAME=value still works; env vars work too)
  --yes                 retire/delete without the typed "yes"

Writes need safety.allowPlanDefinitionChanges=true; dev/uat also need PLAN_DEFINITION_VERSION_SUFFIX or a /loadtest/ url.
Exit codes: 0 done, 1 validation failed, 2 refused, 3 tool error.`;

/** Sub-commands that need an environment. */
const ENV_SUB_COMMANDS = ['status', 'load', 'retire', 'delete', 'list-active'];
/** Sub-commands that write to the protocol service (gated by plan §7.3). */
const WRITE_SUB_COMMANDS = ['load', 'retire', 'delete'];

/** Why: retire/delete are irreversible; a pipe without a terminal never counts as a "yes". */
function terminalConfirm() {
  return async (question) => {
    if (!process.stdin.isTTY) return false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      return (await rl.question(question)).trim() === 'yes';
    } finally {
      rl.close();
    }
  };
}

/** A fixed-width text table. Why: status and list-active are read by people in a terminal. */
function table(header, rows) {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells) =>
    `  ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')}`.trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

/**
 * validate: every set (or the named one) against the offline protocol-service rules.
 * Why: a 400 from a shared environment is slow to diagnose; the same rules offline say why at once.
 */
async function validateCommand({ setName, settings, testDataRoot, stdout }) {
  const names = setName ? [setName] : listPlanDefinitionSets({ testDataRoot });
  if (names.length === 0)
    throw new RefusedError(`No plan-definition sets found in ${testDataRoot}`);
  let failed = 0;
  for (const name of names) {
    const set = await loadPlanDefinitionSet(name, {
      versionSuffix: settings.values.PLAN_DEFINITION_VERSION_SUFFIX ?? '',
      testDataRoot,
    });
    const errors = validateSet(set, { dataset: datasetForRun(settings.values.DATASET, set) });
    if (errors.length) {
      failed += 1;
      stdout.write(
        `✖ ${name}: ${errors.length} problem(s)\n${errors.map((e) => `    - ${e}`).join('\n')}\n`,
      );
    } else {
      const mandatory = set.planDefinitions.map((p) => p.mandatorySteps.length).join(', ');
      stdout.write(
        `✔ ${name}: ${set.fanOut} plan definition(s) valid (mandatory steps ${mandatory}; dataset ${datasetForRun(settings.values.DATASET, set) ?? 'not checked'})\n`,
      );
    }
  }
  return failed ? EXIT.FAILED : EXIT.OK;
}

/**
 * generate: write the set's plan definitions as they would be loaded ("$comment" removed, suffix applied,
 * without the marker). Why: lets a reviewer see exactly what is posted, or load one by hand.
 */
async function generateCommand({ set, outDir, stdout }) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const pd of set.planDefinitions) {
    const file = path.join(outDir, `${String(pd.json.id ?? pd.name ?? 'plan-definition')}.json`);
    fs.writeFileSync(file, `${JSON.stringify(pd.json, null, 2)}\n`);
    stdout.write(`wrote ${file} (${pd.canonical}, ${pd.mandatorySteps.length} mandatory steps)\n`);
  }
  return EXIT.OK;
}

/**
 * Look up every plan definition of the set in the protocol service.
 * Why: status, load, retire and delete all start from "what is there now"; the stored definition is
 * needed to see the load-test marker.
 */
async function lookUp(set, api) {
  const rows = [];
  for (const pd of set.planDefinitions) {
    const found = await api.getByUrlVersion(pd.url, pd.version);
    // by-url-version returns the DTO with `definition`; fetch by id only if a service ever leaves it out.
    const stored =
      found && found.definition === undefined && found.id ? await api.get(found.id) : found;
    rows.push({
      pd,
      found: stored,
      status: stored?.status ?? 'missing',
      marker: hasLoadTestMarker(stored?.definition),
    });
  }
  return rows;
}

/** status: one line per plan definition, then this tool's ledger entries for the set. */
async function statusCommand({ environment, set, api, cacheDir, stdout }) {
  const rows = await lookUp(set, api);
  stdout.write(`Plan-definition set ${set.name} on ${environment.name}\n`);
  stdout.write(
    `${table(
      ['canonical', 'status', 'id', 'marker', 'mandatory'],
      rows.map((r) => [
        r.pd.canonical,
        r.status,
        r.found?.id ?? '–',
        r.found ? (r.marker ? 'yes' : 'no') : '–',
        r.pd.mandatorySteps.length,
      ]),
    )}\n`,
  );
  const canonicals = new Set(set.planDefinitions.map((p) => p.canonical));
  const ledger = readLedger({ cacheDir, environmentName: environment.name }).filter((e) =>
    canonicals.has(e.canonical),
  );
  stdout.write(
    ledger.length
      ? `Ledger (informational, .cache/plan-definitions/${environment.name}-ledger.json):\n${ledger.map((e) => `  ${e.at}  ${e.action}  ${e.canonical}  ${e.id ?? ''}`).join('\n')}\n`
      : 'Ledger: no writes by this tool recorded for this set\n',
  );
  return EXIT.OK;
}

/** Wait for the matcher's plan-definition cache refresh. Why: until then it still matches the old set. */
async function waitForRefresh({ settings, sleep, stdout }) {
  const seconds = Number(settings.values.PROTOCOL_REFRESH_WAIT ?? 65);
  stdout.write(
    `Waiting ${seconds} s (PROTOCOL_REFRESH_WAIT) for the matcher to refresh its plan definitions …\n`,
  );
  await sleep(seconds * 1000);
}

/** load: post the missing plan definitions with the load-test marker. */
async function loadCommand({ environment, set, api, settings, cacheDir, sleep, stdout }) {
  const errors = validateSet(set, { dataset: datasetForRun(settings.values.DATASET, set) });
  if (errors.length) {
    throw new RefusedError(
      `set ${set.name} is not valid, nothing loaded:\n  - ${errors.join('\n  - ')}`,
    );
  }
  const rows = await lookUp(set, api);
  const retired = rows.filter((r) => r.status === 'RETIRED');
  if (retired.length) {
    // A retired url+version can never be ACTIVE again (protocol service rule).
    throw new RefusedError(
      `${retired.map((r) => r.pd.canonical).join(', ')} is RETIRED and cannot be loaded again: ` +
        'use a new PLAN_DEFINITION_VERSION_SUFFIX (e.g. -loadtest2)',
    );
  }
  let loaded = 0;
  for (const row of rows) {
    if (row.status === 'ACTIVE') {
      stdout.write(
        `= ${row.pd.canonical} already ACTIVE (${row.marker ? 'loaded by this tool' : 'no load-test marker'})\n`,
      );
      continue;
    }
    const answer = await api.load(withLoadTestMarker(row.pd.json));
    appendLedger({
      cacheDir,
      environmentName: environment.name,
      entry: { action: 'load', canonical: row.pd.canonical, id: answer?.id ?? null },
    });
    stdout.write(`+ ${row.pd.canonical} loaded (id ${answer?.id ?? '?'})\n`);
    loaded += 1;
  }
  if (loaded > 0) await waitForRefresh({ settings, sleep, stdout });
  stdout.write(`Loaded ${loaded}, already ACTIVE ${rows.length - loaded}\n`);
  return EXIT.OK;
}

/**
 * retire / delete: act only on the set's own definitions that carry the load-test marker.
 * Why: a definition without the marker was not loaded by this tool (maybe a real protocol, or v1's), so it
 * is left untouched even when its url+version is in the set (plan §7.3 rule 3).
 */
async function removeCommand({
  action,
  environment,
  set,
  api,
  settings,
  cacheDir,
  confirm,
  sleep,
  stdout,
}) {
  const rows = await lookUp(set, api);
  const untouched = [];
  const targets = [];
  for (const row of rows) {
    if (row.status === 'missing')
      stdout.write(`- ${row.pd.canonical}: not in ${environment.name}, nothing to ${action}\n`);
    else if (action === 'retire' && row.status !== 'ACTIVE')
      stdout.write(`- ${row.pd.canonical}: already ${row.status}\n`);
    else if (!row.marker) untouched.push(row);
    else targets.push(row);
  }
  for (const row of untouched) {
    stdout.write(
      `! ${row.pd.canonical}: not loaded by this tool (no load-test marker): left untouched. ` +
        `If you really mean it, ${action} id ${row.found.id} by hand through the protocol API.\n`,
    );
  }
  if (targets.length === 0) return untouched.length ? EXIT.REFUSED : EXIT.OK;

  const warning =
    action === 'retire'
      ? 'Retiring is IRREVERSIBLE for these url+versions (they can never be ACTIVE again).'
      : 'Deleting removes these plan definitions; the protocol service refuses while instances still use them.';
  stdout.write(
    `${warning}\n${targets.map((r) => `  ${r.pd.canonical} (id ${r.found.id})`).join('\n')}\n`,
  );
  if (
    !(await confirm(
      `${action} ${targets.length} plan definition(s) on ${environment.name}? Type yes: `,
    ))
  ) {
    throw new RefusedError(
      `not confirmed: nothing was ${action === 'retire' ? 'retired' : 'deleted'} (type yes, or pass --yes)`,
    );
  }
  let blocked = 0;
  for (const row of targets) {
    try {
      if (action === 'retire') await api.retire(row.found.id);
      else await api.remove(row.found.id);
    } catch (error) {
      if (action === 'delete' && error instanceof ProtocolApiError && error.status === 409) {
        stdout.write(
          `✖ ${row.pd.canonical}: still referenced by protocol instances (HTTP 409): run cleanup first ` +
            `(node tools/cli.mjs cleanup ${environment.name} --run-id <id> or --all)\n`,
        );
        blocked += 1;
        continue;
      }
      throw error;
    }
    appendLedger({
      cacheDir,
      environmentName: environment.name,
      entry: { action, canonical: row.pd.canonical, id: row.found.id },
    });
    stdout.write(`${action === 'retire' ? 'retired' : 'deleted'} ${row.pd.canonical}\n`);
  }
  if (action === 'retire' && blocked < targets.length)
    await waitForRefresh({ settings, sleep, stdout });
  return blocked || untouched.length ? EXIT.REFUSED : EXIT.OK;
}

/** list-active: every ACTIVE plan definition (protocol API; database fallback when the password is set). */
async function listActiveCommand({ environment, api, pgPool, stdout }) {
  const active = await getActivePlanDefinitions(environment, { protocolApi: api, pgPool });
  stdout.write(
    `ACTIVE plan definitions on ${environment.name} (${active.length}, source ${active[0]?.source ?? 'n/a'})\n`,
  );
  stdout.write(
    `${table(
      ['canonical', 'id', 'updated'],
      active.map((a) => [a.canonical, a.id, a.updatedAt ?? '–']),
    )}\n`,
  );
  return EXIT.OK;
}

/**
 * Splits the parsed options into the set name and the setting overrides.
 * Why: every command overrides settings with `--set NAME=value`; here `--set <name>` (no "=") also names
 *      the plan-definition set, the short form of `--plan-definition-set`. A set name never contains "=".
 * @param {{'plan-definition-set'?: string, set: string[], setting: string[]}} values parsed options
 * @returns {{setName: string|undefined, settingPairs: string[]}} settingPairs: from --set and --setting
 */
export function splitSetOptions(values) {
  const names = values.set.filter((v) => !v.includes('='));
  const settingPairs = [...values.set.filter((v) => v.includes('=')), ...values.setting];
  const given = [...new Set([values['plan-definition-set'], ...names].filter(Boolean))];
  if (given.length > 1) {
    throw new UsageError(`Name one plan-definition set, not ${given.join(' and ')}`);
  }
  return { setName: given[0], settingPairs };
}

/**
 * Command entry (plan §6.1 contract).
 * @param {string[]} argv
 * @param {{stdout?, env?, configDir?, testDataRoot?, cacheDir?, protocolApi?, pgPool?, confirm?, sleep?}} [io]
 *   extra fields are for unit tests (fake protocol API, temporary folders, scripted confirmation, no waiting)
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const env = io.env ?? process.env;
  const { values, positionals } = parseCommandArgs(argv, {
    'plan-definition-set': { type: 'string' },
    // --set NAME=value overrides a setting as in every other command; a bare --set <name> is the short
    // form of --plan-definition-set (plan §6.1). --setting NAME=value is the older spelling, kept as an alias.
    set: { type: 'string', multiple: true, default: [] },
    setting: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
    yes: { type: 'boolean', default: false },
  });
  const { setName, settingPairs } = splitSetOptions(values);
  if (values.help) {
    stdout.write(`${description}\n\n${usage}\n`);
    return EXIT.OK;
  }
  const [sub, envName, ...extra] = positionals;
  const known = ['validate', 'generate', ...ENV_SUB_COMMANDS];
  if (!known.includes(sub))
    throw new UsageError(`Unknown sub-command "${sub ?? ''}" (one of ${known.join(', ')})`);
  const needsEnv = ENV_SUB_COMMANDS.includes(sub);
  if (needsEnv ? !envName || extra.length : envName) {
    throw new UsageError(
      needsEnv ? `${sub} needs exactly one environment name` : `${sub} takes no environment`,
    );
  }
  if (sub !== 'validate' && sub !== 'list-active' && !setName)
    throw new UsageError(`${sub} needs --plan-definition-set <name> (or --set <name>)`);

  const testDataRoot = io.testDataRoot ?? DEFAULT_TEST_DATA_ROOT;
  const cacheDir = io.cacheDir ?? DEFAULT_CACHE_DIR;
  const overrides = parseSetArgs(settingPairs);
  // Prod is refused inside loadEnvironment, before anything else.
  const environment = needsEnv
    ? loadEnvironment(envName, io.configDir ? { configDir: io.configDir } : {})
    : null;
  // No subject/test type: values only (plan §3.3).
  const settings = resolveSettings({ environment, overrides, env });

  if (sub === 'validate') return validateCommand({ setName, settings, testDataRoot, stdout });
  const set =
    sub === 'list-active'
      ? null
      : await loadPlanDefinitionSet(setName, {
          versionSuffix: settings.values.PLAN_DEFINITION_VERSION_SUFFIX ?? '',
          testDataRoot,
        });
  if (sub === 'generate') {
    const outDir = values.out
      ? path.resolve(values.out)
      : path.join(cacheDir, 'generated', set.name);
    return generateCommand({ set, outDir, stdout });
  }

  // Gate every write BEFORE talking to the service (plan §7.3 rules 1–2).
  if (WRITE_SUB_COMMANDS.includes(sub))
    assertPlanDefinitionWriteAllowed({ environment, set, action: sub });
  const api = io.protocolApi ?? createProtocolApi(environment);
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const common = { environment, set, api, settings, cacheDir, sleep, stdout };
  switch (sub) {
    case 'status':
      return statusCommand(common);
    case 'load':
      return loadCommand(common);
    case 'retire':
    case 'delete': {
      const confirm = values.yes ? async () => true : (io.confirm ?? terminalConfirm());
      return removeCommand({ ...common, action: sub, confirm });
    }
    case 'list-active':
    default: {
      // Database fallback only when a password is there; the pool is ours, so we end it.
      let pgPool = io.pgPool ?? null;
      let ownPool = null;
      if (!pgPool && environment.database && env[environment.database.passwordEnvVar]) {
        const { createPool } = await import('../core/clients/postgres.mjs');
        ownPool = createPool(environment, {
          max: 1,
          applicationName: 'cce-performance-tests-plan-definitions',
          env,
        });
        pgPool = ownPool;
      }
      try {
        return await listActiveCommand({ environment, api, pgPool, stdout });
      } finally {
        await ownPool?.end().catch(() => {});
      }
    }
  }
}
