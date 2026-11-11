/**
 * plan-definitions.spec.mjs — unit tests of the `plan-definitions` command (tools/commands/plan-definitions.mjs)
 *
 * What:    validate (acceptance: --set kenya-sha-emr-service passes offline; a broken set exits 1), --set NAME=value
 *          vs --plan-definition-set, generate (files
 *          written, no marker), status, load (only missing ones, with the load-test marker, then
 *          PROTOCOL_REFRESH_WAIT; RETIRED refused), retire and delete (typed yes; only the set's own
 *          definitions that carry the marker; 409 → "run cleanup first"), list-active, and the write-safety
 *          rules: allowPlanDefinitionChanges false refuses load, retire AND delete; dev without a version
 *          suffix refused, with one allowed. A fake protocol API records every call; nothing connects.
 * How:     npm test   (or: node --test tools/commands/unit-tests/plan-definitions.spec.mjs)
 * Needs:   test-data/ (A1); fixtures/plan-definitions/ (environments, a broken set).
 * Outputs: node:test results only; temporary generated files and ledgers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RefusedError, UsageError } from '../../core/errors.mjs';
import { readLedger } from '../../plan-definitions/ledger.mjs';
import { ProtocolApiError } from '../../plan-definitions/protocol-api.mjs';
import { LOADTEST_MARKER, hasLoadTestMarker } from '../../plan-definitions/sets.mjs';
import { description, main, splitSetOptions, usage } from '../plan-definitions.mjs';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'plan-definitions',
);
const BASE = 'http://openphc.org/PlanDefinition/emr-service-protocol';

/**
 * Fake protocol service: canonical → { id, status, definition }.
 * @param {Record<string, {status:string, marker?:boolean}>} [initial]
 * @param {{conflictOnDelete?: boolean}} [o]
 */
function fakeProtocolApi(initial = {}, o = {}) {
  const store = new Map();
  const calls = [];
  let next = 1;
  for (const [canonical, { status, marker = true }] of Object.entries(initial)) {
    store.set(canonical, {
      id: `id-${next++}`,
      status,
      definition: marker ? { meta: { tag: [{ ...LOADTEST_MARKER }] } } : { meta: {} },
    });
  }
  const find = (id) => [...store.entries()].find(([, v]) => v.id === id);
  const dto = (canonical, v) =>
    v ? { ...v, url: canonical.split('|')[0], version: canonical.split('|')[1], canonical } : null;
  return {
    calls,
    store,
    async getByUrlVersion(url, version) {
      calls.push(['getByUrlVersion', `${url}|${version}`]);
      const canonical = `${url}|${version}`;
      return dto(canonical, store.get(canonical));
    },
    async get(id) {
      calls.push(['get', id]);
      const hit = find(id);
      return hit ? dto(hit[0], hit[1]) : null;
    },
    async load(json) {
      calls.push(['load', `${json.url}|${json.version}`, json]);
      const value = { id: `id-${next++}`, status: 'ACTIVE', definition: json };
      store.set(`${json.url}|${json.version}`, value);
      return { id: value.id };
    },
    async retire(id) {
      calls.push(['retire', id]);
      find(id)[1].status = 'RETIRED';
    },
    async remove(id) {
      calls.push(['remove', id]);
      if (o.conflictOnDelete)
        throw new ProtocolApiError('DELETE → HTTP 409: referenced', 409, null);
      store.delete(find(id)[0]);
    },
    async list() {
      calls.push(['list']);
      return [...store.entries()].map(([canonical, v]) => dto(canonical, v));
    },
  };
}

