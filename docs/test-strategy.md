<!--
  What:    The testing approach of the whole suite: which test types exist and when to use each, why the load
           model is open, the difference between a threshold, capacity, a breaking point and a baseline,
           warm-up, breakpoint searches, the dropped-iterations rule and the k6 limit, verdict vs diagnostics,
           data correctness, plan definitions as a parameter, environments and repeat runs.
  How:     Read before planning a test round or interpreting a result. Per-service details (exact rules,
           data checks, panels) are in each service folder's docs/test-strategy.md and docs/test-plan.md.
  Needs:   Nothing. Sources: specs/000-performance-testing-setup/plan.md §4.2, §6.9, §8; the lessons of the
           first round (known-results-and-lessons.md).
  Outputs: Documentation only.
-->

# CCE Performance Tests — Test Strategy

> Thresholds are rules; breaking points are measurements. Every result is stored with the conditions it
> was measured under.

---

## 1. Goals

1. Show, per service, that it handles the **expected peak** (load test) and a **margin above it** (stress test).
2. Find, per service, **where it starts breaking** and **what breaks first** (breakpoint test), so the team
   knows the weakest link of the write path and how much headroom it has.
3. Prove after every run that **no event was lost or doubled** (data checks).
4. Make every result **comparable**: same settings, same conditions recorded, baselines from repeated runs.
5. Never harm a shared environment: preflight before, verified cleanup after, never prod.

## 2. Test types

| Type | Question it answers | Collector (HTTP) | Matcher (Kafka) | Step SLA (seeded alarms) | When to run it |
|---|---|---|---|---|---|
| `smoke` | Does the path work at all? (not a measurement) | 1 event/s for 30 s | 1 event/s for 30 s | 30 alarms at 1/s | Before anything else, after every deployment or setup change; a failing smoke stops at once |
| `load` | Does it handle a normal busy period? | 1 × peak: 50/s for 10 min, after 1 min warm-up | same | 50 alarms/s for 10 min (30,000) | Every round; the number most baselines are built from |
| `stress` | Does it still meet its rules well above peak? | `EXPECTED_HEADROOM` × peak: 200/s for 10 min | same | 200 alarms/s (120,000) | Every round; expectation "withstand 4 × peak" (to be confirmed) |
| `breakpoint` | Where does it break, and what breaks first? | **staircase** 200 → 400 → … → 6400/s, 1 min per level | **flood**: 2,000/s for 1 min, then measure the drain rate | **storm**: 100,000 alarms ringing at once | When capacity matters: new release, new plan definitions, new environment |
| `soak`, `spike` | Leaks and growth over hours; a sudden burst (a clinic comes back online) | not built yet | | | Later (§13) |

Defaults come from the signed-off first test plan and live in
[config/settings/defaults.json](../config/settings/defaults.json); every one can be changed per run
([workload-model.md](workload-model.md)). The *peak* (50 events/s) is a design figure from CCE's
data-pipeline documentation, not measured traffic: it will be replaced by the UAT/Dev analysis
([spec 007](../specs/007-uat-dev-traffic-analysis/spec.md)).

**Why three different breakpoint shapes.** Services fail differently:

- An **HTTP service** (collector, later adaptors) answers every request, so overload shows as latency,
  errors or requests k6 cannot send. A rising staircase finds the first level that fails the rules.
- A **queue service** (matcher) never refuses work: it falls behind. Its limit is how fast it drains a
  backlog, so the flood sends far more than it can handle and the watcher measures the drain rate.
- A **scheduled service** (Step SLA) only sees what is due. The storm makes 100,000 alarms due at the same
  moment and measures how long it takes to work through them.

## 3. Open load model

k6 can generate load in two ways:

| | Closed model (not used) | **Open model (used everywhere)** |
|---|---|---|
| How | N virtual users each send, wait for the answer, send again | k6 starts a new iteration at a fixed *arrival rate* (e.g. 50 per second), whatever the service does |
| When the service slows | each user waits longer, so the load **drops by itself** and hides the problem | the rate stays; overload shows as rising latency, errors, *dropped iterations* or a growing backlog |
| k6 executors | `constant-vus`, `ramping-vus` | `constant-arrival-rate`, `ramping-arrival-rate` |

