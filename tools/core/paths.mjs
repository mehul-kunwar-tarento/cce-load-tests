/**
 * paths.mjs — where the repository and its standard folders are on disk.
 *
 * What:    Every tool needs the repository root (to find config/, results/, test-data/ and to mount
 *          it into the k6 container as /tests). Computing it from this file's own location means the
 *          tools work from any current directory.
 * How:     import { REPO_ROOT, repoPath } from './paths.mjs';
 * Needs:   Nothing.
 * Outputs: Absolute paths (strings).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root (two folders above tools/core/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Folders the tools read or write, relative to the repository root. */
export const FOLDERS = {
  environments: 'config/environments',
  settings: 'config/settings',
  results: 'results',
  baselines: 'baselines',
  datasets: 'test-data/datasets',
  planDefinitionSets: 'test-data/plan-definition-sets',
  cache: '.cache',
};

/**
 * Builds an absolute path inside the repository.
 * Why: callers say what they want ('results', 'x') instead of joining with the root themselves.
 * @param {...string} parts path segments relative to the repository root
 * @returns {string}
 */
export function repoPath(...parts) {
  return path.join(REPO_ROOT, ...parts);
}

/**
 * Turns an absolute path into one relative to the repository root, with forward slashes.
 * Why: results and reports show short, portable paths (results/…, config/…), never /home/<user>/….
 * @param {string} absolutePath
 * @param {string} [root] repository root (tests pass a temporary folder)
 * @returns {string}
 */
export function toRepoRelative(absolutePath, root = REPO_ROOT) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}
