<!--
  What:    Guide to the monitoring stack of the CCE performance tests: a laptop Prometheus + Grafana
           (docker-compose.yml) and the five dashboards that also import into CCE's own Grafana.
  How:     Read before your first test run. Commands below are run from the repository root.
  Needs:   Docker with Compose v2, local-stack running (network cce-net), GRAFANA_ADMIN_PASSWORD and
           DB_PASSWORD in your shell. For CCE's Grafana: cce-grafana-import/README.md.
  Outputs: Nothing by itself; explains how to start/stop the stack, where k6 sends its metrics, how runs
           are marked and how to find them.
-->

# Monitoring: Prometheus and Grafana for performance tests

| Prometheus | Grafana | Dashboards folder | k6 → Prometheus | Spec |
|---|---|---|---|---|
| http://localhost:9095 | http://localhost:3030 | "CCE Performance" (5 dashboards) | remote write to `/api/v1/write` | [specs/004-monitoring-and-grafana](../specs/004-monitoring-and-grafana/spec.md) |

## 1. Why this exists

A performance problem rarely shows up where it starts: a slow database makes the collector's
connection pool fill, which makes k6's latency climb, which makes k6 drop iterations. To see the chain
you need **everything on one timeline**: what k6 sent, what each service counted, Kafka lag, the
database pool, CPU/memory per container, free disk and the Postgres WAL. That is what this stack and its
dashboards give you. (The first test round used home-made sampling of `docker stats` and logs, which made
it hard to see *when* things broke.)

## 2. What runs

`docker-compose.yml` starts six containers, all joined to the CCE Docker network `cce-net` so Prometheus
can reach the services by container name:

