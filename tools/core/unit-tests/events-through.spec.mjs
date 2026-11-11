/**
 * events-through.spec.mjs — unit tests for tools/core/events-through.mjs ("went through" per kind, R1).
 *
 * What:    HTTP counts what the service accepted (2xx), Kafka what it processed (warm-up taken off, catch-up
 *          included, capped at what was sent), seeded what it handled; the rate is that number over the time
 *          it had; without the service's count the basis is 'sent'; old result.json files are derived.
 * How:     node --test tools/core/unit-tests/events-through.spec.mjs (or npm test)
 * Needs:   Nothing (pure functions, inline fixtures).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideThrough, throughOf, throughWords, transportOfResult } from '../events-through.mjs';

test('http: accepted in the measured interval, not sent', () => {
  const t = decideThrough({
    transport: 'http',
    load: { measuredEventsSent: 259390, measuredEventsAccepted: 259034, measuredSeconds: 265.75 },
  });
  assert.equal(t.eventsThrough, 259034);
  assert.equal(t.throughBasis, 'accepted');
  assert.equal(t.throughSeconds, 265.75);
  assert.equal(Math.round(t.averageRate * 100) / 100, 974.73);
});

test('kafka: processed minus warm-up, over sending + catch-up; never more than sent', () => {
  const load = {
    eventsSent: 120598,
    measuredEventsSent: 119998,
    eventsProcessed: 109124,
    measuredSeconds: 600,
  };
  const notCaughtUp = decideThrough({
    transport: 'kafka',
    load,
    breaking: { caughtUp: false, gaveUpAfterSeconds: 120 },
  });
  assert.equal(notCaughtUp.eventsThrough, 108524);
  assert.equal(notCaughtUp.throughBasis, 'processed');
  assert.equal(notCaughtUp.throughSeconds, 720);
  assert.equal(Math.round(notCaughtUp.averageRate * 100) / 100, 150.73);
  const caughtUp = decideThrough({
    transport: 'kafka',
    load: { ...load, eventsProcessed: 120598 },
    breaking: { caughtUp: true, catchUpSeconds: 30 },
  });
  assert.equal(caughtUp.eventsThrough, 119998);
  assert.equal(caughtUp.throughSeconds, 630);
  // A shared counter that also saw other traffic is capped at what this run sent.
  const shared = decideThrough({ transport: 'kafka', load: { ...load, eventsProcessed: 500000 } });
  assert.equal(shared.eventsThrough, 119998);
});

test('seeded: handled; a storm (0 s ring interval) is rated over its catch-up', () => {
  const storm = decideThrough({
    transport: 'seeded',
    load: {
      eventsSent: 100000,
      measuredEventsSent: 100000,
      eventsProcessed: 100000,
      measuredSeconds: 0,
    },
    breaking: { caughtUp: true, catchUpSeconds: 121 },
  });
  assert.equal(storm.throughBasis, 'handled');
  assert.equal(storm.throughSeconds, 121);
  assert.equal(Math.round(storm.averageRate * 100) / 100, 826.45);
});

test("without the service's count the basis is 'sent' (and the words say so)", () => {
  const t = decideThrough({
    transport: 'kafka',
    load: { eventsSent: 700, measuredEventsSent: 600, eventsProcessed: null, measuredSeconds: 60 },
  });
  assert.equal(t.throughBasis, 'sent');
  assert.equal(t.eventsThrough, 600);
  assert.equal(t.averageRate, 10);
  assert.match(throughWords('sent'), /not available/);
  assert.equal(decideThrough({ transport: null, load: {} }).eventsThrough, null);
});

test('throughOf: saved fields win; older result.json files are derived from their shape', () => {
  assert.deepEqual(
    throughOf({
      load: { eventsThrough: 5, throughBasis: 'handled', throughSeconds: 10, averageRate: 0.5 },
    }),
    { eventsThrough: 5, throughBasis: 'handled', throughSeconds: 10, averageRate: 0.5 },
  );
  assert.equal(transportOfResult({ load: { unit: 'alarms' } }), 'seeded');
  assert.equal(
    transportOfResult({ load: { unit: 'events', eventsSent: 1 }, latency: { p95: 1 } }),
    'http',
  );
  assert.equal(
    transportOfResult({ load: { unit: 'events', eventsSent: 1 }, latency: null }),
    'kafka',
  );
  // Catch-up length from the phases when breaking does not say.
  const derived = throughOf({
    load: {
      unit: 'events',
      eventsSent: 110,
      measuredEventsSent: 100,
      eventsProcessed: 110,
      measuredSeconds: 10,
    },
    latency: null,
    breaking: { caughtUp: null },
    phases: [
      { name: 'catch-up', startedAt: '2026-11-05T10:00:00Z', endedAt: '2026-11-05T10:00:10Z' },
    ],
  });
  assert.equal(derived.eventsThrough, 100);
  assert.equal(derived.throughSeconds, 20);
});
