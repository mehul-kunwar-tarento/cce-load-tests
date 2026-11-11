/**
 * cleanup.mjs — CLI command `cleanup`: delete one run's load-test data (or all of it), verified per table
 *
 * What:    Every load test leaves rows in CCE's database (events, protocol instances, steps, alarms …),
 *          all tagged LOADTEST-<runId>-…. This command removes exactly those rows, child tables first, in
 *          small batches, while watching disk space and the replication slots, and proves with before/after
 *          counts per table that nothing was left (tools/cleanup/cleanup.mjs, plan §7.2). Three modes:
 *            --print-sql  print every statement it would run, connect to nothing (review it with a DBA);
 *            --dry-run    connect, stage and count, then ROLLBACK: nothing is deleted;
 *            (default)    delete, after a typed "yes" (or --yes).
 * How:     node tools/cli.mjs cleanup local --run-id 20261105-142233 --dry-run
 *          node tools/cli.mjs cleanup local --run-id 20261105-142233          (asks "yes")
 *          node tools/cli.mjs cleanup local --all --yes                        (every LOADTEST row)
 *          scripts/cleanup-test-data.sh local --run-id 20261105-142233 --print-sql
 * Needs:   config/environments/<env>.json (safety.allowCleanup true); the DB password env var
 *          (database.passwordEnvVar, e.g. DB_PASSWORD) except for --print-sql; Kafka (local: matcher lag guard).
 * Outputs: The printed plan/table; the cleanup JSON (plan §5.6) next to the run
 *          (results/<run>/cleanup-<stamp>.json) or in results/cleanup-<runId|all>-<stamp>/cleanup.json.
 *          Exit code 0 verified / dry-run / print-sql, 1 incomplete, 2 refused, 3 tool error.
 */
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseCommandArgs } from '../core/command-args.mjs';
import { loadEnvironment } from '../core/environment.mjs';
import { EXIT, RefusedError, UsageError } from '../core/errors.mjs';
import { REPO_ROOT } from '../core/paths.mjs';
import { validateRunId } from '../core/run-id.mjs';
import { parseSetArgs, resolveSettings } from '../core/settings.mjs';
import {
  CLEANUP_SETTING_NAMES,
  cleanupSettingsSnapshot,
  formatCleanupTable,
  printCleanupSql,
  runCleanup,
} from '../cleanup/cleanup.mjs';

export const description =
  'Delete the test data of one run (or all LOADTEST data) in verified batches';
export const usage = `Usage: cleanup <env> (--run-id <id> | --all) [--legacy-v1] [--dry-run] [--print-sql] [--yes] [--wait] [--set NAME=value]… [--json]

  <env>            environment name (config/environments/<env>.json), e.g. local; prod is always refused
  --run-id <id>    the run to clean (e.g. 20261105-142233); its results folder, when found, bounds the scans
  --all            every LOADTEST row (also the shared LOADTEST facility and v1 data)
  --legacy-v1      also select by the patient in the event JSON (v1 runs used random event ids);
                   automatic for --all and for run ids that are not yyyymmdd-hhmmss (CLEANUP_LEGACY_V1=auto)
  --print-sql      print every statement, connect to nothing
  --dry-run        connect, stage and count, roll back: nothing is deleted
  --yes            do not ask for the typed "yes" (scripts); without a terminal the answer is no
  --wait           wait (up to IDLE_TIMEOUT) until the services stopped processing this run's data
  --set NAME=value override a setting, e.g. --set CLEANUP_BATCH_SIZE=5000
  --json           print the cleanup JSON instead of the table

Exit codes: 0 verified / dry-run / print-sql, 1 incomplete (see notes), 2 refused, 3 tool error.`;

/** Cleanup status → exit code (plan §5.7). */
const EXIT_BY_STATUS = {
  verified: EXIT.OK,
  'dry-run': EXIT.OK,
  incomplete: EXIT.FAILED,
  refused: EXIT.REFUSED,
  error: EXIT.TOOL_ERROR,
};

/**
 * Ask for a typed "yes" on the terminal.
 * Why: deleting is irreversible; a script must say --yes explicitly, and a pipe without a terminal
 * never counts as consent.
 */
export function terminalConfirm({ input = process.stdin, output = process.stderr } = {}) {
  return async (question) => {
    if (!input.isTTY) return false;
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question(question)).trim() === 'yes';
    } finally {
      rl.close();
    }
  };
}

/**
 * The settings cleanup uses, one per line.
 * Why: owner rule — every setting is printed at start (and saved in the JSON); `prefix` turns the lines
 * into SQL comments for --print-sql, so that output stays runnable.
 */
