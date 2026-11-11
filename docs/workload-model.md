<!--
  What:    How the amount of load is configured: events per interval as rate + duration or as a total number
           of events, warm-up, the collector staircase, the matcher flood, the Step SLA storm and seed modes,
           k6 virtual-user limits, every load setting with its default, the reserved EVENT_MODE /
           WORKLOAD_PROFILE settings, and how the UAT/Dev traffic analysis becomes a workload profile and a
           baseline.
  How:     Read before changing a rate or duration, or before planning a test round. Print the values a run
           would use with: scripts/print-settings.sh <env> <subject> <test-type> [--set NAME=value]…
  Needs:   Nothing. Sources: config/settings/defaults.json (the single source of every default),
           specs/000-performance-testing-setup/plan.md §3.2, §3.3, §4.1, §4.3.
  Outputs: Documentation only.
-->

# CCE Performance Tests — Workload Model

> The tester decides how many events arrive per interval; the code never does. Every number below is a
> setting with a default, changeable for one run without editing a file.

---

## 1. Events per interval

A test's load is a **phase plan**: a list of phases, each with a rate (events or alarms per second), a start
time and a duration. The tester sets the rates and durations; the plan is computed from them by one function
(`lib/phase-plan.js` `buildPhasePlan`) that both the Node runner and k6 use, so what is printed is what is sent.

```
 rate (events/s)
   ▲
 50│               ┌────────────────────────────── measure ──────────────────────────────┐
   │               │  LOAD_RATE × LOAD_DURATION = 50/s × 10 min = 30,000 measured events  │
 10│ ┌── warm-up ──┤                                                                      │
   │ │ 10/s × 1 min│                                                                      │
   └─┴─────────────┴──────────────────────────────────────────────────────────────────────┴──► time
     0            1 min                                                                 11 min
```

See the plan of any test without running it:

```bash
scripts/print-settings.sh local collector load                       # settings table + phase plan
scripts/print-settings.sh local matcher stress --set STRESS_EVENTS=60000
node tools/cli.mjs settings local step-sla load --json                # the same as JSON
```

