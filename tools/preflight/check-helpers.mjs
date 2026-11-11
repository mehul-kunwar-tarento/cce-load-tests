/**
 * check-helpers.mjs — small helpers every preflight check module uses
 *
 * What:    Result builders (pass/fail/warn/skip), "is this subject being tested" questions driven by the
 *          service modules' `requires`, a per-run memo (so e.g. /actuator/health is called once), the
 *          database/Kafka accessors with clear errors, and Prometheus-text helpers.
 * How:     import { pass, fail, needsPostgres } from '../check-helpers.mjs'; (imported by checks/*.mjs)
 * Needs:   The preflight context built by tools/preflight/preflight.mjs.
 * Outputs: Return values only.
 */

/** Subjects of the in-scope services, in display order (plan §2.1). */
export const SERVICE_SUBJECTS = ['collector', 'matcher', 'step-sla'];
/** Human names for check titles. */
export const DISPLAY_NAMES = {
  collector: 'Collector',
  matcher: 'Matcher',
  'step-sla': 'Step SLA',
  protocol: 'Protocol',
};

/** Check outcome builders. Why: every check returns the same small shape (plan §5.5 `checks[]`). */
export const pass = (detail, data = {}) => ({ status: 'pass', detail, data });
export const fail = (detail, data = {}) => ({ status: 'fail', detail, data });
export const warn = (detail, data = {}) => ({ status: 'warn', detail, data });
export const skip = (detail, data = {}) => ({ status: 'skip', detail, data });

/** True when `subject` is one of the subjects being tested in this run. */
export function testsSubject(ctx, subject) {
  return ctx.subjects.some((s) => s.subject === subject);
}

/** True when any tested module declares `requires[key]` (postgres, kafka, protocol). */
export function anyRequires(ctx, key) {
  return ctx.subjects.some((s) => s.requires?.[key] === true);
}

/** Why: a stack check (no subject named) still checks the database; a run only when a module needs it. */
export function needsPostgres(ctx) {
  return ctx.stackCheck || anyRequires(ctx, 'postgres');
}

/** Same for Kafka. */
export function needsKafka(ctx) {
  return ctx.stackCheck || anyRequires(ctx, 'kafka');
}

/**
 * Compute once per preflight run and reuse.
 * Why: collector /actuator/health opens a Kafka AdminClient on every call — never poll it (plan §7.1).
 */
export async function memo(ctx, key, compute) {
  if (!ctx.memo.has(key)) ctx.memo.set(key, Promise.resolve().then(compute));
  return ctx.memo.get(key);
}

/** The database adapter or a clear error. Why: without DB_PASSWORD no client exists; say so plainly. */
export function database(ctx) {
  if (!ctx.clients.db) {
    throw new Error(
      `no database connection (set ${ctx.environment?.database?.passwordEnvVar ?? 'DB_PASSWORD'} and check the database block)`,
    );
  }
  return ctx.clients.db;
}

/** Connected Kafka admin client (connects once per preflight run). */
export async function kafkaAdmin(ctx) {
  const admin = ctx.clients.kafkaAdmin;
  if (!admin) throw new Error('no Kafka admin client (kafka.brokers in the environment file?)');
  // connect() is idempotent in kafkajs, so a caller's already-connected admin is fine too.
  await memo(ctx, 'kafka:connect', async () => {
    if (typeof admin.connect === 'function') await admin.connect();
  });
  return admin;
}

/** True when a Postgres error is a statement timeout (SQLSTATE 57014). */
export function isStatementTimeout(error) {
  return error?.code === '57014' || /statement timeout/i.test(String(error?.message));
}

/**
 * Sum every series of one metric in a parsed Prometheus text (Map name → [{labels, value}]).
 * Why: A2's parser returns a Map; plain objects are accepted too so tests can stay small. null = absent.
 */
export function sumSeries(parsed, name) {
  const series = parsed instanceof Map ? parsed.get(name) : parsed?.[name];
  if (series === undefined || series === null) return null;
  if (typeof series === 'number') return series;
  if (!Array.isArray(series) || series.length === 0) return null;
  return series.reduce((total, s) => total + (Number.isFinite(s?.value) ? s.value : 0), 0);
}

/** GB with one decimal from bytes. Why: disk numbers are read in GB. */
export function toGb(bytes) {
  return bytes === null || bytes === undefined ? null : Math.round((bytes / 1024 ** 3) * 10) / 10;
}
