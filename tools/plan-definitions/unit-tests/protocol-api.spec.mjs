/**
 * protocol-api.spec.mjs — unit tests of protocol-api.mjs, active.mjs and ledger.mjs
 *
 * What:    With a fake HTTP transport (no network): the protocol API client builds the right URLs (by-url-version
 *          encoded, list size=200, retire, delete), sends the plan definition as a JSON *string* in
 *          { planDefinitionJson }, turns 404 into null and 409 into ProtocolApiError(status 409).
 *          getActivePlanDefinitions keeps ACTIVE rows from the API and falls back to the database when the API
 *          fails. The ledger appends and reads entries in a temporary folder.
 * How:     npm test   (or: node --test tools/plan-definitions/unit-tests/protocol-api.spec.mjs)
 * Needs:   Nothing external.
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ACTIVE_DEFINITIONS_SQL, getActivePlanDefinitions } from '../active.mjs';
import { appendLedger, readLedger } from '../ledger.mjs';
import { ProtocolApiError, createProtocolApi } from '../protocol-api.mjs';

const ENV = {
  name: 'local',
  services: {
    protocol: { baseUrl: 'http://p:8096/', apiPath: '/v1/protocol/protocol-definitions' },
  },
};
const BASE = 'http://p:8096/v1/protocol/protocol-definitions';

/** Fake transport: records requests, answers from a function. */
function fakeHttp(answer) {
  const requests = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      return answer(req);
    },
  };
}

describe('createProtocolApi', () => {
  it('looks up by url + version (encoded) and maps 404 to null', async () => {
    const http = fakeHttp(() => ({ status: 404, body: null }));
    const api = createProtocolApi(ENV, { http });
    assert.equal(await api.getByUrlVersion('http://x/p a', '1.0.0-loadtest'), null);
    assert.equal(http.requests[0].method, 'GET');
    assert.equal(
      http.requests[0].url,
      `${BASE}/by-url-version?url=http%3A%2F%2Fx%2Fp%20a&version=1.0.0-loadtest`,
    );
  });

  it('lists one page of 200 and unwraps the Spring page content', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: { content: [{ id: '1', status: 'ACTIVE' }] },
    }));
    const rows = await createProtocolApi(ENV, { http }).list();
    assert.equal(http.requests[0].url, `${BASE}?size=200`);
    assert.deepEqual(rows, [{ id: '1', status: 'ACTIVE' }]);
  });

  it('loads with the plan definition as a JSON string in planDefinitionJson', async () => {
    const http = fakeHttp(() => ({ status: 201, body: { id: 'new' } }));
    const json = { resourceType: 'PlanDefinition', url: 'u', version: '1' };
    const answer = await createProtocolApi(ENV, { http }).load(json);
    assert.equal(answer.id, 'new');
    assert.equal(http.requests[0].method, 'POST');
    assert.equal(typeof http.requests[0].body.planDefinitionJson, 'string');
    assert.deepEqual(JSON.parse(http.requests[0].body.planDefinitionJson), json);
  });

  it('retires with POST /{id}/retire and deletes with DELETE /{id}; 409 keeps its status', async () => {
    const http = fakeHttp((req) =>
      req.method === 'DELETE'
        ? { status: 409, body: { message: 'in use' } }
        : { status: 200, body: {} },
    );
    const api = createProtocolApi(ENV, { http });
    await api.retire('abc');
    assert.deepEqual(
      [http.requests[0].method, http.requests[0].url],
      ['POST', `${BASE}/abc/retire`],
    );
    await assert.rejects(
      api.remove('abc'),
      (error) =>
        error instanceof ProtocolApiError && error.status === 409 && /in use/.test(error.message),
    );
    assert.deepEqual([http.requests[1].method, http.requests[1].url], ['DELETE', `${BASE}/abc`]);
  });

  it('refuses an environment without a protocol service', () => {
    assert.throws(() => createProtocolApi({ name: 'x', services: {} }), /protocol/);
  });
});

describe('getActivePlanDefinitions', () => {
  it('keeps the ACTIVE rows from the API', async () => {
    const protocolApi = {
      list: async () => [
        { id: '1', url: 'u1', version: '1', status: 'ACTIVE', loadedAt: '2026-11-05T10:00:00Z' },
        { id: '2', url: 'u2', version: '1', status: 'RETIRED' },
      ],
    };
    const active = await getActivePlanDefinitions(ENV, { protocolApi });
    assert.deepEqual(active, [
      {
        id: '1',
        url: 'u1',
        version: '1',
        canonical: 'u1|1',
        status: 'ACTIVE',
        updatedAt: '2026-11-05T10:00:00Z',
        source: 'api',
      },
    ]);
  });

  it('falls back to the database (read-only query) when the API fails', async () => {
    const queries = [];
    const pgPool = {
      query: async (sql) => {
        queries.push(sql);
        return {
          rows: [
            {
              id: '9',
              url: 'u9',
              version: '2',
              status: 'ACTIVE',
              updated_at: new Date('2026-11-05T00:00:00Z'),
            },
          ],
        };
      },
    };
    const protocolApi = {
      list: async () => {
        throw new Error('down');
      },
    };
    const active = await getActivePlanDefinitions(ENV, { protocolApi, pgPool });
    assert.deepEqual(queries, [ACTIVE_DEFINITIONS_SQL]);
    assert.match(ACTIVE_DEFINITIONS_SQL, /^SELECT /);
    assert.equal(active[0].canonical, 'u9|2');
    assert.equal(active[0].source, 'database');
  });

  it('throws when neither API nor database is available', async () => {
    await assert.rejects(getActivePlanDefinitions(ENV, {}), /No protocol API or database/);
  });
});

describe('ledger', () => {
  it('appends entries per environment and reads them back', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-'));
    assert.deepEqual(readLedger({ cacheDir, environmentName: 'local' }), []);
    appendLedger({
      cacheDir,
      environmentName: 'local',
      entry: { action: 'load', canonical: 'u|1', id: 'a' },
    });
    appendLedger({
      cacheDir,
      environmentName: 'local',
      entry: { action: 'retire', canonical: 'u|1', id: 'a' },
    });
    const entries = readLedger({ cacheDir, environmentName: 'local' });
    assert.deepEqual(
      entries.map((e) => e.action),
      ['load', 'retire'],
    );
    assert.ok(entries[0].at);
    assert.deepEqual(readLedger({ cacheDir, environmentName: 'dev' }), []);
    const file = JSON.parse(fs.readFileSync(path.join(cacheDir, 'local-ledger.json'), 'utf8'));
    assert.match(file.$comment, /What:.*How:.*Needs:.*Outputs:/);
  });
});
