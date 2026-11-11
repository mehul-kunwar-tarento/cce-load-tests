/**
 * clients.mjs — the clients preflight talks through (HTTP, Prometheus scrape, Postgres, Kafka, protocol API)
 *
 * What:    Preflight checks never import pg, kafkajs or fetch themselves: they use `ctx.clients`. This module
 *          completes whatever the caller did not pass:
 *            - a key the caller passed (even as null, meaning "not available") is used as given;
 *            - a key the caller left out is built from the environment file (and closed again afterwards).
 *          So `node tools/cli.mjs preflight` passes nothing and gets real clients; A2's `run` may pass its own
 *          `{ pgPool, kafkaAdmin }` (they are adapted, never closed here); unit tests pass fakes for every key.
 * How:     const { clients, close } = await completeClients(environment, given, { env });
 *          … run checks with clients … ; await close();
 * Needs:   The environment (services, database, kafka blocks); the DB password env var for a database client.
 *          Building a client opens no connection by itself: Postgres connects on the first query, Kafka on
 *          connect() (called by the first Kafka check).
 * Outputs: { clients: { http, scrapeUrl, db, kafkaAdmin, protocolApi, exec, statfs, sleep, env }, close() }
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { serviceConfig } from '../core/environment.mjs';
import { createFetchHttp, createProtocolApi } from '../plan-definitions/protocol-api.mjs';

/** Timeout of every preflight HTTP call: a dead service must make a check fail fast, not hang. */
export const PREFLIGHT_HTTP_TIMEOUT_MS = 5000;

/**
 * Turn an HTTP client of either shape into `{ request({method, url, body}) → {status, body} }`.
 * Why: A3 modules use `request`; A2's http-json exports getJson/postJson. Both are accepted.
 */
export function adaptHttp(http) {
  if (!http) return http;
  if (typeof http.request === 'function') return http;
  if (typeof http.getJson === 'function') {
    return {
      request: ({ method, url, body }) =>
        method === 'POST' ? http.postJson(url, body ?? {}) : http.getJson(url),
    };
  }
  throw new Error('clients.http needs request({method, url, body}) or getJson/postJson');
}

/**
 * Wrap a pg Pool as `{ query(sql, params, {statementTimeoutMs}) → rows }`.
 * Why: every check query carries a statement_timeout (A2 queryRows sets it with SET LOCAL on one connection).
 */
export async function dbFromPool(pgPool) {
  const { queryRows } = await import('../core/clients/postgres.mjs');
  return { query: (sql, params = [], options = {}) => queryRows(pgPool, sql, params, options) };
}

/** Run a program and return its exit code and output, never throwing. Why: `docker` may be missing. */
export function execProgram(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr,
      }),
    );
  });
}

/**
 * Complete the client bundle for one preflight run.
 * @param {object} environment loaded environment
 * @param {object} [given] clients from the caller; a present key wins (null = "not available")
 * @param {{env?: Record<string,string|undefined>}} [options]
 * @returns {Promise<{clients: object, close: () => Promise<void>}>}
 */
export async function completeClients(environment, given = {}, { env = process.env } = {}) {
  const has = (key) => Object.hasOwn(given, key);
  const closers = [];
  const clients = { env, ...given };

  clients.http = has('http')
    ? adaptHttp(given.http)
    : createFetchHttp({ timeoutMs: PREFLIGHT_HTTP_TIMEOUT_MS });
  if (!has('scrapeUrl')) {
    // Lazy import: unit tests that pass scrapeUrl never load the Prometheus client.
    const { scrapeMetrics } = await import('../core/clients/prometheus-text.mjs');
    clients.scrapeUrl = (url) => scrapeMetrics(url, { timeoutMs: PREFLIGHT_HTTP_TIMEOUT_MS });
  }
  if (!has('protocolApi')) {
    clients.protocolApi = serviceConfig(environment, 'protocol')?.baseUrl
      ? createProtocolApi(environment, { http: clients.http })
      : null;
  }
  if (!has('db')) {
    if (given.pgPool) {
      // The caller's pool: adapted, but the caller ends it.
      clients.db = await dbFromPool(given.pgPool);
    } else if (environment?.database && env[environment.database.passwordEnvVar]) {
      const { createPool } = await import('../core/clients/postgres.mjs');
      const pool = createPool(environment, {
        max: 2,
        applicationName: 'cce-performance-tests-preflight',
        env,
      });
      clients.db = await dbFromPool(pool);
      closers.push(() => pool.end());
    } else {
      // No password: the `environment` check says so; database checks fail with that reason.
      clients.db = null;
    }
  }
  if (!has('kafkaAdmin')) {
    if (environment?.kafka?.brokers?.length) {
      const { createKafkaAdmin } = await import('../core/clients/kafka-admin.mjs');
      const admin = createKafkaAdmin(environment);
      clients.kafkaAdmin = admin;
      // disconnect() of a never-connected kafkajs admin is harmless.
      closers.push(() => admin.disconnect());
    } else clients.kafkaAdmin = null;
  }
  if (!has('exec')) clients.exec = execProgram;
  if (!has('statfs')) clients.statfs = (target) => fs.statfs(target);
  if (!has('sleep')) clients.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    clients,
    // Close only what was built here, in reverse order; a failing close never hides the result.
    close: async () => {
      for (const closer of closers.reverse())
        await Promise.resolve()
          .then(closer)
          .catch(() => {});
    },
  };
}
