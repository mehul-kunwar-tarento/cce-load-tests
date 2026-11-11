<!--
  What:    Test plan of the cce-step-sla-service performance tests: what is tested, how it is fed and measured,
           test types and defaults, thresholds and expectations (marked "to be confirmed"), data checks, Grafana
           panels, plan-definition variations, conditions recorded, risks, and the commands.
  How:     Read before running or changing a Step SLA test; the numbers here are the defaults of
           config/settings/defaults.json and can be overridden per run (--set NAME=value or env var NAME).
  Needs:   ../README.md (quick start), test-strategy.md (the why), the repository's tools/README.md.
  Outputs: Documentation only.
-->

# CCE Step SLA Service Performance Tests — Test Plan

Values marked **TBC** are "to be confirmed from UAT/Dev data" (or by the team): they are sensible starting points,
not agreed limits. Laptop numbers are for trying the scripts and comparing runs with each other, not capacity
statements about production.

## 1. What is tested

cce-step-sla-service (release-2.0.0) on its own: the scheduled sweep that picks up SLA transitions ("alarms")
whose deadline has passed and writes the verdict. For each `DUE_DATE_REACHED` alarm of a mandatory step that was
not done in time it sets `step_instance.sla_status = 'OVERDUE'`, writes a `step_instance_history` row and one
`OVERDUE` deviation, and marks the alarm processed.

Questions answered for every run:

- **How many alarms went through in the configured interval** (seeded, handled, and how long each waited).
- **Whether every alarm was handled in time** (longest wait against the rule) and correctly (`OVERDUE` + one
  deviation per step).
- **When it started breaking** (the ring time of the first alarm that waited longer than the rule) and **what
  broke** (waits, not caught up, failed batches, scheduler stopped, service restarted).
- **Expectation vs result**, in alarms per second, against the peak alarm rate.

Not tested here: the Matcher Service that normally creates the alarms (it has its own tests), `MET` verdicts
(`MET_CONDITION_REACHED`), several Step SLA replicas, and the whole flow (later end-to-end module).

## 2. How it is fed and measured

**Fed by alarms seeded in Postgres.** `seeding/seed-alarms.mjs` inserts, in one transaction, for every alarm the
rows the matcher writes for one enrolment with one mandatory step: a test enrolment (`protocol_instance`, patient
`LOADTEST-<runId>-sla-0-<n>`, and its `ACTIVE` `protocol_instance_history` row dated at enrolment), one mandatory
step not done (`step_instance`, `required_behavior = 'must'`, `NOT_STARTED`, and its `NOT_STARTED`
`step_instance_history` row) and its alarm (`step_sla_state_transition`, `DUE_DATE_REACHED`,
`process_by = next_attempt_at = ring time`): 5 rows per alarm. Step SLA reads only the step and the alarm; the
history rows are there so table volumes match production-shaped data (a judged step ends with 2 history rows,
`NOT_STARTED` and `OVERDUE`, as in production). Alarm `n` (0-based) rings at

```
ring(n) = seeding time + STEP_SLA_FIRST_RING_DELAY + n / rate        (storm: rate 0 → all at the same moment)
```

so the ring schedule *is* the load: 50 alarms per second ringing for 10 minutes is 50 alarms/s of work arriving.
Ids are UUIDv7-shaped (time-ordered, so data checks and cleanup can bound their scans). Only `DUE_DATE_REACHED`
rows are seeded unless `STEP_SLA_SEED_MISSED_ALARMS=true` (§9). **This differs from the matcher on purpose**: the
matcher also schedules a `MISSED_DATE_REACHED` alarm for every step with `tolerance-days` (every mandatory step of
the base plan definition, 1 day after the due date). Seeded, it would ring after the test as a second storm nobody
watches; Step SLA's verdict on the `DUE` alarm does not depend on it. When opted in, the seed rings it 3 days after
the due date (v1), not after the step's tolerance.

**Measured twice.**

| What | How | Role |
|---|---|---|
| Live watch (`watchers/alarm-watcher.mjs`, every `WATCH_INTERVAL` 5 s) | `cce_sla_transitions_due` (alarms rung, not handled), increase of `cce_sla_transitions_applied_total` + `_skipped_total` (handled), `cce_sla_evaluator_cycles_total` (scheduler alive), `cce_sla_evaluator_batches_failed_total` | Progress, early stop (restart, stall, scheduler stopped), drain rate and cap hits for the storm, `watch-alarms.json` |
| Database (`data-checks/step-sla-data-checks.mjs`, after the watch) | For each seeded alarm: `processed_at − process_by` = its **wait**; `sla_status`; its `OVERDUE` deviation | **The verdict** (the counters are global and sampled; the database knows every alarm exactly) |
| Sampler (`service-metrics.json`) | Hikari (pool of 3), heap, GC pause, CPU, the five `cce_sla_*` metrics | Diagnostics: explain a break, never decide it |

