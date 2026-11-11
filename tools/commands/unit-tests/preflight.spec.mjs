/**
 * preflight.spec.mjs — unit tests of the `preflight` command (tools/commands/preflight.mjs)
 *
 * What:    The command contract of plan §6.1 (description, usage, main → exit code): --help, usage errors,
 *          prod refused, exit 0 on a healthy (fake) stack and 2 when a required check fails, --json output and
 *          --out file that validate against A2's validatePreflight. Clients are the fake stack, so nothing
 *          connects anywhere.
 * How:     npm test   (or: node --test tools/commands/unit-tests/preflight.spec.mjs)
 * Needs:   config/environments/local.json (A2), test-data/ (A1), tools/preflight/unit-tests/fake-clients.mjs.
 * Outputs: node:test results only; a temporary preflight.json.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RefusedError, UsageError } from '../../core/errors.mjs';
import { repoPath } from '../../core/paths.mjs';
import { validatePreflight } from '../../core/result-schema.mjs';
import { MODULES, fakeStack } from '../../preflight/unit-tests/fake-clients.mjs';
import { description, main, usage } from '../preflight.mjs';

/** Run the command with the fake stack; returns exit code and printed text. */
async function runCommand(argv, stackOptions = {}) {
  const fake = fakeStack({ resultsRoot: repoPath('results'), ...stackOptions });
  let out = '';
  const code = await main(argv, {
    stdout: { write: (s) => (out += s) },
    env: fake.clients.env,
    clients: fake.clients,
    modules: MODULES,
  });
  return { code, out };
}

describe('preflight command', () => {
  it('exports the command contract', () => {
    assert.equal(typeof description, 'string');
    assert.match(usage, /^Usage: preflight <env>/);
  });

  it('--help prints the usage and exits 0', async () => {
    const { code, out } = await runCommand(['--help']);
    assert.equal(code, 0);
    assert.match(out, /--subject/);
  });

  it('refuses wrong usage and prod', async () => {
    await assert.rejects(runCommand([]), UsageError);
    await assert.rejects(runCommand(['local', '--bogus']), UsageError);
    await assert.rejects(runCommand(['prod']), RefusedError);
  });

  it('exit 0 and the ✔ table on a healthy stack', async () => {
    const { code, out } = await runCommand(['local', '--subject', 'matcher']);
    assert.equal(code, 0, out);
    assert.match(out, /✔ service-health\.matcher/);
    assert.match(out, /Preflight passed/);
  });

  it('exit 2 when a required check fails', async () => {
    const { code, out } = await runCommand(['local', '--subject', 'matcher'], {
      health: { matcher: { status: 'DOWN' } },
    });
    assert.equal(code, 2);
    assert.match(out, /✖ service-health\.matcher/);
  });

  it('--json prints and --out writes a preflight.json that validatePreflight accepts', async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-cmd-')),
      'preflight.json',
    );
    const { code, out } = await runCommand([
      'local',
      '--subject',
      'collector',
      '--json',
      '--out',
      file,
      '--set',
      'PLAN_DEFINITION_SET=kenya-sha-emr-service',
    ]);
    assert.equal(code, 0);
    const printed = JSON.parse(out.slice(0, out.lastIndexOf('}') + 1));
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(validatePreflight(written), []);
    assert.equal(written.planDefinitionSet, 'kenya-sha-emr-service');
    assert.equal(printed.status, written.status);
  });
});
