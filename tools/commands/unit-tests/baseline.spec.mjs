/**
 * baseline.spec.mjs — unit tests of tools/commands/baseline.mjs (the `baseline` command, plan §8.3).
 *
 * What:    save with 3 runs writes baselines/<name>.json (with $comment); 2 runs are refused unless
 *          --allow-fewer (provisional); an existing name needs --force; runs under different conditions are
 *          refused; compare writes baseline-comparison.json into each run folder and prints the table; list and
 *          show print what is saved.
 * How:     node --test tools/commands/unit-tests/baseline.spec.mjs
 * Needs:   tools/report/unit-tests/fixtures/results/collector-load-20261105-120000/result.json (copied and
 *          varied in temporary folders); the stub module's baselineMetrics is not used (generic metrics).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sink, tempDir } from '../../core/unit-tests/helpers.mjs';
import { main } from '../baseline.mjs';

const LOAD = new URL(
  '../../report/unit-tests/fixtures/results/collector-load-20261105-120000/result.json',
  import.meta.url,
).pathname;

/** Writes collector load runs with the given p95 values; returns their folders. */
function runs(p95s, change = () => {}) {
  const root = tempDir();
  return p95s.map((p95, i) => {
    const result = JSON.parse(fs.readFileSync(LOAD, 'utf8'));
    result.runId = `2026110${i + 1}-120000`;
    result.latency.p95 = p95;
    change(result, i);
    const dir = path.join(root, `collector-load-2026110${i + 1}-120000`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
    return dir;
  });
}

const call = async (argv, deps) => {
  const out = sink();
  const err = sink();
  const code = await main(argv, { stdout: out, stderr: err }, { modules: [], env: {}, ...deps });
  return { code, out: out.text, err: err.text };
};

test('save: 3 runs → baselines/<name>.json with mean/min/max, conditions and a generated $comment', async () => {
  const baselinesDir = tempDir();
  const { code, out } = await call(
    ['save', 'local-1', ...runs([15.4, 16.0, 14.9]), '--note', 'laptop'],
    { baselinesDir },
  );
  assert.equal(code, 0);
  assert.match(out, /Saved baseline local-1 with \d+ metric/);
  const saved = JSON.parse(fs.readFileSync(path.join(baselinesDir, 'local-1.json'), 'utf8'));
  assert.match(saved.$comment, /What:/);
  assert.equal(saved.kind, 'cce-performance-baseline');
  assert.equal(saved.provisional, false);
  assert.equal(saved.note, 'laptop');
  assert.deepEqual(saved.metrics['collector.load.p95Ms'].values, [15.4, 16, 14.9]);
  assert.equal(saved.metrics['collector.load.p95Ms'].mean, 15.433);
  assert.equal(saved.conditions.planDefinitionSet.name, 'overlapping-4');
  assert.equal(saved.runs.length, 3);
});

test('save: fewer than BASELINE_MIN_RUNS refused; --allow-fewer → provisional; existing name needs --force', async () => {
  const baselinesDir = tempDir();
  await assert.rejects(call(['save', 'b', ...runs([15, 16])], { baselinesDir }), /at least 3 runs/);
  const { out } = await call(['save', 'b', ...runs([15, 16]), '--allow-fewer'], { baselinesDir });
  assert.match(out, /PROVISIONAL/);
  await assert.rejects(call(['save', 'b', ...runs([1, 2, 3])], { baselinesDir }), /use --force/);
  assert.equal(
    (await call(['save', 'b', ...runs([1, 2, 3]), '--force'], { baselinesDir })).code,
    0,
  );
});

test('save refuses runs measured under different conditions, listing the differences', async () => {
  const dirs = runs([15, 16, 17], (result, i) => {
    if (i === 2) result.conditions.settings.LOAD_RATE = { value: 100, source: 'cli' };
  });
  await assert.rejects(
    call(['save', 'c', ...dirs], { baselinesDir: tempDir() }),
    /LOAD_RATE=100 ≠ 50/,
  );
  const errorRun = runs([15], (result) => (result.status = 'error'));
  await assert.rejects(
    call(['save', 'c', ...errorRun, '--allow-fewer'], { baselinesDir: tempDir() }),
    /Only passed or failed runs/,
  );
});

test('compare: baseline-comparison.json in each run folder, verdicts with tolerance and unit floors', async () => {
  const baselinesDir = tempDir();
  await call(['save', 'base', ...runs([15.4, 16.0, 14.9])], { baselinesDir });
  const [slow] = runs([40]);
  const { code, out } = await call(['compare', 'base', slow], { baselinesDir });
  assert.equal(code, 0);
  const comparison = JSON.parse(
    fs.readFileSync(path.join(slow, 'baseline-comparison.json'), 'utf8'),
  );
  assert.equal(comparison.baseline, 'base');
  const p95 = comparison.rows.find((r) => r.key === 'collector.load.p95Ms');
  assert.equal(p95.verdict, 'worse');
  assert.equal(p95.current, 40);
  assert.match(out, /## Baseline comparison/);
  const [same] = runs([18]);
  await call(['compare', 'base', same], { baselinesDir });
  const sameRow = JSON.parse(
    fs.readFileSync(path.join(same, 'baseline-comparison.json'), 'utf8'),
  ).rows.find((r) => r.key === 'collector.load.p95Ms');
  assert.equal(sameRow.verdict, 'same', '+2.6 ms is below the 5 ms floor');
});

test('list and show', async () => {
  const baselinesDir = tempDir();
  assert.match((await call(['list'], { baselinesDir })).out, /No baselines yet/);
  await call(['save', 'shown', ...runs([15, 16, 17])], { baselinesDir });
  assert.match(
    (await call(['list'], { baselinesDir })).out,
    /\| shown \| .* \| local \| overlapping-4 \| 3 \| no \|/,
  );
  assert.match(
    (await call(['show', 'shown'], { baselinesDir })).out,
    /collector load p95 \| ms \| 16 \|/,
  );
  await assert.rejects(call(['show', 'missing'], { baselinesDir }), /No baseline missing/);
  await assert.rejects(call(['show', '../escape'], { baselinesDir }), /must be 1-80 letters/);
});