**Where a value comes from** (lowest to highest precedence): `config/settings/defaults.json` → the
environment file's `settings` block → an environment variable of the same name (`LOAD_RATE=80
scripts/run-test.sh …`) → `--set NAME=value`. The printout shows the source of each value (`default`,
`environment`, `env-var`, `cli`, `derived`) and whether it is still *to be confirmed*. Every resolved value is
saved with the result (`result.json` `conditions.settings`).

## 2. Rate + duration, or total events

Each test type has a rate, a duration and an optional total:

| Test type | Rate | Duration | Total instead of duration |
|---|---|---|---|
| smoke | `SMOKE_RATE` (1/s) | `SMOKE_DURATION` (30 s) | `SMOKE_EVENTS` |
| load | `LOAD_RATE` (50/s) | `LOAD_DURATION` (10 min) | `LOAD_EVENTS` |
| stress | `STRESS_RATE` (200/s) | `STRESS_DURATION` (10 min) | `STRESS_EVENTS` |
| matcher breakpoint (flood) | `MATCHER_FLOOD_RATE` (2,000/s) | `MATCHER_FLOOD_DURATION` (1 min) | `MATCHER_FLOOD_EVENTS` |

When a `*_EVENTS` total is set, the duration is derived: **duration = ceil(events ÷ rate)** seconds (source
`derived`; if a duration was also given, the total wins and a warning is printed). Totals count the **measured
phase only** — warm-up events are extra. Example:

```bash
scripts/print-settings.sh local collector load --set LOAD_EVENTS=1000
#   LOAD_DURATION   20s   derived        (1,000 events ÷ 50/s)
#   phases: warm-up 10/s × 1 min (600 events, not measured) + measure 50/s × 20 s (1,000 events)
```

Durations accept `500ms`, `30s`, `10m`, `1h30m` (or plain seconds); a typo is refused instead of silently
becoming 0. Rates are whole events per second (≥ 1).

## 3. Warm-up

Load, stress and every breakpoint start with a warm-up phase (`WARM_UP_RATE` 10/s for `WARM_UP_DURATION`
1 min) so JVM start-up slowness is not measured. It is not counted in the average rate, the latency rules, the
report windows or `*_EVENTS`. `WARM_UP_DURATION=0s` turns it off; smoke and Step SLA tests have none. Refining a
staircase raises the warm-up rate to the last level that held (§4).

## 4. Staircase (collector breakpoint)

`LEVELS` (`200,400,800,1600,3200,6400`, strictly ascending) each held `LEVEL_DURATION` (1 min, to be
confirmed: the lessons suggest longer), after the warm-up. k6 uses one `ramping-arrival-rate` scenario that
jumps to each level within one second. The run stops at the first level that breaks; the plan is the upper
bound (756,000 measured events at the defaults).

| Level | 200/s | 400/s | 800/s | 1,600/s | 3,200/s | 6,400/s |
|---|---|---|---|---|---|---|
| × peak (50/s) | 4 × | 8 × | 16 × | 32 × | 64 × | 128 × |
| Planned events | 12,000 | 24,000 | 48,000 | 96,000 | 192,000 | 384,000 |

**Refine**: `--refine-from <result folder>` sets `LEVELS` to finer steps between "held" and "broke"
(step = max(50, gap ÷ 4 rounded down to 50); held 400, broke 800 → 500, 600, 700) and `WARM_UP_RATE` to the
held level, unless you set them yourself. Custom staircase: `--set LEVELS=100,150,200,250`.

## 5. Flood (matcher breakpoint)

`MATCHER_FLOOD_RATE` × `MATCHER_FLOOD_DURATION` = 2,000/s × 1 min = **120,000 events** into Kafka after the
warm-up, far more than the matcher processes. The load itself is short; the measurement is the **drain**: the
backlog watcher follows the consumer lag until it is back to ≤ 10 or `BREAKPOINT_CATCH_UP_LIMIT` (15 min)
passes, and records the events processed per second while more than `MATCHER_MAX_BACKLOG` wait (the drain
rate). Bigger floods: `--set MATCHER_FLOOD_EVENTS=300000` (= 150 s at 2,000/s).

## 6. Storm and seed modes (Step SLA)

Step SLA receives no traffic: the runner **seeds** alarms into Postgres in one transaction, with ring times
it chooses, before the measured phase. The phase plan is the **ring schedule**:

| Test | Alarms (= measured events) | Ring schedule | Settings |
|---|---|---|---|
| smoke | 30 | 1 per second, from `STEP_SLA_FIRST_RING_DELAY` (60 s) after seeding | `SMOKE_RATE`, `SMOKE_DURATION` / `SMOKE_EVENTS` |
| load | 30,000 | 50 per second for 10 min | `LOAD_RATE`, `LOAD_DURATION` / `LOAD_EVENTS` |
| stress | 120,000 | 200 per second for 10 min | `STRESS_RATE`, `STRESS_DURATION` / `STRESS_EVENTS` |
| breakpoint (storm) | 100,000 | **all at the same moment** | `STEP_SLA_STORM_ALARMS` |

Rates here are **alarms per second**; the same `*_RATE` settings are read as alarms/s for Step SLA.

**Seed modes** (`STEP_SLA_SEED_MODE`, to be confirmed):

- `set` (default): alarm *n* goes to pair *n* mod *P*, where the pairs are every (plan definition of the set ×
  each of its mandatory steps **with a deadline** — the only steps the matcher gives an alarm). `emr-service`
  has 3 pairs; `kenya-sha-emr-service` has 4 (its mandatory `consent-request` has no `tolerance-days`), so the
  set really changes Step SLA's work.
- `single-action`: the first round's behaviour: every alarm on the set's first plan definition and
  `STEP_SLA_ACTION_ID` (`vitals-recording`, which must be a mandatory step with a deadline there; it fits
  `emr-service`; for `kenya-sha-emr-service` use e.g. `consent-verification`). The set then does not change
  the result; the result records the mode.

Only `DUE_DATE_REACHED` alarms are seeded. `STEP_SLA_SEED_MISSED_ALARMS=true` also seeds the
`MISSED_DATE_REACHED` alarms (ringing 3 days later) — off by default, because forgotten test data then rings
days later.

**Alarms/s peak.** "× peak" for Step SLA compares with `STEP_SLA_PEAK_ALARM_RATE`, never the events peak.
`auto` = ceil(`PEAK_RATE` × DUE alarms one event creates under the set): 1 for both `emr-service` and
`kenya-sha-emr-service` → 50 alarms/s.

**Limits.** `STEP_SLA_MAX_WAIT` (`auto` = 2 × the environment's poll interval: 10 s locally) for smoke, load,
stress; `STEP_SLA_STORM_MAX_CATCH_UP` (5 min) for the storm. Step SLA handles at most 10,000 rows per poll
cycle (100 batches × 100), so a storm drains in steps of that size.

## 7. k6 virtual users

With an arrival-rate executor k6 needs enough virtual users (VUs) to keep the rate when responses slow
down. The runner computes them from the rate (`lib/scenarios.js`):

| Kind | Pre-allocated VUs | Most VUs | Bound by |
|---|---|---|---|
| HTTP (collector) | ceil(rate × 0.5), at least 2 | max(ceil(rate × 4), 50) | `MAX_VUS` (2,000) |
| Kafka (matcher) | min(`KAFKA_PRE_ALLOCATED_VUS`, max(2, ceil(rate × 0.5))) | ceil(rate × 4), between pre-allocated and `KAFKA_MAX_VUS` | `KAFKA_PRE_ALLOCATED_VUS` (100), `KAFKA_MAX_VUS` (500) |

A staircase pre-allocates for its first level and caps at its top level (200 → 6400: 100 / 2,000). In Kafka
tests every VU owns one producer with its own threads and buffers, so VUs are capped lower (the flood gets
100 / 500, the first round's values, to be confirmed on a separate k6 host). If k6 runs out of VUs it drops
iterations; with a fast service that is reported as a k6 limit ([test-strategy.md](test-strategy.md) §7).

## 8. Settings and defaults

The defaults below are the signed-off ones (peak 50/s; smoke 1/s 30 s; load 50/s 10 min; stress 200/s 10 min
= 4 × peak; staircase 200 → 6400/s with warm-up; matcher flood 2,000/s 1 min; Step SLA storm 100,000 alarms).
`TBC` = to be confirmed from UAT/Dev data or by the team. The file
[config/settings/defaults.json](../config/settings/defaults.json) is authoritative; `--all-settings` prints
every one.

| Setting | Default | Applies to | Meaning |
|---|---|---|---|
| `PEAK_RATE` | 50 /s | all | Expected peak (design figure, TBC); every "× peak" divides by it |
| `EXPECTED_HEADROOM` | 4 | stress, breakpoint | Expectation: withstand this × peak (TBC) |
| `SMOKE_RATE`, `SMOKE_DURATION`, `SMOKE_EVENTS` | 1 /s, 30s, unset | smoke | |
| `LOAD_RATE`, `LOAD_DURATION`, `LOAD_EVENTS` | 50 /s, 10m, unset | load | 1 × peak |
| `STRESS_RATE`, `STRESS_DURATION`, `STRESS_EVENTS` | 200 /s, 10m, unset | stress | 4 × peak |
| `WARM_UP_RATE`, `WARM_UP_DURATION` | 10 /s (TBC), 1m | load, stress, breakpoint | `0s` disables |
| `LEVELS`, `LEVEL_DURATION` | 200,…,6400; 1m (TBC) | collector breakpoint | Staircase |
| `MATCHER_FLOOD_RATE`, `MATCHER_FLOOD_DURATION`, `MATCHER_FLOOD_EVENTS` | 2000 /s, 1m, unset | matcher breakpoint | Flood |
| `STEP_SLA_STORM_ALARMS` | 100000 | Step SLA breakpoint | Storm |
| `STEP_SLA_FIRST_RING_DELAY` | 60s | Step SLA | Seeding → first ring |
| `STEP_SLA_SEED_MODE`, `STEP_SLA_ACTION_ID` | `set` (TBC), `vitals-recording` | Step SLA | §6 |
| `STEP_SLA_SEED_MISSED_ALARMS` | false | Step SLA | Also seed MISSED alarms |
| `STEP_SLA_PEAK_ALARM_RATE` | auto (TBC) | Step SLA | Alarms/s peak |
| `MAX_VUS`, `KAFKA_PRE_ALLOCATED_VUS`, `KAFKA_MAX_VUS` | 2000, 100 (TBC), 500 (TBC) | k6 | §7 |
| `PLAN_DEFINITION_SET`, `DATASET` | `emr-service`, empty (= the set's dataset: `ebuzima-emr`) | all; collector, matcher | Test conditions |
| `EVENT_ACTION_ID`, `EVENT_SOURCE`, `FACILITY_ID` | dataset values | collector, matcher | Which template, `source`, `facilityid` |
| `REPORT_WINDOW`, `BREAK_CONSECUTIVE_WINDOWS` | 10s, 2 | all | "When it started breaking" |
| `WATCH_INTERVAL` | 5s | watchers, sampler | Sampling interval |
| `CATCH_UP_LIMIT`, `BREAKPOINT_CATCH_UP_LIMIT` | 2m, 15m | matcher, Step SLA | How long watchers wait after sending/ringing ends |

Thresholds (`HTTP_P95_LIMIT_MS`, `MATCHER_MAX_BACKLOG`, `STEP_SLA_MAX_WAIT`, `MAX_DROPPED_RATE`, …) are in the
same file and explained in [test-strategy.md](test-strategy.md) and each service's `docs/test-plan.md` §4.

**Reserved for later (refused today):**

- `EVENT_MODE` — only `single` is accepted: every iteration sends one event of `EVENT_ACTION_ID` for a new
  patient. `journey` (each iteration sends a patient's next step from the dataset journeys, as a real visit
  does) comes with the end-to-end module and the workload profile.
- `WORKLOAD_PROFILE` — the path of a workload-profile JSON (§9) to be turned into `ramping-arrival-rate`
  stages instead of a constant rate. Setting it now is refused with "not implemented yet".

## 9. From UAT/Dev traffic to a workload profile and a baseline

Today's numbers are assumptions: 50/s is a design figure and the event mix of the first round was our own.
[Spec 007](../specs/007-uat-dev-traffic-analysis/spec.md) (future work) describes how to replace them:

```
 UAT/Dev (read-only, aggregates only)                workload profile JSON                     suite
 ─────────────────────────────────────                ────────────────────                     ─────
 inbound_event_log received_at per minute   ──►  rates per interval (avg, p95, peak)   ──►  PEAK_RATE, LOAD_RATE,
 (event_time vs received_at = upload lag)        peak 10-min window, burst shape            WORKLOAD_PROFILE stages
 raw_payload type + Encounter type          ──►  event-type mix                         ──►  EVENT_MODE=journey weights
 events per subject (patient) per visit     ──►  events per patient, journeys            ──►  dataset journeys
 matcher_event_log, Kafka offsets, counters ──►  processed rate, lag at peak             ──►  expectations, EXPECTED_HEADROOM
 step_sla_state_transition DUE rows / event ──►  alarms per event                        ──►  STEP_SLA_PEAK_ALARM_RATE
```

1. **Extract** (spec 007): read-only SQL over `inbound_event_log` (`received_at`, `event_time`,
   `raw_payload` type and subject), `matcher_event_log`, Kafka topic offsets and Prometheus counters, bucketed
   per minute and per 10 minutes over several weeks. Only aggregates leave the environment: no patient id,
   no payload.
2. **Profile**: write the numbers into a workload-profile JSON (schema in spec 007's plan): the measured peak
   and average, a day shape as rates per interval, the burst shape, the event-type mix, events per patient and
   due alarms per event.
3. **Settings**: set `PEAK_RATE` from the measured peak (all "× peak" figures change with it), `LOAD_RATE` =
   that peak, `EXPECTED_HEADROOM` from the agreed growth margin, `STEP_SLA_PEAK_ALARM_RATE` from the measured
   alarms; clear the "to be confirmed" flags the data answers.
4. **Later code**: `WORKLOAD_PROFILE` turns the day shape into ramping stages and `EVENT_MODE=journey` sends
   the measured mix.
5. **Baseline**: run each service's load and stress 3 times on Dev/UAT with the new settings (k6 on its own
   host) and save them: `node tools/cli.mjs baseline save uat-<set> <dirs…>`. From then on, every change is
   compared with that baseline.