export function formatCleanupSettings(settings, prefix = '') {
  const snapshot = cleanupSettingsSnapshot(settings);
  const width = Math.max(...CLEANUP_SETTING_NAMES.map((name) => name.length));
  return CLEANUP_SETTING_NAMES.map(
    (name) =>
      `${prefix}${name.padEnd(width)}  ${JSON.stringify(snapshot[name].value)}  (${snapshot[name].source})`,
  ).join('\n');
}

/**
 * Real clients: ONE-connection pool (cleanup holds a single dedicated client) and, on the laptop, the
 * Kafka admin for the matcher-lag guard. Why lazy: --print-sql and unit tests never load pg or kafkajs.
 */
async function openClients(environment, env) {
  const passwordVar = environment.database?.passwordEnvVar;
  if (!passwordVar || !env[passwordVar]) {
    throw new RefusedError(
      `Set ${passwordVar ?? 'the database password variable'} (it is never stored in a file)`,
    );
  }
  const { createPool } = await import('../core/clients/postgres.mjs');
  // max 1: the tool can never hold a second connection while cleanup runs (CONCURRENTLY safety, §7.2).
  const pgPool = createPool(environment, {
    max: 1,
    applicationName: 'cce-performance-tests-cleanup',
    env,
  });
  let kafkaAdmin = null;
  if (environment.kind === 'local' && environment.kafka?.brokers?.length) {
    const { createKafkaAdmin } = await import('../core/clients/kafka-admin.mjs');
    kafkaAdmin = createKafkaAdmin(environment);
    await kafkaAdmin.connect();
  }
  return {
    clients: { pgPool, kafkaAdmin },
    close: async () => {
      await kafkaAdmin?.disconnect().catch(() => {});
      await pgPool.end().catch(() => {});
    },
  };
}

/**
 * Command entry (plan §6.1 contract).
 * @param {string[]} argv
 * @param {{stdout?, stderr?, env?, clients?, configDir?, resultsRoot?, confirm?, now?}} [io] the extra
 *   fields are for unit tests (fake clients, temporary results folder, scripted confirmation)
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const env = io.env ?? process.env;
  const { values, positionals } = parseCommandArgs(argv, {
    'run-id': { type: 'string' },
    all: { type: 'boolean', default: false },
    'legacy-v1': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'print-sql': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    wait: { type: 'boolean', default: false },
    set: { type: 'string', multiple: true, default: [] },
    json: { type: 'boolean', default: false },
  });
  if (values.help) {
    stdout.write(`${description}\n\n${usage}\n`);
    return EXIT.OK;
  }
  if (positionals.length !== 1) throw new UsageError('cleanup needs exactly one environment name');
  if (Boolean(values['run-id']) === values.all)
    throw new UsageError('give either --run-id <id> or --all');
  if (values['dry-run'] && values['print-sql'])
    throw new UsageError('--dry-run and --print-sql exclude each other');
  if (values['run-id']) validateRunId(values['run-id']);

  // Prod is refused here, before anything else happens.
  const environment = loadEnvironment(
    positionals[0],
    io.configDir ? { configDir: io.configDir } : {},
  );
  // Cleanup has no subject or test type: settings are resolved from the environment only (plan §7.2).
  const settings = resolveSettings({ environment, overrides: parseSetArgs(values.set), env });
  const scope = { runId: values['run-id'] ?? null, all: values.all, legacyV1: values['legacy-v1'] };
  const resultsRoot = io.resultsRoot ?? path.join(REPO_ROOT, 'results');

  if (values['print-sql']) {
    stdout.write(`-- Settings:\n${formatCleanupSettings(settings, '--   ')}\n`);
    stdout.write(printCleanupSql({ environment, scope, settings, resultsRoot }));
    return EXIT.OK;
  }

  const mode = values['dry-run'] ? 'dry-run' : 'delete';
  if (!values.json)
    stdout.write(
      `Cleanup ${environment.name} (${mode}) settings:\n${formatCleanupSettings(settings, '  ')}\n\n`,
    );
  const opened = io.clients ? null : await openClients(environment, env);
  try {
    const result = await runCleanup({
      environment,
      scope,
      mode,
      settings,
      clients: io.clients ?? opened.clients,
      confirm: values.yes ? async () => true : (io.confirm ?? terminalConfirm()),
      resultsRoot,
      wait: values.wait,
      ...(io.now ? { now: io.now } : {}),
    });
    stdout.write(
      values.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatCleanupTable(result)}\n`,
    );
    if (!values.json && result.savedTo) stdout.write(`Saved: ${result.savedTo}\n`);
    return EXIT_BY_STATUS[result.status] ?? EXIT.TOOL_ERROR;
  } finally {
    await opened?.close();
  }
}
