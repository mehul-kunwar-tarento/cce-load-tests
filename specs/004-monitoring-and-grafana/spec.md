<!--
  What:    Feature specification of work package A4: a laptop monitoring stack (Prometheus with a
           remote-write receiver + Grafana + exporters) and Grafana dashboards that also import into
           CCE's own Grafana, so a load test is seen on one timeline next to the services' metrics.
  How:     Read top to bottom. plan.md (same folder) says HOW and lists every file; tasks.md is the
           checklist. Contract: specs/000-performance-testing-setup/plan.md §9 (and §1, §2.4, §3.1, §12).
  Needs:   specs/000-performance-testing-setup/{spec,plan}.md (R8, D6, D14, D15).
  Outputs: Requirements FR-001..FR-016 and acceptance criteria for everything under monitoring/.
-->

# Feature Specification: Monitoring and Grafana

**Feature Branch**: n/a (folder only; suggested branch feature/monitoring-and-grafana)
**Created**: 2026-11-06
**Status**: Implemented (static verification only; first `up` deferred to the owner)
**Input**: Team lead's review point 8 ("Grafana integration, CCE already uses Grafana"), spec 000 R8,
owner decision D6 (both a laptop stack and dashboards importable into CCE's Grafana).

## Goal

Show every performance test **in Grafana, on one timeline**: what k6 sent (rate, latency, errors,
dropped iterations) next to what each service did (counters, backlog, DB pool, JVM), plus container
CPU/memory, disk and Postgres WAL / replication slots. Lesson 9 of the prompt set: the error you see is
often several hops from its cause, so all signals must sit on the same time axis. The same dashboards
must work on a laptop (our own compose stack) and import into CCE's existing Grafana without changing
`deploy-scripts`.

## Scope

### In scope
- `monitoring/docker-compose.yml`: Prometheus v2.51.2 (remote-write receiver on), Grafana 10.4.2
  (provisioned), kafka-exporter, postgres-exporter, cAdvisor and node-exporter (all on by default),
  joined to the external CCE network; `monitoring/.env.example` (variable names only).
- `monitoring/prometheus/prometheus.yml`: scrape jobs named exactly like CCE's.
- Grafana provisioning: datasource (`Prometheus`, uid `prometheus`) and a file dashboard provider
  (folder "CCE Performance").
- Five dashboards (plan 000 §9.4) with the `DS_PROMETHEUS`, `service`, `test_type`, `testid` variables
  and run annotations (k6 region + runner annotations by tag).
- `monitoring/cce-grafana-import/`: import guide for CCE's Grafana and example scrape jobs ops would add.
- `monitoring/README.md`: start/stop, ports, remote write, labels, annotations, metric names to verify.
- `monitoring/unit-tests/dashboards.spec.mjs`: static checks of dashboards, provisioning and compose.

### Out of scope
- Any change to `deploy-scripts`, CCE's Prometheus/Grafana or any CCE repository (D6).
- Starting the stack (`docker compose up`) or contacting Prometheus/Grafana during the build (D14).
- The k6 side of remote write (`tools/core/k6-runner.mjs`, A2) and the annotation client
  (`tools/core/clients/grafana.mjs`, A2); the monitoring preflight check (A3). This package only
  documents how they connect.
- Alerting rules, long-term storage, adaptor dashboards (adaptors are later, R4).

## Inputs

- Contract: plan 000 §1 (monitoring rows), §2.4 (headers), §3.1 (`monitoring` block of the environment
  file: `prometheusUrl` http://localhost:9095, `remoteWriteUrl` …/api/v1/write, `grafanaUrl`
  http://localhost:3030, `grafanaUser` admin; Grafana auth rule), §3.2 (`PROMETHEUS_REMOTE_WRITE`,
  `K6_TREND_STATS`, `HTTP_P95_LIMIT_MS`, `MATCHER_MAX_BACKLOG`, `MIN_FREE_DISK_GB`,
  `CLEANUP_MIN_SAFE_WAL_GB`), §9.1–§9.5, §12, §14 Q2/Q7.
- Reference (read-only): `openphc-repos/deploy-scripts` (docker-compose.yml, prometheus/prometheus.yml,
  grafana/provisioning, grafana/dashboards/*.json: `${DS_PROMETHEUS}` datasource variable,
  schemaVersion 39) and `openphc-repos/local-stack/docker-compose.yml` (network `cce-net`, containers
  `cce-collector-service`, `cce-matcher-service`, `cce-step-sla-service`, `cce-protocol-service` on 8080,
  `kafka:9092`, `postgres:5432`).
- Metric names from the services' source on `release-2.0.0` (Micrometer: `cce.collector.*`,
  `cce.events.*`, `cce.step.matching.duration`, `cce.protocol.instances.active`, `cce.sla.*`).
- Environment variables at `up` time (never in files): `GRAFANA_ADMIN_PASSWORD`, `DB_PASSWORD`;
  optional `PROMETHEUS_PORT`, `GRAFANA_PORT`, `CCE_NETWORK`, `DB_USER`, `DB_NAME`.

## Outputs

- The files listed in plan.md §Files.
- At run time (owner, not the build): Prometheus on `http://localhost:9095` accepting k6 remote write
  at `/api/v1/write`; Grafana on `http://localhost:3030` with folder "CCE Performance" holding the five
  dashboards (uids `cce-perf-overview`, `cce-perf-collector`, `cce-perf-matcher`, `cce-perf-step-sla`,
  `cce-perf-k6`).
- `node --test "monitoring/unit-tests/*.spec.mjs"` exit code 0 when every static rule holds (also run by `npm test`).

## Acceptance criteria

1. `docker compose -f monitoring/docker-compose.yml config` succeeds with dummy `GRAFANA_ADMIN_PASSWORD`
   and `DB_PASSWORD` set only for that command, and fails with a clear message when either is unset.
2. The compose file has the six services of plan 000 §9.1 with the exact image tags, host ports
   `${PROMETHEUS_PORT:-9095}:9090` and `${GRAFANA_PORT:-3030}:3000`, `--web.enable-remote-write-receiver`,
   no `profiles` on cAdvisor/node-exporter, and the external network `${CCE_NETWORK:-cce-net}`.
3. `prometheus.yml` has scrape interval 5s and the jobs `prometheus`, `cce-collector-service`,
   `cce-matcher-service`, `cce-step-sla-service`, `cce-protocol-service`, `kafka`, `postgres`,
   `cadvisor`, `node-exporter`.
4. All five dashboard files parse as JSON, have unique uids equal to plan 000 §9.4, schemaVersion 39, a
   `description` holding What/How/Needs/Outputs, and every panel and every Prometheus annotation uses
   datasource `${DS_PROMETHEUS}`.
5. Every metric name used in any PromQL query is in the allow-list exported by
   `monitoring/unit-tests/dashboards.spec.mjs` (the names of plan 000 §9.4).
6. Every dashboard has the variables `DS_PROMETHEUS`, `service`, `test_type`, `testid` (multi, All,
   custom values allowed), the k6 region annotation and a Grafana annotation on tags `cce-performance` +
   `$testid`; every panel has a description.
7. No password or token value appears in any file under `monitoring/` (only `${VAR:?…}` references).
8. `node --test "monitoring/unit-tests/*.spec.mjs"` passes (Node 22 takes files or globs, not a folder).

## User Scenarios & Testing

### User Story 1 - Watch a collector load test on a laptop (Priority: P1)
**Given** local-stack is running and `monitoring/` is up, **when** the tester runs
`scripts/run-test.sh local collector load`, **then** the "CCE Performance — Overview" dashboard shows
k6 requests/s, p95/p99, failed share and dropped iterations next to collector accepted/s, Hikari
pending, heap, container CPU/memory and disk, with the run shaded as a region and the runner's phase
markers on the time axis.
**Independent test**: the unit test proves every panel queries only known metric names through
`${DS_PROMETHEUS}`; `docker compose config` proves the stack definition is valid.

### User Story 2 - Find a Step SLA run that has no k6 metrics (Priority: P1)
**Given** a Step SLA storm (seeded alarms, no k6), **when** the tester opens the Step SLA dashboard and
types the run id (e.g. `20261105-142233`) into the `testid` box, **then** the runner's annotations tagged
`cce-performance` + that run id appear and the due-alarm, applied/s and Hikari panels around them show
the storm.

### User Story 3 - Use the same dashboards in CCE's Grafana (Priority: P2)
**Given** CCE's Grafana on Dev/UAT, **when** an operator imports the JSON files (Dashboards → Import)
and picks a Prometheus datasource for `DS_PROMETHEUS`, **then** service panels work for every job CCE's
Prometheus scrapes, and k6 panels work once a remote-write-capable Prometheus is chosen; the import guide
says what to ask ops for and what not to change.

### User Story 4 - Diagnose a lost replication slot during cleanup (Priority: P2)
**Given** a cleanup run, **when** the WAL / replication-slot panels show `safe_wal_size` falling towards
zero, **then** the tester sees it before the slot is lost (lesson 8) and stops the cleanup.

### Edge Cases
- k6 not running or remote write off: k6 panels are empty, service panels still work.
- A metric the services do not export (Tomcat threads with mbeanregistry off; Spring Kafka listener
  timers; postgres-exporter slot/WAL metrics on another exporter version): the panel is empty and its
  description says so; the README lists these as "verify at first scrape".
- `testid` = All: k6 panels show every run; the "every run" annotation toggle shows all runner markers.
- Docker Desktop (macOS/Windows): node-exporter sees the Docker VM's disk, which is the disk that matters
  for Postgres WAL and Kafka anyway; cAdvisor may need its mounts adjusted.
- The CCE network does not exist: `up` fails with "network cce-net declared as external, but could not
  be found"; start local-stack first or set `CCE_NETWORK`.

## Requirements

- **FR-001**: The compose stack MUST run Prometheus `prom/prometheus:v2.51.2` with
  `--web.enable-remote-write-receiver`, `--storage.tsdb.retention.time=15d`, host port
  `${PROMETHEUS_PORT:-9095}`.
- **FR-002**: The compose stack MUST run Grafana `grafana/grafana:10.4.2` on host port
  `${GRAFANA_PORT:-3030}` with the admin password only from `${GRAFANA_ADMIN_PASSWORD:?…}`, anonymous
  Viewer access, and provisioning + dashboards mounted read-only.
- **FR-003**: kafka-exporter v1.7.0 (`--kafka.server=kafka:9092`), postgres-exporter v0.15.0
  (`postgres:5432/ccedb`, user `cce_user`, password `${DB_PASSWORD:?…}`), cAdvisor v0.49.1 and
  node-exporter v1.8.1 MUST start by default (no profiles); node-exporter MUST see the host root so the
  Docker data root disk is visible.
- **FR-004**: All services MUST join the external network `${CCE_NETWORK:-cce-net}` so Prometheus reaches
  the CCE containers by name.
- **FR-005**: Prometheus MUST scrape every 5s with job names identical to CCE's, plus a commented
  host-port alternative (`host.docker.internal:8093/8097/8099`).
- **FR-006**: Grafana MUST be provisioned with datasource `Prometheus` (uid `prometheus`, default) and a
  file provider loading the dashboards into folder "CCE Performance".
- **FR-007**: The five dashboards MUST have the uids and queries of plan 000 §9.4, schemaVersion 39,
  datasource `${DS_PROMETHEUS}` on every panel and target.
- **FR-008**: Every dashboard MUST have variables `DS_PROMETHEUS` (datasource, query `prometheus`),
  `service`, `test_type` and `testid` (query on `k6_vus`, multi, include All, custom values allowed).
- **FR-009**: Every dashboard MUST carry the k6 region annotation
  `max by (testid, service, test_type) (k6_vus{testid=~"$testid"})` and a built-in Grafana annotation
  query on tags `cce-performance` + `$testid`.
- **FR-010**: k6 trend values (seconds) MUST be multiplied by 1000 on millisecond panels.
- **FR-011**: Every panel MUST have a description written for someone new to performance testing; panels
  that may be empty MUST say so and why.
- **FR-012**: The overview MUST include WAL / replication-slot panels (`pg_replication_slot_slot_is_active`,
  `pg_replication_slot_safe_wal_size_bytes`, `pg_replication_slot_slot_current_wal_lsn`,
  `pg_wal_size_bytes`), container CPU/memory and disk panels.
- **FR-013**: `monitoring/cce-grafana-import/README.md` MUST explain the import, the `DS_PROMETHEUS`
  choice, the remote-write prerequisite or a separate "Prometheus-LoadTest" datasource, annotation auth
  (API token on CCE's Grafana) and what NOT to change; `prometheus-scrape-jobs.example.yml` MUST hold the
  matcher and Step SLA jobs ops would add (not applied).
- **FR-014**: No file MUST contain a password or token value (D15).
- **FR-015**: Every file MUST carry a header (YAML `#` lines, Markdown HTML comment, dashboards their
  `description`, dashboard JSON also described in `grafana/dashboards/README.md`).
- **FR-016**: `monitoring/unit-tests/dashboards.spec.mjs` MUST check the rules of acceptance criteria 2–7
  with `node --test` and no dependencies.

## Success Criteria

- **SC-001**: `node --test "monitoring/unit-tests/*.spec.mjs"` passes (0 failures).
- **SC-002**: `docker compose -f monitoring/docker-compose.yml config` succeeds with dummy secrets and
  fails without them.
- **SC-003**: A newcomer can start the stack and find a run from `monitoring/README.md` alone (reviewed by
  the owner at the first `up`, DEFERRED).
- **SC-004**: Zero changes to `deploy-scripts` or any CCE repository.
