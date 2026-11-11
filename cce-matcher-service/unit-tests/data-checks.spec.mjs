/**
 * data-checks.spec.mjs — unit tests of the matcher data checks (plan §6.8) with a fake Postgres.
 *
 * What:    The data checks prove from the database that every event k6 wrote into Kafka was logged, matched
 *          and enrolled with the expected fan-out. These tests feed them fixed row counts through a fake
 *          pg pool and check the verdicts for: the emr-service and kenya-sha-emr-service sets (1 enrolment
 *          and 2 step rows per event); one extra overlapping ACTIVE plan definition (effectiveFanOut 2,
 *          steps "at least"); the matcher still draining when checked; dead letters measured / not measured; the
 *          "sent" counter fallbacks; k6 sending one event more than planned at a phase edge (its id must be
 *          among the candidates, so logged = sent still passes); and the shape of the SQL (candidate ids
 *          from the phase plan plus the 1 % + 10 margin, UUIDv7 floor then selector, statement_timeout on
 *          every query).
 * How:     npm test   (or: node --test cce-matcher-service/unit-tests/data-checks.spec.mjs)
 * Needs:   ./fakes.mjs, ./fixtures/k6-summary-matcher-load.json, ../data-checks/matcher-data-checks.mjs,
 *          ../shared.mjs (plan-definition sets from test-data/, expected-rows formula). No network, no DB.
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  buildEnrolmentCountsSql,
  buildEventCountsSql,
  runMatcherDataChecks,
  sentFromSummary,
} from '../data-checks/matcher-data-checks.mjs';
import {
  CANDIDATE_MARGIN,
  computeExpectedRows,
  loadPlanDefinitionSet,
  uuidV7LowerBound,
} from '../shared.mjs';
import {
  ENVIRONMENT,
  T0,
  createFakeClock,
  createFakeKafkaAdmin,
  createFakePgPool,
  createQuietLogger,
  defaultSettings,
  phasePlanFor,
} from './fakes.mjs';

/** The synthetic k6 summary of a load run: 30,600 events written (600 warm-up + 30,000 measured). */
const K6_SUMMARY = JSON.parse(
  fs.readFileSync(new URL('./fixtures/k6-summary-matcher-load.json', import.meta.url), 'utf8'),
);
const SENT = 30600;
const SELECTOR = 'LOADTEST-20261105-142233-mat-';

/** The plan-definition sets as the runner puts them on ctx: loaded set + fan-out figures + expected rows. */
async function setOnCtx(name, { otherMatching = 0, actionId = 'visit-encounter' } = {}) {
  const set = await loadPlanDefinitionSet(name);
  return {
    ...set,
    effectiveFanOut: set.fanOut + otherMatching,
    expectedRows: computeExpectedRows(set, actionId),
  };
}

/** watch-backlog.json as the watcher leaves it (only the parts the data checks read). */
function watchFile({ deadLetterDelta = 0, caughtUp = true } = {}) {
  return {
    outcome: {
      breaking: { caughtUp },
      summary: {
        deadLetters:
          deadLetterDelta === null
            ? { topic: 'cce.events.inbound.dlq', start: null, end: null, delta: null }
            : {
                topic: 'cce.events.inbound.dlq',
                start: 7,
                end: 7 + deadLetterDelta,
                delta: deadLetterDelta,
              },
      },
    },
  };
}

/**
 * Runs the data checks against fixed database counts.
 * Why: every test differs only in the counts, the set, the lag at check time and the result files.
 */
async function runChecks({
  planDefinitionSet,
  events = { logged: SENT, matched: SENT, zero_match: 0, duplicate: 0 },
  enrolments,
  steps,
  lagNow = 0,
  files = { 'k6-summary.json': K6_SUMMARY, 'watch-backlog.json': watchFile() },
  settings = defaultSettings(),
}) {
  const clock = createFakeClock();
  // pg returns bigint columns as text: the checks must turn them into numbers.
  const asText = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)]));
  const pgPool = createFakePgPool({
    events: asText(events),
    enrolments: asText(enrolments),
    steps: asText(steps),
  });
  const ctx = {
    environment: ENVIRONMENT,
    settings,
    phasePlan: phasePlanFor('load', settings),
    selector: SELECTOR,
    resultsDir: '/fake/results/matcher-load-20261105-142233',
    context: {
      startedAt: new Date(T0).toISOString(),
      dataset: { source: 'loadtest-emr', defaultActionId: 'visit-encounter' },
    },
    pgPool,
    // Lag at check time: a number, or an Error the fake admin throws (Kafka unreadable).
    kafkaAdmin: createFakeKafkaAdmin({ lagAt: () => lagNow, clock }),
    logger: createQuietLogger(),
    planDefinitionSet,
  };
  const checks = await runMatcherDataChecks(ctx, {
    readResultFile: (name) => files[name] ?? null,
  });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  return { checks, byId, pgPool, ctx };
}

