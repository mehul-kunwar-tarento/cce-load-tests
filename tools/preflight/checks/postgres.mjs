/**
 * postgres.mjs — preflight check `postgres`: connect and run SELECT 1
 *
 * What:    Data checks, seeding and cleanup all need the database; fail early with the connection error.
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.db ({ query(sql, params, opts) → rows }), built from the environment + DB_PASSWORD.
 * Outputs: { status, detail }
 */
import { database, fail, needsPostgres, pass } from '../check-helpers.mjs';

export default {
  id: 'postgres',
  title: 'Postgres reachable (SELECT 1)',
  appliesTo: (ctx) => needsPostgres(ctx),
  severity: () => 'required',
  async run(ctx) {
    const db = ctx.environment?.database ?? {};
    try {
      const rows = await database(ctx).query('SELECT 1 AS ok', [], { statementTimeoutMs: 5000 });
      if (Number(rows?.[0]?.ok) !== 1) return fail('SELECT 1 returned an unexpected answer');
      return pass(`${db.user}@${db.host}:${db.port}/${db.name}`);
    } catch (error) {
      return fail(`cannot connect to ${db.host}:${db.port}/${db.name}: ${error.message}`);
    }
  },
};
