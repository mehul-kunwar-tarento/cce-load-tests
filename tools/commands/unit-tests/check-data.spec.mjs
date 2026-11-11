/**
 * check-data.spec.mjs — unit tests of tools/commands/check-data.mjs (the `check-data` command).
 *
 * What:    Re-running the data checks of a finished stub run (fake clients, no connection) rewrites
 *          data-checks.json, result.json (with a note) and report.md; applyDataChecks turns a failed required
 *          check into "what broke" and a failed status, leaves info checks and aborted runs alone; a folder
 *          without run-context.json or a different environment is refused.
 * How:     node --test tools/commands/unit-tests/check-data.spec.mjs
 * Needs:   fixtures/check-data/stub-load-20261105-142234/, the stub module.
 * Outputs: Test results only (temporary copies).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateResult } from '../../core/result-schema.mjs';
import { copyFixture, sink, tempDir } from '../../core/unit-tests/helpers.mjs';
import { applyDataChecks, main } from '../check-data.mjs';

const MODULES_ROOT = new URL('../../core/unit-tests/fixtures', import.meta.url).pathname;
const RUN = new URL('./fixtures/check-data/stub-load-20261105-142234', import.meta.url).pathname;
const fakeClients = async () => ({
  pgPool: null,
  kafkaAdmin: null,
  scrape: async () => new Map(),
  close: async () => {},
});

test('re-runs the module data checks and rewrites data-checks.json, result.json and report.md', async () => {
  const dir = copyFixture(RUN, path.join(tempDir(), 'stub-load-20261105-142234'));
  const out = sink();
  const code = await main(
    ['local', dir, '--modules-root', MODULES_ROOT],
    { stdout: out, stderr: sink() },
    { createRunClients: fakeClients, env: {} },
  );
  assert.equal(code, 0);
  const checks = JSON.parse(fs.readFileSync(path.join(dir, 'data-checks.json'), 'utf8')).checks;
  assert.equal(checks[0].id, 'stub.nothing-to-check');
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  assert.deepEqual(validateResult(result), []);
  assert.match(result.notes.at(-1), /Data checks re-run at .* \(check-data\)/);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /^# Stub load — PASSED/);
  assert.match(out.text, /Stub load — PASSED/);
});

test('applyDataChecks: a failed required check fails the run and is listed in what broke; info checks never do', () => {
  const result = JSON.parse(fs.readFileSync(path.join(RUN, 'result.json'), 'utf8'));
  applyDataChecks(
    result,
    [
      {
        id: 'x.stored',
        description: 'Stored = accepted',
        expected: 100,
        actual: 97,
        comparison: 'equals',
        passed: false,
        severity: 'required',
      },
    ],
    new Date(),
  );
  assert.equal(result.status, 'failed');
  assert.match(result.statusReason, /data check x\.stored: expected 100, got 97/);
  assert.deepEqual(
    result.breaking.whatBroke.filter((w) => w.source === 'data-check').map((w) => w.metric),
    ['x.stored'],
  );
  applyDataChecks(
    result,
    [
      {
        id: 'x.info',
        description: 'info',
        expected: 1,
        actual: 0,
        comparison: 'equals',
        passed: false,
        severity: 'info',
      },
    ],
    new Date(),
  );
  assert.equal(result.status, 'passed');
  assert.equal(
    result.breaking.whatBroke.filter((w) => w.source === 'data-check').length,
    0,
    'old entries replaced',
  );
  const aborted = {
    ...JSON.parse(fs.readFileSync(path.join(RUN, 'result.json'), 'utf8')),
    status: 'aborted',
    statusReason: 'Aborted: Ctrl-C',
  };
  applyDataChecks(aborted, [], new Date());
  assert.equal(aborted.status, 'aborted', 'an aborted run stays aborted');
});

test('refused: a folder without run-context.json, another environment, wrong arity', async () => {
  const empty = tempDir();
  await assert.rejects(
    main(['local', empty], { stdout: sink() }, { createRunClients: fakeClients }),
    /has no run-context\.json/,
  );
  const dir = copyFixture(RUN, path.join(tempDir(), 'run'));
  const contextFile = path.join(dir, 'run-context.json');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  context.environment.name = 'dev';
  fs.writeFileSync(contextFile, JSON.stringify(context));
  await assert.rejects(
    main(
      ['local', dir, '--modules-root', MODULES_ROOT],
      { stdout: sink(), stderr: sink() },
      { createRunClients: fakeClients },
    ),
    /used environment dev/,
  );
  await assert.rejects(main(['local'], { stdout: sink() }), /check-data needs/);
});
