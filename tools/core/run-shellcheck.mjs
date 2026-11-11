#!/usr/bin/env node
/**
 * run-shellcheck.mjs — `npm run lint:shell`: ShellCheck on the shell entry points, local or in Docker.
 *
 * What:    ShellCheck finds common shell-script mistakes (unquoted variables, wrong tests). It is used
 *          when installed; otherwise the official image koalaman/shellcheck:v0.10.0 is used IF it is
 *          already present locally (no image is pulled during a lint, and the container has no network).
 *          When neither is available the tool says so and exits 0, so `npm run lint` still works on a
 *          fresh machine (install shellcheck to get the check).
 * How:     node tools/core/run-shellcheck.mjs scripts/*.sh
 * Needs:   shellcheck on PATH, or Docker with koalaman/shellcheck:v0.10.0 pulled.
 * Outputs: ShellCheck's findings; its exit code (0 clean, 1 findings).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, toRepoRelative } from './paths.mjs';

/** The pinned ShellCheck image (plan §0). */
export const SHELLCHECK_IMAGE = 'koalaman/shellcheck:v0.10.0';

/**
 * Picks how to run ShellCheck.
 * Why: a local binary is fastest; the image is the fallback; nothing is downloaded during a lint.
 * @param {{run?: typeof spawnSync}} [options]
 * @returns {'local'|'docker'|null}
 */
export function chooseRunner({ run = spawnSync } = {}) {
  if (run('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0) return 'local';
  if (run('docker', ['image', 'inspect', SHELLCHECK_IMAGE], { encoding: 'utf8' }).status === 0)
    return 'docker';
  return null;
}

/**
 * The command line for the chosen runner.
 * @param {'local'|'docker'} runner
 * @param {string[]} files repository-relative paths
 * @param {string} [repoRoot]
 * @returns {{command:string, args:string[]}}
 */
export function buildShellcheckCommand(runner, files, repoRoot = REPO_ROOT) {
  if (runner === 'local') return { command: 'shellcheck', args: files };
  return {
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${repoRoot}:/mnt:ro`,
      '-w',
      '/mnt',
      SHELLCHECK_IMAGE,
      ...files,
    ],
  };
}

/**
 * Runs ShellCheck on the given files.
 * @param {string[]} files
 * @param {{run?: typeof spawnSync, out?:{write(s:string):void}}} [options]
 * @returns {number} exit code
 */
export function runShellcheck(files, { run = spawnSync, out = process.stdout } = {}) {
  const relative = files.map((file) => toRepoRelative(path.resolve(file), REPO_ROOT));
  if (!relative.length) {
    out.write('run-shellcheck: no files given\n');
    return 0;
  }
  const runner = chooseRunner({ run });
  if (!runner) {
    out.write(`run-shellcheck: SKIPPED — install shellcheck, or docker pull ${SHELLCHECK_IMAGE}\n`);
    return 0;
  }
  const { command, args } = buildShellcheckCommand(runner, relative);
  const outcome = run(command, args, { encoding: 'utf8', cwd: REPO_ROOT });
  out.write(outcome.stdout ?? '');
  out.write(outcome.stderr ?? '');
  if (outcome.status === 0)
    out.write(`run-shellcheck: ${relative.length} file(s) clean (${runner})\n`);
  return outcome.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runShellcheck(process.argv.slice(2));
}
