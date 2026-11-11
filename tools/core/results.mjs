/**
 * results.mjs — the results folder of a run and the JSON files in it (plan §5.1).
 *
 * What:    Every run writes into its own folder results/<subject>-<test-type>-<yyyymmdd-hhmmss>/
 *          (git-ignored). This module creates that folder, writes/reads JSON files (pretty-printed, so
 *          people can open them) and finds result folders for reports and baselines. Only folders that
 *          contain a result.json count: old v1 folders in results/ are evidence and are ignored.
 * How:     import { createResultsDir, writeJson, readJson, findResultDirs } from './results.mjs';
 * Needs:   A writable results/ folder (created when missing).
 * Outputs: Folders and JSON files; lists of result folders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatStamp } from './format.mjs';
import { readConfigJson, readJsonFile } from './json-file.mjs';
import { FOLDERS, REPO_ROOT, repoPath, toRepoRelative } from './paths.mjs';

/** Folder name of a run: <subject>-<test-type>-<yyyymmdd-hhmmss>. */
const RESULT_DIR_NAME = /^(.+)-(smoke|load|stress|breakpoint|soak|spike)-(\d{8}-\d{6})$/;

/**
 * Creates the results folder of a run.
 * Why: one naming rule (plan §2.1); the container path is what k6 sees (repository mounted at /tests).
 * @param {{subject:string, testType:string, startedAt:Date, root?:string, repoRoot?:string}} input
 *   root: the results folder (default <repo>/results); repoRoot: the folder mounted at /tests
 * @returns {{dir:string, relativeDir:string, dirInContainer:string}}
 */
export function createResultsDir({
  subject,
  testType,
  startedAt,
  root = repoPath(FOLDERS.results),
  repoRoot = REPO_ROOT,
}) {
  const dir = path.join(root, `${subject}-${testType}-${formatStamp(startedAt)}`);
  fs.mkdirSync(root, { recursive: true });
  // Non-recursive mkdir fails when the folder exists: two runs started in the same second must not mix.
  fs.mkdirSync(dir);
  const relativeDir = toRepoRelative(dir, repoRoot);
  return { dir, relativeDir, dirInContainer: `/tests/${relativeDir}` };
}

/**
 * Writes a value as pretty JSON (2 spaces, final newline), creating parent folders.
 * Why: result files are read by people too; atomic rename avoids half-written files on Ctrl-C.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/**
 * Writes a tool-generated JSON file whose first key is a "$comment" header (plan §2.4).
 * Why: baselines and summaries are files people open; the header says what they are. Loaders drop it.
 * @param {string} file
 * @param {string} comment the What/How/Needs/Outputs text
 * @param {object} value
 */
export function writeGeneratedJson(file, comment, value) {
  writeJson(file, { $comment: comment, ...value });
}

/**
 * Reads a JSON file written by the tools.
 * Why: symmetric with writeJson; drops a generated "$comment" header if there is one.
 * @param {string} file
 * @returns {any}
 */
export function readJson(file) {
  return readConfigJson(file);
}

/**
 * Reads a JSON file if it exists, else returns the fallback.
 * Why: optional run files (seed.json, watch-*.json) are missing for some services.
 * @param {string} file
 * @param {unknown} [fallback]
 */
export function readJsonIfExists(file, fallback = null) {
  return fs.existsSync(file) ? readJsonFile(file) : fallback;
}

/**
 * Parses a results folder name into subject, test type and start stamp.
 * Why: folders can be filtered and sorted without opening every result.json.
 * @param {string} name folder name
 * @returns {{subject:string, testType:string, stamp:string}|null}
 */
export function parseResultDirName(name) {
  const match = RESULT_DIR_NAME.exec(name);
  return match ? { subject: match[1], testType: match[2], stamp: match[3] } : null;
}

/**
 * Finds result folders (only those with a result.json), oldest first.
 * Why: series reports and baselines pick runs by --latest, --since, subject or test type.
 * @param {{root?:string, latest?:number, since?:string, subject?:string, testType?:string}} [filter]
 *   since: 'yyyy-mm-dd' (inclusive)
 * @returns {string[]} absolute folder paths
 */
export function findResultDirs({
  root = repoPath(FOLDERS.results),
  latest,
  since,
  subject,
  testType,
} = {}) {
  if (!fs.existsSync(root)) return [];
  const sinceStamp = since ? since.replaceAll('-', '') : null;
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    // v1 folders and cleanup folders have no result.json: ignored (plan §8.2).
    if (!fs.existsSync(path.join(dir, 'result.json'))) continue;
    const parsed = parseResultDirName(entry.name);
    if (subject && parsed?.subject !== subject) continue;
    if (testType && parsed?.testType !== testType) continue;
    if (sinceStamp && (!parsed || parsed.stamp.slice(0, 8) < sinceStamp)) continue;
    found.push({ dir, stamp: parsed?.stamp ?? entry.name });
  }
  found.sort((a, b) => a.stamp.localeCompare(b.stamp));
  const dirs = found.map((item) => item.dir);
  return latest ? dirs.slice(-latest) : dirs;
}

/**
 * Finds the results folder of a run id (via each folder's run-context.json).
 * Why: check-data and cleanup accept a run id and need that run's phase plan and start time.
 * @param {string} runId
 * @param {{root?:string}} [options]
 * @returns {string|null}
 */
export function findResultDirByRunId(runId, { root = repoPath(FOLDERS.results) } = {}) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const contextFile = path.join(root, entry.name, 'run-context.json');
    if (!fs.existsSync(contextFile)) continue;
    try {
      if (readJsonFile(contextFile).runId === runId) return path.join(root, entry.name);
    } catch {
      // A broken run-context.json belongs to some other run; keep looking.
    }
  }
  return null;
}
