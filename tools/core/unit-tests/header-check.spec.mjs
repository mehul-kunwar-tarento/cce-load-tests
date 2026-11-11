/**
 * header-check.spec.mjs — unit tests of tools/core/header-check.mjs (plan §2.4 exact scope).
 *
 * What:    Text headers (JS, shell after a shebang, YAML, Markdown comment), JSON headers ("$comment",
 *          package.json description, dashboard description, JSON Schema native $comment), the scope
 *          (fixtures/, archive/, test-data/plan-definitions/, package-lock.json excluded) and the git-ignored
 *          exclusion (with a fake ignore list, as `git ls-files --others --ignored` would give).
 * How:     node --test tools/core/unit-tests/header-check.spec.mjs
 * Needs:   A temporary repository-like folder.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkHeaders,
  checkJsonHeader,
  checkTextHeader,
  isInScope,
  listIgnored,
} from '../header-check.mjs';
import { tempDir } from './helpers.mjs';

const LABELS = 'What: x\n * How: y\n * Needs: z\n * Outputs: w';
const GOOD_JS = `/**\n * a.mjs — x\n *\n * ${LABELS}\n */\nexport {};\n`;
const COMMENT = 'What: a How: b Needs: c Outputs: d';

test('text headers: JS, shell after a shebang, YAML, Markdown comment; missing labels named', () => {
  assert.equal(checkTextHeader('a.mjs', GOOD_JS), null);
  assert.equal(
    checkTextHeader(
      's.sh',
      '#!/usr/bin/env bash\n# s.sh\n# What: a\n# How: b\n# Needs: c\n# Outputs: d\n',
    ),
    null,
  );
  assert.equal(
    checkTextHeader('c.yml', '# What: a\n# How: b\n# Needs: c\n# Outputs: d\nx: 1\n'),
    null,
  );
  assert.equal(
    checkTextHeader('r.md', '<!--\n  What: a\n  How: b\n  Needs: c\n  Outputs: d\n-->\n# T\n'),
    null,
  );
  assert.match(checkTextHeader('r.md', '# Title\nWhat: a'), /does not start with a header comment/);
  assert.match(checkTextHeader('a.mjs', '/**\n * What: a\n * How: b\n */'), /lacks Needs, Outputs/);
  const late = `/**\n${' * filler\n'.repeat(40)} * ${LABELS}\n */`;
  assert.match(checkTextHeader('a.js', late), /within the first 30 lines/);
});

test('JSON headers: $comment, package.json description, dashboards description', () => {
  assert.equal(checkJsonHeader('config/x.json', JSON.stringify({ $comment: COMMENT, a: 1 })), null);
  assert.equal(
    checkJsonHeader(
      'tools/results/r.schema.json',
      JSON.stringify({ $schema: 's', $comment: COMMENT }),
    ),
    null,
  );
  assert.equal(checkJsonHeader('package.json', JSON.stringify({ description: COMMENT })), null);
  assert.match(
    checkJsonHeader('package.json', JSON.stringify({ $comment: COMMENT })),
    /no top-level "description"/,
  );
  assert.equal(
    checkJsonHeader(
      'monitoring/grafana/dashboards/d.json',
      JSON.stringify({ description: COMMENT }),
    ),
    null,
  );
  assert.match(
    checkJsonHeader('config/x.json', JSON.stringify({ a: 1 })),
    /no top-level "\$comment"/,
  );
  assert.match(checkJsonHeader('config/x.json', '{ bad'), /not valid JSON/);
});

test('scope: fixtures, archive, results, test-data/plan-definitions and package-lock.json are out', () => {
  assert.equal(isInScope('tools/core/x.mjs'), true);
  assert.equal(isInScope('specs/002-node-tooling-core/spec.md'), true);
  assert.equal(isInScope('config/settings/defaults.json'), true);
  assert.equal(isInScope('tools/core/unit-tests/fixtures/a.json'), false);
  assert.equal(isInScope('archive/v1/run.sh'), false);
  assert.equal(isInScope('results/x/result.json'), false);
  assert.equal(isInScope('test-data/plan-definitions/emr-service-protocol.json'), false);
  assert.equal(isInScope('package-lock.json'), false);
  assert.equal(isInScope('.editorconfig'), false);
});

test('checkHeaders skips git-ignored files and reports the rest', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'config', 'environments'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'environments', 'local.json'),
    JSON.stringify({ $comment: COMMENT }),
  );
  fs.writeFileSync(
    path.join(root, 'config', 'environments', 'local.local.json'),
    JSON.stringify({ a: 1 }),
  );
  fs.writeFileSync(path.join(root, 'bad.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(root, 'good.mjs'), GOOD_JS);
  fs.mkdirSync(path.join(root, 'tools', 'unit-tests', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'unit-tests', 'fixtures', 'raw.json'), '{}');
  const ignored = {
    source: 'given',
    matches: (relative) => relative === 'config/environments/local.local.json',
  };
  const { problems, checked } = checkHeaders({ root, ignored });
  assert.deepEqual(problems, [
    { file: 'bad.mjs', problem: 'does not start with a header comment' },
  ]);
  assert.equal(checked, 3);
  // --paths restricts the check.
  assert.deepEqual(checkHeaders({ root, ignored, paths: ['good.mjs'] }).problems, []);
});

test('listIgnored: parses `git ls-files --others --ignored --exclude-standard --directory`; falls back without git', () => {
  const calls = [];
  const exec = (cmd, args) => (
    calls.push([cmd, ...args].join(' ')),
    'results/\nconfig/environments/local.local.json\n'
  );
  const viaGit = listIgnored('/repo', { exec });
  assert.equal(calls[0], 'git ls-files --others --ignored --exclude-standard --directory');
  assert.equal(viaGit.source, 'git');
  assert.equal(viaGit.matches('results/a/result.json'), true);
  assert.equal(viaGit.matches('config/environments/local.local.json'), true);
  assert.equal(viaGit.matches('config/environments/local.json'), false);
  const fallback = listIgnored('/repo', {
    exec: () => {
      throw new Error('no git');
    },
  });
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.matches('config/environments/dev.local.json'), true);
  assert.equal(fallback.matches('monitoring/.env'), true);
  assert.equal(fallback.matches('monitoring/.env.example'), false);
});
