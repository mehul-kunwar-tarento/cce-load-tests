#!/usr/bin/env node
/**
 * cli.mjs — the one command line of the CCE performance tests: `node tools/cli.mjs <command> …`.
 *
 * What:    Dispatches to the command modules in tools/commands/ (run, settings, report, baseline,
 *          check-data, lint-headers, preflight, cleanup, plan-definitions). Each command module exports
 *          `description`, `usage` and `main(argv, { stdout, stderr, cwd })` returning an exit code
 *          (plan §6.1). This file maps errors to exit codes (plan §5.7): RefusedError/UsageError → 2,
 *          anything unexpected → 3. A command whose file is missing (built by another package) prints a
 *          clear message instead of a stack trace.
 * How:     node tools/cli.mjs --help
 *          node tools/cli.mjs run local collector smoke          (or scripts/run-test.sh local collector smoke)
 *          npm run perf -- settings local collector load --set LOAD_EVENTS=1000
 * Needs:   Node.js 22; what each command needs is in its own header.
 * Outputs: Whatever the command prints/writes; exit code 0 passed/done, 1 failed, 2 refused, 3 tool error.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXIT, RefusedError, UsageError } from './core/errors.mjs';

/** Command name → module file in tools/commands/ (A2 and A3 commands, plan §6.1). */
export const COMMANDS = {
  run: 'run-test.mjs',
  settings: 'settings.mjs',
  preflight: 'preflight.mjs',
  cleanup: 'cleanup.mjs',
  report: 'report.mjs',
  baseline: 'baseline.mjs',
  'check-data': 'check-data.mjs',
  'plan-definitions': 'plan-definitions.mjs',
  'lint-headers': 'lint-headers.mjs',
};

/** Absolute URL of a command module. */
function commandUrl(file) {
  return new URL(`./commands/${file}`, import.meta.url);
}

/**
 * Imports a command module, or returns null when its file does not exist.
 * Why: preflight/cleanup/plan-definitions are built by another package; the CLI must still work.
 * @param {string} name
 */
export async function loadCommand(name) {
  const url = commandUrl(COMMANDS[name]);
  if (!fs.existsSync(url)) return null;
  return import(url.href);
}

/**
 * The --help text: every command with its one-line description.
 * Why: the runbook's commands are checked against this list (R6 acceptance).
 */
async function helpText() {
  const lines = [
    'Usage: node tools/cli.mjs <command> [arguments]   (npm run perf -- <command> …)',
    '',
    'Commands:',
  ];
  for (const [name, file] of Object.entries(COMMANDS)) {
    const module = await loadCommand(name).catch(() => null);
    const description =
      module?.description ?? `(not installed yet: tools/commands/${file} is missing)`;
    lines.push(`  ${name.padEnd(17)} ${description}`);
  }
  lines.push('', 'Run "node tools/cli.mjs <command> --help" for the options of one command.');
  lines.push('Exit codes: 0 passed/done, 1 test or data check failed, 2 refused, 3 tool error.');
  return `${lines.join('\n')}\n`;
}

/**
 * Runs the CLI.
 * Why: exported so unit tests can call it with fake streams.
 * @param {string[]} argv arguments after "node tools/cli.mjs"
 * @param {{stdout?:{write(s:string):void}, stderr?:{write(s:string):void}, cwd?:string}} [io]
 * @returns {Promise<number>} exit code
 */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    stdout.write(await helpText());
    return name ? EXIT.OK : EXIT.REFUSED;
  }
  if (!(name in COMMANDS)) {
    stderr.write(`Unknown command "${name}".\n\n${await helpText()}`);
    return EXIT.REFUSED;
  }
  const module = await loadCommand(name);
  if (!module) {
    stderr.write(
      `The command "${name}" is not installed: tools/commands/${COMMANDS[name]} is missing.\n`,
    );
    return EXIT.TOOL_ERROR;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    stdout.write(`${module.description}\n\n${module.usage}\n`);
    return EXIT.OK;
  }
  try {
    return await module.main(rest, { stdout, stderr, cwd });
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n\n${module.usage}\n`);
      return EXIT.REFUSED;
    }
    if (error instanceof RefusedError) {
      stderr.write(`Refused: ${error.message}\n`);
      return EXIT.REFUSED;
    }
    stderr.write(`Tool error: ${error?.stack ?? error}\n`);
    return EXIT.TOOL_ERROR;
  }
}

// Run only when executed directly (not when imported by a unit test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
