<!--
  What:    Test strategy of the cce-step-sla-service performance tests: why these test types, why the load is
           seeded instead of sent, why the database decides the verdict, what "breaking" means for a scheduled
           sweep, and the risks that shaped the design. Written for someone new to performance testing.
  How:     Read with test-plan.md (the what and how much); the shared strategy of the whole suite is in the
           repository's docs/ (test types, open load model, baselines).
  Needs:   Nothing to run; background in ../README.md.
  Outputs: Documentation only.
-->

# CCE Step SLA Service Performance Tests — Test Strategy

## What kind of service this is

Most services are tested by sending them requests and timing the answers. Step SLA cannot be: it has **no
application API and reads no Kafka**. It is a clock. Every poll interval (`CCE_SLA_POLL_INTERVAL_MS`: 5 s on the
laptop, 15 s in production) it asks Postgres for the SLA transitions — "alarms" — whose time has come (both
`next_attempt_at` and `process_by` passed), oldest `process_by` first, 100 rows per batch with
`FOR UPDATE SKIP LOCKED`, and at most 100 batches per cycle. For each mandatory step that was not done in time it
writes `OVERDUE`, a history row and a deviation. It never refuses work: when it falls behind, alarms simply wait
longer.

So the load on Step SLA is **how many alarms ring per second**, and its performance is **how long an alarm
waits** between ringing and being handled. Everything below follows from that.

## How it is fed: seeded alarms

In production the Matcher Service creates alarms as patient events arrive. Driving Step SLA through the matcher
would test both at once and make it impossible to choose the alarm rate. Instead the test **writes the alarms
straight into Postgres**, as the matcher would (enrolment and its history row, mandatory step and its history row,
`DUE_DATE_REACHED` alarm — but no `MISSED_DATE_REACHED` alarm, see below), with ring times chosen to give the wanted rate: alarm `n` rings at `start + n / rate`. This is an **open load model**:
alarms ring on schedule whether or not Step SLA keeps up, just as real deadlines pass whether or not the service
is busy — so a slow service shows up as growing waits, never as a politely slower test.

Design choices, each from a lesson of the first version (v1):

- **One transaction** for the whole seed: Step SLA sees all alarms or none, and a refusal leaves nothing behind.
- **Ring times start a delay after seeding** (`STEP_SLA_FIRST_RING_DELAY`), so seeding time is not measured.
- **Run-tagged, time-ordered ids** (`LOADTEST-<runId>-sla-0-<n>`, UUIDv7): data checks and cleanup find exactly
  this run's rows quickly; v1's random ids forced full scans.
- **DUE alarms only** by default: v1 also seeded MISSED alarms, which rang three days later — a surprise storm on
  an idle laptop. This is the one deliberate difference from the matcher, which schedules a MISSED alarm for every
  step with `tolerance-days`; Step SLA's verdict on the DUE alarm does not depend on it.
- **History rows as the matcher writes them** (`protocol_instance_history` `ACTIVE`, `step_instance_history`
  `NOT_STARTED`): Step SLA never reads them, but rows per alarm and history-table growth then match production.
- **The plan-definition set is a real parameter**: alarms are spread over every (plan definition × mandatory
  step with a deadline) pair of the set, because Step SLA reads the definition and action of every row. v1's
  single action is still available (`STEP_SLA_SEED_MODE=single-action`).

## How it is measured: watch live, decide from the database

Two views, with clear roles:

1. **The live watch** reads Step SLA's own metrics every 5 s: alarms due (its backlog), alarms handled, cycles run,
   batches failed. It shows progress, stops a run that cannot succeed (service restarted, scheduler stopped,
   nothing handled for 30 s while alarms wait) and measures the storm's drain rate. Its weakness: the counters
   are **global** (any other work moves them) and sampled.