| Container | Image | Port on your laptop | What it gives you |
|---|---|---|---|
| `perf-prometheus` | `prom/prometheus:v2.51.2` | 9095 | Stores all metrics; **accepts k6's pushes** (`--web.enable-remote-write-receiver`) |
| `perf-grafana` | `grafana/grafana:10.4.2` | 3030 | Dashboards (anonymous viewing; admin login to edit) |
| `perf-kafka-exporter` | `danielqsj/kafka-exporter:v1.7.0` | – | Kafka consumer lag (matcher backlog), topic offsets (DLQ growth) |
| `perf-postgres-exporter` | `prometheuscommunity/postgres-exporter:v0.15.0` | – | Connections by state, DB size, row activity, **WAL and replication slots** |
| `perf-cadvisor` | `gcr.io/cadvisor/cadvisor:v0.49.1` | – | CPU and memory **per container** (the JVM's own CPU figure is misleading in containers) |
| `perf-node-exporter` | `prom/node-exporter:v1.8.1` | – | Free disk on the host root (where Docker keeps Postgres WAL and Kafka data) |

All six start by default. Versions are the ones CCE uses in `openphc-repos/deploy-scripts`, so the
dashboards behave the same here and in CCE's Grafana. Host ports 9095/3030 avoid CCE's 9090/3000 (and
3001, taken on the laptop); change them with `PROMETHEUS_PORT` / `GRAFANA_PORT`.

Prometheus scrapes (every **5 s**, `prometheus/prometheus.yml`) with job names identical to CCE's:
`cce-collector-service`, `cce-matcher-service`, `cce-step-sla-service`, `cce-protocol-service` (all on
`<container>:8080/actuator/prometheus`), `kafka`, `postgres`, `cadvisor`, `node-exporter`, `prometheus`.

## 3. Start and stop

```bash
# 1. local-stack must be running first: it creates the network cce-net and the CCE containers.
# 2. Secrets only in your shell (or in monitoring/.env, git-ignored; template: monitoring/.env.example).
export GRAFANA_ADMIN_PASSWORD='<choose one>'   # Grafana admin password (laptop only)
export DB_PASSWORD='<cce_user password>'        # read by postgres-exporter (same as the test tooling)

# 3. Start (from the repository root). Always starts all six containers, cAdvisor and node-exporter included.
docker compose -f monitoring/docker-compose.yml up -d

# Check: every target should be UP at http://localhost:9095/targets
# Open:  http://localhost:3030  →  Dashboards → CCE Performance

# Stop (metrics and Grafana settings are kept in the volumes prometheus-data / grafana-data)
docker compose -f monitoring/docker-compose.yml down
# Stop and DELETE all stored metrics and Grafana state
docker compose -f monitoring/docker-compose.yml down -v

# Validate the file without starting anything (dummy secrets: the real ones are required, so plain `config` fails)
GRAFANA_ADMIN_PASSWORD=dummy DB_PASSWORD=dummy docker compose -f monitoring/docker-compose.yml config --quiet
```

If `up` fails with *"network cce-net declared as external, but could not be found"*, start local-stack
first, or set `CCE_NETWORK` to the name of your CCE network.

**Changing the admin password.** Grafana applies `GRAFANA_ADMIN_PASSWORD` only when it creates its
database (first start). Later: `docker compose -f monitoring/docker-compose.yml exec grafana grafana cli admin reset-admin-password '<new>'`,
or `down -v` and start again (loses Grafana state, not the dashboards: those come from the files).

**Docker Desktop (macOS/Windows).** node-exporter and cAdvisor see the Docker VM, not your Mac/PC. The
VM's disk is the one that holds Postgres and Kafka data, so the disk panel is still the right one;
cAdvisor may need its volume list adjusted if it shows no containers.

## 4. How k6 gets its metrics in (remote write)

k6 does not get scraped; it **pushes** its metrics to Prometheus while the test runs. The test runner
(`scripts/run-test.sh` → `tools/core/k6-runner.mjs`) does this when the environment file has
`monitoring.enabled: true` and the setting `PROMETHEUS_REMOTE_WRITE` is `true` (default). It adds to the
k6 container:

| What | Value (local) | Comes from |
|---|---|---|
| `-o experimental-prometheus-rw` | output switched on | `PROMETHEUS_REMOTE_WRITE=true` |
| `K6_PROMETHEUS_RW_SERVER_URL` | `http://localhost:9095/api/v1/write` | `monitoring.remoteWriteUrl` in `config/environments/local.json` |
| `K6_PROMETHEUS_RW_TREND_STATS` | `p(95),p(99),avg,med,min,max` | setting `K6_TREND_STATS` |
| `K6_PROMETHEUS_RW_STALE_MARKERS` | `true` | series end cleanly when the test ends |
| `K6_PROMETHEUS_RW_PUSH_INTERVAL` | `5s` | same rhythm as the scrapes |

Turn it off for one run with `--set PROMETHEUS_REMOTE_WRITE=false`. If Prometheus is down the test still
runs (k6 only logs push errors); preflight warns, or fails when `MONITORING_REQUIRED=true`.

**Names in Prometheus.** k6 metric `http_req_duration` with trend stat `p(95)` becomes
`k6_http_req_duration_p95`; counters get `_total` (`k6_http_reqs_total`), rates get `_rate`
(`k6_http_req_failed_rate`). **Trend values are seconds**: the millisecond panels multiply by 1000.

**Labels on every k6 series** (set from the run, same names as the report's conditions):

| Label | Example | Meaning |
|---|---|---|
| `testid` | `20261105-142233` | the run id (RUN_ID); the label the official k6 dashboards use too |
| `service` | `collector`, `matcher`, `step-sla` | subject under test |
| `test_type` | `smoke`, `load`, `stress`, `breakpoint` | test type |
| `plan_definition_set` | `emr-service`, `kenya-sha-emr-service` (older runs: `single`, `overlapping-4`) | plan-definition set of the run |
| `environment` | `local` | environment file name |
| `scenario`, `phase`, `level`, `window` | `measure`, `800` | k6 scenario, phase, staircase level, report window |
| `name`, `status`, `expected_response` | `POST /v1/events`, `202`, `true` | request name and outcome (HTTP tests) |

Service metrics (scraped from `/actuator/prometheus`) carry **no run id**: the services do not know about
tests. Locate a run on service panels by its time range and the run markers (next section).

## 5. Run markers (annotations) and finding a run

Every dashboard shows two kinds of markers:

1. **k6 test runs** (orange shaded region): a Prometheus query
   `max by (testid, service, test_type) (k6_vus{testid=~"$testid"})`. While k6 has virtual users the
   region is drawn, so it starts and ends with the k6 run.
2. **Run markers from the runner** (green): the runner posts Grafana annotations for **every** run, k6 or
   seeded: run start/end, phase starts, send end / last alarm rang, caught up, "started breaking". Tags:
   `cce-performance`, `<runId>`, `<subject>`, `<testType>`. The dashboards show those with tags
   `cce-performance` **and** the selected `testid` ("Run markers (selected run)"). A second toggle,
   "Run markers (every run)", off by default, shows all of them (use it when *Run id* = All).

**Authentication for annotations** (writing needs more than the anonymous Viewer): the runner uses
`GRAFANA_API_TOKEN` when set (a service-account token, role Editor), otherwise basic auth with
`monitoring.grafanaUser` (`admin`) + `GRAFANA_ADMIN_PASSWORD`. On the laptop the admin password you
exported for `up` is enough. Neither set → the run still works, annotations are skipped with one warning.

**Finding a run.** Pick it in **Run id** (top of every dashboard, newest first; it lists the `testid`
values k6 pushed, filtered by *Service* and *Test type*). Then set the time range around it (the shaded
region shows where).

**Finding a Step SLA run (no k6).** Step SLA tests seed alarms in Postgres and need no k6, so they have
no `k6_vus` series and do not appear in the *Run id* list. Type the run id (printed at the start of the
run; also the end of the results folder name, e.g. `results/step-sla-breakpoint-20261105-142233/`) into
*Run id* and press Enter. The variable allows custom values; if your Grafana version does not accept typed
text there, open the dashboard with `&var-testid=20261105-142233` added to the URL. The green run markers
then show seeding, first alarm ringing and catch-up on the Step SLA dashboard.

## 6. The dashboards

| Dashboard | uid | Use it for |
|---|---|---|
| CCE Performance — Overview | `cce-perf-overview` | The one timeline: k6 + all three services + Kafka + DB pools + JVM + containers + disk + Postgres WAL / replication slots |
| CCE Collector Service — Performance | `cce-perf-collector` | Collector tests: HTTP rate by status, p95/p99, failures, received/accepted/rejected, Kafka publishing, server-side time, Hikari |
| CCE Matcher Service — Performance | `cce-perf-matcher` | Matcher tests: Kafka write rate, arriving vs processed, backlog, DLQ, matched vs zero-match, processing time |
| CCE Step SLA Service — Performance | `cce-perf-step-sla` | Step SLA tests: alarms due, applied/skipped, cycles, failed batches, its 3-connection pool |
| k6 Load Test (CCE) | `cce-perf-k6` | k6 itself: per scenario and per staircase level, checks, data sent |

Every panel has a description (hover the ⓘ next to its title) written for someone new to performance
testing. Details, variables and editing rules: [grafana/dashboards/README.md](grafana/dashboards/README.md).

## 7. Metrics to verify at the first scrape

These names come from the plan and the service source, but their presence depends on configuration or
versions that only a running stack shows. Panels using them stay empty (no error) if absent; check them
once in Prometheus (http://localhost:9095/graph) after the first smoke run and fix the panel if needed:

| Metric | Why it may be missing |
|---|---|
| `tomcat_threads_busy_threads` | Needs `server.tomcat.mbeanregistry.enabled=true`, which the services do not set |
| `k6_kafka_writer_message_count_total`, `k6_kafka_writer_error_count_total` | Name of the xk6-kafka 2.2.0 writer metrics after remote-write conversion |
| `spring_kafka_listener_seconds_sum`, `_count`, `_max` | Spring exports the listener timer only with listener observation on |
| `pg_replication_slot_slot_is_active`, `pg_replication_slot_safe_wal_size_bytes`, `pg_replication_slot_slot_current_wal_lsn` | postgres-exporter `replication_slot` collector; empty when the DB has no replication slot (local-stack without the analytics pipeline) |
| `pg_wal_size_bytes` | postgres-exporter `wal` collector; reading `pg_ls_waldir()` needs superuser or the `pg_monitor` role |

The same list is exported as `VERIFY_AT_FIRST_SCRAPE` by `unit-tests/dashboards.spec.mjs`; the first
check is task T040 (DEFERRED, owner) in `specs/004-monitoring-and-grafana/tasks.md`.

## 8. Observer effect

Monitoring is not free. Two effects to keep in mind when reading laptop numbers:

- **Step SLA's `cce_sla_transitions_due` gauge runs a SQL count on every scrape** (every 5 s here) on a
  pool of only 3 connections; the test tooling's own sampler scrapes too. During a storm that competes
  with the evaluator. If Hikari *pending* shows up on the Step SLA dashboard, compare with a run at a
  longer scrape interval (add `scrape_interval: 15s` to the `cce-step-sla-service` job).
- The six containers here use some CPU and memory on the same laptop as the services. On Dev/UAT run
  k6 and this stack on a separate host.

## 9. Laptop Grafana or CCE's Grafana?

| | Laptop (this compose) | CCE's Grafana (Dev/UAT) |
|---|---|---|
| Who runs it | you, per session | CCE ops (`openphc-repos/deploy-scripts`, never changed by this repository) |
| k6 panels | work out of the box (remote-write receiver on) | need a remote-write-capable Prometheus: ask ops, or add a separate "Prometheus-LoadTest" datasource |
| Matcher / Step SLA panels | work (jobs scraped here) | only once ops add the scrape jobs (`cce-grafana-import/prometheus-scrape-jobs.example.yml`) |
| Exporters | all six here | CCE has node-exporter, postgres-exporter, kafka-exporter; no cAdvisor |
| Annotations | admin password | API token (service account, Editor) |

How to import: [cce-grafana-import/README.md](cce-grafana-import/README.md).

## 10. Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | The six containers, external network, volumes |
| `.env.example` | Names of the variables compose reads (copy to `.env`, git-ignored) |
| `prometheus/prometheus.yml` | Scrape jobs (5 s), commented host-port alternative |
| `grafana/provisioning/datasources/datasources.yml` | Datasource `Prometheus`, uid `prometheus`, default |
| `grafana/provisioning/dashboards/dashboards.yml` | Loads `grafana/dashboards/*.json` into folder "CCE Performance" |
| `grafana/dashboards/*.json` | The five dashboards ([README](grafana/dashboards/README.md)) |
| `cce-grafana-import/` | Import guide and example scrape jobs for CCE's Grafana/Prometheus |
| `unit-tests/dashboards.spec.mjs` | Static checks: `node --test "monitoring/unit-tests/*.spec.mjs"` (part of `npm test`) |
