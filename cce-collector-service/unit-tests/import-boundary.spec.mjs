/**
 * import-boundary.spec.mjs — proves this folder reaches shared code only through its two shims.
 *
 * What:    The folder will be copied into the cce-collector-service repository as performance-tests/.
 *          That stays a two-file job only if no other file reaches outside the folder (plan §10.1):
 *          - shared.mjs is the only Node file that imports from the repository's tools/core/ or lib/;
 *          - tests/shared-lib.js is the only k6 file that imports from lib/;
 *          - no file imports another service folder, and bare imports are only node:* (Node) or k6* (k6).
 *          Every import specifier (static, re-export, dynamic, side-effect, module-relative new URL) of
 *          every .js/.mjs file is resolved against its file and checked.
 * How:     npm test   (or: node --test "cce-collector-service/unit-tests/import-boundary.spec.mjs")
 * Needs:   Node 22; the folder's own files (read only).
 * Outputs: node:test results; a failure names the file and the offending import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/** The cce-collector-service folder and the repository root above it. */
const FOLDER = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.dirname(path.resolve(FOLDER));

/** The two shims and the shared folders each may reach (repository-relative, with a trailing slash). */
const SHIMS = {
  'shared.mjs': ['tools/core/', 'lib/'],
  'tests/shared-lib.js': ['lib/'],
};

/**
 * Every import specifier in a source text.
 * Why: one regex per import form; comments are stripped first so prose about paths is not mistaken for code.
 * @param {string} source
 * @returns {string[]}
 */
export function importSpecifiers(source) {
  // Drop block comments and line comments ("//" at a line start or after a space; "http://" survives).
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const patterns = [
    // import x from '…' / export { … } from '…' — statements start a line (may span several lines).
    /^(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm,
    /^import\s*['"]([^'"]+)['"]/gm, // side-effect import '…'
    /\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // dynamic import('…')
    /\bnew URL\(\s*['"`]([^'"`$]+)/g, // new URL('./…', import.meta.url) (static part)
  ];
  const found = [];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.push(match[1]);
  return found;
}

/** Every .js / .mjs file of the folder (fixtures hold JSON only, but are skipped anyway). */
function sourceFiles(dir = FOLDER) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures' && entry.name !== 'node_modules')
        files.push(...sourceFiles(full));
    } else if (/\.(m?js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * Problems of one file's imports (empty when it keeps the rules).
 * @param {string} file absolute path
 * @param {string[]} specifiers
 * @returns {string[]}
 */
export function boundaryProblems(file, specifiers) {
  const relative = path.relative(FOLDER, file).split(path.sep).join('/');
  const isK6 = relative.startsWith('tests/');
  const problems = [];
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      // Bare specifiers: Node built-ins for Node files, k6 modules for k6 scripts. Nothing else.
      const allowed = isK6 ? /^k6(\/|$)/ : /^node:/;
      if (!allowed.test(specifier))
        problems.push(`${relative}: bare import "${specifier}" not allowed`);
      continue;
    }
    const target = path.resolve(path.dirname(file), specifier);
    const insideFolder = `${target}${path.sep}`.startsWith(FOLDER) || target === FOLDER;
    if (insideFolder) continue;
    const fromRepo = path.relative(REPO, target).split(path.sep).join('/');
    const reach = SHIMS[relative];
    if (!reach) {
      problems.push(`${relative}: imports "${specifier}" outside the folder (only the shims may)`);
    } else if (!reach.some((prefix) => fromRepo.startsWith(prefix))) {
      problems.push(
        `${relative}: shim imports "${specifier}" (${fromRepo}), allowed: ${reach.join(', ')}`,
      );
    }
    if (/^cce-[^/]+-service\//.test(fromRepo))
      problems.push(`${relative}: imports another service folder (${fromRepo})`);
  }
  return problems;
}

describe('import boundary of cce-collector-service', () => {
  it('only the two shims reach shared code; nothing else leaves the folder', () => {
    const problems = sourceFiles().flatMap((file) =>
      boundaryProblems(file, importSpecifiers(fs.readFileSync(file, 'utf8'))),
    );
    assert.deepEqual(problems, []);
  });

  it('the shims really are the doors (they import shared code)', () => {
    const node = importSpecifiers(fs.readFileSync(path.join(FOLDER, 'shared.mjs'), 'utf8'));
    const k6 = importSpecifiers(fs.readFileSync(path.join(FOLDER, 'tests/shared-lib.js'), 'utf8'));
    assert.ok(node.some((s) => s.startsWith('../tools/core/')));
    assert.ok(node.some((s) => s.startsWith('../lib/')));
    assert.ok(k6.length >= 7, `found only ${k6.length} imports in tests/shared-lib.js`);
    assert.ok(k6.every((s) => s.startsWith('../../lib/')));
  });

  it('finds multi-line imports in the real test files', () => {
    const scenario = importSpecifiers(
      fs.readFileSync(path.join(FOLDER, 'tests/collector-scenario.js'), 'utf8'),
    );
    assert.deepEqual(scenario.sort(), ['./shared-lib.js', 'k6/execution']);
  });

  it('the checker catches a file that bypasses the shims', () => {
    const fake = path.join(FOLDER, 'data-checks', 'sneaky.mjs');
    const source = "import { x } from '../../tools/core/run-sql.mjs';\nimport pg from 'pg';\n";
    const problems = boundaryProblems(fake, importSpecifiers(source));
    assert.equal(problems.length, 2);
    assert.match(problems[0], /outside the folder/);
    assert.match(problems[1], /bare import "pg"/);
  });

  it('the checker catches a k6 script importing the library directly or another service', () => {
    const fake = path.join(FOLDER, 'tests', 'collector-load.test.js');
    const source =
      "import { a } from '../../lib/tagging.js';\nimport { b } from '../../cce-matcher-service/tests/x.js';\n";
    const problems = boundaryProblems(fake, importSpecifiers(source));
    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => /another service folder/.test(p)));
  });
});
