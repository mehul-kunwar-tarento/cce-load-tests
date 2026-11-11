<!--
  What:    Onboarding runbook: everything needed to go from a fresh checkout to a finished, cleaned-up test of
           each service — prerequisites, the k6 image, npm install, the monitoring stack, configuring an
           environment, plan-definition sets, preflight, running every test, reading report.md, result.json and
           Grafana, series reports, baselines, cleanup, and troubleshooting built from the first round's lessons.
  How:     Follow it top to bottom the first time; later jump to the section you need. Commands run from the
           repository root. Words in italics are explained in glossary.md.
  Needs:   A Linux (or macOS) machine with Docker and Node.js 22; a CCE stack (openphc-repos/local-stack on a
           laptop, or Dev/UAT); the database password in DB_PASSWORD.
  Outputs: Documentation only. The commands write results/<subject>-<test-type>-<yyyymmdd-hhmmss>/ folders.
-->

# CCE Performance Tests — Runbook

> First run: §1 → §8 with a smoke test. Every command here exists in `node tools/cli.mjs --help`; every
> command also has `--help`.

---

## 1. Prerequisites

| You need | Why | Check |
|---|---|---|
| Docker (with Compose v2 for the monitoring stack) | k6 runs in a container; the monitoring stack too | `docker version` |
| Node.js 22 or newer | The CLI and all tooling (`engines: >=22`, enforced by `.npmrc`) | `node --version` |
| A CCE stack on `release-2.0.0` | The services under test | laptop: `openphc-repos/local-stack` running (`docker ps` shows the `cce-…` containers) |
| The database password of the CCE user | Preflight, data checks, Step SLA seeding and cleanup read Postgres | you get it from whoever runs the stack; it is **never** written to a file |
| Free disk (≥ 20 GB by default, `MIN_FREE_DISK_GB`) | Every test event costs Postgres WAL and Kafka disk (the first round measured 33–100 KB per event with 4 plan definitions) | preflight checks it |
| For Dev/UAT: a separate host for k6, close to the services | A laptop over a VPN measures the network, not CCE | – |

You do **not** need k6 installed: it comes in the Docker image (§3). Knowing k6 is not needed to run tests,
only to change them.

New to performance testing? Read [test-strategy.md](test-strategy.md) §2–§4 first (ten minutes) and keep the
[glossary](glossary.md) open.

## 2. Install the Node tooling

```bash
cd cce-load-tests
npm install            # exact versions from package-lock.json: pg, kafkajs, eslint, prettier
npm test               # optional: every unit test, with fakes (connects to nothing)
node tools/cli.mjs --help
```

`npm run perf -- <command> …` is the same as `node tools/cli.mjs <command> …`. The `scripts/*.sh` files are
short wrappers around the CLI (the table in §8.4 maps them).

## 3. Build the k6 image

The tests need k6 **with the Kafka extension** (for the matcher), which the official image does not have, so
the suite builds its own once per machine:

```bash
scripts/build-k6-image.sh                                     # needs internet during the build
docker run --rm cce-load-tests/k6:2.3.0-kafka2.2.0 version    # prints k6 v2.3.0 and the xk6-kafka extension
```

The image name is also in every environment file (`k6.image`); change both together. Why a custom build and
how it works: [docker/k6/README.md](../docker/k6/README.md).

## 4. Start the monitoring stack (optional on the laptop, recommended)

Tests run without Grafana, but the dashboards show load, latency, Kafka lag, DB pools, CPU/memory and disk on
**one timeline** — the fastest way to see why something broke. On the laptop:

```bash
export GRAFANA_ADMIN_PASSWORD='<choose one>'   # laptop Grafana admin; also lets the runner write run markers
export DB_PASSWORD='<cce_user password>'       # read by postgres-exporter
docker compose -f monitoring/docker-compose.yml up -d     # local-stack must already be running (network cce-net)
# Prometheus: http://localhost:9095/targets (all UP?)   Grafana: http://localhost:3030 → Dashboards → CCE Performance
docker compose -f monitoring/docker-compose.yml down      # stop (keeps metrics); "down -v" also deletes them
```

