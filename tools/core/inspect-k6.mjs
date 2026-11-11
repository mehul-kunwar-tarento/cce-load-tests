#!/usr/bin/env node
/**
 * inspect-k6.mjs — `npm run check:k6`: checks every k6 test script with `k6 inspect`, without any network.
 *
 * What:    `k6 inspect` loads a test script, runs its init code (imports, run context, options) and prints
 *          the resulting options — a fast way to prove a script is valid without sending a single request.
 *          For each <subject>-<test-type>.test.js this tool writes a fixture run-context.json (the same one
 *          `run` would write, for the local environment, with defaults) into .cache/inspect/ and runs
 *          docker run --rm --network none -v <repo>:/tests -w /tests <image> inspect -e RUN_CONTEXT=… <file>
 *          (`k6 inspect` ignores system env vars, so RUN_CONTEXT is passed with k6's own -e flag).
 *          --network none guarantees nothing is contacted (D14).
 * How:     node tools/core/inspect-k6.mjs                 (every <subject>-<test-type>.test.js outside fixtures)
 *          node tools/core/inspect-k6.mjs --files cce-collector-service/tests/collector-load.test.js
 *          node tools/core/inspect-k6.mjs --dry-run       (print the docker commands only; writes nothing)
 * Needs:   Docker and the image cce-load-tests/k6:2.3.0-kafka2.2.0 (scripts/build-k6-image.sh); the service
 *          modules (to know subject, kind and breakpoint kind of each test).
 * Outputs: .cache/inspect/<subject>-<test-type>.run-context.json (not with --dry-run); one line per script (ok / failed);
 *          exit 0 when every script passed, 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvironment } from './environment.mjs';
import { REPO_ROOT, toRepoRelative } from './paths.mjs';
import { writeJson } from './results.mjs';
import { buildRunContext, prepareRunSettings } from './run-setup.mjs';
import { listServiceModules } from './service-registry.mjs';

/** Where the fixture run contexts go (git-ignored runtime scratch owned by this tool, plan §13). */
export const INSPECT_CACHE = path.join('.cache', 'inspect');

/** Folders never searched for test scripts. */
const SKIPPED = new Set(['archive', 'node_modules', 'results', '.cache', '.git', 'fixtures']);

/** Name of a k6 test file: <subject>-<test-type>.test.js. */
const TEST_FILE = /^(.+)-(smoke|load|stress|breakpoint)\.test\.js$/;

/**
 * Every k6 test script of the repository (relative paths).
 * Why: new tests are checked without editing this tool.
 * @param {string} root
 * @returns {string[]}
 */
export function findTestScripts(root = REPO_ROOT) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) visit(path.join(dir, entry.name));
      } else if (TEST_FILE.test(entry.name)) {
        found.push(toRepoRelative(path.join(dir, entry.name), root));
      }
    }
  };
  visit(root);
  return found.sort();
}

/**
 * The docker arguments of one inspect (plan §6.10).
 * Why: one tested function; --network none is never optional.
 * @param {{repoRoot:string, image:string, runContextInContainer:string, scriptInContainer:string, uid:number, gid:number}} input
 * @returns {string[]}
 */
export function buildInspectArgs({
  repoRoot,
  image,
  runContextInContainer,
  scriptInContainer,
  uid,
  gid,
}) {
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '-u',
    `${uid}:${gid}`,
    '-v',
    `${repoRoot}:/tests`,
    '-w',
    '/tests',
    image,
    'inspect',
    '-e',
    `RUN_CONTEXT=${runContextInContainer}`,
    scriptInContainer,
  ];
}

/**
 * Writes the fixture run context of one script and returns its docker arguments.
 * Why: the scripts read everything from run-context.json; inspect needs a realistic one. With dryRun the
 *      context is still built (so a bad setting still fails) but not written: a dry run writes nothing.
 * @param {{script:string, modules:object[], environment:object, repoRoot:string, uid:number, gid:number,
 *          dryRun?:boolean}} input
 */
export async function prepareInspect({
  script,
  modules,
  environment,
  repoRoot,
  uid,
  gid,
  dryRun = false,
}) {
  const [, subject, testType] = TEST_FILE.exec(path.basename(script));
  // The module whose folder holds the script (or whose subject matches its name).
  const absolute = path.join(repoRoot, script);
  const module =
    modules.find((m) => absolute.startsWith(`${m.folder}${path.sep}`)) ??
    modules.find((m) => m.subject === subject);
  if (!module) throw new Error(`no service module for ${script}`);
  const setup = await prepareRunSettings({
    environment,
    module,
    testType,
    env: {},
    now: new Date(),
  });
  const relativeDir = INSPECT_CACHE.split(path.sep).join('/');
  const context = buildRunContext({
    setup,
    module,
    testType,
    environment,
    resultsDir: { relativeDir, dirInContainer: `/tests/${relativeDir}` },
    apiPort: 6565,
    startedAt: new Date(),
  });
  const contextFile = path.join(
    repoRoot,
    INSPECT_CACHE,
    `${module.subject}-${testType}.run-context.json`,
  );
  if (!dryRun) writeJson(contextFile, context);
  return buildInspectArgs({
    repoRoot,
    image: environment.k6.image,
    runContextInContainer: `/tests/${toRepoRelative(contextFile, repoRoot)}`,
    scriptInContainer: `/tests/${script}`,
    uid,
    gid,
  });
}

/**
 * Inspects the scripts; prints one line each.
 * @param {{files?:string[], dryRun?:boolean, repoRoot?:string, modulesRoot?:string, out?:{write(s:string):void},
 *          run?:(args:string[]) => {status:number, stdout:string, stderr:string}}} [options]
 * @returns {Promise<number>} exit code
 */
export async function inspectAll({
  files = null,
  dryRun = false,
  repoRoot = REPO_ROOT,
  modulesRoot = repoRoot,
  out = process.stdout,
  run = (args) => spawnSync('docker', args, { encoding: 'utf8' }),
} = {}) {
  const scripts = files?.length
    ? files.map((f) => toRepoRelative(path.resolve(f), repoRoot))
    : findTestScripts(repoRoot);
  if (!scripts.length) {
    out.write('No k6 test scripts found (<subject>-<test-type>.test.js).\n');
    return 0;
  }
  const environment = loadEnvironment('local');
  const modules = await listServiceModules({ root: modulesRoot });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  let failed = 0;
  for (const script of scripts) {
    try {
      const args = await prepareInspect({
        script,
        modules,
        environment,
        repoRoot,
        uid,
        gid,
        dryRun,
      });
      if (dryRun) {
        out.write(`docker ${args.join(' ')}\n`);
        continue;
      }
      const outcome = run(args);
      if (outcome.status === 0) out.write(`ok      ${script}\n`);
      else {
        failed += 1;
        out.write(`FAILED  ${script}\n${outcome.stderr || outcome.stdout}\n`);
      }
    } catch (error) {
      failed += 1;
      out.write(`FAILED  ${script}: ${error.message}\n`);
    }
  }
  return failed ? 1 : 0;
}

// Command-line use: node tools/core/inspect-k6.mjs [--files a b …] [--dry-run] [--modules-root <dir>]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const rootIndex = args.indexOf('--modules-root');
  const modulesRoot = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : REPO_ROOT;
  const filesIndex = args.indexOf('--files');
  const files =
    filesIndex >= 0
      ? args.slice(filesIndex + 1).filter((a) => !a.startsWith('--') && a !== args[rootIndex + 1])
      : null;
  process.exitCode = await inspectAll({ files, dryRun, modulesRoot });
}
