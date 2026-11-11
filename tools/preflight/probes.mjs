/**
 * probes.mjs — read-only measurements shared by preflight checks and cleanup guards
 *
 * What:    Replication-slot health (WAL a CDC slot still needs, plan lesson 8: a 27M-row delete lost the
 *          Debezium slot), free disk of the results volume and of Docker's data root (where the laptop's
 *          Postgres and Kafka keep their data), database/WAL/Kafka sizes on remote environments, and the
 *          single rule for the minimum free disk (MIN_FREE_DISK_GB vs safety.minFreeDiskGb).
 * How:     import { readSlots, slotProblems, measureDataStores, minFreeDiskGb } from './probes.mjs';
 * Needs:   A `query(sql) → rows` function (read-only SQL), `exec(cmd, args)`, `statfs(path)`; all injected.
 * Outputs: Plain objects (numbers in bytes/GB), never throws for "not measurable" — it says so instead.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Slots and how much WAL they still hold (pg_replication_slots, PG 13+). */
export const SLOTS_SQL =
  'SELECT slot_name, active, wal_status, safe_wal_size, ' +
  'pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes FROM pg_replication_slots ORDER BY slot_name';
/** The limit after which Postgres invalidates a slot ("lost"). */
export const MAX_SLOT_WAL_KEEP_SQL =
  "SELECT current_setting('max_slot_wal_keep_size') AS max_slot_wal_keep_size";
/** Database size (works without superuser). */
export const DB_SIZE_SQL = 'SELECT pg_database_size(current_database()) AS db_size_bytes';
/** WAL size; needs pg_monitor or superuser, so callers treat a permission error as "not measurable". */
export const WAL_SIZE_SQL = 'SELECT coalesce(sum(size), 0) AS wal_bytes FROM pg_ls_waldir()';

/** Why: settings may arrive as ResolvedSettings ({values, sources}) or as plain values. */
export function settingValues(settings) {
  return settings?.values ?? settings ?? {};
}

/**
 * The free-disk limit in GB.
 * Why: plan §3.2 — the environment's safety.minFreeDiskGb wins over the default, but an explicit env var
 * or --set wins over the environment.
 */
export function minFreeDiskGb(settings, environment) {
  const values = settingValues(settings);
  const source = settings?.sources?.MIN_FREE_DISK_GB;
  if (source === 'env-var' || source === 'cli') return Number(values.MIN_FREE_DISK_GB);
  const safety = environment?.safety?.minFreeDiskGb;
  return Number.isFinite(safety) ? safety : Number(values.MIN_FREE_DISK_GB ?? 20);
}

/** Read slots + max_slot_wal_keep_size. */
export async function readSlots(query) {
  const rows = await query(SLOTS_SQL);
  let maxSlotWalKeepSize;
  try {
    maxSlotWalKeepSize = (await query(MAX_SLOT_WAL_KEEP_SQL))[0]?.max_slot_wal_keep_size ?? null;
  } catch {
    maxSlotWalKeepSize = null; // older Postgres: no such setting
  }
  return {
    slots: rows.map((r) => ({
      slotName: r.slot_name,
      active: r.active === true || r.active === 't',
      walStatus: r.wal_status ?? null,
      safeWalSizeBytes:
        r.safe_wal_size === null || r.safe_wal_size === undefined ? null : Number(r.safe_wal_size),
      lagBytes: r.lag_bytes === null || r.lag_bytes === undefined ? null : Number(r.lag_bytes),
    })),
    maxSlotWalKeepSize,
  };
}

/**
 * Problems that make deleting (or testing) unsafe for the slots.
 * Why: 'lost'/'unreserved' means WAL the slot needs is gone or about to go; a small safe_wal_size means
 * one big delete could push it over.
 */
export function slotProblems(slots, minSafeWalGb) {
  const problems = [];
  for (const slot of slots) {
    if (slot.walStatus && !['reserved', 'extended'].includes(slot.walStatus)) {
      problems.push(`slot ${slot.slotName} is ${slot.walStatus}`);
    }
    if (slot.safeWalSizeBytes !== null && slot.safeWalSizeBytes < minSafeWalGb * 1024 ** 3) {
      problems.push(
        `slot ${slot.slotName}: only ${(slot.safeWalSizeBytes / 1024 ** 3).toFixed(1)} GB of WAL headroom (< ${minSafeWalGb} GB)`,
      );
    }
  }
  return problems;
}

/** Free GB of the file system holding `target` (walks up to the nearest existing folder). */
export async function freeGbAt(statfs, target) {
  let dir = path.resolve(target);
  // results/ may not exist yet on a fresh clone; measure the folder it will be created in.
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const stats = await statfs(dir);
  return {
    path: dir,
    freeGb: Math.round(((Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3) * 10) / 10,
  };
}

/** Docker's data root on this machine (where local-stack's Postgres/Kafka volumes live). */
export async function dockerRootDir(exec) {
  const out = await exec('docker', ['info', '--format', '{{.DockerRootDir}}']);
  const dir = String(out.stdout ?? '').trim();
  if (out.code !== 0 || !dir)
    throw new Error(`docker info failed: ${String(out.stderr ?? '').trim() || 'no output'}`);
  return dir;
}

/**
 * Measure where Postgres and Kafka keep their data.
 * local: free GB of the Docker data root (measurable). dev/uat: the stores are remote, so report sizes only.
 * @returns {Promise<{dataStoresFreeGb, dataStoresSource, path, dbSizeBytes, walBytes, kafkaLogBytes, notes: string[]}>}
 */
export async function measureDataStores({
  environment,
  exec,
  statfs,
  query = null,
  kafkaAdmin = null,
  topic = null,
}) {
  const out = {
    dataStoresFreeGb: null,
    dataStoresSource: 'not-measurable',
    path: null,
    dbSizeBytes: null,
    walBytes: null,
    kafkaLogBytes: null,
    notes: [],
  };
  if (environment?.kind === 'local') {
    const root = await dockerRootDir(exec);
    const { freeGb, path: measured } = await freeGbAt(statfs, root);
    Object.assign(out, {
      dataStoresFreeGb: freeGb,
      dataStoresSource: 'docker-root',
      path: measured,
    });
  }
  if (query) {
    try {
      out.dbSizeBytes = Number((await query(DB_SIZE_SQL))[0]?.db_size_bytes ?? null);
    } catch (error) {
      out.notes.push(`database size not measurable: ${error.message}`);
    }
    try {
      out.walBytes = Number((await query(WAL_SIZE_SQL))[0]?.wal_bytes ?? null);
    } catch (error) {
      out.notes.push(`WAL size not measurable (pg_ls_waldir needs pg_monitor): ${error.message}`);
    }
  }
  if (environment?.kind !== 'local') {
    if (kafkaAdmin && typeof kafkaAdmin.describeLogDirs === 'function') {
      try {
        out.kafkaLogBytes = await kafkaAdmin.describeLogDirs(topic);
      } catch (error) {
        out.notes.push(`Kafka topic size not measurable: ${error.message}`);
      }
    } else out.notes.push('Kafka topic size not measurable (admin client has no describeLogDirs)');
  }
  return out;
}