It starts six containers: Prometheus (accepts k6's pushes), Grafana, kafka-exporter (matcher lag),
postgres-exporter (connections, WAL, replication slots), **cAdvisor** (CPU and memory per container) and
**node-exporter** (free disk where Docker keeps Postgres and Kafka data) — all on by default. Ports, versions,
the observer effect of scraping and how to use CCE's own Grafana instead:
[monitoring/README.md](../monitoring/README.md) and
[monitoring/cce-grafana-import/README.md](../monitoring/cce-grafana-import/README.md).

With `monitoring.enabled: true` in the environment file (true for `local`), k6 pushes its metrics to
Prometheus by remote write. Turn it off for one run with `--set PROMETHEUS_REMOTE_WRITE=false`. If Prometheus
is down the test still runs; preflight warns (or fails with `MONITORING_REQUIRED=true`).

## 5. Configure an environment

An environment file says where everything is: `config/environments/<env>.json`. Details of every field:
[config/README.md](../config/README.md).

| Environment | File | Ready? |
|---|---|---|
| Laptop (`local-stack`) | `config/environments/local.json` | Yes: collector 8093, matcher 8097, Step SLA 8099, protocol 8096, Postgres 15433, Kafka 29092, Prometheus 9095, Grafana 3030 |
| Dev, UAT | copy `dev.example.json` → `dev.json`, `uat.example.json` → `uat.json` | Replace every `REPLACE-ME`; keep `allowTempIndex` and `allowPlanDefinitionChanges` false until the team agrees |
| Your own tweaks | `config/environments/<env>.local.json` (git-ignored) | Deep-merged over `<env>.json`, e.g. different ports on your laptop |

Rules that matter:

- Service URLs are the **direct** service URLs, never the API gateway (it rate-limits `/v1/events`).
- **Secrets only in environment variables**, never in a file or a result:

  ```bash
  export DB_PASSWORD='…'               # the variable named by database.passwordEnvVar (DB_PASSWORD by default)
  export GRAFANA_API_TOKEN='…'         # Dev/UAT Grafana: service-account token (Editor) for run markers
  export GRAFANA_ADMIN_PASSWORD='…'    # laptop Grafana: used for run markers when no token is set
  ```

  Neither Grafana variable set → the run works, run markers are skipped with one warning.
- Anything named or marked `prod` is refused by every command (exit 2).
- Environment-specific setting values go in the file's `settings` block.
- **Set `services.stepSla.pollIntervalSeconds` to the environment's real Step SLA poll interval**
  (`cce.sla.poll-interval-ms` / `CCE_SLA_POLL_INTERVAL_MS`, in seconds). `STEP_SLA_MAX_WAIT=auto` is derived
  from it (2 × poll). `local.json` ships `5` (the service's default profile, `application.yml`, as in
  `local-stack`). The Dev/UAT templates (`dev.example.json`, `uat.example.json`) ship **`15`**, because
  `deploy-scripts` start the service with the `prod` profile (`application-prod.yml`, 15 000 ms), so
  `STEP_SLA_MAX_WAIT=auto` gives 30 s there. Change it to `5` only if that environment runs the default
  profile: a value smaller than the real interval reports a healthy scheduler as stopped and fails healthy
  runs. Ask whoever deploys the environment which value it uses; override `STEP_SLA_MAX_WAIT` in the
  `settings` block only when you want a limit that is not 2 × poll.

Check an environment without connecting to it: `node tools/cli.mjs settings <env>`.

## 6. Plan-definition sets

Which plan definitions are ACTIVE changes the matcher's and Step SLA's work more than anything else, so the
set is a test parameter: `PLAN_DEFINITION_SET` = `emr-service` (default; the protocol of the `ebuzima-emr`
dataset) or `kenya-sha-emr-service` (the Kenya SHA protocol of the `tiberbu-emr` dataset)
([test-data/README.md](../test-data/README.md)). Each set holds one plan definition, and the run sends that
set's own dataset unless `DATASET` is set, so `--set PLAN_DEFINITION_SET=kenya-sha-emr-service` alone is
enough. Sets are named after their protocols, not their EMRs ([conventions.md](conventions.md) §8). The set must be **loaded** (ACTIVE in the protocol service)
before a test that uses it — **including Step SLA tests**, whose seeded enrolments reference ACTIVE plan
definitions even though no event is sent.

```bash
scripts/manage-plan-definitions.sh validate --set kenya-sha-emr-service      # offline check (no connection)
scripts/manage-plan-definitions.sh generate --set kenya-sha-emr-service      # write the FHIR files as loaded to .cache/ to inspect
scripts/manage-plan-definitions.sh status local --set kenya-sha-emr-service  # ACTIVE / RETIRED / missing, marker, ledger
scripts/manage-plan-definitions.sh load local --set kenya-sha-emr-service    # load the missing ones, then wait 65 s
scripts/manage-plan-definitions.sh list-active local                         # every ACTIVE plan definition
scripts/manage-plan-definitions.sh retire local --set kenya-sha-emr-service  # after testing (asks for "yes")
scripts/manage-plan-definitions.sh delete local --set kenya-sha-emr-service  # only when no enrolment uses them
```

`load` waits `PROTOCOL_REFRESH_WAIT` (65 s) because the matcher refreshes its plan definitions every 60 s.

**Write safety** (`load`, `retire`, `delete`):

1. Every write needs `safety.allowPlanDefinitionChanges: true` in the environment file (true for `local`,
   false in the Dev/UAT templates).
2. On `dev`/`uat` a write is also refused unless every version carries a suffix
   (`--setting PLAN_DEFINITION_VERSION_SUFFIX=-loadtest`; here `--set` names the set) or every url contains
   `/loadtest/`. The shipped sets use the real url and version (`emr-service-protocol|1.0.0`), which may be
   ACTIVE for real there. Use the **same suffix** for the runs (`PLAN_DEFINITION_VERSION_SUFFIX=-loadtest
   scripts/run-test.sh …`), so preflight and the result look up the suffixed versions.
3. `load` marks what it posts with a *load-test marker* (a FHIR `meta.tag`); `retire` and `delete` refuse any
   definition without it ("not loaded by this tool: left untouched") and never touch a plan definition outside
   the named set.
4. `retire` is irreversible for that url + version: loading it again needs a new suffix. `delete` returns 409
   while enrolments still use the definition — run cleanup first (§12).
5. Even a suffixed test definition has the real triggers: while ACTIVE on a shared environment it also
   matches real events. Loading sets on Dev/UAT needs team agreement (open questions 3 and 15).

## 7. Preflight

Before every run the runner checks the stack by itself; run it on its own first to see the state. It sends no
test traffic (it is not a smoke test):

```bash
scripts/check-services.sh local                                   # stack check: every service the environment defines
scripts/check-services.sh local --subject matcher                 # exactly what a matcher test needs
scripts/check-services.sh local --subject matcher --set PLAN_DEFINITION_SET=kenya-sha-emr-service
scripts/check-services.sh local --subject collector --json --out /tmp/preflight.json
```

One line per check: `✔` pass, `✖` fail, `!` warning, `–` skipped. A failed **required** check means "do not
start the test" (exit 2; `run` stops there too). The checks:

| Check | What it proves |
|---|---|
| `environment`, `docker` | Environment file valid and not prod, password variable set; Docker works and the k6 image exists |
| `service-health.<subject>` | `/actuator/health` is UP (a crash-looping service can show its container "up") |
| `service-metrics.<subject>` | `/actuator/prometheus` answers and has the service's key counter |
| `postgres`, `postgres-target` | Postgres answers, and it is the **right** database (name, port, expected tables) |
| `schema-step-groups` | The `step_group_instance` table exists (needed by Step SLA seeding) |
| `kafka`, `matcher-consumer-group` | The inbound topic exists with the expected partitions; the matcher group is Stable with all partitions assigned |
| `plan-definition-set` | Every plan definition of the set is ACTIVE; **other** ACTIVE plan definitions matching the dataset's events fail it for the matcher (§14) |
| `disk.results`, `disk.data-stores` | Free disk for results and for Docker's data (Postgres WAL, Kafka) ≥ `MIN_FREE_DISK_GB` |
| `wal-and-slots` | Replication slots healthy, safe WAL size above `CLEANUP_MIN_SAFE_WAL_GB` |
| `autovacuum` | No vacuum running and few dead rows (after a big cleanup the next test is slower) |
| `leftover-test-data` | No LOADTEST data left, and no test alarms about to ring in the next 24 h |
| `step-sla-scheduler` | Step SLA's evaluator cycle counter increases (its health does not cover the database) |
| `monitoring` | Prometheus ready, remote write accepted, Grafana healthy, annotation credentials present |

`SKIP_PREFLIGHT=true` skips it for a run (recorded in the result; not recommended).

## 8. Run the tests

### 8.1 The first test

```bash
scripts/run-test.sh local collector smoke --dry-run    # prints settings, phase plan, docker command; writes nothing
scripts/run-test.sh local collector smoke              # 1 event/s for 30 s
```

A run prints, in order: environment, subject, test type, **run id**, results folder, plan-definition set, the
settings table (value, source, "to be confirmed"), the phase plan and the docker command (secrets masked);
then preflight, the idle wait, k6's progress, the watchers, the data checks and finally the report. On Linux
desktops `scripts/run-test.sh` keeps the machine from sleeping while it runs (`systemd-inhibit`).

**The first smoke can fail on a cold service.** Smoke has no warm-up. If the service was just started or has
been idle for a while, its first request can take seconds instead of milliseconds: the JVM has not compiled
the code yet, and idle database and Kafka connections may have to be reopened. With only 30 events, that one
request is enough to fail the p95 rule, and it can also cost one dropped iteration (k6 has no free VU while
the request hangs). It is a cold start, not a broken setup, when the data checks pass, no request failed, and
the slowness is only in the first report window (`window:0` in `k6-summary.json`). Run smoke again straight
away; on a warm service it should pass. Example from the laptop stack: cold run p95 813 ms (one request
2,338 ms, one dropped), warm re-run a minute later p95 16 ms, nothing dropped. Load, stress and breakpoint are not
affected: their warm-up phase is not measured.

### 8.2 Every service and test type

| Service | smoke | load | stress | breakpoint |
|---|---|---|---|---|
| Collector (HTTP) | `scripts/run-test.sh local collector smoke` | `… collector load` | `… collector stress` | `… collector breakpoint` (staircase); refine: `… collector breakpoint --refine-from results/collector-breakpoint-<stamp>` |
| Matcher (Kafka) | `scripts/run-test.sh local matcher smoke` | `… matcher load` | `… matcher stress` | `… matcher breakpoint` (flood, then drain) |
| Step SLA (seeded) | `scripts/run-test.sh local step-sla smoke` | `… step-sla load` | `… step-sla stress` | `… step-sla breakpoint` (storm) |

Defaults: smoke 1/s for 30 s; load 50/s for 10 min (collector and matcher after a 1-min warm-up); stress 200/s
for 10 min; collector staircase 200 → 6400/s, 1 min per level; matcher flood 2,000/s for 1 min; Step SLA storm
100,000 alarms at once. What each test checks, its rules and its Grafana panels are in the service's test plan:
[collector](../cce-collector-service/docs/test-plan.md) ·
[matcher](../cce-matcher-service/docs/test-plan.md) ·
[Step SLA](../cce-step-sla-service/docs/test-plan.md).

**Rules of thumb**

- **One test at a time.** Matcher and Step SLA counters are global; each run waits until the service is idle
  first and is refused (exit 2) after `IDLE_TIMEOUT` (5 min).
- **Smoke first**, after every restart or setup change. A JVM is slow in its first minute; the load tests have a
  warm-up for that, but a failing path should fail in 30 s, not 11 minutes.
- **Same set for the whole round.** Load the set (§6), then run every test with the same `PLAN_DEFINITION_SET`.
- Long runs: `stress` takes ~11 min plus catch-up; a matcher flood can take up to 15 min to drain.

### 8.3 Changing the load

No code changes, ever — `--set` (repeatable) or an environment variable of the same name:

```bash
scripts/run-test.sh local collector load --set LOAD_RATE=80 --set LOAD_DURATION=5m
scripts/run-test.sh local matcher load --set LOAD_EVENTS=10000               # duration derived: 10,000 ÷ 50 = 200 s
STRESS_RATE=300 scripts/run-test.sh local collector stress
scripts/run-test.sh local matcher stress --set PLAN_DEFINITION_SET=kenya-sha-emr-service --set NOTE="Kenya protocol, after V8 index"
scripts/run-test.sh local step-sla breakpoint --set STEP_SLA_STORM_ALARMS=300000
scripts/run-test.sh local collector load --all-settings --dry-run           # every setting, not only the relevant ones
```

What each setting means and its default: [workload-model.md](workload-model.md).

### 8.4 Scripts and CLI commands

| Script | CLI command | What it does |
|---|---|---|
| `scripts/run-test.sh` | `node tools/cli.mjs run` | One test, end to end |
| `scripts/print-settings.sh` | `node tools/cli.mjs settings` | Settings and phase plan, no connection |
| `scripts/check-services.sh` | `node tools/cli.mjs preflight` | Preflight on its own |
| `scripts/manage-plan-definitions.sh` | `node tools/cli.mjs plan-definitions` | Plan-definition sets |
| `scripts/build-report.sh` | `node tools/cli.mjs report` | Run report or series report |
| `scripts/manage-baselines.sh` | `node tools/cli.mjs baseline` | Save / compare / list / show baselines |
| `scripts/cleanup-test-data.sh` | `node tools/cli.mjs cleanup` | Delete a run's test data, verified |
| – | `node tools/cli.mjs check-data` | Re-run a finished run's data checks |
| `scripts/build-k6-image.sh` | – | Build the k6 image |

**Exit codes** of every command: `0` passed / done · `1` failed or aborted (cleanup: incomplete) · `2`
refused (prod, preflight failed, guard, idle timeout, bad setting) · `3` tool error.

## 9. Read the results

Each run writes `results/<subject>-<test-type>-<yyyymmdd-hhmmss>/` (git-ignored):

| File | What it holds |
|---|---|
| `report.md` | The concise report (also printed at the end of the run). Rendered from `result.json` only |
| `result.json` | **The source of truth**: status, expectation, load, latency, thresholds, breaking, levels, time series, service-metric peaks, data checks, conditions. Schema: `tools/results/result.schema.json` |
| `run-context.json` | Resolved settings and phase plan handed to k6 |
| `preflight.json`, `seed.json` | Preflight checks; Step SLA's seeded alarms |
| `k6-summary.json`, `k6.log` | k6's raw summary and output |
| `watch-*.json`, `service-metrics.json` | Watcher samples (backlog, due alarms) and sampled service metrics, every `WATCH_INTERVAL` |
| `data-checks.json` | The SQL checks with expected and actual values (and the SQL text) |
| `baseline-comparison.json`, `cleanup-<stamp>.json` | Written by `baseline compare` and by cleanup |

**`report.md`, section by section**

| Section | Read it as |
|---|---|
| Header | Service, test type, `PASSED` / `FAILED` / `ABORTED`, run id, environment, plan-definition set and its size, start–end clock time |
| Expectation vs result | What it was expected to withstand (marked *to be confirmed*) and how many events went through in the measured interval, at what average rate (warm-up excluded), against the target |
| Thresholds | One row per rule: limit, actual, pass/fail; "(to be confirmed)" on unconfirmed rules; informational rules marked "noted" |
| When it started breaking | Stress, breakpoint and any failed run: clock time and seconds into the measured phase, the rate at that moment, **what broke** in words (latency, errors, backlog, k6 limit) plus *diagnostics* from the service metrics; caught up or "N still waiting after S s"; for a staircase: held up to / broke at, × peak, and the level table |
| Data checks | Sent vs stored vs processed vs enrolled; `required` checks decide, `info` checks inform |
| Dropped iterations | Exact count, share, allowed count (< 0.1 %, to be confirmed), whether it decided the result |
| Conditions | Environment, machine, commit, plan definitions (and other ACTIVE ones), dataset, data volume, settings that differ from the defaults, preflight warnings |
| Baseline comparison | When `BASELINE` was set: per metric baseline, this run, change, verdict |

Re-render a report (e.g. after `check-data`): `scripts/build-report.sh results/<run folder>`. Re-run the data
checks later — **before** cleanup, which deletes the rows they count:
`node tools/cli.mjs check-data local results/<run folder>`.

## 10. Find a run in Grafana

Open http://localhost:3030 (laptop) → Dashboards → *CCE Performance*: the **Overview** for the whole
timeline, or the dashboard of the service under test.

1. Pick the run in **Run id** (`testid`, newest first; filter by *Service* and *Test type*). The orange shaded
   region marks the k6 run; green markers show run start/end, phase starts, send end, "started breaking" and
   "caught up" (posted by the runner).
2. Set the time range around the region. Service panels are not tagged with the run id (the services know
   nothing about tests): the time range and the markers locate the run.
3. **Step SLA runs have no k6** and are not in the Run id list: type the run id (printed at the start, also the
   end of the results folder name) into *Run id*, or add `&var-testid=<runId>` to the dashboard URL. The green
   markers then show seeding, first ring and catch-up.

What to look at per service: section 6 of each service's test plan. Panels that may be empty until the first
scrape confirms their metric names: [monitoring/README.md](../monitoring/README.md) §7.

## 11. Series reports and baselines

**Series report** — the lead's view over a round: per service (load: events through in the interval; stress:
events through, when it started breaking, what broke; breaking points vs expectation), then the whole flow
(weakest link until the end-to-end module exists):

