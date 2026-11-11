/**
 * eslint.config.mjs — ESLint flat configuration for the Node.js tooling and the k6 scripts.
 *
 * What:    Catches mistakes (undefined names, unused variables) before a test run does. Node.js files
 *          get Node globals; k6 files get the k6 globals (__ENV, __VU, __ITER, open) instead, because k6
 *          is not Node.js and has no `process` or `require`.
 * How:     `npx eslint .` (part of `npm run lint`).
 * Needs:   eslint, @eslint/js, globals (devDependencies).
 * Outputs: Lint findings on stdout; exit code 1 when there are errors.
 */
import js from '@eslint/js';
import globals from 'globals';

// Globals the k6 runtime provides to every script (https://grafana.com/docs/k6/latest/using-k6/).
const K6_GLOBALS = {
  __ENV: 'readonly',
  __VU: 'readonly',
  __ITER: 'readonly',
  open: 'readonly',
  console: 'readonly',
};

export default [
  // Never lint frozen v1 code, run outputs, installed packages or runtime scratch.
  { ignores: ['archive/**', 'results/**', 'node_modules/**', '.cache/**'] },
  js.configs.recommended,
  {
    // Node.js tooling, unit tests and config files.
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // An argument named _x is deliberately unused (e.g. a fake's signature in a unit test).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // k6 scripts: the shared library and the per-service tests.
    files: ['lib/**/*.js', 'cce-*/tests/**/*.js', '**/unit-tests/fixtures/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: K6_GLOBALS,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
