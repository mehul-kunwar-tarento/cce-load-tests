/**
 * seed-alarms.mjs — writes the Step SLA test load into Postgres: test steps whose deadline alarms ring on schedule.
 *
 * What:    Step SLA has no API: every poll interval it picks up deadline "alarms" (step_sla_state_transition
 *          rows of type DUE_DATE_REACHED) whose time has come, marks the step OVERDUE and records a deviation.
 *          So the load of a Step SLA test is a set of alarms with chosen ring times. This module inserts, in ONE
 *          transaction on ONE connection, for every alarm the rows the matcher writes for one enrolment with one
 *          mandatory step: the test patient's enrolment (protocol_instance + its ACTIVE protocol_instance_history
 *          row), the step (step_instance + its NOT_STARTED step_instance_history row) and its DUE alarm ringing at
 *              ring(n) = seeding time + STEP_SLA_FIRST_RING_DELAY + n / rate      (n = 0 … alarms − 1)
 *          (rate 0 = the storm: every alarm rings at the same moment). Ported from the first version's seed-sla.sh with
 *          the lessons fixed: parameterised SQL, UUIDv7-shaped ids (UUID_V7_SQL) so data checks and cleanup can
 *          bound their scans, patients LOADTEST-<runId>-sla-0-<n> (run id + id code, plan §2.3), MISSED alarms
 *          only on request (they would ring 3 days later), and the plan-definition set as a real parameter:
 *            STEP_SLA_SEED_MODE=set            alarms spread round-robin over every (plan definition of the set ×
 *                                              its mandatory step with a deadline) pair (emr-service: 3 pairs,
 *                                              kenya-sha-emr-service: 4; a mandatory step without tolerance-days
 *                                              never gets an alarm from the matcher, so none is seeded)
 *            STEP_SLA_SEED_MODE=single-action  v1 behaviour: first plan definition + STEP_SLA_ACTION_ID only
 *          One difference from the matcher, on purpose: the matcher also schedules a MISSED_DATE_REACHED alarm
 *          for every step with tolerance-days (1 day in both shipped plan definitions) after the
 *          due date. The seed leaves it out unless STEP_SLA_SEED_MISSED_ALARMS=true, because it would ring days
 *          after the test as a second, unobserved storm. Step SLA's verdict on the DUE alarm does not depend on it.
 *          The seed manifest goes to the run's results folder as seed.json (never the source tree, D20).
 * How:     Called by the shared runner as the service module's prepare(ctx) (plan §6.2 step 6):
 *            const prepareResult = await seedAlarms(ctx, plan);   // plan = test definition describe()
 * Needs:   ctx.pgPool (DB_PASSWORD), ctx.settings, ctx.runId, ctx.selector, ctx.planDefinitionSet (url, version,
 *          deadlineSteps per plan definition; the definitions must be ACTIVE: scripts/manage-plan-definitions.sh
 *          load <env> --set <name>), ctx.writeJson; tables of the release-2.0.0 schema.
 * Outputs: Rows in protocol_instance, protocol_instance_history, step_instance, step_instance_history,
 *          step_sla_state_transition (5 rows per alarm; 6 with MISSED alarms); <resultsDir>/seed.json;
 *          PrepareResult { measureStart (first ring), sendEnd (last ring), plannedEvents, manifestFile }.
 */
import { RefusedError, toIsoWithOffset, UUID_V7_SQL, withDedicatedClient } from '../shared.mjs';

/**
 * Days between an alarm ringing and its MISSED alarm, only used with STEP_SLA_SEED_MISSED_ALARMS=true.
 * 3 days as v1 (the first version's seed-sla.sh). The matcher uses the step's tolerance-days
 * instead (1 day for the mandatory steps of both shipped plan definitions); kept at 3 so an opted-in MISSED storm rings
 * well after the test and its cleanup.
 */
export const MISSED_AFTER_DAYS = 3;

/** How far before the ring the fake enrolment is dated (v1: the visit 14 days before its deadline). */
export const ENROLLED_DAYS_BEFORE_RING = 14;