```bash
scripts/build-report.sh --latest 12                         # the 12 newest runs
scripts/build-report.sh --since 2026-11-05 --subject matcher
scripts/build-report.sh --series results/<dir1> results/<dir2> --out results/round-1
```

It writes `summary.json` + `summary.md` (default `results/summary-<yyyymmdd-hhmmss>/`). Old v1 folders have no
`result.json` and are ignored.

**Baselines** — the mean of at least 3 runs under the same conditions ([baselines/README.md](../baselines/README.md)):

```bash
node tools/cli.mjs baseline save local-emr-service results/<r1> results/<r2> results/<r3> --note "laptop"
node tools/cli.mjs baseline compare local-emr-service results/<new run>
BASELINE=local-emr-service scripts/run-test.sh local matcher load          # compare right after the run
node tools/cli.mjs baseline list
node tools/cli.mjs baseline show local-emr-service
```

`--allow-fewer` saves a *provisional* baseline from fewer runs; `--force` replaces one. A comparison never
changes a run's status.

## 12. Clean up

**Cleanup is part of the test.** Test data is real data: it creates alarms that ring hours or days later,
fills Kafka (7-day retention) and the WAL, and is copied to ClickHouse. Clean up **the same day**, after the
services have finished processing, and before the next test round.

```bash
# 1. See the SQL it would run, connecting to nothing
scripts/cleanup-test-data.sh local --run-id 20261105-142233 --print-sql
# 2. Stage and count this run's rows per table, then roll back (nothing deleted)
scripts/cleanup-test-data.sh local --run-id 20261105-142233 --dry-run
# 3. Delete (asks you to type "yes"; --wait waits until the services stopped processing this run's data)
scripts/cleanup-test-data.sh local --run-id 20261105-142233 --wait
# Every LOADTEST row, including the shared test facility and first-version data
scripts/cleanup-test-data.sh local --all --dry-run
scripts/cleanup-test-data.sh local --all
# First-version (v1) runs: their event ids were random, so select them by the patient in the event JSON
scripts/cleanup-test-data.sh local --run-id 1103170952 --legacy-v1 --dry-run
```

