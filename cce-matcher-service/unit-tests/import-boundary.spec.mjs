/**
 * import-boundary.spec.mjs — proves the matcher folder reaches shared code only through its two shims.
 *
 * What:    This folder will be copied one day into the cce-matcher-service repository as performance-tests/.
 *          That stays a two-file job only if no other file reaches outside the folder (plan §6.4, §10.1):
 *          - shared.mjs is the only Node file that imports the repository's tools/ or lib/;
 *          - tests/shared-lib.js is the only k6 file that imports lib/;
 *          - no file imports another service folder; bare imports are only node:* (Node files) or k6*
 *            (k6 files under tests/).
 *          Every import form (static, re-export, side-effect, dynamic, module-relative new URL) of every
 *          .js/.mjs file is found and resolved against its own file.
 * How:     npm test   (or: node --test cce-matcher-service/unit-tests/import-boundary.spec.mjs)
 * Needs:   Node 22; the folder's own files (read only).
 * Outputs: node:test results; a failure names the file and the offending import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/** The cce-matcher-service folder (with a trailing separator) and the repository root above it. */
const FOLDER = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.dirname(path.resolve(FOLDER));

/** The two shims and the shared folders each may reach (repository-relative prefixes). */
const SHIMS = {
  'shared.mjs': ['tools/core/', 'tools/plan-definitions/', 'lib/'],
  'tests/shared-lib.js': ['lib/'],
};

/**
 * Every import specifier in a source text.
 * Why: one pattern per import form; comments are removed first so prose that mentions paths (like this
 * header) is not mistaken for an import.
 * @param {string} source
 * @returns {string[]}
 */
export function importSpecifiers(source) {
  // Block comments, then line comments ("//" at a line start or after a space, so "http://" survives).
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const patterns = [
    /^\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm, // import … from / export … from (multi-line)
    /^\s*import\s*['"]([^'"]+)['"]/gm, // side-effect import '…'
    /\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // dynamic import('…')
    /\bnew URL\(\s*['"`]([^'"`$]+)/g, // new URL('./…', import.meta.url): the static part
  ];
  const found = [];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.push(match[1]);
  return found;
}

/** Every .js / .mjs file of the folder (fixtures hold JSON only and are skipped). */
function sourceFiles(dir = FOLDER) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['fixtures', 'node_modules'].includes(entry.name)) files.push(...sourceFiles(full));
    } else if (/\.m?js$/.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * The boundary problems of one file (empty when it keeps the rules).
 * @param {string} file absolute path
 * @param {string[]} specifiers its import specifiers
 * @returns {string[]}
 */
export function boundaryProblems(file, specifiers) {
  const relative = path.relative(FOLDER, file).split(path.sep).join('/');
  const isK6 = relative.startsWith('tests/');
  const problems = [];
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      // Bare specifiers: Node built-ins in Node files, k6 modules in k6 scripts. No npm packages here.
      const allowed = isK6 ? /^k6(\/|$)/ : /^node:/;
      if (!allowed.test(specifier))
        problems.push(`${relative}: bare import "${specifier}" not allowed`);
      continue;
    }
    const target = path.resolve(path.dirname(file), specifier);
    if (`${target}${path.sep}`.startsWith(FOLDER)) continue; // inside the folder: always fine
    const fromRepo = path.relative(REPO, target).split(path.sep).join('/');
    const reach = SHIMS[relative];
    if (!reach) {
      problems.push(
        `${relative}: imports "${specifier}" outside the folder (only the two shims may)`,
      );
    } else if (!reach.some((prefix) => fromRepo.startsWith(prefix))) {
      problems.push(
        `${relative}: shim imports "${specifier}" (${fromRepo}); allowed: ${reach.join(', ')}`,
      );
    }
    if (/^cce-[^/]+-service\//.test(fromRepo)) {
      problems.push(`${relative}: imports another service folder (${fromRepo})`);
    }
  }
  return problems;
}

describe('import boundary of cce-matcher-service', () => {
  it('only the two shims reach shared code; nothing else leaves the folder', () => {
    const files = sourceFiles();
    assert.ok(files.length >= 14, `found only ${files.length} source files`);
    const problems = files.flatMap((file) =>
      boundaryProblems(file, importSpecifiers(fs.readFileSync(file, 'utf8'))),
    );
    assert.deepEqual(problems, []);
  });

  it('the shims really are the doors (they import the shared code)', () => {
    const node = importSpecifiers(fs.readFileSync(path.join(FOLDER, 'shared.mjs'), 'utf8'));
    const k6 = importSpecifiers(fs.readFileSync(path.join(FOLDER, 'tests/shared-lib.js'), 'utf8'));
    assert.ok(node.some((s) => s.startsWith('../tools/core/')));
    assert.ok(node.some((s) => s.startsWith('../lib/')));
    assert.ok(k6.length >= 7, `found only ${k6.length} imports in tests/shared-lib.js`);
    assert.ok(k6.every((s) => s.startsWith('../../lib/')));
  });

  it('finds multi-line imports in the real files (the checker is not blind)', () => {
    const scenario = importSpecifiers(
      fs.readFileSync(path.join(FOLDER, 'tests/matcher-scenario.js'), 'utf8'),
    );
    assert.deepEqual(scenario.sort(), ['./shared-lib.js', 'k6', 'k6/execution']);
    const module = importSpecifiers(
      fs.readFileSync(path.join(FOLDER, 'service-module.mjs'), 'utf8'),
    );
    assert.ok(module.includes('./tests/matcher-'), 'the testFile URL is seen as module-relative');
  });

  it('flags what it must flag', () => {
    const file = path.join(FOLDER, 'watchers/backlog-watcher.mjs');
    assert.equal(boundaryProblems(file, ['../../tools/core/idle.mjs']).length, 1);
    assert.equal(boundaryProblems(file, ['../../cce-collector-service/shared.mjs']).length, 2);
    assert.equal(boundaryProblems(file, ['kafkajs']).length, 1);
    assert.deepEqual(boundaryProblems(file, ['../shared.mjs', 'node:path']), []);
    const shim = path.join(FOLDER, 'shared.mjs');
    assert.equal(boundaryProblems(shim, ['../config/settings/defaults.json']).length, 1);
    const k6File = path.join(FOLDER, 'tests/matcher-load.test.js');
    assert.equal(boundaryProblems(k6File, ['node:fs']).length, 1);
  });
});
