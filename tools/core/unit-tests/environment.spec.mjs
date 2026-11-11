/**
 * environment.spec.mjs — unit tests of tools/core/environment.mjs (plan §3.1, §2.1).
 *
 * What:    Prod is refused (by name, file name or kind), the local file loads and validates, <env>.local.json is
 *          deep-merged, passwords in files are refused, serviceConfig maps step-sla → stepSla
 *          (and falls back to adaptors.<key>).
 * How:     node --test tools/core/unit-tests/environment.spec.mjs
 * Needs:   config/environments/local.json; temporary folders for invented environments.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RefusedError, environmentForK6, loadEnvironment, serviceConfig } from '../environment.mjs';
import { readJsonFile } from '../json-file.mjs';
import { repoPath } from '../paths.mjs';
import { tempDir } from './helpers.mjs';

/** A temporary config folder with a copy of local.json under another name, optionally changed. */
function configWith(name, change = (e) => e, extraFiles = {}) {
  const dir = tempDir();
  const local = readJsonFile(repoPath('config/environments/local.json'));
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(change({ ...local, name })));
  for (const [file, content] of Object.entries(extraFiles))
    fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
  return dir;
}

test('local loads, has no $comment and a repository-relative configFile', () => {
  const environment = loadEnvironment('local');
  assert.equal(environment.kind, 'local');
  assert.equal(environment.configFile, 'config/environments/local.json');
  assert.ok(!('$comment' in environment));
  assert.equal(environment.monitoring.grafanaUser, 'admin');
  assert.equal(environment.services.stepSla.baseUrl, 'http://localhost:8099');
});

test('prod is refused: by name, by file name and by kind', () => {
  assert.throws(() => loadEnvironment('prod'), RefusedError);
  assert.throws(() => loadEnvironment('my-production'), RefusedError);
  const dir = configWith('live', (e) => ({ ...e, kind: 'prod' }));
  assert.throws(() => loadEnvironment('live', { configDir: dir }), /production/);
  const dir2 = configWith('other', (e) => ({ ...e, name: 'prod-eu' }));
  assert.throws(() => loadEnvironment('other', { configDir: dir2 }), RefusedError);
});

test('an unknown environment lists the known ones', () => {
  assert.throws(() => loadEnvironment('nowhere'), /Known: local/);
});

test('<env>.local.json is deep-merged over <env>.json', () => {
  const dir = configWith('dev', (e) => ({ ...e, kind: 'dev' }), {
    'dev.local.json': { services: { collector: { baseUrl: 'http://other:1' } } },
  });
  const environment = loadEnvironment('dev', { configDir: dir });
  assert.equal(environment.services.collector.baseUrl, 'http://other:1');
  assert.equal(environment.services.collector.healthPath, '/actuator/health', 'other fields kept');
});

test('a password in the file is refused (secrets come from env vars only)', () => {
  const dir = configWith('dev', (e) => ({
    ...e,
    kind: 'dev',
    database: { ...e.database, password: 'x' },
  }));
  assert.throws(() => loadEnvironment('dev', { configDir: dir }), /password must not be in a file/);
});

test('serviceConfig maps subjects to environment keys (step-sla → stepSla)', () => {
  const environment = loadEnvironment('local');
  assert.equal(serviceConfig(environment, 'step-sla').baseUrl, 'http://localhost:8099');
  assert.equal(serviceConfig(environment, 'collector').baseUrl, 'http://localhost:8093');
  assert.equal(serviceConfig(environment, 'stub'), null);
  // A later adaptor module's address lives in adaptors.<key> (plan §10.4).
  const withAdaptor = { ...environment, adaptors: { 'stub-adaptor': { baseUrl: 'http://a' } } };
  assert.equal(serviceConfig(withAdaptor, 'stub-adaptor').baseUrl, 'http://a');
});

test('the k6 view of an environment has no database block', () => {
  const k6View = environmentForK6(loadEnvironment('local'));
  assert.ok(!('database' in k6View));
  assert.deepEqual(Object.keys(k6View).sort(), ['kafka', 'kind', 'name', 'services']);
});

test('the example environments are valid templates (dev/uat kinds, safety off, monitoring off)', () => {
  for (const kind of ['dev', 'uat']) {
    const example = readJsonFile(repoPath(`config/environments/${kind}.example.json`));
    assert.equal(example.kind, kind);
    assert.equal(example.safety.allowTempIndex, false);
    assert.equal(example.safety.allowPlanDefinitionChanges, false);
    assert.equal(example.monitoring.enabled, false);
    assert.match(JSON.stringify(example.services), /REPLACE-ME/);
  }
});
