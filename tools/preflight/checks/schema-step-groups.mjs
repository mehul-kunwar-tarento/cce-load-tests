/**
 * schema-step-groups.mjs — preflight check `schema-step-groups`: step-group schema present
 *
 * What:    Step SLA (release-2.0.0) reads step_group_instance and step_instance.step_group_instance_id;
 *          a database without them (older matcher migrations) breaks the Step SLA service under load.
 *          Cleanup detects the same columns on its own.
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.db.
 * Outputs: { status, detail, data: { table, column } }
 */
import { database, fail, needsPostgres, pass, testsSubject } from '../check-helpers.mjs';

export const STEP_GROUPS_SQL =
  "SELECT (to_regclass('step_group_instance') IS NOT NULL) AS has_table, EXISTS (SELECT 1 FROM information_schema.columns " +
  "WHERE table_schema = current_schema() AND table_name = 'step_instance' AND column_name = 'step_group_instance_id') AS has_column";

export default {
  id: 'schema-step-groups',
  title: 'step_group_instance table and step_instance.step_group_instance_id exist',
  appliesTo: (ctx) => needsPostgres(ctx),
  severity: (ctx) => (testsSubject(ctx, 'step-sla') ? 'required' : 'warning'),
  async run(ctx) {
    const [row] = await database(ctx).query(STEP_GROUPS_SQL, [], { statementTimeoutMs: 5000 });
    const data = { table: row?.has_table === true, column: row?.has_column === true };
    if (data.table && data.column) return pass('both exist', data);
    const missing = [
      !data.table && 'table step_group_instance',
      !data.column && 'column step_instance.step_group_instance_id',
    ];
    return fail(`missing: ${missing.filter(Boolean).join(', ')}`, data);
  },
};