describe('matcher data checks: plan-definition sets', () => {
  it('emr-service set: all checks pass with 1 enrolment and 2 step rows per event', async () => {
    const planDefinitionSet = await setOnCtx('emr-service');
    const { checks, byId } = await runChecks({
      planDefinitionSet,
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
    });
    assert.deepEqual(
      checks.map((c) => c.id),
      [
        'matcher.logged-equals-sent',
        'matcher.all-matched',
        'matcher.patients-enrolled',
        'matcher.enrolments-equal-fan-out',
        'matcher.steps-created',
        'matcher.no-dead-letters',
      ],
    );
    for (const check of checks)
      assert.equal(check.passed, true, `${check.id}: ${JSON.stringify(check)}`);
    assert.equal(byId['matcher.logged-equals-sent'].expected, SENT);
    assert.match(byId['matcher.logged-equals-sent'].description, /kafka_writer_message_count/);
    assert.equal(byId['matcher.logged-equals-sent'].severity, 'required');
    assert.equal(byId['matcher.enrolments-equal-fan-out'].expected, SENT);
    assert.equal(byId['matcher.steps-created'].expected, 2 * SENT);
    assert.equal(byId['matcher.steps-created'].comparison, 'equals');
    // "info until a live smoke confirms the expected-rows rule" (tasks.md DEFERRED task).
    assert.equal(byId['matcher.steps-created'].severity, 'info');
    assert.equal(byId['matcher.no-dead-letters'].severity, 'required');
  });

  it('kenya-sha-emr-service: 1 enrolment per patient and 2 step rows per consent-request event', async () => {
    const planDefinitionSet = await setOnCtx('kenya-sha-emr-service', {
      actionId: 'consent-request',
    });
    assert.equal(planDefinitionSet.effectiveFanOut, 1);
    const { byId } = await runChecks({
      planDefinitionSet,
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
    });
    assert.equal(byId['matcher.enrolments-equal-fan-out'].expected, SENT);
    assert.equal(byId['matcher.enrolments-equal-fan-out'].passed, true);
    assert.equal(byId['matcher.steps-created'].expected, 2 * SENT);
    assert.equal(byId['matcher.steps-created'].passed, true);
  });

  it('one extra overlapping ACTIVE definition: effectiveFanOut 2 and steps "at least"', async () => {
    // ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true: preflight only warned, and conditions counted the extra one.
    const planDefinitionSet = await setOnCtx('emr-service', { otherMatching: 1 });
    assert.equal(planDefinitionSet.effectiveFanOut, 2);
    const { byId } = await runChecks({
      planDefinitionSet,
      enrolments: { enrolments: 2 * SENT, patients: SENT },
      // The extra definition adds steps of its own, unknown to the set: 2 + 2 per event here.
      steps: { steps: 4 * SENT },
    });
    const fanOut = byId['matcher.enrolments-equal-fan-out'];
    assert.equal(fanOut.expected, 2 * SENT);
    assert.equal(fanOut.passed, true);
    assert.match(fanOut.description, /1 \+ 1 other ACTIVE/);
    const stepsCheck = byId['matcher.steps-created'];
    assert.equal(stepsCheck.comparison, 'at-least');
    assert.equal(stepsCheck.expected, 2 * SENT);
    assert.equal(stepsCheck.passed, true);
  });

  it('the extra ACTIVE definition is what makes 2 × patients right (1 × fails, required)', async () => {
    const { byId } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service', { otherMatching: 1 }),
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
    });
    const fanOut = byId['matcher.enrolments-equal-fan-out'];
    assert.equal(fanOut.passed, false);
    assert.equal(fanOut.severity, 'required');
    assert.equal(fanOut.expected, 2 * SENT);
    assert.equal(fanOut.actual, SENT);
  });

  it('computes the expected rows itself when the ctx set has none (check-data on an older run)', async () => {
    const set = await loadPlanDefinitionSet('emr-service');
    const { byId } = await runChecks({
      planDefinitionSet: { ...set, effectiveFanOut: 1, expectedRows: null },
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
    });
    assert.equal(byId['matcher.steps-created'].expected, 2 * SENT);
  });
});

