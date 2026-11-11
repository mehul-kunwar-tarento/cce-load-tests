/**
 * lint-headers.mjs — CLI command `lint-headers`: every file in scope has its header comment (plan §2.4, R11).
 *
 * What:    Runs tools/core/header-check.mjs over the repository (or only the given paths) and lists every
 *          file whose header lacks one of What / How / Needs / Outputs. Part of `npm run lint`.
 * How:     node tools/cli.mjs lint-headers
 *          node tools/cli.mjs lint-headers --paths tools/core config     (only these files/folders)
 *          node tools/cli.mjs lint-headers --json
 * Needs:   Read access to the repository; git (read-only) to skip git-ignored files.
 * Outputs: One line per problem (or JSON); exit 0 when every header is present, 1 otherwise.
 */
import path from 'node:path';
import { parseCommandArgs } from '../core/command-args.mjs';
import { EXIT } from '../core/errors.mjs';
import { checkHeaders } from '../core/header-check.mjs';
import { REPO_ROOT } from '../core/paths.mjs';

export const description =
  'Check that every file in scope starts with its What/How/Needs/Outputs header';
export const usage = `Usage: lint-headers [--paths <file or folder>…] [--json]

  --paths   only check these files/folders (repeat or list several after one --paths)
  --json    print { checked, problems } as JSON
Scope (plan §2.4): .js .mjs .sh .yml .yaml .md and our own .json, except archive/, results/,
node_modules/, .cache/, .git/, git-ignored files, package-lock.json, fixtures/ and test-data/plan-definitions/.`;

/**
 * Command entry (plan §6.1).
 * @param {string[]} argv
 * @param {{stdout?:{write(s:string):void}, cwd?:string}} [io]
 * @param {{root?:string, ignored?:object}} [deps] injected by unit tests
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}, deps = {}) {
  const stdout = io.stdout ?? process.stdout;
  const cwd = io.cwd ?? process.cwd();
  const { values, positionals } = parseCommandArgs(argv, {
    paths: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  const root = deps.root ?? REPO_ROOT;
  // "--paths a b c": everything after the flag is a path (positionals), relative to the current folder.
  const paths = values.paths ? positionals.map((p) => path.resolve(cwd, p)) : null;
  const { problems, checked } = checkHeaders({
    root,
    paths,
    ...(deps.ignored ? { ignored: deps.ignored } : {}),
  });
  if (values.json) {
    stdout.write(`${JSON.stringify({ checked, problems }, null, 2)}\n`);
  } else {
    for (const { file, problem } of problems) stdout.write(`${file}: ${problem}\n`);
    stdout.write(
      problems.length
        ? `${problems.length} of ${checked} file(s) lack a complete header (What/How/Needs/Outputs, plan §2.4)\n`
        : `All ${checked} file(s) have their header\n`,
    );
  }
  return problems.length ? EXIT.FAILED : EXIT.OK;
}
