/**
 * header-check.mjs — checks that every file in scope starts with the What/How/Needs/Outputs header (plan §2.4).
 *
 * What:    The team lead asked for a header on top of every file (R11): what it does, how to run it, what
 *          it needs, what it outputs. This module finds the files in scope and checks each one:
 *          - .js .mjs .sh .yml .yaml .md: the labels "What", "How", "Needs", "Outputs" (each followed by ":")
 *            within the first 30 lines, inside a comment that starts the file (after a shebang, <!doctype>
 *            or YAML "---");
 *          - our own .json: a top-level "$comment" string with the four labels (JSON Schema files use their
 *            native "$comment"); package.json its "description"; Grafana dashboards
 *            (monitoring/grafana/dashboards/*.json) their "description".
 *          Out of scope: archive/, results/, node_modules/, .cache/, .git/, git-ignored files (listed with the
 *          READ-ONLY `git ls-files --others --ignored --exclude-standard --directory`; without git, the
 *          fixed list config/environments/*.local.json and monitoring/.env), package-lock.json,
 *          any fixtures/ folder (verbatim test fixtures) and test-data/plan-definitions/ (verbatim FHIR).
 * How:     import { checkHeaders } from './header-check.mjs'; const problems = checkHeaders({ root });
 *          CLI: node tools/cli.mjs lint-headers [--paths <file or folder>…]
 * Needs:   Read access to the repository; git on PATH (optional).
 * Outputs: [{ file, problem }] — empty when every file has its header.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

/** The four labels every header carries. */
export const HEADER_LABELS = ['What', 'How', 'Needs', 'Outputs'];

/** Extensions in scope (plus .json, handled separately). */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.sh', '.yml', '.yaml', '.md']);

/** Folder names never entered, wherever they are. */
const SKIPPED_DIRS = new Set(['archive', 'results', 'node_modules', '.cache', '.git', 'fixtures']);

/** Repository-relative path prefixes out of scope (verbatim FHIR fixtures). */
const SKIPPED_PREFIXES = ['test-data/plan-definitions/'];

/** Files out of scope by name. */
const SKIPPED_FILES = new Set(['package-lock.json']);

/** Fallback list of git-ignored files when git is unavailable (plan §2.4). */
const FALLBACK_IGNORED = [/^config\/environments\/[^/]+\.local\.json$/, /^monitoring\/\.env$/];

/** How many lines a header may start within. */
const HEADER_LINES = 30;

/**
 * Git-ignored paths, read-only (D1): files and whole folders (ending with "/").
 * Why: personal files (local env overrides, monitoring/.env) are not ours to lint.
 * @param {string} root
 * @param {{exec?: typeof execFileSync}} [options]
 * @returns {{matches(relative:string):boolean, source:'git'|'fallback'}}
 */