What it does: stages the run's rows (selected by the *run selector* `LOADTEST-<runId>-<idCode>-`, bounded by the
run's start time), prints a per-table plan, deletes **child tables first** in batches of `CLEANUP_BATCH_SIZE`
(10,000) rows, one short transaction each, and finally proves the result: for every table it counts what is
left both from the snapshot of staged ids and by the selectors directly (*snapshot verification*); status
`verified` only when every count is 0. Output: a table `order · table · before · deleted · after` and a JSON
file next to the run (`results/<run>/cleanup-<stamp>.json`, or `results/cleanup-<runId|all>-<stamp>/cleanup.json`).
`--print-sql` writes no file.

| Table (in delete order) | | |
|---|---|---|
| 1 `intelligence_delivery_audit_log` · 2 `intelligence_delivery` · 3 `deviation` · 4 `step_sla_state_transition` · 5 `step_instance_history` | 6 `intelligence_event_log` · 7 `step_instance` · 8 `step_group_instance` · 9 `protocol_instance_history` | 10 `protocol_instance` · 11 `matcher_event_log` · 12 `inbound_event_log` · 13 `facility` (`--all` only) |

Never touched: plan definitions (`protocol_definition`, `trigger_index`, `action_definition`; use
`plan-definitions retire|delete`), adaptor and notification tables.