/**
 * The steps of a plan definition the matcher gives an alarm: mandatory with tolerance-days.
 * Why: older callers (and test doubles) only carry mandatorySteps; then every mandatory step counts.
 */
function stepsWithAlarms(definition) {
  return definition.deadlineSteps ?? definition.mandatorySteps ?? [];
}

/**
 * The (plan definition, mandatory action with a deadline) pairs alarms are spread over.
 * Why: makes the plan-definition set a real test parameter (R2) — or, in single-action mode, reproduces v1.
 * @param {{planDefinitionSet:{name?:string, planDefinitions?:Array<{url:string, version:string,
 *          canonical?:string, mandatorySteps?:string[], deadlineSteps?:string[]}>}|null, seedMode:'set'|'single-action', actionId?:string}} input
 * @returns {Array<{url:string, version:string, canonical:string, actionId:string}>}
 */
export function buildSeedPairs({ planDefinitionSet, seedMode, actionId }) {
  const definitions = planDefinitionSet?.planDefinitions ?? [];
  if (!definitions.length) {
    throw new RefusedError(
      `Plan-definition set ${planDefinitionSet?.name ?? '(none)'} has no plan definitions: ` +
        'Step SLA seeding needs at least one (PLAN_DEFINITION_SET)',
    );
  }
  const pair = (definition, action) => ({
    url: definition.url,
    version: definition.version,
    canonical: definition.canonical ?? `${definition.url}|${definition.version}`,
    actionId: action,
  });
  if (seedMode === 'single-action') {
    const first = definitions[0];
    // Step SLA only judges mandatory steps; an optional one would be "skipped" (no verdict, no deviation).
    if (!stepsWithAlarms(first).includes(actionId)) {
      throw new RefusedError(
        `STEP_SLA_ACTION_ID=${actionId} is not a mandatory ("must") action with a deadline of ${first.url}|${first.version} ` +
          `(mandatory with tolerance-days: ${stepsWithAlarms(first).join(', ') || 'none'}): choose one of those`,
      );
    }
    return [pair(first, actionId)];
  }
  if (seedMode !== 'set') {
    throw new RefusedError(`STEP_SLA_SEED_MODE must be set or single-action, got ${seedMode}`);
  }
  const pairs = definitions.flatMap((definition) =>
    stepsWithAlarms(definition).map((action) => pair(definition, action)),
  );
  if (!pairs.length) {
    throw new RefusedError(
      `Plan-definition set ${planDefinitionSet.name} has no mandatory steps with a deadline: nothing for Step SLA to judge`,
    );
  }
  return pairs;
}

/** SQL that finds the ACTIVE protocol_definition of one url + version (read inside the seed transaction). */
export const ACTIVE_DEFINITION_SQL =
  "SELECT id::text AS id FROM protocol_definition WHERE url = $1 AND version = $2 AND status = 'ACTIVE' " +
  'ORDER BY id LIMIT 1';

/**
 * The statements of the seed transaction, in order, with their parameters.
 * Why: one pure function makes the exact SQL testable without a database (D14) and keeps every value a
 * parameter ($1, $2 …), never pasted into the text.
 * @param {{protocolDefinitionIds:string[], actionIds:string[], alarmCount:number, ratePerSecond:number,
 *          firstRingDelaySeconds:number, patientIdPrefix:string, seedMissed:boolean}} input
 *   protocolDefinitionIds/actionIds: one entry per pair, same order; alarm n goes to pair n mod pairs.
 * @returns {Array<{name:string, sql:string, params:unknown[]}>}
 */