describe('matcher data checks: draining, dead letters, sent counter', () => {
  it('matcher still draining at check time: count checks become info, ratio checks stay required', async () => {
    const { byId } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      events: { logged: 20000, matched: 20000, zero_match: 0, duplicate: 0 },
      enrolments: { enrolments: 20000, patients: 20000 },
      steps: { steps: 40000 },
      lagNow: 10600,
    });
    const logged = byId['matcher.logged-equals-sent'];
    assert.equal(logged.passed, false);
    assert.equal(logged.severity, 'info');
    assert.match(logged.description, /still draining.*check-data/);
    assert.equal(byId['matcher.patients-enrolled'].severity, 'info');
    assert.equal(byId['matcher.all-matched'].severity, 'required');
    assert.equal(byId['matcher.all-matched'].passed, true);
    assert.equal(byId['matcher.enrolments-equal-fan-out'].severity, 'required');
    assert.equal(byId['matcher.enrolments-equal-fan-out'].passed, true);
  });

  it('Kafka unreadable at check time: falls back to the watcher verdict (not caught up → draining)', async () => {
    const { byId } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      events: { logged: 100, matched: 100, zero_match: 0, duplicate: 0 },
      enrolments: { enrolments: 100, patients: 100 },
      steps: { steps: 200 },
      lagNow: new Error('broker gone'),
      files: {
        'k6-summary.json': K6_SUMMARY,
        'watch-backlog.json': watchFile({ caughtUp: false }),
      },
    });
    assert.equal(byId['matcher.logged-equals-sent'].severity, 'info');
  });

  it('caught up but events lost: logged ≠ sent fails as required', async () => {
    const { byId } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      events: { logged: SENT - 3, matched: SENT - 3, zero_match: 0, duplicate: 0 },
      enrolments: { enrolments: SENT - 3, patients: SENT - 3 },
      steps: { steps: 2 * (SENT - 3) },
    });
    const logged = byId['matcher.logged-equals-sent'];
    assert.equal(logged.severity, 'required');
    assert.equal(logged.passed, false);
    assert.equal(logged.actual, SENT - 3);
  });

  it('k6 sends plannedEvents + 1 (phase-edge iteration): the extra id is a candidate and logged = sent passes', async () => {
    // One more event than planned in the measure phase: id …-mat-1-30000-1 (n = plannedEvents).
    const summary = structuredClone(K6_SUMMARY);
    summary.metrics.kafka_writer_message_count.values.count = SENT + 1;
    const { byId, pgPool, ctx } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      events: { logged: SENT + 1, matched: SENT + 1, zero_match: 0, duplicate: 0 },
      enrolments: { enrolments: SENT + 1, patients: SENT + 1 },
      steps: { steps: 2 * (SENT + 1) },
      files: { 'k6-summary.json': summary, 'watch-backlog.json': watchFile() },
    });
    const measurePlanned = ctx.phasePlan.phases[1].plannedEvents;
    assert.equal(measurePlanned, 30000);
    // The SQL sent to Postgres covers the planned ids plus 1 % + 10 (n = 0 … 30,309), so n = 30,000 is in.
    const eventsSql = pgPool.statements.find((s) => s.sql.startsWith('WITH')).sql;
    const measureLast =
      measurePlanned +
      Math.ceil(measurePlanned * CANDIDATE_MARGIN.share) +
      CANDIDATE_MARGIN.extra -
      1;
    assert.ok(measureLast >= measurePlanned);
    assert.match(
      eventsSql,
      new RegExp(
        `'${SELECTOR}1-' \\|\\| n \\|\\| '-1' AS id FROM generate_series\\(0, ${measureLast}\\)`,
      ),
    );
    assert.match(
      eventsSql,
      /'LOADTEST-20261105-142233-mat-0-' \|\| n \|\| '-1' AS id FROM generate_series\(0, 615\)/,
    );
    const logged = byId['matcher.logged-equals-sent'];
    assert.equal(logged.expected, SENT + 1);
    assert.equal(logged.actual, SENT + 1);
    assert.equal(logged.passed, true);
    assert.equal(byId['matcher.all-matched'].passed, true);
    assert.equal(byId['matcher.patients-enrolled'].passed, true);
    assert.equal(byId['matcher.enrolments-equal-fan-out'].passed, true);
  });

  it('ZERO_MATCH events fail all-matched with a hint about the set', async () => {
    const { byId } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      events: { logged: SENT, matched: SENT - 50, zero_match: 50, duplicate: 0 },
      enrolments: { enrolments: SENT - 50, patients: SENT - 50 },
      steps: { steps: 2 * (SENT - 50) },
    });
    const matched = byId['matcher.all-matched'];
    assert.equal(matched.passed, false);
    assert.match(matched.description, /50 ZERO_MATCH/);
  });

  it('dead letters: a measured growth fails, an unmeasured one is info', async () => {
    const grown = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
      files: {
        'k6-summary.json': K6_SUMMARY,
        'watch-backlog.json': watchFile({ deadLetterDelta: 2 }),
      },
    });
    const dead = grown.byId['matcher.no-dead-letters'];
    assert.equal(dead.passed, false);
    assert.equal(dead.severity, 'required');
    assert.equal(dead.actual, 2);
    assert.equal(dead.comparison, 'at-most');

    const unmeasured = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
      files: { 'k6-summary.json': K6_SUMMARY },
    });
    const none = unmeasured.byId['matcher.no-dead-letters'];
    assert.equal(none.severity, 'info');
    assert.equal(none.actual, null);
    assert.match(none.description, /not measured/);
  });

  it('without a k6 summary the sent-based checks are info (nothing to compare with)', async () => {
    const { byId } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
      files: { 'watch-backlog.json': watchFile() },
    });
    assert.equal(byId['matcher.logged-equals-sent'].severity, 'info');
    assert.equal(byId['matcher.logged-equals-sent'].expected, null);
    assert.equal(byId['matcher.patients-enrolled'].severity, 'info');
  });

  it('sentFromSummary prefers kafka_writer_message_count, then events_accepted, then events_sent', () => {
    assert.deepEqual(sentFromSummary(K6_SUMMARY), {
      value: SENT,
      source: 'kafka_writer_message_count',
    });
    const withoutWriter = structuredClone(K6_SUMMARY);
    delete withoutWriter.metrics.kafka_writer_message_count;
    withoutWriter.metrics.events_accepted.values.count = 30590;
    assert.deepEqual(sentFromSummary(withoutWriter), { value: 30590, source: 'events_accepted' });
    delete withoutWriter.metrics.events_accepted;
    assert.deepEqual(sentFromSummary(withoutWriter), { value: SENT, source: 'events_sent' });
    assert.deepEqual(sentFromSummary(null), { value: null, source: null });
  });

  it('refuses clearly without a database connection', async () => {
    await assert.rejects(
      runMatcherDataChecks(
        { settings: defaultSettings(), pgPool: null },
        { readResultFile: () => null },
      ),
      /DB_PASSWORD/,
    );
  });
});

