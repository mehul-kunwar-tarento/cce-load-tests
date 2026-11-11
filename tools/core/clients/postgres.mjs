/**
 * postgres.mjs — the Postgres connection pool and query helpers (node-postgres "pg").
 *
 * What:    Data checks, conditions (data volume), preflight and cleanup read CCE's database. The pool is
 *          built from the environment file (host, port, name, user) and the password from the
 *          environment variable named by database.passwordEnvVar (never from a file, D15).
 *          queryRows can set a statement_timeout so a slow query cannot hang a run.
 *          withDedicatedClient runs a function on ONE connection and always gives it back: anything that
 *          relies on session state (TEMP tables, SET, CREATE INDEX CONCURRENTLY) must use it.
 * How:     import { createPool, queryRows, withDedicatedClient } from './clients/postgres.mjs';
 *          const pool = createPool(environment); const rows = await queryRows(pool, 'SELECT 1', []);
 * Needs:   The password env var (e.g. DB_PASSWORD) and network access (never during the build).
 * Outputs: pg.Pool, arrays of row objects.
 */
import pg from 'pg';

/**
 * Creates a connection pool for an environment.
 * Why: one place that reads the password env var and fails with a clear message when it is unset.
 * @param {object} environment loaded environment (database block)
 * @param {{max?: number, applicationName?: string, env?: Record<string,string|undefined>, Pool?: typeof pg.Pool}} [options]
 * @returns {pg.Pool}
 */
export function createPool(
  environment,
  { max = 4, applicationName = 'cce-performance-tests', env = process.env, Pool = pg.Pool } = {},
) {
  const database = environment?.database;
  if (!database) throw new Error(`Environment ${environment?.name} has no database block`);
  const password = env[database.passwordEnvVar];
  if (!password) {
    throw new Error(
      `Set the database password in the environment variable ${database.passwordEnvVar} ` +
        `(e.g. export ${database.passwordEnvVar}=…); it is never stored in a file`,
    );
  }
  return new Pool({
    host: database.host,
    port: database.port,
    database: database.name,
    user: database.user,
    password,
    max,
    // Shows up in pg_stat_activity, so a DBA can see which connections are ours.
    application_name: applicationName,
    connectionTimeoutMillis: 10000,
  });
}

/**
 * Runs a function on one dedicated connection and always releases it.
 * Why: session state (TEMP tables, SET, CONCURRENTLY) lives on one connection; `finally` guarantees the
 * connection goes back to the pool even when fn throws.
 * @template T
 * @param {{connect(): Promise<{release(err?: unknown): void}>}} pool
 * @param {(client: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withDedicatedClient(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Runs a query and returns its rows, optionally with a statement_timeout.
 * Why: data checks must never hang (plan §6.8). The timeout is set with SET LOCAL inside a short
 * transaction on one connection, so it cannot leak into other queries of the pool.
 * @param {object} poolOrClient a pg.Pool (has connect) or a checked-out client
 * @param {string} sql
 * @param {unknown[]} [params]
 * @param {{statementTimeoutMs?: number}} [options]
 * @returns {Promise<object[]>}
 */
export async function queryRows(poolOrClient, sql, params = [], { statementTimeoutMs } = {}) {
  if (!statementTimeoutMs) return (await poolOrClient.query(sql, params)).rows;
  const run = async (client) => {
    await client.query('BEGIN');
    try {
      // SET LOCAL only lasts until COMMIT/ROLLBACK; the value must be a literal, so it is an integer here.
      await client.query(`SET LOCAL statement_timeout = ${Math.round(statementTimeoutMs)}`);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  // A pool hands out a dedicated client; a client is used as it is.
  return typeof poolOrClient.connect === 'function' && typeof poolOrClient.release !== 'function'
    ? withDedicatedClient(poolOrClient, run)
    : run(poolOrClient);
}