export function listIgnored(root, { exec = execFileSync } = {}) {
  try {
    const output = exec(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const entries = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const files = new Set(entries.filter((entry) => !entry.endsWith('/')));
    const dirs = entries.filter((entry) => entry.endsWith('/'));
    return {
      source: 'git',
      matches: (relative) => files.has(relative) || dirs.some((dir) => relative.startsWith(dir)),
    };
  } catch {
    return {
      source: 'fallback',
      matches: (relative) => FALLBACK_IGNORED.some((pattern) => pattern.test(relative)),
    };
  }
}

/**
 * True when a repository-relative path is in the header-check scope (ignoring git-ignore).
 * Why: one place states the exact scope of plan §2.4.
 * @param {string} relative forward-slash path
 * @returns {boolean}
 */
export function isInScope(relative) {
  const parts = relative.split('/');
  if (parts.slice(0, -1).some((part) => SKIPPED_DIRS.has(part))) return false;
  if (SKIPPED_PREFIXES.some((prefix) => relative.startsWith(prefix))) return false;
  const name = parts[parts.length - 1];
  if (SKIPPED_FILES.has(name)) return false;
  const extension = path.extname(name);
  return TEXT_EXTENSIONS.has(extension) || extension === '.json';
}

/**
 * Missing labels in a text, e.g. ['Needs'] when "Needs:" is absent.
 * @param {string} text
 * @returns {string[]}
 */
export function missingLabels(text) {
  return HEADER_LABELS.filter((label) => !new RegExp(`\\b${label}\\s*:`).test(text));
}

/**
 * Checks a text file's header.
 * Why: the header must be the first thing a reader sees, inside a comment.
 * @param {string} relative
 * @param {string} content
 * @returns {string|null} problem, or null when fine
 */
export function checkTextHeader(relative, content) {
  const lines = content.split('\n');
  let start = 0;
  // A shebang, a doctype or a YAML document marker may come before the header.
  while (start < lines.length && /^(#!|<!doctype|---\s*$)/i.test(lines[start])) start += 1;
  const first = lines[start]?.trim() ?? '';
  const extension = path.extname(relative);
  const opensComment =
    extension === '.md'
      ? first.startsWith('<!--')
      : ['.sh', '.yml', '.yaml'].includes(extension)
        ? first.startsWith('#')
        : first.startsWith('/**') || first.startsWith('/*') || first.startsWith('//');
  if (!opensComment) return 'does not start with a header comment';
  const head = lines.slice(start, start + HEADER_LINES).join('\n');
  const missing = missingLabels(head);
  return missing.length
    ? `header lacks ${missing.join(', ')} (within the first ${HEADER_LINES} lines)`
    : null;
}

/**
 * Checks a JSON file's header ($comment, or description for package.json and dashboards).
 * @param {string} relative
 * @param {string} content
 * @returns {string|null}
 */
export function checkJsonHeader(relative, content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch (error) {
    return `is not valid JSON (${error.message})`;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return 'is not a JSON object, so it cannot carry "$comment"';
  const isPackage = relative === 'package.json' || relative.endsWith('/package.json');
  const isDashboard = /^monitoring\/grafana\/dashboards\/[^/]+\.json$/.test(relative);
  const field = isPackage || isDashboard ? 'description' : '$comment';
  if (typeof data[field] !== 'string') return `has no top-level "${field}" header`;
  const missing = missingLabels(data[field]);
  return missing.length ? `"${field}" lacks ${missing.join(', ')}` : null;
}

/**
 * Walks a folder and returns repository-relative files in scope.
 * @param {string} root repository root
 * @param {string} start absolute folder or file to start from
 * @returns {string[]}
 */
function walk(root, start) {
  const found = [];
  const visit = (absolute) => {
    const stat = fs.statSync(absolute);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (stat.isDirectory()) {
      if (relative && SKIPPED_DIRS.has(path.basename(absolute))) return;
      for (const entry of fs.readdirSync(absolute)) visit(path.join(absolute, entry));
    } else if (isInScope(relative)) {
      found.push(relative);
    }
  };
  visit(start);
  return found.sort();
}

/**
 * Checks every file in scope (or only under the given paths).
 * @param {{root?:string, paths?:string[], ignored?:{matches(r:string):boolean}}} [options]
 *   paths: files or folders (absolute or relative to root) to restrict the check to
 * @returns {{problems: Array<{file:string, problem:string}>, checked:number, ignoredSource:string}}
 */
export function checkHeaders({ root = REPO_ROOT, paths = null, ignored = listIgnored(root) } = {}) {
  const starts = paths?.length ? paths.map((p) => path.resolve(root, p)) : [root];
  const files = [
    ...new Set(starts.flatMap((start) => (fs.existsSync(start) ? walk(root, start) : []))),
  ];
  const problems = [];
  let checked = 0;
  for (const relative of files) {
    if (ignored.matches(relative)) continue;
    checked += 1;
    const content = fs.readFileSync(path.join(root, relative), 'utf8');
    const problem = relative.endsWith('.json')
      ? checkJsonHeader(relative, content)
      : checkTextHeader(relative, content);
    if (problem) problems.push({ file: relative, problem });
  }
  for (const start of starts) {
    if (!fs.existsSync(start))
      problems.push({ file: path.relative(root, start), problem: 'does not exist' });
  }
  return { problems, checked, ignoredSource: ignored.source ?? 'given' };
}