Real clinics do not slow down because CCE is slow, so only the open model describes them. The scenarios are
built from the phase plan (`lib/scenarios.js`): `constant-arrival-rate` for smoke, warm-up and measured
phases, `ramping-arrival-rate` for the staircase.

## 4. Threshold, capacity, breaking point, baseline

| Term | What it is | Example | Where it lives |
|---|---|---|---|
| **Threshold** | A fixed pass/fail rule decided in advance | collector p95 < 500 ms; matcher backlog never above 1,000; every alarm handled within 2 poll intervals | Settings (`HTTP_P95_LIMIT_MS`, `MATCHER_MAX_BACKLOG`, `STEP_SLA_MAX_WAIT`, …); marked "to be confirmed" until the team or UAT/Dev data confirms them |
| **Capacity** | The most work per second the service gets through while meeting its rules | collector: highest staircase level that held; matcher/Step SLA: drain rate | `result.json` `breaking.heldUpTo`, `breaking.drainRate` |
| **Breaking point** | The load at which the service starts failing its thresholds — and *when* in the run it started and *what* broke | "started breaking 31 s into the measured phase at 200/s: up to 28,811 events waiting" | `result.json` `breaking` |
| **Baseline** | The numbers we normally get, the mean of ≥ 3 runs under the same conditions | collector load p95 15 ms on the laptop with 4 plan definitions | `baselines/<name>.json` |

A threshold is a promise; a breaking point is an observation. Breaking points move with the machine, the
data volume, warm-up and — most of all — the number of ACTIVE plan definitions. That is why every result
stores its *conditions* (environment, host, k6 image, commit, plan-definition set and other ACTIVE plan
definitions, dataset, data volume, every setting) and why baselines refuse to mix runs with different
conditions.

**Expectation vs result.** Every report states what the service was expected to withstand next to what it
did: load = 1 × `PEAK_RATE`; stress = `EXPECTED_HEADROOM` × `PEAK_RATE` (4 × = 200/s); breakpoint = held or
drained at least that. Step SLA uses its own peak in alarms per second (`STEP_SLA_PEAK_ALARM_RATE`, by
default the events peak × the due alarms one event creates under the chosen set).

## 5. Warm-up

A JVM service is slow for the first minute after a start (first request ~4 s, an 884 ms spike in the first
round). Load, stress and breakpoint tests therefore start with a **warm-up** phase (`WARM_UP_RATE` 10/s for
`WARM_UP_DURATION` 1 min) that is not measured: its events do not count towards `*_EVENTS`, the average rate,
the latency rules or the report windows. `WARM_UP_DURATION=0s` turns it off. A warm-up sanity rule
(> 99 % checks) stops the run at once if the path does not work at all. Step SLA has no warm-up (its first
alarm rings `STEP_SLA_FIRST_RING_DELAY` after seeding).

## 6. Breakpoints

**Staircase (collector).** Levels `LEVELS` (200, 400, 800, 1600, 3200, 6400/s), each held `LEVEL_DURATION`
(1 min). Each level has its own rules (p95, failed rate, checks) that stop k6 at the first broken level. Those
per-level rules only *find* the breaking point; the **verdict** of a staircase is the capacity rule
`breakpoint.held-up-to`: held at least the expected rate (4 × peak, to be confirmed). The report shows a
level table (rate, × peak, sent, planned, p95, errors, held/broke/not reached).

**Refine with warm-up at the last good level.** A first staircase gives "held 400/s, broke at 800/s". Narrow
it down with

```bash
scripts/run-test.sh local collector breakpoint --refine-from results/collector-breakpoint-<yyyymmdd-hhmmss>
```

The runner sets finer levels between the two (step = max(50, ¼ of the gap rounded to 50): 500, 600, 700/s)
and warms up **at the held level** instead of 10/s. The first round's finer staircases started cold, which
understated the limit; this fixes it. The result records `refinedFrom`.

**Flood (matcher).** 2,000 events/s for 1 min (`MATCHER_FLOOD_RATE`, `MATCHER_FLOOD_DURATION`) into Kafka,
far above what the matcher can process. The backlog watcher then measures the **drain rate** (events processed
per second while more than `MATCHER_MAX_BACKLOG` wait) until the backlog is gone or
`BREAKPOINT_CATCH_UP_LIMIT` (15 min) passes. The drain rate is the matcher's capacity; it is reported against
the target `EXPECTED_HEADROOM × PEAK_RATE` (informational rule `matcher.drain-rate`).

