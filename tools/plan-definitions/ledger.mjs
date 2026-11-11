/**
 * ledger.mjs — informational log of every plan-definition write made by this tool
 *
 * What:    Appends { at, action, canonical, id } to .cache/plan-definitions/<env>-ledger.json after each load,
 *          retire or delete, and reads it back for `plan-definitions status`. The load-test marker on the
 *          definition (not this file) is what decides whether a definition may be retired or deleted.
 * How:     appendLedger({ cacheDir, environmentName, entry }); readLedger({ cacheDir, environmentName })
 * Needs:   Write access to .cache/plan-definitions/ (git-ignored runtime scratch owned by A3).
 * Outputs: .cache/plan-definitions/<env>-ledger.json ({ "$comment", "entries": [...] }).
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoPath } from '../core/paths.mjs';

/** Default ledger folder (A3's subfolder of the ownerless .cache/). */
export const DEFAULT_CACHE_DIR = repoPath('.cache', 'plan-definitions');

/** Why: one name per environment so two environments never share history. */
function ledgerFile(cacheDir, environmentName) {
  return path.join(cacheDir, `${environmentName}-ledger.json`);
}

/** Read the ledger entries (empty list when there is none yet). */
export function readLedger({ cacheDir = DEFAULT_CACHE_DIR, environmentName }) {
  const file = ledgerFile(cacheDir, environmentName);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).entries ?? [];
  } catch {
    return []; // informational only: a damaged ledger must never block a command
  }
}

/** Append one entry. Why: a record of what this tool changed, shown by `status`. */
export function appendLedger({ cacheDir = DEFAULT_CACHE_DIR, environmentName, entry }) {
  const entries = readLedger({ cacheDir, environmentName });
  entries.push({ at: new Date().toISOString(), ...entry });
  fs.mkdirSync(cacheDir, { recursive: true });
  const doc = {
    $comment:
      'What: plan-definition writes (load/retire/delete) made by `node tools/cli.mjs plan-definitions` on this environment. ' +
      'How: written by tools/plan-definitions/ledger.mjs, shown by `plan-definitions status`. Needs: nothing. ' +
      'Outputs: informational only; the load-test marker (meta.tag) on the definition is authoritative.',
    entries,
  };
  fs.writeFileSync(ledgerFile(cacheDir, environmentName), `${JSON.stringify(doc, null, 2)}\n`);
  return entries;
}
