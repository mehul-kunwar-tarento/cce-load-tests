/**
 * helpers.mjs — small helpers shared by the tools/ unit tests (not a test file itself).
 *
 * What:    Output collectors (fake stdout/stderr), a temporary folder per test, the local environment and
 *          typed settings at their defaults, so each spec stays short and never touches a live system.
 * How:     import { sink, tempDir, localEnvironment, defaultValues } from '../../core/unit-tests/helpers.mjs';
 * Needs:   config/environments/local.json, config/settings/defaults.json.
 * Outputs: Helper functions only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvironment } from '../environment.mjs';
import { resolveSettings } from '../settings.mjs';

/** A fake writable stream that keeps what was written; why: commands print to stdout/stderr. */
export function sink() {
  let text = '';
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

/** A fresh temporary folder (removed by the OS later); why: tests never write into the repository. */
export function tempDir(prefix = 'cce-perf-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The real local environment (read from config/, no connection). */
export function localEnvironment() {
  return loadEnvironment('local');
}

/** Typed settings at their defaults (plus overrides), as k6 and Node receive them. */
export function defaultValues(overrides = {}) {
  return resolveSettings({
    environment: localEnvironment(),
    overrides,
    env: {},
    now: new Date('2026-11-05T14:22:33'),
  }).values;
}

/** Copies a fixture folder into a temporary folder; why: commands rewrite files in result folders. */
export function copyFixture(source, target) {
  fs.cpSync(source, target, { recursive: true });
  return target;
}