**Why batches and the WAL checks.** In the first round one 27-million-row `DELETE` in a single transaction
wrote more WAL than the replication slot may hold (`max_slot_wal_keep_size`, 10 GB); Postgres dropped it, the
Debezium slot was **lost**, ClickHouse stopped syncing and kept ~40 million stale test rows, and the insights
dashboard returned 503. Now cleanup checks free disk and every slot's safe WAL size before starting and every
10 batches, pauses between batches (`CLEANUP_PAUSE`) so Debezium and autovacuum keep up, and stops with status
`incomplete` (exit 1, counts saved) when a slot's `safe_wal_size` falls below `CLEANUP_MIN_SAFE_WAL_GB` or disk
runs low — rerun it later to continue.

**Refusals (exit 2)**: prod; `safety.allowCleanup` false; another database than configured; a run id that is a
prefix of another run's id in `results/`; the services still processing this run's data (unprocessed due alarms;
on the laptop any matcher lag) unless `--wait`; low disk or WAL; no typed `yes` (`--yes` for scripts).

**After a big cleanup, wait.** Autovacuum follows the deletes and competes with the next test (§14). Preflight's
`autovacuum` check warns until it is done.

## 13. A test round, in order

1. Stack up and idle; monitoring up; `export DB_PASSWORD=…` (and the Grafana variable).
2. `scripts/manage-plan-definitions.sh status local --set <set>` → `load` if needed.
3. `scripts/check-services.sh local` — fix every `✖`, read every `!`.
4. Per service: smoke → load → stress → breakpoint, one at a time, with the same `PLAN_DEFINITION_SET`.
5. Repeat the runs you want to baseline (≥ 3); `baseline save`.
6. `scripts/build-report.sh --latest <n>` → share `summary.md` (and the Grafana Overview).
7. `node tools/cli.mjs check-data …` for any run you want to re-check, **then** cleanup per run id (dry run
   first); wait for autovacuum before the next round.