2. **The database** then reads, for every alarm of this run, `processed_at − process_by`: the exact wait. It
   decides the verdict — longest wait, all handled, all `OVERDUE`, one deviation each, and when the waits started
   to exceed the rule. This is the same choice v1 made (decision D8), now returned as JSON checks.

When the two disagree (e.g. other work on a shared environment moved the counters), the database wins and the
report says why.

## Test types and why each

| Type | Question | Why this shape |
|---|---|---|
| smoke (30 alarms, 1/s) | Does the setup work end to end — seeding, watch, checks, report, cleanup? | Small and fast; run it first on every new environment |
| load (30,000, 50/s for 10 min) | At the expected peak, is every alarm handled within two poll intervals? | Ten minutes shows steady behaviour (connection pool, history growth), not a burst |
| stress (120,000, 200/s for 10 min) | At 4 × peak, does it still keep up, and if not, from when? | The expectation is to withstand 4 × peak (`EXPECTED_HEADROOM`, TBC) |
| breakpoint = storm (100,000 at once) | How fast does it drain a large backlog, and how long until it has caught up? | A sweep has no "requests per second" breaking point to climb to; its limit shows as a drain rate. Real storms happen after downtime or an event replay |

There is no staircase for Step SLA: raising the ring rate step by step would only find where waits exceed two
poll intervals, which the stress test already answers; the storm measures the maximum directly.

## What "breaking" means for Step SLA

- **Steady tests**: Step SLA is broken from the moment alarms wait longer than `STEP_SLA_MAX_WAIT` (2 poll
  intervals: an alarm that rings just after a poll waits up to one interval, plus the cycle's own work). "Started
  breaking" is the ring time of the first such alarm, at the ring rate of the test.
- **Not caught up**: alarms still unhandled after the catch-up limit. The report then gives how many were still
  waiting and after how long — never a catch-up time (v1 reported the give-up time as if it had caught up).
- **Storm**: broken when the last alarm is handled later than `STEP_SLA_STORM_MAX_CATCH_UP` after the ring. The
  drain rate (median alarms handled per second while more than 1,000 are due) is its capacity; it is compared with
  4 × the peak alarm rate for information, and is reported only for the storm (at a steady rate it just equals the
  ring rate).
- **What broke** comes from failed rules and diagnostics near the break: the 10,000-rows-per-cycle cap (a cycle
  stops after 100 batches even with more due — the main reason a storm drains in steps), a full Hikari pool (3
  connections), failed batches, GC pauses.

## Peak in alarms, not events

Business figures speak of events per second (`PEAK_RATE` 50/s, TBC). One event creates as many `DUE` alarms as the
set's enrolment step has mandatory successors with a deadline (1 for both shipped sets; the removed
`overlapping-4` set had 3). Comparing alarms/s with events/s would be wrong by that factor, so
Step SLA uses its own peak, `STEP_SLA_PEAK_ALARM_RATE` (auto: `PEAK_RATE × DUE alarms per event`), and every
"× peak" in its reports is alarms against alarms. Whether this is the right peak is an open question for the team.

## Risks that shaped the design

- **Shared counters, one test at a time**: before seeding, the runner waits until no alarm is due for 30 s.
- **Laptop vs Dev/UAT**: laptop runs try the scripts and compare runs; numbers for decisions come from Dev/UAT
  with the production poll interval and data volume (both recorded with every result).
- **Writes are the cost**: every handled alarm updates a step, inserts history and a deviation. Large runs grow
  tables, WAL and the analytics replication slot; cleanup by run id afterwards is part of every test.
- **The baseline is not known yet**: thresholds and the peak are marked "to be confirmed from UAT/Dev data"; the
  UAT/Dev event-flow analysis (spec 007) will turn into a realistic alarm rate.

## Later

`MET` verdicts (`MET_CONDITION_REACHED` alarms), several Step SLA replicas competing with `SKIP LOCKED`, a soak test
(hours at peak), and the end-to-end flow where the matcher creates the alarms.
