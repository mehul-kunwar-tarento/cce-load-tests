/**
 * purity.spec.mjs — checks that the PURE lib modules stay importable by Node
 *
 * What:    Reads the source of every pure module and fails if it imports k6 or calls open(), then imports
 *          each one in Node. Keeps the promise of plan §4: Node and k6 run the same arithmetic.
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22.
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Modules that must stay free of k6 (summary.js has no k6 imports either, so Node can test it). */
const PURE = [
  'duration.js',
  'settings-guard.js',
  'phase-plan.js',
  'thresholds.js',
  'scenarios.js',
  'windows.js',
  'test-data.js',
  'summary.js',
];

for (const file of PURE) {
  test(`${file} imports nothing from k6 and never calls open()`, async () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]k6/);
    assert.doesNotMatch(source, /\bopen\(/);
    assert.doesNotMatch(source, /__ENV/);
    await import(new URL(`../${file}`, import.meta.url));
  });
}
