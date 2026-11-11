/**
 * lint-headers.spec.mjs — unit tests of tools/commands/lint-headers.mjs (the `lint-headers` command).
 *
 * What:    A folder with one file lacking its header → exit 1 and the file named; --paths restricted to good
 *          files → exit 0; --json output; git-ignored files skipped (injected ignore list).
 * How:     node --test tools/commands/unit-tests/lint-headers.spec.mjs
 * Needs:   fixtures/lint-headers/sample-repo/ (copied into a temporary folder).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, sink, tempDir } from '../../core/unit-tests/helpers.mjs';
import { main } from '../lint-headers.mjs';

const SAMPLE = new URL('./fixtures/lint-headers/sample-repo', import.meta.url).pathname;
const ignoreNothing = { source: 'given', matches: () => false };

test('reports the file without a header and exits 1', async () => {
  const root = copyFixture(SAMPLE, path.join(tempDir(), 'repo'));
  const out = sink();
  assert.equal(await main([], { stdout: out, cwd: root }, { root, ignored: ignoreNothing }), 1);
  assert.match(out.text, /tools\/no-header\.mjs: does not start with a header comment/);
  assert.match(out.text, /config\/no-comment\.json: has no top-level "\$comment" header/);
  assert.match(out.text, /2 of 5 file\(s\) lack a complete header/);
});

test('--paths limits the check; --json prints checked and problems', async () => {
  const root = copyFixture(SAMPLE, path.join(tempDir(), 'repo'));
  const out = sink();
  assert.equal(
    await main(
      ['--paths', 'tools/good.mjs', 'scripts'],
      { stdout: out, cwd: root },
      { root, ignored: ignoreNothing },
    ),
    0,
  );
  assert.match(out.text, /All 2 file\(s\) have their header/);
  const json = sink();
  await main(['--json'], { stdout: json, cwd: root }, { root, ignored: ignoreNothing });
  assert.equal(JSON.parse(json.text).checked, 5);
});

test('git-ignored files are skipped', async () => {
  const root = copyFixture(SAMPLE, path.join(tempDir(), 'repo'));
  const ignored = {
    source: 'given',
    matches: (relative) =>
      relative === 'tools/no-header.mjs' || relative === 'config/no-comment.json',
  };
  assert.equal(await main([], { stdout: sink(), cwd: root }, { root, ignored }), 0);
});