## 3. Test types and defaults

| Test type | Alarms | Ring rate | Ring period | Settings (rate · duration · count) | Waits for after the last ring |
|---|---|---|---|---|---|
| `smoke` | 30 | 1/s | 30 s | `SMOKE_RATE` · `SMOKE_DURATION` · `SMOKE_EVENTS` | `CATCH_UP_LIMIT` 2m |
| `load` | 30,000 | 50/s | 10 min | `LOAD_RATE` · `LOAD_DURATION` · `LOAD_EVENTS` | `CATCH_UP_LIMIT` 2m |
| `stress` | 120,000 | 200/s | 10 min | `STRESS_RATE` · `STRESS_DURATION` · `STRESS_EVENTS` | `CATCH_UP_LIMIT` 2m |
| `breakpoint` (storm) | 100,000 | all at once | 0 s | `STEP_SLA_STORM_ALARMS` | `BREAKPOINT_CATCH_UP_LIMIT` 15m |

- The first alarm rings `STEP_SLA_FIRST_RING_DELAY` (60 s) after seeding. There is no warm-up phase.
- **Settings Step SLA ignores**: `WARM_UP_RATE` and `WARM_UP_DURATION` (no warm-up phase), and the event settings
  `DATASET`, `EVENT_ACTION_ID`, `EVENT_SOURCE`, `FACILITY_ID` (no event is sent; the seeded step is chosen by
  `STEP_SLA_ACTION_ID`). The shared settings printout still lists `WARM_UP_*` and the start banner still prints a
  `dataset:` line for every service (shared tooling, outside this folder); disregard them for Step SLA. When one of
  them is overridden for the run (`--set` or an environment variable), the run prints a warning
  "`<NAME>=… is ignored: …`" before seeding and saves it in `result.json` `warnings`. The dry run has no module hook
  and does not show that warning.
- **Rate + duration or total**: `*_EVENTS` counts alarms here; when set, the duration becomes `ceil(alarms / rate)`
  (e.g. `--set LOAD_EVENTS=5000` → 5,000 alarms at 50/s over 100 s). The phase plan printed at the start
  (`--dry-run` shows it without connecting) is the single source of the count and the rate: seeding, watcher,
  data checks and the report all read it.
- Seed mode `STEP_SLA_SEED_MODE`: `set` (default) spreads the alarms over the plan-definition set (§7);
  `single-action` reproduces v1 (first plan definition, `STEP_SLA_ACTION_ID` = `vitals-recording`).
