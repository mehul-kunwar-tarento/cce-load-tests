/**
 * leftover-test-data.mjs — preflight check `leftover-test-data`: earlier test data still there? alarms about to ring?
 *
 * What:    Two CHEAP probes, each with a 5 s statement timeout (a timeout says "not measured", never hangs):
 *          (a) any LOADTEST protocol_instance created in the last 7 days (UUIDv7 primary-key range, then LIKE);
 *          (b) unprocessed Step SLA transitions of LOADTEST patients due within the next 24 h, through the
 *              partial index idx_sslt_due_order (process_by WHERE NOT is_processed). Old test alarms ringing
 *              during a run add Step SLA work nobody planned (lesson 7).
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.db, uuidV7Floor (A2 run-id.mjs).
 * Outputs: { status, detail, data: { recentTestData, dueAlarms, firstRing, notMeasured[] } }
 */
import { uuidV7Floor } from '../../core/run-id.mjs';
import { database, isStatementTimeout, needsPostgres, pass, warn } from '../check-helpers.mjs';

export const RECENT_TEST_DATA_SQL =
  "SELECT EXISTS (SELECT 1 FROM protocol_instance WHERE id >= $1::uuid AND patient_id LIKE 'LOADTEST-%') AS found";
export const DUE_ALARMS_SQL = `SELECT count(*)::int AS due, min(x.process_by) AS first_ring FROM (
  SELECT t.process_by FROM step_sla_state_transition t
  JOIN step_instance s ON s.id = t.step_instance_id
  JOIN protocol_instance p ON p.id = s.protocol_instance_id
  WHERE t.is_processed = FALSE AND t.process_by <= now() + interval '24 hours' AND p.patient_id LIKE 'LOADTEST-%'
  LIMIT 10000) x`;

export default {
  id: 'leftover-test-data',
  title: 'No recent LOADTEST data; no LOADTEST alarms ringing in the next 24 h',
  appliesTo: (ctx) => needsPostgres(ctx),
  severity: () => 'warning',
  async run(ctx) {
    const db = database(ctx);
    const data = { recentTestData: null, dueAlarms: null, firstRing: null, notMeasured: [] };
    const floor = uuidV7Floor(new Date(ctx.now().getTime() - 7 * 24 * 3600 * 1000));
    try {
      data.recentTestData =
        (await db.query(RECENT_TEST_DATA_SQL, [floor], { statementTimeoutMs: 5000 }))[0]?.found ===
        true;
    } catch (error) {
      if (!isStatementTimeout(error)) throw error;
      data.notMeasured.push('recent test data');
    }
    try {
      const [row] = await db.query(DUE_ALARMS_SQL, [], { statementTimeoutMs: 5000 });
      data.dueAlarms = Number(row?.due ?? 0);
      data.firstRing =
        row?.first_ring instanceof Date ? row.first_ring.toISOString() : (row?.first_ring ?? null);
    } catch (error) {
      if (!isStatementTimeout(error)) throw error;
      data.notMeasured.push('due alarms');
    }
    const issues = [];
    if (data.recentTestData) issues.push('LOADTEST data from the last 7 days found (run cleanup)');
    if (data.dueAlarms > 0)
      issues.push(
        `${data.dueAlarms >= 10000 ? '≥ 10,000' : data.dueAlarms} LOADTEST alarm(s) due within 24 h (first ${data.firstRing})`,
      );
    if (data.notMeasured.length)
      issues.push(`not measured (timeout): ${data.notMeasured.join(', ')}`);
    return issues.length ? warn(issues.join('; '), data) : pass('none found', data);
  },
};