**Storm (Step SLA).** `STEP_SLA_STORM_ALARMS` (100,000) alarms all ring at once. Verdict: every alarm
handled within `STEP_SLA_STORM_MAX_CATCH_UP` (5 min). The drain rate (alarms/s) is reported for the storm only;
at a steady ring rate it would only echo the rate the test chose. Watch the 10,000-rows-per-cycle cap.

**When it started breaking.** The measured phase is cut into *report windows* (`REPORT_WINDOW`, 10 s;
widened to keep at most 200). A window is broken when its p95, failed rate or checks fail the rules, or when
k6 sent fewer than (1 − `RATE_SHORTFALL_TOLERANCE`) × planned events. "Started breaking" is the first of
`BREAK_CONSECUTIVE_WINDOWS` (2) broken windows in a row, given as clock time and seconds into the measured
phase. For the matcher the same rule runs on the backlog samples (backlog above `MATCHER_MAX_BACKLOG`); for
Step SLA it is the ring time of the first alarm that waited longer than allowed.

## 7. Dropped iterations and the k6 limit

A *dropped iteration* is an event k6 should have sent (open model) but could not, because all its virtual
users were busy. The first round's rule "0 dropped" failed a whole 10-minute load run over **1 stalled
request out of 30,030**. The rule now is:

- **Allowed: fewer than 0.1 % of the planned events** (`MAX_DROPPED_RATE=0.001`, *to be confirmed by the
  team*). The report always gives the exact count, the share, the allowed count and whether it decided the
  verdict ("11 of 30,020 (0.04 %, allowed < 0.1 % = 30) — within rule").
- **k6 limit.** When the only failed rules are dropped iterations or windows/levels that sent too little,
  and the service still answered fast (measured p95 < `K6_LIMIT_P95_MS`, 100 ms), the load generator ran out,
  not the service. The result says **"at least X/s (k6 limit)"** — for staircase levels and for windows — and
  the report labels it as a load-generator limit, not a service failure.
- **Kafka tests never claim a k6 limit**: producing to Kafka has no response time that could prove the
  matcher was fast, so dropped iterations in a flood are reported as dropped, with a note.
- A staircase stops after `BREAKPOINT_MAX_DROPPED` (1,000) dropped iterations.

If you see a k6 limit, give k6 more room (`MAX_VUS`; on Dev/UAT a bigger k6 host), not the service.

## 8. Verdict vs diagnostics

| | Verdict | Diagnostics |
|---|---|---|
| Decided by | Thresholds (k6 rules, watcher rules, module rules) and **required** data checks | Service metrics the sampler collects: Hikari pool pending/active/timeouts, heap, GC pause, CPU, Kafka publish failures, Step SLA failed batches and cycle-cap hits |
| In the report | `status` (`passed`, `failed`, `aborted`, `error`), `statusReason`, the thresholds table | Under "what broke", with source `service-metrics`, when a signal crossed its trouble level within ±1 window of "started breaking" (e.g. "collector DB pool: requests waiting for a connection from 14:31:02") |
| Changes the result? | Yes | **Never**: they explain *why*, they do not decide *whether* |

Some rules are marked **informational** (the staircase's per-level search rules, the matcher drain-rate target,
the matcher processing-time candidate): they are shown as "noted" and never fail a run. An `aborted` run (abort
rule, stall, service restart, Ctrl-C) keeps its partial data; an `error` run has no verdict (the tool could not
run the test).

## 9. Data correctness

The most valuable result of the first round was that **sent = stored = matched = enrolled** held in every run.
Every test keeps that check, from Postgres, after the load:

| Service | Required data checks (ids in `result.json` `dataChecks`) |
|---|---|
| Collector | `collector.stored-equals-accepted` (rows stored = events k6 saw accepted), `collector.no-rejections`; info: rows the matcher logged, backlog left for the matcher |
| Matcher | `matcher.logged-equals-sent`, `matcher.all-matched`, `matcher.patients-enrolled`, `matcher.enrolments-equal-fan-out` (= effective fan-out × patients), `matcher.no-dead-letters`; `matcher.steps-created` is info until the first live smoke confirms the expected rows |
| Step SLA | every alarm handled, every step `OVERDUE`, one deviation each, wait avg/p95/max within the limit (storm: catch-up within the limit) |