/** Run the command with fixtures, a fake API and temporary cache folder. */
async function runCommand(argv, { api = fakeProtocolApi(), confirm, testDataRoot } = {}) {
  let out = '';
  const sleeps = [];
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cmd-'));
  const code = await main(argv, {
    stdout: { write: (s) => (out += s) },
    env: {},
    configDir: path.join(FIXTURES, 'environments'),
    cacheDir,
    protocolApi: api,
    confirm,
    sleep: async (ms) => sleeps.push(ms),
    ...(testDataRoot ? { testDataRoot } : {}),
  });
  return { code, out, api, sleeps, cacheDir };
}
const writes = (api) => api.calls.filter(([name]) => ['load', 'retire', 'remove'].includes(name));

describe('plan-definitions — offline', () => {
  it('exports the command contract', () => {
    assert.equal(typeof description, 'string');
    for (const sub of ['validate', 'generate', 'status', 'load', 'retire', 'delete', 'list-active'])
      assert.ok(usage.includes(sub), sub);
  });

  it('acceptance: validate --set kenya-sha-emr-service passes offline (no API call)', async () => {
    const { code, out, api } = await runCommand(['validate', '--set', 'kenya-sha-emr-service']);
    assert.equal(code, 0);
    // DATASET empty: checked against the set's own dataset.
    assert.match(
      out,
      /✔ kenya-sha-emr-service: 1 plan definition\(s\) valid \(mandatory steps 5; dataset tiberbu-emr\)/,
    );
    assert.deepEqual(api.calls, []);
  });

  it('validate without --set checks every set', async () => {
    const { code, out } = await runCommand(['validate']);
    assert.equal(code, 0);
    for (const name of ['emr-service', 'kenya-sha-emr-service'])
      assert.match(out, new RegExp(`✔ ${name}:`));
  });

  it('validate exits 1 on a broken set (tolerance-days on a could step)', async () => {
    const { code, out } = await runCommand(['validate', '--set', 'broken'], {
      testDataRoot: path.join(FIXTURES, 'test-data'),
    });
    assert.equal(code, 1);
    assert.match(out, /✖ broken.*\n.*Optional action 'only-step'/);
  });

  it('generate writes the plan definitions as loaded (suffix applied, no marker)', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gen-'));
    const run = await runCommand([
      'generate',
      '--set',
      'kenya-sha-emr-service',
      '--out',
      out,
      '--setting',
      'PLAN_DEFINITION_VERSION_SUFFIX=-lt',
    ]);
    assert.equal(run.code, 0);
    const files = fs.readdirSync(out).sort();
    // Named after the resource id, which differs from the file name for this protocol.
    assert.deepEqual(files, ['kenya-sha-emr-outpatient-service-protocol.json']);
    const kenya = JSON.parse(fs.readFileSync(path.join(out, files[0]), 'utf8'));
    assert.equal(kenya.url, 'http://openphc.org/PlanDefinition/kenya-sha-emr-service-protocol');
    assert.equal(kenya.version, '1.0.0-lt');
    assert.equal(hasLoadTestMarker(kenya), false);
  });

  it('generate defaults to .cache/plan-definitions/generated/<set>/', async () => {
    const run = await runCommand(['generate', '--set', 'emr-service']);
    assert.ok(
      fs.existsSync(
        path.join(run.cacheDir, 'generated', 'emr-service', 'emr-service-protocol.json'),
      ),
    );
  });

  it('--set NAME=value overrides a setting as in every command; --plan-definition-set names the set', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gen-'));
    const run = await runCommand([
      'generate',
      '--plan-definition-set',
      'emr-service',
      '--out',
      out,
      '--set',
      'PLAN_DEFINITION_VERSION_SUFFIX=-lt',
    ]);
    assert.equal(run.code, 0);
    const generated = JSON.parse(
      fs.readFileSync(path.join(out, 'emr-service-protocol.json'), 'utf8'),
    );
    assert.equal(generated.version, '1.0.0-lt');
    assert.deepEqual(splitSetOptions({ set: ['emr-service', 'A=1'], setting: ['B=2'] }), {
      setName: 'emr-service',
      settingPairs: ['A=1', 'B=2'],
    });
    await assert.rejects(
      runCommand([
        'generate',
        '--plan-definition-set',
        'emr-service',
        '--set',
        'kenya-sha-emr-service',
      ]),
      /Name one plan-definition set/,
    );
  });

  it('refuses wrong usage and prod', async () => {
    await assert.rejects(runCommand(['nope']), UsageError);
    await assert.rejects(runCommand(['status', '--set', 'emr-service']), UsageError);
    await assert.rejects(runCommand(['generate']), UsageError);
    await assert.rejects(runCommand(['validate', 'local']), UsageError);
    await assert.rejects(runCommand(['load', 'prod', '--set', 'emr-service']), RefusedError);
  });
});