- `WATCH_INTERVAL` 5 s, `STALL_TIMEOUT` 30 s, `IDLE_FLAT_DURATION` 30 s, `IDLE_TIMEOUT` 5 m: before seeding the
  runner waits until no alarm is due for 30 s (an earlier test's alarms would compete).

## 4. Thresholds and expectations

**Expectation, in alarms per second.** One patient event creates one or more `DUE` alarms depending on the
plan-definition set, so Step SLA rates are never compared with the events/s peak (`PEAK_RATE`). The peak alarm
rate is `STEP_SLA_PEAK_ALARM_RATE` — **TBC**; `auto` = `ceil(PEAK_RATE × DUE alarms per event)`: 1 for both
`emr-service` and `kenya-sha-emr-service` → **50 alarms/s**. "× peak" in the report uses that number (load 50/s =
1 × peak with either set).

| Test | Expected (the report's "Expected:" line) |
|---|---|
| smoke, load, stress | Every alarm handled, each within `STEP_SLA_MAX_WAIT` of ringing, each step `OVERDUE` with one deviation |
| breakpoint (storm) | All 100,000 handled within `STEP_SLA_STORM_MAX_CATCH_UP` of ringing; drain ≥ `EXPECTED_HEADROOM` (4) × peak alarm rate (informational) |

**Rules** (in `result.json` `thresholds` and `dataChecks`; required unless marked):

| Id | Rule | Default | TBC |
|---|---|---|---|
| `step-sla.max-wait` | longest wait after ringing `<` `STEP_SLA_MAX_WAIT` (smoke/load/stress) | `auto` = 2 × poll interval = 10 s local (30 s with the 15 s prod poll) | yes |
| `step-sla.storm-catch-up` | last alarm handled `<` `STEP_SLA_STORM_MAX_CATCH_UP` after the ring (breakpoint) | 5 min | yes |
| `step-sla.all-handled`, `.all-overdue`, `.deviations`, `.alarms-seeded` | each = alarm count | — | no |
| `step-sla.caught-up` | every alarm handled within the catch-up limit after the last ring (from the database; the watcher's counter-based estimate is replaced) | 2 min / storm 15 min | no |
| `step-sla.batches-failed` | no batch rolled back during the run | 0 | no |
| `step-sla.scheduler-alive` | evaluation cycles ran during the run | > 0 | no |
| `step-sla.drain-rate` | storm median drain ≥ `EXPECTED_HEADROOM × STEP_SLA_PEAK_ALARM_RATE` — **informational**, the storm verdict is the catch-up | 200 alarms/s (both sets) | yes |
| `step-sla.wait-avg`, `.wait-p95`, `.storm-drain` | reported only (`severity: info`) | — | — |

**When it started breaking** = the ring time (`process_by`) of the first alarm whose wait exceeded the rule (or
that is still waiting past it), with the ring rate at that moment; for the storm there is no rate (all at once),
so the report gives the time and the drain rate. **What broke** lists the failed rules in words, plus diagnostics
near that time (e.g. Hikari requests waiting, "Step SLA hit the 10,000-rows-per-cycle cap"). Not caught up is
reported as "N alarms still waiting after N s" — never as a catch-up time.

**The 10,000-rows-per-cycle cap.** One cycle handles at most 100 batches × 100 rows; with more due, the rest
waits for the next cycle. `serviceMetrics.peaks['step-sla'].slaCycleCapHits` counts cycles that reached it (an
estimate from the counters, ± one sample; Step SLA's log line "stopped at the 100-batch cycle limit" is exact).
At a steady ring rate it should be 0; in the storm it explains the drain rate.

**Drain rate** (alarms handled per second while more than 1,000 are due) is reported **for the storm only**: at a
steady rate it simply equals the ring rate. The database also gives the storm average (alarms ÷ catch-up time).

v1 laptop numbers, relative only: load longest wait 5 s, stress 5.1 s; storm 100,000 alarms, p95 wait 68.8 s,
longest 69.8 s (about 1,490 alarms/s).

## 5. Data checks

One query per run (`statement_timeout` 5 min), selecting this run's alarms only: `protocol_instance.id ≥` the
UUIDv7 floor of run start − 5 min (primary-key range), then `patient_id LIKE 'LOADTEST-<runId>-sla-%'`.

| Check | Expected | Severity |
|---|---|---|
| `step-sla.alarms-seeded` | seeded alarms found = alarm count | required |
| `step-sla.all-handled` | `is_processed` = alarm count | required |
| `step-sla.all-overdue` | `sla_status = 'OVERDUE'` = alarm count | required |
| `step-sla.deviations` | `OVERDUE` deviations = alarm count | required |
| `step-sla.max-wait` (steady) / `step-sla.storm-catch-up` (storm) | under the limit; carries "started breaking" | required |
| `step-sla.wait-avg`, `step-sla.wait-p95`, `step-sla.storm-drain` | — | info |

Seeded = handled = `OVERDUE` = deviations is the Step SLA form of "sent = stored = processed". Re-run a finished
run's checks with `node tools/cli.mjs check-data <env> <resultDir>`.

## 6. Grafana panels to watch

Dashboard **CCE Step SLA Service — Performance** (`monitoring/grafana/dashboards/cce-step-sla-service-performance.json`,
uid `cce-perf-step-sla`), on the laptop stack (`monitoring/`) or imported into CCE's Grafana:

- **Alarms due now** (`cce_sla_transitions_due`): rises while ringing, must come back to 0; the storm shows the
  drain as a falling line.
- **Alarms applied / skipped per second**: equals the ring rate in steady tests; the drain rate in the storm.
  Skipped should stay 0 (seeded steps are mandatory).
- **Evaluator cycles per second**: flat at 1 / poll interval; a gap = scheduler stopped (or a long capped cycle).
- **Failed batches (last 5 minutes)**: must stay 0.
- **Hikari connections (Step SLA, pool of 3)**: pending > 0 means the pool is the limit.
- **Postgres rows updated per second**, **JVM heap**, **GC pause**, **container CPU/memory**.

Step SLA runs have no k6 series: type the run id into the `testid` variable (custom values are allowed); the
run's start/end, "last alarm rang", "caught up" and "started breaking" appear as annotations.

## 7. Plan-definition variations

`PLAN_DEFINITION_SET` (recorded with every result) chooses the plan definitions the alarms belong to. With the
default `STEP_SLA_SEED_MODE=set`, alarm `n` goes to pair `n mod P` over every (plan definition × mandatory step
with a deadline) pair of the set, one patient per alarm. A mandatory step without `tolerance-days` gets no
alarm from the matcher, so none is seeded for it:

| Set | Mandatory steps with a deadline (pairs) | Pairs P | DUE alarms per event (peak alarm rate) |
|---|---|---|---|
| `emr-service` | vitals-recording, consultation, diagnosis | 3 | 1 (50/s) |
| `kenya-sha-emr-service` | consent-verification, visit-encounter, patient-check-in, diagnosis (not consent-request: mandatory, no deadline) | 4 | 1 (50/s) |

What changes: which `protocol_definition` and action each step belongs to (Step SLA reads both per row), and the
peak alarm rate. What does not: the number of alarms per test (that is the phase plan). `seed.json` lists every
pair with its alarm count. `single-action` mode ignores the set's spread (v1 behaviour, recorded as
`stepSlaSeedMode`); it refuses a `STEP_SLA_ACTION_ID` that is not a mandatory step with a deadline in the first plan definition
(Step SLA would only skip an optional one: no verdict, no deviation). The default `vitals-recording` fits
`emr-service`; for `kenya-sha-emr-service` use e.g. `consent-verification`. Every plan definition of the set must be ACTIVE (seeded enrolments
reference it): `scripts/manage-plan-definitions.sh load <env> --set <name>` first.

## 8. Conditions recorded

Every `result.json` carries: environment and service URLs; host (CPUs, memory, OS, Node); suite commit; the
plan-definition set (canonicals, mandatory steps, other ACTIVE ones) and `stepSlaSeedMode`; data volume (database
size, rows of the main tables); every setting with its source (default, environment, env var, `--set`,
derived); preflight status and warnings. `seed.json` adds the pairs, ring start/end, first-ring delay, whether
MISSED alarms were seeded and any seeding warning. Baselines refuse to mix runs whose conditions differ.

## 9. Risks and known limits

- **Laptop numbers** are relative only (shared CPU, Docker); real numbers come from Dev/UAT with the prod poll
  interval (set `services.stepSla.pollIntervalSeconds` in the environment file: it drives `STEP_SLA_MAX_WAIT=auto`).
- **Global counters**: Step SLA's metrics count all its work. Run one Step SLA test at a time and let the runner
  wait for idle; on shared environments the database checks (this run's alarms only) decide, and the report says
  when the counters moved by more than this run's alarms.
- **MISSED alarms ring days later**: with `STEP_SLA_SEED_MISSED_ALARMS=true` every alarm also gets a MISSED alarm 3
  days after its ring — a second storm long after the test. Off by default; if used, clean up before then.
- **Seeding time**: the rows are invisible to Step SLA until the seed transaction commits. If seeding takes longer
  than `STEP_SLA_FIRST_RING_DELAY` (possible for 120,000 alarms on a slow disk), the first alarms' waits include
  it; `seed.json` and the report warn. Raise the delay (`--set STEP_SLA_FIRST_RING_DELAY=3m`).
- **Schema**: Step SLA needs the `step_group_instance` table locally; preflight `schema-step-groups` checks it.
- **Hikari pool of 3** and Postgres write speed (history rows, deviations, WAL) bound the storm; the Debezium slot
  on Dev/UAT also sees every write.
- **`slaCycleCapHits`** is an estimate from the counters (± one sample interval of rows).
- **Cleanup side effects**: deleting 100,000+ alarms with their steps and enrolments is a large delete
  (autovacuum afterwards; preflight warns until it finishes). Always clean up by run id after a run.
- **Prod is always refused.** Dev/UAT need team agreement before loading test plan definitions (open question).

## 10. How to run

```bash
export DB_PASSWORD=…
scripts/check-services.sh local --subject step-sla                       # preflight only (also runs before every test)
scripts/manage-plan-definitions.sh load local --set emr-service          # once per set
scripts/print-settings.sh local step-sla load                            # settings + alarm schedule, no connection
scripts/run-test.sh local step-sla smoke                                 # then load, stress, breakpoint
scripts/run-test.sh local step-sla load --set PLAN_DEFINITION_SET=kenya-sha-emr-service
scripts/run-test.sh local step-sla breakpoint --set STEP_SLA_STORM_ALARMS=20000
node tools/cli.mjs check-data local results/step-sla-load-<yyyymmdd-hhmmss>   # re-run the data checks
scripts/build-report.sh --latest 4 --subject step-sla                    # the last four in one summary
scripts/manage-baselines.sh save local-step-sla results/step-sla-load-…  # ≥ 3 runs per test
scripts/cleanup-test-data.sh local --run-id <runId> --dry-run            # counts per table, then without --dry-run
```

Exit codes: 0 passed · 1 failed or aborted · 2 refused (preflight, idle timeout, set not ACTIVE, action not
mandatory, prod) · 3 tool error. The verdict is `result.status` in `result.json`.