8. Optionally `retire` the set.

## 14. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| p95 suddenly 10–40 × higher than last time (e.g. 18 ms → 666 ms), collector DB pool waiting | **Autovacuum** after a big cleanup is still running | Wait; preflight `autovacuum` warns while it runs; rerun |
| Run stopped half-way overnight; gaps in Grafana | The **laptop went to sleep** | Use `scripts/run-test.sh` (keeps Linux desktops awake with `systemd-inhibit`); on macOS run it under `caffeinate -i`; keep the lid open on power |
| `disk.results` / `disk.data-stores` fail; Kafka volume grows by tens of GB | Every event writes WAL and Kafka messages; Kafka keeps them 7 days (first round: 38 → 73 GB overnight) | Clean up the runs, free disk (Docker volumes, Kafka retention on the laptop stack — the stack owner's decision); never lower `MIN_FREE_DISK_GB` to get past it |
| `wal-and-slots` warns; a slot shows `lost`/`unreserved`; analytics dashboards stale or 503 | A large delete (or other WAL burst) exceeded `max_slot_wal_keep_size` | Fixing a lost Debezium slot (drop, re-snapshot) is the stack owner's decision, outside this suite; cleanup itself now batches and stops before a slot is at risk |
| Alarms "ring" the next day; Step SLA busy with no test running; `leftover-test-data` warns | Test data left behind: its deadlines are real | Clean up by run id the same day (or `--all`); keep `STEP_SLA_SEED_MISSED_ALARMS=false` |
| First minute of a run much slower, one spike of ~1 s | **JVM warm-up** after a service restart | Keep the warm-up phase (`WARM_UP_DURATION`); run a smoke test after every restart |
| Smoke FAILED on p95 (and maybe 1 dropped iteration), but every data check passed and no request failed | **Cold service**: just started or idle for a while; smoke has no warm-up, so one slow first request (seconds) fails the p95 of 30 events | Check that only the first report window is slow (`window:0` in `k6-summary.json`), then run smoke again right away; it should pass (§8.1). If later windows are slow too, it is not a cold start |
| "Waiting for idle" then refused after 5 min (exit 2) | **Global counters**: another test, a draining backlog, or real traffic | Run one test at a time; let the matcher drain; on Dev/UAT see open question about idle on shared environments |
| Preflight `plan-definition-set` fails for the matcher: "other ACTIVE plan definitions match the dataset events" | **Overlapping ACTIVE plan definitions** outside the set would multiply the matcher's work and break the data checks | `scripts/manage-plan-definitions.sh list-active local`; retire the extra ones by hand if they are yours (the tool never touches definitions outside the named set), choose a set that includes them, or run with `--set ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true` (the data checks then expect the larger fan-out) |
| `plan-definitions retire/delete` says "not loaded by this tool: left untouched" | The definition has no load-test marker (e.g. loaded by the first version or by hand) | Leave it, or retire it by hand if it is really a test definition |
| `plan-definitions load` refused: url + version retired | A retired url + version cannot become ACTIVE again | Use a new `PLAN_DEFINITION_VERSION_SUFFIX` (and the same suffix for the runs) |
| `plan-definitions delete` returns 409 | Enrolments still reference it | Clean up the runs first, then delete |
| `postgres-target` fails | You reached another database on that port (two Postgres instances, one port) | Fix host/port/name in the environment file or your `<env>.local.json` |
| `service-health` fails while `docker ps` shows the container up | The service is crash-looping or not ready | Check its logs; wait for UP; never skip preflight to get past it |
| `docker` check fails: image missing | k6 image not built on this machine | `scripts/build-k6-image.sh` |
| Report says "at least X/s (k6 limit)" | k6 could not send fast enough while the service answered quickly | Not a service failure: give k6 more VUs (`MAX_VUS`) or a bigger/separate k6 host |
| Matcher result "not caught up: N events still waiting after S s" | The matcher drains slower than the rate sent | Expected above its capacity (stress with many plan definitions); the flood measures the drain rate |
| Collector p95 spikes, `hikariPending` in "what broke" | Collector DB pool (10 locally) full: Postgres busy (matcher draining, vacuum) | Check the matcher backlog and autovacuum on the Overview dashboard; run tests one at a time |
| No k6 panels in Grafana | Remote write off or Prometheus down (the test still runs) | `monitoring.enabled`, `PROMETHEUS_REMOTE_WRITE`; preflight `monitoring`; `MONITORING_REQUIRED=true` to make it a failure |
| "Annotations skipped" warning | Neither `GRAFANA_API_TOKEN` nor `GRAFANA_ADMIN_PASSWORD` set | Export one (§5) |
| `RUN_CONTEXT missing: run tests through scripts/run-test.sh` | k6 was started by hand | Always start tests through the runner; to look at a script use `npm run check:k6` |
| Collector requests throttled or rejected although the collector is idle | You are going through the API gateway, which rate-limits `/v1/events` | Use the service's direct URL in the environment file |
| A setting value refused ("Invalid duration", unknown name) | Typo; unknown `--set` names are errors on purpose | `scripts/print-settings.sh <env> <subject> <type> --set …` to check |
| `EVENT_MODE=journey` or `WORKLOAD_PROFILE` refused | Reserved for later work | Use rates/durations or `*_EVENTS` ([workload-model.md](workload-model.md) §8) |

Still stuck? Every result folder has `k6.log` and the JSON files; the lessons behind most of these rows are in
[known-results-and-lessons.md](known-results-and-lessons.md); the first version's code and procedures are on
the `ebuzima-flow-tests` branch.
