/**
 * run-clients.mjs — the live connections of a real run (Postgres pool, Kafka admin, metric scrapes).
 *
 * What:    A real run talks to the environment: Postgres (data checks, data volume, plan-definition
 *          snapshot), Kafka (matcher backlog), the services' /actuator/prometheus (sampler, watchers,
 *          idle checks) and the protocol service (ACTIVE plan definitions). This module builds them once,
 *          from the environment file and the password env var, and closes them at the end. It is only
 *          called by `run` and `check-data` for real (never by --dry-run, `settings` or unit tests, which
 *          inject fakes), so the build never connects anywhere (D14). Nothing connects until first use.
 * How:     const clients = await createRunClients({ environment, module, env, logger });
 *          …; await clients.close();
 * Needs:   config/environments/<env>.json; DB_PASSWORD (or the variable named by database.passwordEnvVar)
 *          for Postgres; A3's tools/plan-definitions/protocol-api.mjs for the protocol client (optional).
 * Outputs: { pgPool|null, kafkaAdmin|null, scrape(subject), scrapeUrl(url), protocolApi|null,
 *            preflightClients(), close() }.
 */
import { serviceConfig } from './environment.mjs';
import { createKafkaAdmin } from './clients/kafka-admin.mjs';
import { createPool, queryRows } from './clients/postgres.mjs';
import { scrapeMetrics } from './clients/prometheus-text.mjs';
import { importOptional } from './run-setup.mjs';

/** Timeout of one metrics scrape during a run. */
const SCRAPE_TIMEOUT_MS = 5000;

/**
 * The /actuator/prometheus URL of a subject ('collector', 'step-sla', …), or null when not configured.
 * Why: the sampler, watchers and idle checks all scrape by subject; serviceConfig does the key mapping.
 * @param {object} environment
 * @param {string} subject
 * @returns {string|null}
 */
export function metricsUrl(environment, subject) {
  const service = serviceConfig(environment, subject);
  if (!service?.baseUrl) return null;
  return `${service.baseUrl.replace(/\/$/, '')}${service.metricsPath ?? '/actuator/prometheus'}`;
}

/**
 * Builds the clients of a run.
 * @param {{environment:object, module:object, env?:Record<string,string|undefined>, logger?:object}} input
 * @returns {Promise<object>}
 */
export async function createRunClients({ environment, module, env = process.env, logger }) {
  const closers = [];
  const requires = module?.requires ?? {};
  const passwordVar = environment.database?.passwordEnvVar;

  // Postgres: whenever the password is set (data volume is recorded for every run); a module that
  // needs it without a password is stopped by preflight's `environment` check with a clear message.
  let pgPool = null;
  if (passwordVar && env[passwordVar]) {
    pgPool = createPool(environment, { env });
    closers.push(() => pgPool.end());
  } else if (requires.postgres) {
    logger?.warn?.(`${passwordVar ?? 'DB_PASSWORD'} is not set: database checks cannot run`);
  }

  // Kafka admin only for subjects that need it (matcher backlog); connected on first use by watchers.
  let kafkaAdmin = null;
  if (requires.kafka && environment.kafka?.brokers?.length) {
    kafkaAdmin = createKafkaAdmin(environment);
    let connected = null;
    const raw = kafkaAdmin;
    // Connect lazily and once: helpers call getGroupLag/describeGroup without connecting themselves.
    const ensure = () => (connected ??= raw.connect());
    kafkaAdmin = {
      ...raw,
      connect: ensure,
      getGroupLag: async (input) => (await ensure(), raw.getGroupLag(input)),
      getTopicEndOffsetTotal: async (topic) => (await ensure(), raw.getTopicEndOffsetTotal(topic)),
      describeGroup: async (groupId) => (await ensure(), raw.describeGroup(groupId)),
      listTopics: async () => (await ensure(), raw.listTopics()),
    };
    closers.push(() => (connected ? raw.disconnect() : undefined));
  }

  const protocolModule = await importOptional(
    '../plan-definitions/protocol-api.mjs',
    'protocol-api.mjs',
  );
  const protocolApi =
    protocolModule?.createProtocolApi && serviceConfig(environment, 'protocol')?.baseUrl
      ? protocolModule.createProtocolApi(environment)
      : null;

  const scrapeUrl = (url) => scrapeMetrics(url, { timeoutMs: SCRAPE_TIMEOUT_MS });
  const scrape = (subject) => {
    const url = metricsUrl(environment, subject);
    if (!url)
      throw new Error(`environment ${environment.name} has no services entry for ${subject}`);
    return scrapeUrl(url);
  };

  return {
    pgPool,
    kafkaAdmin,
    protocolApi,
    scrape,
    scrapeUrl,
    /**
     * Clients for A3's runPreflight, in the shape both of its client conventions accept. Preflight
     * gets its OWN Kafka admin (it may disconnect it), which is closed with the rest.
     */
    preflightClients() {
      const clients = {
        env,
        pgPool,
        db: pgPool
          ? { query: (sql, params = [], options = {}) => queryRows(pgPool, sql, params, options) }
          : null,
        scrape: scrapeUrl,
        scrapeUrl,
        protocolApi,
      };
      if (environment.kafka?.brokers?.length) {
        const admin = createKafkaAdmin(environment);
        clients.kafkaAdmin = admin;
        closers.push(() => admin.disconnect().catch(() => {}));
      }
      if (protocolModule?.createFetchHttp)
        clients.http = protocolModule.createFetchHttp({ timeoutMs: SCRAPE_TIMEOUT_MS });
      return clients;
    },
    /** Closes everything opened here, newest first; a failing close never hides the run's result. */
    async close() {
      for (const closer of closers.reverse())
        await Promise.resolve()
          .then(closer)
          .catch(() => {});
    },
  };
}