export function buildSeedStatements({
  protocolDefinitionIds,
  actionIds,
  alarmCount,
  ratePerSecond,
  firstRingDelaySeconds,
  patientIdPrefix,
  seedMissed,
}) {
  const statements = [
    {
      // One row per alarm: its number n (0-based), ids, pair and ring time. TEMP + ON COMMIT DROP: it lives
      // only in this transaction. now() is the transaction start, so every ring time has the same origin.
      // UUID_V7_SQL is evaluated per row (clock_timestamp + random bits), so ids are unique and time-ordered.
      name: 'stage alarms',
      sql: `CREATE TEMP TABLE lt_seed ON COMMIT DROP AS
WITH pairs AS (
  SELECT (p.ord - 1)::int AS pair_index, p.protocol_definition_id, p.action_id
  FROM unnest($1::uuid[], $2::text[]) WITH ORDINALITY AS p(protocol_definition_id, action_id, ord)
)
SELECT g.n,
       ${UUID_V7_SQL} AS protocol_instance_id,
       ${UUID_V7_SQL} AS step_instance_id,
       pairs.protocol_definition_id,
       pairs.action_id,
       now() + make_interval(secs => $4::float8)
         + CASE WHEN $5::float8 > 0 THEN make_interval(secs => g.n / $5::float8) ELSE interval '0' END AS ring
FROM generate_series(0, $3::int - 1) AS g(n)
JOIN pairs ON pairs.pair_index = g.n % $6::int`,
      params: [
        protocolDefinitionIds,
        actionIds,
        alarmCount,
        firstRingDelaySeconds,
        ratePerSecond,
        protocolDefinitionIds.length,
      ],
    },
    {
      // The enrolment Step SLA never reads but the step needs (foreign key). Dated like a real visit.
      name: 'insert protocol_instance',
      sql: `INSERT INTO protocol_instance (id, patient_id, protocol_definition_id, enrolled_at, status, created_at, updated_at)
SELECT protocol_instance_id, $1::text || n, protocol_definition_id,
       ring - make_interval(days => $2::int), 'ACTIVE', now(), now()
FROM lt_seed`,
      params: [patientIdPrefix, ENROLLED_DAYS_BEFORE_RING],
    },
    {
      // The enrolment's history row, as the matcher writes it in the same transaction (status ACTIVE, dated at
      // enrolment: ProtocolInstanceService records changed_at = enrolled_at). Step SLA never reads it; it is
      // here so rows per alarm and history-table volume match production-shaped data. id comes from the
      // column default (nextval), which V6__history_ids_by_sequence_block.sql states is safe next to the
      // services' block-allocated ids.
      name: 'insert protocol_instance_history',
      sql: `INSERT INTO protocol_instance_history (protocol_instance_id, status, changed_at)
SELECT protocol_instance_id, 'ACTIVE', ring - make_interval(days => $1::int)
FROM lt_seed`,
      params: [ENROLLED_DAYS_BEFORE_RING],
    },
    {
      // A mandatory step not done yet, due at the ring time: Step SLA will judge it OVERDUE.
      name: 'insert step_instance',
      sql: `INSERT INTO step_instance (id, protocol_instance_id, action_id, repeat_index, step_status, due_date,
                           required_behavior, created_at, updated_at)
SELECT step_instance_id, protocol_instance_id, action_id, 0, 'NOT_STARTED', ring, 'must', now(), now()
FROM lt_seed`,
      params: [],
    },
    {
      // The step's creation history row, as the matcher writes it with the step (StepInstanceService: step
      // NOT_STARTED, sla_status still null, changed_at = the step's created_at, here now()). Step SLA adds the
      // OVERDUE row when it judges the step, so a judged step ends with 2 history rows, as in production.
      name: 'insert step_instance_history',
      sql: `INSERT INTO step_instance_history (step_instance_id, step_status, sla_status, changed_at)
SELECT step_instance_id, 'NOT_STARTED', NULL, now()
FROM lt_seed`,
      params: [],
    },
    {
      // The alarm itself: Step SLA fetches it once BOTH next_attempt_at and process_by have passed.
      name: 'insert DUE alarms',
      sql: `INSERT INTO step_sla_state_transition (id, step_instance_id, transition_type, process_by, is_processed,
                                       attempts, next_attempt_at, created_at)
SELECT ${UUID_V7_SQL}, step_instance_id, 'DUE_DATE_REACHED', ring, false, 0, ring, now()
FROM lt_seed`,
      params: [],
    },
  ];
  if (seedMissed) {
    statements.push({
      // Off by default: these ring days later, long after the test, and would cause a second storm.
      name: 'insert MISSED alarms',
      sql: `INSERT INTO step_sla_state_transition (id, step_instance_id, transition_type, process_by, is_processed,
                                       attempts, next_attempt_at, created_at)
SELECT ${UUID_V7_SQL}, step_instance_id, 'MISSED_DATE_REACHED', ring + make_interval(days => $1::int), false, 0,
       ring + make_interval(days => $1::int), now()
FROM lt_seed`,
      params: [MISSED_AFTER_DAYS],
    });
  }
  statements.push(
    {
      // What was seeded: count, first and last ring (epoch ms), the seeding time.
      name: 'summary',
      sql: `SELECT count(*)::int AS alarms,
       (extract(epoch FROM min(ring)) * 1000)::bigint AS ring_start_ms,
       (extract(epoch FROM max(ring)) * 1000)::bigint AS ring_end_ms,
       (extract(epoch FROM now()) * 1000)::bigint AS seeded_at_ms
FROM lt_seed`,
      params: [],
    },
    {
      // Alarms per pair, for seed.json (shows the spread over the set).
      name: 'alarms per pair',
      sql: `SELECT protocol_definition_id::text AS protocol_definition_id, action_id, count(*)::int AS alarms
FROM lt_seed GROUP BY protocol_definition_id, action_id`,
      params: [],
    },
  );
  return statements;
}