Data checks select only the run's own rows (run selector `LOADTEST-<runId>-<idCode>-`) through indexes, so
they stay fast on a big database. They can be re-run later with `node tools/cli.mjs check-data <env> <resultDir>`
— before cleanup, which deletes the rows they count.

## 10. Plan definitions as a parameter

Going from 1 to 4 overlapping plan definitions cut the matcher from ~551 to ~156–179 events/s and the
collector's breaking point from 1,600–3,200/s to 500–600/s in the first round (laptop numbers). So:

- `PLAN_DEFINITION_SET` selects the protocol: `emr-service` (default, `ebuzima-emr` events) or
  `kenya-sha-emr-service` (`tiberbu-emr` events), one plan definition each; the set and its plan definition's
  url, version and mandatory steps are recorded with the result. The overlapping sets of the first round
  (generated variants with 3, 7, 1 and 5 mandatory steps) were removed on 2026-11-11 by decision: the suite now
  tests the real protocols, not synthetic overlap.
- Preflight looks for **other** ACTIVE plan definitions whose triggers match the dataset's events. For the
  matcher they fail preflight (the numbers would be wrong), unless `ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true`,
  in which case the data checks expect the larger *effective fan-out*.
- Step SLA spreads its seeded alarms over every (plan definition × mandatory step with a deadline) pair of the
  set (`STEP_SLA_SEED_MODE=set`: 3 pairs for `emr-service`, 4 for `kenya-sha-emr-service`), so the set changes
  its work too.
- Compare sets with the same test: e.g. matcher stress with `emr-service`, then with `kenya-sha-emr-service`.

Which plan definitions UAT and production run is still open (open question 8); it moves the matcher limit
more than anything else.

## 11. Environments

| Environment | Use it for | Notes |
|---|---|---|
| **Laptop** (`local`, CCE's `local-stack`) | Trying and debugging scripts, smoke tests, relative comparisons (before/after a change, set A vs set B) | k6, the monitoring stack and ~25 containers share one machine: numbers are **relative only**, never capacity figures for the team |
| **Dev / UAT** (`dev`, `uat`, from the `*.example.json` templates) | The real numbers: capacity, breaking points, baselines | Run k6 (and the monitoring stack, if used) on a **separate host** close to the services, never through a VPN relay; plan-definition writes and the cleanup temp index are off until the team agrees; real traffic shares the services (counters are global, lag is rarely 0) |
| Production | Never | Refused by every command |

## 12. Repeat runs and baselines

One run is an anecdote. For any number that will be compared or reported to the team:

1. Run each test **at least 3 times** under the same conditions (same environment, plan-definition set,
   dataset, settings), with idle services and no autovacuum running in between.
2. Save them as a baseline: `node tools/cli.mjs baseline save <name> <dir1> <dir2> <dir3>` (refused with
   fewer than `BASELINE_MIN_RUNS`, unless `--allow-fewer`, which marks it provisional).
3. Compare later runs: `BASELINE=<name> scripts/run-test.sh …` or
   `node tools/cli.mjs baseline compare <name> <dir>`. A change counts only beyond `BASELINE_TOLERANCE` (20 %)
   and a unit floor (5 ms, 2 s, 100 events, 5 events/s, 20 alarms/s), so laptop noise is not reported as a
   regression. Condition differences are listed as warnings.

The first baselines worth keeping come from Dev/UAT, once the workload profile from real traffic exists
([workload-model.md](workload-model.md) §9).

## 13. Not covered yet

| Gap | Why it matters | Plan |
|---|---|---|
| Adaptors (OpenHIM, Tiberbu) | They sit in front of the collector | Independent modules later ([conventions.md](conventions.md) §7.3) |
| End-to-end flow | Event → enrolment p95 < 10 s across all services | `end-to-end-flow/` module later; the v1 flow is on the `ebuzima-flow-tests` branch |
| Soak (hours at peak) | Memory leaks, lag growth, disk, autovacuum | New test type ([conventions.md](conventions.md) §7.1) |
| Spike / backfill | A clinic uploads a day of events at once | Needs `WORKLOAD_PROFILE` (reserved) |
| Recovery | Matcher killed, Kafka down: does it catch up without loss? | Not designed yet |
| Analytics path | Debezium → ClickHouse → insights (dashboards < 500 ms) | Later |
| Matcher scaling | More consumers or partitions | Not designed yet |
