/**
 * cleanup.spec.mjs — unit tests of the `cleanup` command (tools/commands/cleanup.mjs)
 *
 * What:    The acceptance commands run offline: `cleanup local --run-id 20261105-142233 --print-sql` prints
 *          settings, stage, count, batched delete and verify SQL for all 13 tables, and a v1 run id shows the
 *          legacy branch. Usage errors and prod are refused. With fake clients: delete --yes ends verified
 *          (exit 0) and saves the JSON next to the run found by its run-context.json; no "yes" → 2;
 *          incomplete → 1; dry-run → 0; --json prints the cleanup JSON; without the DB password the command
 *          refuses before connecting.
 * How:     npm test   (or: node --test tools/commands/unit-tests/cleanup.spec.mjs)
 * Needs:   config/environments/local.json (A2); fixtures/cleanup/ (copied to a temporary folder first);
 *          tools/cleanup/unit-tests/fake-pg.mjs. Nothing connects anywhere.
 * Outputs: node:test results only; temporary cleanup JSON files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEANUP_TABLES } from '../../cleanup/cleanup-tables.mjs';
import {
  fakeCleanupDb,
  fakeExec,
  fakeKafkaAdmin,
  fakeStatfs,
} from '../../cleanup/unit-tests/fake-pg.mjs';
import { RefusedError, UsageError } from '../../core/errors.mjs';
import { validateCleanup } from '../../core/result-schema.mjs';
import { description, main, usage } from '../cleanup.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cleanup');

/** A temporary results folder; with `withRun`, holding a copy of the fixture run folder. */
function resultsFolder(withRun = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-cmd-'));
  if (withRun) fs.cpSync(path.join(FIXTURES, 'run-folder'), root, { recursive: true });
  return root;
}

/** Run the command; `db` options make fake clients, `null` means "no clients injected". */
async function runCommand(
  argv,
  { db = {}, confirm, resultsRoot = resultsFolder(), env = {} } = {},
) {
  let out = '';
  const fake = db === null ? null : fakeCleanupDb(db);
  const io = { stdout: { write: (s) => (out += s) }, env, resultsRoot, confirm };
  if (fake)
    io.clients = {
      pgPool: fake.pool,
      kafkaAdmin: fakeKafkaAdmin([0]),
      statfs: fakeStatfs(100),
      exec: fakeExec,
      sleep: async () => {},
    };
  const code = await main(argv, io);
  return { code, out, fake, resultsRoot };
}

describe('cleanup command — offline', () => {
  it('exports the command contract', () => {
    assert.equal(typeof description, 'string');
    assert.match(usage, /--legacy-v1/);
    assert.match(usage, /--print-sql/);
  });

  it('acceptance: --print-sql for 20261105-142233 covers all 13 tables, connects to nothing', async () => {
    const { code, out } = await runCommand(
      ['local', '--run-id', '20261105-142233', '--print-sql'],
      { db: null },
    );
    assert.equal(code, 0);
    assert.match(out, /^-- Settings:\n-- {3}CLEANUP_LEGACY_V1/);
    for (const { table } of CLEANUP_TABLES) assert.ok(out.includes(table), table);
    for (const kind of [
      'CREATE TEMP TABLE lt_pi',
      'SELECT count(*)::bigint AS n FROM lt_pi',
      'BEGIN;',
      "SET LOCAL lock_timeout = '5000ms';",
      'COMMIT;',
      'FROM protocol_instance WHERE id IN (SELECT id FROM lt_pi_all)',
    ]) {
      assert.ok(out.includes(kind), kind);
    }
    assert.ok(!out.includes('raw_payload'));
  });

  it('acceptance: --print-sql for the v1 id 1103172520 shows the legacy branch', async () => {
    const { code, out } = await runCommand(['local', '--run-id', '1103172520', '--print-sql'], {
      db: null,
    });
    assert.equal(code, 0);
    assert.match(out, /legacy v1 branch ON/);
    assert.match(out, /raw_payload->>'subject' LIKE 'LOADTEST-1103172520-%'/);
  });

  it('refuses wrong usage, bad run ids and prod', async () => {
    await assert.rejects(runCommand(['local', '--print-sql'], { db: null }), UsageError);
    await assert.rejects(
      runCommand(['local', '--all', '--run-id', '20261105-142233'], { db: null }),
      UsageError,
    );
    await assert.rejects(
      runCommand(['local', '--all', '--dry-run', '--print-sql'], { db: null }),
      UsageError,
    );
    await assert.rejects(runCommand(['local', '--run-id', 'bad-id'], { db: null }), RefusedError);
    await assert.rejects(runCommand(['prod', '--all', '--print-sql'], { db: null }), RefusedError);
  });

  it('refuses to connect without the DB password variable', async () => {
    await assert.rejects(
      runCommand(['local', '--run-id', '20261105-142233', '--dry-run'], { db: null }),
      /DB_PASSWORD/,
    );
  });
});

describe('cleanup command — with a fake database', () => {
  it('delete --yes: verified, exit 0, JSON saved next to the run found by run-context.json', async () => {
    const resultsRoot = resultsFolder(true);
    const { code, out, fake } = await runCommand(
      ['local', '--run-id', '20261105-142233', '--yes'],
      { resultsRoot },
    );
    assert.equal(code, 0, out);
    assert.match(out, /: verified/);
    assert.match(out, /protocol_instance\s+3\s+3\s+0/);
    const saved = /Saved: (.+)\n/.exec(out)[1];
    assert.equal(path.dirname(saved), path.join(resultsRoot, 'matcher-smoke-20261105-142233'));
    const json = JSON.parse(fs.readFileSync(saved, 'utf8'));
    assert.deepEqual(validateCleanup(json), []);
    assert.match(json.scope.usedRunContext, /run-context\.json$/);
    assert.equal(fake.pool.connects, 1);
  });

  it('no typed "yes": refused, exit 2, nothing deleted', async () => {
    const { code, fake } = await runCommand(['local', '--run-id', '20261105-142233'], {
      confirm: async () => false,
    });
    assert.equal(code, 2);
    assert.ok(!fake.statements.some((s) => /^WITH b AS/.test(s)));
  });

  it('incomplete: exit 1', async () => {
    const { code } = await runCommand(['local', '--run-id', '20261105-142233', '--yes'], {
      db: { remaining: { inbound_event_log: 2 } },
    });
    assert.equal(code, 1);
  });

  it('--dry-run: exit 0, rolled back, counts printed', async () => {
    const { code, out, fake } = await runCommand(['local', '--all', '--dry-run']);
    assert.equal(code, 0);
    assert.match(out, /\(dry-run\): dry-run/);
    assert.equal(fake.statements.at(-1), 'ROLLBACK');
  });

  it('--json prints the cleanup JSON; --set changes the batch size', async () => {
    const { code, out, fake } = await runCommand([
      'local',
      '--run-id',
      '20261105-142233',
      '--yes',
      '--json',
      '--set',
      'CLEANUP_BATCH_SIZE=2',
    ]);
    assert.equal(code, 0);
    const json = JSON.parse(out);
    assert.equal(json.status, 'verified');
    assert.deepEqual(json.settings.CLEANUP_BATCH_SIZE, { value: 2, source: 'cli' });
    assert.ok(fake.statements.some((s) => /LIMIT 2\)/.test(s)));
  });
});
