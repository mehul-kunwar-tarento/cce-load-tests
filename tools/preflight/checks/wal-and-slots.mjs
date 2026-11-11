/**
 * wal-and-slots.mjs — preflight check `wal-and-slots`: replication slots healthy, WAL headroom
 *
 * What:    A Debezium (CDC) slot that is 'lost' or 'unreserved', or close to max_slot_wal_keep_size, means
 *          the analytics pipeline is already broken or a burst of writes (a test, a cleanup) will break it.
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.db (pg_replication_slots), CLEANUP_MIN_SAFE_WAL_GB.
 * Outputs: { status, detail, data: { slots[], maxSlotWalKeepSize, missingSlots[] } }
 */
import { database, needsPostgres, pass, warn } from '../check-helpers.mjs';
import { readSlots, slotProblems } from '../probes.mjs';

export default {
  id: 'wal-and-slots',
  title: 'Replication slots reserved, WAL headroom ≥ CLEANUP_MIN_SAFE_WAL_GB',
  appliesTo: (ctx) => needsPostgres(ctx),
  severity: () => 'warning',
  async run(ctx) {
    const db = database(ctx);
    const { slots, maxSlotWalKeepSize } = await readSlots((sql) =>
      db.query(sql, [], { statementTimeoutMs: 5000 }),
    );
    const expected = ctx.environment?.database?.replicationSlots ?? [];
    const missingSlots = expected.filter((name) => !slots.some((s) => s.slotName === name));
    const data = { slots, maxSlotWalKeepSize, missingSlots };
    const problems = slotProblems(slots, Number(ctx.settings.CLEANUP_MIN_SAFE_WAL_GB ?? 2));
    if (problems.length) return warn(problems.join('; '), data);
    const note = missingSlots.length
      ? ` (slot ${missingSlots.join(', ')} not present: analytics pipeline not running?)`
      : '';
    return pass(`${slots.length} slot(s) healthy${note}`, data);
  },
};