describe('plan-definitions — status and list-active (read-only)', () => {
  it('status shows ACTIVE / missing and the marker', async () => {
    const api = fakeProtocolApi({ [`${BASE}|1.0.0`]: { status: 'ACTIVE', marker: false } });
    const active = await runCommand(['status', 'local', '--set', 'emr-service'], { api });
    assert.equal(active.code, 0);
    assert.match(active.out, new RegExp(`${BASE}\\|1\\.0\\.0\\s+ACTIVE\\s+id-1\\s+no`));
    const missing = await runCommand(['status', 'local', '--set', 'kenya-sha-emr-service'], {
      api,
    });
    assert.equal(missing.code, 0);
    assert.match(missing.out, /kenya-sha-emr-service-protocol\|1\.0\.0\s+missing/);
    assert.deepEqual(writes(api), []);
  });

  it('list-active prints every ACTIVE definition from the API', async () => {
    const api = fakeProtocolApi({
      'http://real/other|2.0.0': { status: 'ACTIVE' },
      'http://real/old|1.0.0': { status: 'RETIRED' },
    });
    const { code, out } = await runCommand(['list-active', 'local'], { api });
    assert.equal(code, 0);
    assert.match(out, /http:\/\/real\/other\|2\.0\.0/);
    assert.ok(!out.includes('http://real/old'));
  });
});

describe('plan-definitions — load', () => {
  it('loads only the missing ones, with the load-test marker, records the ledger, waits PROTOCOL_REFRESH_WAIT', async () => {
    const api = fakeProtocolApi({ [`${BASE}|1.0.0`]: { status: 'ACTIVE' } });
    const { code, out, sleeps, cacheDir } = await runCommand(
      ['load', 'local', '--set', 'kenya-sha-emr-service'],
      { api },
    );
    assert.equal(code, 0, out);
    const loads = api.calls.filter(([name]) => name === 'load');
    assert.equal(loads.length, 1);
    for (const [, , json] of loads) assert.equal(hasLoadTestMarker(json), true);
    assert.deepEqual(sleeps, [65_000]);
    assert.deepEqual(
      readLedger({ cacheDir, environmentName: 'local' }).map((e) => e.action),
      ['load'],
    );
    // Nothing to load when the set is already ACTIVE: no write, no wait.
    const again = await runCommand(['load', 'local', '--set', 'emr-service'], { api });
    assert.equal(again.code, 0);
    assert.equal(api.calls.filter(([name]) => name === 'load').length, 1);
  });

  it('refuses a RETIRED url+version (it can never be ACTIVE again)', async () => {
    const api = fakeProtocolApi({ [`${BASE}|1.0.0`]: { status: 'RETIRED' } });
    await assert.rejects(
      runCommand(['load', 'local', '--set', 'emr-service'], { api }),
      /RETIRED.*PLAN_DEFINITION_VERSION_SUFFIX/,
    );
    assert.deepEqual(writes(api), []);
  });
});

