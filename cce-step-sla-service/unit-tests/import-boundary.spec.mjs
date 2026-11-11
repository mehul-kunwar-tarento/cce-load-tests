/**
 * import-boundary.spec.mjs — keeps the Step SLA test folder self-contained (plan §6.4, §10.1).
 *
 * What:    The folder will later be copied into the cce-step-sla-service repository as performance-tests/.
 *          That is only cheap if exactly ONE file (shared.mjs) reaches outside the folder. This test reads every
 *          .mjs/.js file of the folder (as text, without running it) and checks each import:
 *            - shared.mjs may import only ../tools/core/… and ../lib/… (the shared tooling);
 *            - every other file may import only files inside this folder and Node built-ins (node:…);
 *            - no file imports another service folder (cce-collector-service, cce-matcher-service, …);
 *            - there is no k6 shim (tests/shared-lib.js): Step SLA has no k6 script.
 * How:     npm test   (or: node --test cce-step-sla-service/unit-tests/import-boundary.spec.mjs)
 * Needs:   Nothing but the files of this folder.
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/** Absolute path of cce-step-sla-service/ (this file lives in its unit-tests/ folder). */
const FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.dirname(FOLDER);

/** Every JavaScript file of the folder, relative to it. */
function listCodeFiles(dir = FOLDER) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listCodeFiles(full);
    return /\.(mjs|js)$/.test(entry.name) ? [path.relative(FOLDER, full)] : [];
  });
}

/**
 * The module specifiers a file imports or re-exports (static and dynamic with a string literal).
 * Why: reading the text proves the boundary without executing anything.
 */
function importsOf(file) {
  // Comments are removed first: headers show import examples that are not real imports.
  const text = fs
    .readFileSync(path.join(FOLDER, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|\s)\/\/.*$/gm, '$1'); // line comments (not the // inside 'http://…' strings)
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from '…' / export { x } from '…'
    /^\s*import\s*['"]([^'"]+)['"]/gm, // import '…' (side-effect import, at the start of a line)
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // import('…')
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** True when an absolute path is inside a folder. */
function isInside(target, folder) {
  const relative = path.relative(folder, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

describe('Step SLA folder import boundary', () => {
  const files = listCodeFiles();

  it('finds the folder files (sanity check of the scan itself)', () => {
    for (const expected of [
      'shared.mjs',
      'service-module.mjs',
      'seeding/seed-alarms.mjs',
      'watchers/alarm-watcher.mjs',
      'data-checks/step-sla-data-checks.mjs',
      'tests/step-sla-load.test.mjs',
    ]) {
      assert.ok(files.includes(expected), expected);
    }
    assert.ok(
      importsOf('shared.mjs').length > 5,
      'the import scan sees the re-exports of shared.mjs',
    );
  });

  it('only shared.mjs reaches outside the folder, and only into tools/core/ and lib/', () => {
    const problems = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('node:')) continue; // Node built-ins are fine everywhere
        if (!specifier.startsWith('.')) {
          problems.push(`${file}: package import "${specifier}" (use shared.mjs)`);
          continue;
        }
        const target = path.resolve(path.dirname(path.join(FOLDER, file)), specifier);
        if (isInside(target, FOLDER)) continue;
        const allowed =
          file === 'shared.mjs' &&
          (isInside(target, path.join(REPO, 'tools', 'core')) ||
            isInside(target, path.join(REPO, 'lib')));
        if (!allowed) problems.push(`${file}: "${specifier}" leaves the folder`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('no file imports another service folder', () => {
    const others = /cce-(?!step-sla-service)[a-z-]+-service/;
    const offenders = files.filter((file) => importsOf(file).some((s) => others.test(s)));
    assert.deepEqual(offenders, []);
  });

  it('has no k6 shim: Step SLA is seeded, not driven by k6', () => {
    assert.ok(!fs.existsSync(path.join(FOLDER, 'tests', 'shared-lib.js')));
    assert.deepEqual(
      files.filter((file) => file.endsWith('.js')),
      [],
      'no k6 (.js) files in this folder',
    );
  });
});