/** Number from a pg value (bigint comes back as a string); why: epoch ms do not fit int4. */
function toNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Seeds the alarms of one run and writes seed.json (the service module's prepare hook).
 * Why: the ring times ARE the load; the runner takes measureStart/sendEnd from the result (timing 'seed').
 * @param {object} ctx run ctx (plan §6.4)
 * @param {{alarmCount:number, ratePerSecond:number}} plan from the test definition's describe()
 * @param {{now?:() => number}} [options] clock for the "seeding took too long" check (tests)
 * @returns {Promise<{measureStart:string, sendEnd:string, plannedEvents:number, manifestFile:'seed.json'}>}
 */
export async function seedAlarms(ctx, plan, { now = Date.now } = {}) {
  const { settings } = ctx;
  if (!ctx.pgPool) {
    throw new RefusedError(
      'Step SLA seeding needs Postgres: set DB_PASSWORD (environment database block)',
    );
  }
  const seedMode = settings.STEP_SLA_SEED_MODE ?? 'set';
  const pairs = buildSeedPairs({
    planDefinitionSet: ctx.planDefinitionSet,
    seedMode,
    actionId: settings.STEP_SLA_ACTION_ID,
  });
  // Every patient id of this run starts with the run selector + phase index 0 (plan §2.3).
  const patientIdPrefix = `${ctx.selector}0-`;
  const firstRingDelaySeconds = settings.STEP_SLA_FIRST_RING_DELAY;
  const seedMissed = Boolean(settings.STEP_SLA_SEED_MISSED_ALARMS);
  ctx.logger?.info?.(
    `seeding ${plan.alarmCount} alarms (${plan.ratePerSecond > 0 ? `${plan.ratePerSecond}/s` : 'all at once'}) ` +
      `over ${pairs.length} (plan definition × mandatory step) pair(s), mode ${seedMode} …`,
  );

  // ONE client, ONE transaction: all rows or none (and the TEMP table belongs to this session).
  const seeded = await withDedicatedClient(ctx.pgPool, async (client) => {
    await client.query('BEGIN');
    try {
      // The protocol definitions must be ACTIVE: protocol_instance references them (foreign key).
      const idByCanonical = new Map();
      for (const p of pairs) {
        if (idByCanonical.has(p.canonical)) continue;
        const found = await client.query(ACTIVE_DEFINITION_SQL, [p.url, p.version]);
        if (!found.rows.length) {
          throw new RefusedError(
            `Plan definition ${p.canonical} is not ACTIVE in ${ctx.environment?.name ?? 'this environment'}: ` +
              `load the set first (scripts/manage-plan-definitions.sh load <env> --set ${ctx.planDefinitionSet?.name})`,
          );
        }
        idByCanonical.set(p.canonical, found.rows[0].id);
      }
      const statements = buildSeedStatements({
        protocolDefinitionIds: pairs.map((p) => idByCanonical.get(p.canonical)),
        actionIds: pairs.map((p) => p.actionId),
        alarmCount: plan.alarmCount,
        ratePerSecond: plan.ratePerSecond,
        firstRingDelaySeconds,
        patientIdPrefix,
        seedMissed,
      });
      const results = {};
      for (const statement of statements) {
        results[statement.name] = await client.query(statement.sql, statement.params);
      }
      await client.query('COMMIT');
      return { idByCanonical, results };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
  const committedAtMs = now();

  const summary = seeded.results.summary.rows[0];
  const alarms = toNumber(summary.alarms);
  if (alarms !== plan.alarmCount) {
    // Cannot happen with generate_series, but a silent mismatch would make every later number wrong.
    throw new Error(`Seeded ${alarms} alarms, planned ${plan.alarmCount}`);
  }
  const ringStartMs = toNumber(summary.ring_start_ms);
  const ringEndMs = toNumber(summary.ring_end_ms);
  const seededAtMs = toNumber(summary.seeded_at_ms);
  const countByPair = new Map(
    seeded.results['alarms per pair'].rows.map((row) => [
      `${row.protocol_definition_id}|${row.action_id}`,
      toNumber(row.alarms),
    ]),
  );
  const warnings = [];
  if (committedAtMs > ringStartMs) {
    // Rows are invisible to Step SLA until COMMIT: the first alarms' wait includes the seeding time.
    warnings.push(
      `seeding took longer than STEP_SLA_FIRST_RING_DELAY (${firstRingDelaySeconds} s): the first alarms rang ` +
        `${Math.round((committedAtMs - ringStartMs) / 100) / 10} s before they were committed; raise the delay`,
    );
  }
  for (const warning of warnings) ctx.logger?.warn?.(warning);

  const manifest = {
    $comment:
      'What: seed manifest of one Step SLA run (alarms seeded in Postgres). How: written by ' +
      'cce-step-sla-service/seeding/seed-alarms.mjs during the run. Needs: nothing. Outputs: read by people ' +
      'and the result (artifacts.seedManifest).',
    runId: ctx.runId,
    testType: ctx.phasePlan?.testType ?? ctx.context?.testType ?? null,
    alarmCount: alarms,
    ratePerSecond: plan.ratePerSecond,
    ringStartMs,
    ringEndMs,
    seedMode,
    planDefinitionSet: ctx.planDefinitionSet?.name ?? null,
    pairs: pairs.map((p) => {
      const protocolDefinitionId = seeded.idByCanonical.get(p.canonical);
      return {
        protocolDefinitionId,
        canonical: p.canonical,
        actionId: p.actionId,
        alarms: countByPair.get(`${protocolDefinitionId}|${p.actionId}`) ?? 0,
      };
    }),
    missedSeeded: seedMissed,
    missedRingStartMs: seedMissed ? ringStartMs + MISSED_AFTER_DAYS * 86_400_000 : null,
    patientIdPrefix,
    firstRingDelaySeconds,
    seededAt: toIsoWithOffset(new Date(seededAtMs)),
    committedAt: toIsoWithOffset(new Date(committedAtMs)),
    warnings,
  };
  ctx.writeJson('seed.json', manifest);
  ctx.logger?.info?.(
    `seeded ${alarms} alarms: first rings at ${toIsoWithOffset(new Date(ringStartMs))}, ` +
      `last at ${toIsoWithOffset(new Date(ringEndMs))}`,
  );
  return {
    measureStart: toIsoWithOffset(new Date(ringStartMs)),
    sendEnd: toIsoWithOffset(new Date(ringEndMs)),
    plannedEvents: alarms,
    manifestFile: 'seed.json',
  };
}