describe('plan-definitions — write safety (plan §7.3)', () => {
  it('safety.allowPlanDefinitionChanges false refuses load, retire AND delete before any API call', async () => {
    for (const sub of ['load', 'retire', 'delete']) {
      const api = fakeProtocolApi({ [`${BASE}|1.0.0`]: { status: 'ACTIVE' } });
      await assert.rejects(
        runCommand([sub, 'locked', '--set', 'emr-service', '--yes'], { api }),
        /allowPlanDefinitionChanges/,
      );
      assert.deepEqual(api.calls, [], `${sub} must not call the API`);
    }
  });

  it('dev without a version suffix is refused; with PLAN_DEFINITION_VERSION_SUFFIX it loads the suffixed version', async () => {
    const refused = fakeProtocolApi();
    await assert.rejects(
      runCommand(['load', 'shared-dev', '--set', 'emr-service'], { api: refused }),
      /PLAN_DEFINITION_VERSION_SUFFIX/,
    );
    assert.deepEqual(refused.calls, []);
    const api = fakeProtocolApi();
    const { code } = await runCommand(
      [
        'load',
        'shared-dev',
        '--set',
        'emr-service',
        '--setting',
        'PLAN_DEFINITION_VERSION_SUFFIX=-loadtest',
      ],
      { api },
    );
    assert.equal(code, 0);
    assert.deepEqual(
      api.calls.filter(([n]) => n === 'load').map(([, c]) => c),
      [`${BASE}|1.0.0-loadtest`],
    );
  });
});

describe('plan-definitions — retire and delete', () => {
  it("retire --yes retires the set's marked ACTIVE definitions and nothing else", async () => {
    const api = fakeProtocolApi({
      [`${BASE}|1.0.0`]: { status: 'ACTIVE' },
      'http://real/other|2.0.0': { status: 'ACTIVE' },
    });
    const { code, sleeps } = await runCommand(
      ['retire', 'local', '--set', 'emr-service', '--yes'],
      {
        api,
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(writes(api), [['retire', 'id-1']]);
    assert.equal(
      api.store.get('http://real/other|2.0.0').status,
      'ACTIVE',
      'outside the set: untouched',
    );
    assert.deepEqual(sleeps, [65_000]);
  });

  it('never retires or deletes a definition without the marker, even inside the set (exit 2)', async () => {
    for (const sub of ['retire', 'delete']) {
      const api = fakeProtocolApi({ [`${BASE}|1.0.0`]: { status: 'ACTIVE', marker: false } });
      const { code, out } = await runCommand([sub, 'local', '--set', 'emr-service', '--yes'], {
        api,
      });
      assert.equal(code, 2);
      assert.match(out, /not loaded by this tool \(no load-test marker\): left untouched/);
      assert.deepEqual(writes(api), []);
    }
  });

  it('asks for a typed yes (irreversible warning); no yes → refused, nothing retired', async () => {
    const api = fakeProtocolApi({ [`${BASE}|1.0.0`]: { status: 'ACTIVE' } });
    let question = '';
    await assert.rejects(
      runCommand(['retire', 'local', '--set', 'emr-service'], {
        api,
        confirm: async (q) => ((question = q), false),
      }),
      /not confirmed/,
    );
    assert.match(question, /Type yes/);
    assert.deepEqual(writes(api), []);
  });

  it('delete: 409 (instances still reference it) tells the user to run cleanup first', async () => {
    const api = fakeProtocolApi(
      { [`${BASE}|1.0.0`]: { status: 'RETIRED' } },
      { conflictOnDelete: true },
    );
    const { code, out } = await runCommand(['delete', 'local', '--set', 'emr-service', '--yes'], {
      api,
    });
    assert.equal(code, 2);
    assert.match(out, /HTTP 409\): run cleanup first/);
  });

  it('delete removes a marked definition and records it in the ledger', async () => {
    const api = fakeProtocolApi({ [`${BASE}|1.0.0`]: { status: 'RETIRED' } });
    const { code, cacheDir } = await runCommand(
      ['delete', 'local', '--set', 'emr-service', '--yes'],
      {
        api,
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(writes(api), [['remove', 'id-1']]);
    assert.deepEqual(
      readLedger({ cacheDir, environmentName: 'local' }).map((e) => e.action),
      ['delete'],
    );
  });
});
