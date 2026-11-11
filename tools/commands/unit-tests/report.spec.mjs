/**
 * report.spec.mjs — unit tests of tools/commands/report.mjs (the `report` command).
 *
 * What:    `report <dir>` re-renders report.md from result.json (and includes a baseline-comparison.json
 *          found next to it); an invalid result or a v1 folder without result.json is refused; `--series`
 *          writes summary.json + summary.md into --out; `--latest`/`--since` pick runs from a results root.
 * How:     node --test tools/commands/unit-tests/report.spec.mjs
 * Needs:   tools/report/unit-tests/fixtures/results/ (copied into temporary folders).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RefusedError } from '../../core/errors.mjs';
import { copyFixture, sink, tempDir } from '../../core/unit-tests/helpers.mjs';
import { main } from '../report.mjs';

const RESULTS = new URL('../../report/unit-tests/fixtures/results/', import.meta.url).pathname;

/** A temporary results root holding copies of every fixture folder. */
function resultsCopy() {
  return copyFixture(RESULTS, path.join(tempDir(), 'results'));
}

test('report <dir>: writes report.md from result.json and prints it', async () => {
  const root = resultsCopy();
  const dir = path.join(root, 'matcher-stress-20261105-142233');
  const out = sink();
  assert.equal(await main([dir], { stdout: out }), 0);
  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(report, /^# Matcher stress — FAILED/);
  assert.match(out.text, /Report written to .*report\.md/);
});

test('report <dir> includes a baseline-comparison.json found next to result.json', async () => {
  const root = resultsCopy();
  const dir = path.join(root, 'collector-load-20261105-120000');
  fs.writeFileSync(
    path.join(dir, 'baseline-comparison.json'),
    JSON.stringify({
      baseline: 'local-x',
      provisional: true,
      tolerance: 20,
      warnings: [],
      rows: [
        {
          key: 'collector.load.p95Ms',
          label: 'Collector load p95',
          unit: 'ms',
          baseline: 15.4,
          current: 30.1,
          deltaPercent: 95.5,
          verdict: 'worse',
          baselineRuns: 3,
        },
      ],
    }),
  );
  await main([dir, '--quiet'], { stdout: sink() });
  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(report, /## Baseline comparison/);
  assert.match(report, /PROVISIONAL/);
  assert.match(
    report,
    /\| Collector load p95 \| 15\.4 ms \(mean of 3\) \| 30\.1 ms \| 95\.5% \| worse \|/,
  );
});

test('a folder without result.json (v1) or with an invalid result is refused', async () => {
  const root = resultsCopy();
  await assert.rejects(
    main([path.join(root, 'collector-load-1103003810')], { stdout: sink() }),
    /has no result\.json/,
  );
  const dir = path.join(root, 'collector-load-20261105-120000');
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  delete result.breaking;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  await assert.rejects(main([dir], { stdout: sink() }), RefusedError);
});

test('--series <dirs> --out: summary.json (kind, $comment) and summary.md', async () => {
  const root = resultsCopy();
  const out = path.join(tempDir(), 'summary');
  const dirs = fs.readdirSync(root).map((d) => path.join(root, d));
  assert.equal(await main(['--series', ...dirs, '--out', out, '--quiet'], { stdout: sink() }), 0);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'cce-performance-summary');
  assert.match(summary.$comment, /What:.*How:.*Needs:.*Outputs:/s);
  assert.equal(summary.runs.length, 5);
  assert.equal(summary.ignoredFolders.length, 1);
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /## 5\. Whole flow/);
});

test('--latest and --since pick runs from the results root (folders with result.json only)', async () => {
  const root = resultsCopy();
  const latest = path.join(tempDir(), 'latest');
  await main(
    ['--latest', '2', '--out', latest, '--quiet'],
    { stdout: sink() },
    { resultsRoot: root },
  );
  const summary = JSON.parse(fs.readFileSync(path.join(latest, 'summary.json'), 'utf8'));
  assert.deepEqual(
    summary.runs.map((r) => r.runId),
    ['20261105-150955', '20261105-160000'],
  );
  await assert.rejects(
    main(['--since', '2027-01-01'], { stdout: sink() }, { resultsRoot: root }),
    /No result folders/,
  );
  await assert.rejects(
    main(['--latest', 'x'], { stdout: sink() }, { resultsRoot: root }),
    /--latest needs/,
  );
});
