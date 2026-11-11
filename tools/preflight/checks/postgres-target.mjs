/**
 * postgres-target.mjs — preflight check `postgres-target`: it is the expected database with the CCE tables
 *
 * What:    Two databases on one port meant silently testing the wrong one (lesson 11). Confirms
 *          current_database() = database.name and that database.expectedTables exist; records the server
 *          port and version for the result.
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.db, environment.database.name / expectedTables.
 * Outputs: { status, detail, data: { database, serverPort, version, missingTables } }
 */
import { database, fail, needsPostgres, pass } from '../check-helpers.mjs';

export const TARGET_SQL =
  'SELECT current_database() AS database, inet_server_port() AS server_port, version() AS version';
export const TABLES_SQL =
  'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])';

export default {
  id: 'postgres-target',
  title: 'Postgres is the expected database with the CCE tables',
  appliesTo: (ctx) => needsPostgres(ctx),
  severity: () => 'required',
  async run(ctx) {
    const expected = ctx.environment?.database ?? {};
    const db = database(ctx);
    const [target] = await db.query(TARGET_SQL, [], { statementTimeoutMs: 5000 });
    const wanted = expected.expectedTables ?? [];
    const found = new Set(
      (await db.query(TABLES_SQL, [wanted], { statementTimeoutMs: 5000 })).map((r) => r.table_name),
    );
    const missingTables = wanted.filter((t) => !found.has(t));
    // inet_server_port is the port inside the container (5432) when Docker maps it: recorded, not compared.
    const data = {
      database: target?.database ?? null,
      serverPort: target?.server_port ?? null,
      version: target?.version ?? null,
      missingTables,
    };
    if (target?.database !== expected.name)
      return fail(`connected to "${target?.database}", expected "${expected.name}"`, data);
    if (missingTables.length) return fail(`tables missing: ${missingTables.join(', ')}`, data);
    return pass(`${target.database}, ${wanted.length} expected tables present`, data);
  },
};
