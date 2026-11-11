/**
 * autovacuum.mjs — preflight check `autovacuum`: no vacuum running, few dead rows on the main tables
 *
 * What:    Right after a big cleanup, autovacuum pushed collector p95 from ~18 ms to 666 ms (lesson 8).
 *          A run started then measures the vacuum, not the service. Uses statistics views only (no scans).
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.db (pg_stat_progress_vacuum, pg_stat_user_tables).
 * Outputs: { status, detail, data: { vacuumsRunning, tables: [{ table, liveRows, deadRows, deadShare }] } }
 */
import { database, needsPostgres, pass, warn } from '../check-helpers.mjs';

/** Tables whose bloat affects the tested services. */
export const MAIN_TABLES = [
  'inbound_event_log',
  'matcher_event_log',
  'protocol_instance',
  'step_instance',
  'step_sla_state_transition',
  'step_instance_history',
  'protocol_instance_history',
  'deviation',
];
export const VACUUM_RUNNING_SQL = 'SELECT count(*)::int AS running FROM pg_stat_progress_vacuum';
export const DEAD_ROWS_SQL =
  'SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables WHERE relname = ANY($1::text[]) ORDER BY relname';
/** More than this share of dead rows = autovacuum will soon run (or should have). */
export const DEAD_SHARE_LIMIT = 0.1;

export default {
  id: 'autovacuum',
  title: 'No autovacuum running; dead rows ≤ 10 % on main tables',
  appliesTo: (ctx) => needsPostgres(ctx),
  severity: () => 'warning',
  async run(ctx) {
    const db = database(ctx);
    const [{ running = 0 } = {}] = await db.query(VACUUM_RUNNING_SQL, [], {
      statementTimeoutMs: 5000,
    });
    const tables = (await db.query(DEAD_ROWS_SQL, [MAIN_TABLES], { statementTimeoutMs: 5000 })).map(
      (r) => {
        const live = Number(r.n_live_tup);
        const dead = Number(r.n_dead_tup);
        return {
          table: r.relname,
          liveRows: live,
          deadRows: dead,
          deadShare: live + dead > 0 ? dead / (live + dead) : 0,
        };
      },
    );
    const bloated = tables.filter((t) => t.deadShare > DEAD_SHARE_LIMIT);
    const data = { vacuumsRunning: Number(running), tables };
    const issues = [];
    if (Number(running) > 0) issues.push(`${running} vacuum(s) running`);
    if (bloated.length)
      issues.push(
        `dead rows > 10 % on ${bloated.map((t) => `${t.table} (${Math.round(t.deadShare * 100)} %)`).join(', ')}`,
      );
    if (issues.length)
      return warn(`${issues.join('; ')}: wait for autovacuum before measuring`, data);
    return pass('no vacuum running, dead rows low', data);
  },
};