describe('matcher data checks: SQL shape (index-friendly, plan §6.8)', () => {
  it('generates the candidate ids of every phase and joins on (cloudevents_id, source)', () => {
    const sql = buildEventCountsSql({ selector: SELECTOR, phasePlan: phasePlanFor('load') });
    // Warm-up (phase 0, 600 events) and measure (phase 1, 30,000 events), step 1.
    assert.match(
      sql,
      /'LOADTEST-20261105-142233-mat-0-' \|\| n \|\| '-1' AS id FROM generate_series\(0, 599\)/,
    );
    assert.match(
      sql,
      /'LOADTEST-20261105-142233-mat-1-' \|\| n \|\| '-1' AS id FROM generate_series\(0, 29999\)/,
    );
    assert.match(sql, /JOIN candidates c ON m\.cloudevents_id = c\.id/);
    assert.match(sql, /m\.source = \$1/);
    assert.doesNotMatch(sql, /LIKE/, 'event tables are never scanned with LIKE');
  });

  it('bounds protocol_instance by the UUIDv7 floor before the selector', () => {
    const sql = buildEnrolmentCountsSql();
    assert.ok(sql.indexOf('pi.id >= $1::uuid') < sql.indexOf("LIKE $2 || '%'"));
  });

  it('runs every query with statement_timeout and records its SQL, parameters and duration', async () => {
    const { checks, pgPool } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
    });
    const queries = pgPool.statements.filter((s) => /^(WITH|SELECT)/.test(s.sql));
    assert.equal(queries.length, 3);
    const timeouts = pgPool.statements.filter(
      (s) => s.sql === 'SET LOCAL statement_timeout = 300000',
    );
    assert.equal(timeouts.length, 3, 'one statement_timeout per query (5 min default)');
    assert.deepEqual(queries[0].params, ['loadtest-emr']);
    const floor = uuidV7LowerBound(new Date(T0).toISOString());
    assert.deepEqual(queries[1].params, [floor, SELECTOR]);
    assert.deepEqual(queries[2].params, [floor, SELECTOR]);
    for (const id of [
      'matcher.logged-equals-sent',
      'matcher.patients-enrolled',
      'matcher.steps-created',
    ]) {
      const check = checks.find((c) => c.id === id);
      assert.equal(typeof check.durationMs, 'number', id);
      assert.ok(check.sql, id);
    }
  });

  it('an empty EVENT_SOURCE falls back to the dataset source', async () => {
    const { pgPool } = await runChecks({
      planDefinitionSet: await setOnCtx('emr-service'),
      enrolments: { enrolments: SENT, patients: SENT },
      steps: { steps: 2 * SENT },
      settings: defaultSettings({ EVENT_SOURCE: '' }),
    });
    const events = pgPool.statements.find((s) => s.sql.startsWith('WITH'));
    assert.deepEqual(events.params, ['loadtest-emr']);
  });
});
