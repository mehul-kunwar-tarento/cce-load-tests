<!--
  What:    Ordered checklist of work package A4 (monitoring and Grafana). Each task names its file(s).
  How:     Work top to bottom; tick "- [x]" when a task is done and its check passed. DEFERRED (owner)
           tasks need a live stack and are excluded from "every task ticked" (spec 000 R13, D14).
  Needs:   spec.md and plan.md in this folder; specs/000-performance-testing-setup/plan.md §9.
  Outputs: Progress record of monitoring/.
-->

# Tasks: Monitoring and Grafana

**Input**: `spec.md`, `plan.md` (this folder) · **Contract**: 000 plan §9
**Format**: `- [ ] T### [P] [Story] Description with exact file path` — `[P]` = can run in parallel
(different files).

## Phase 1: Setup

- [x] T001 Write `specs/004-monitoring-and-grafana/spec.md`, `plan.md`, `tasks.md` (this file)
- [x] T002 Create folders `monitoring/{prometheus,grafana/provisioning/datasources,grafana/provisioning/dashboards,grafana/dashboards,cce-grafana-import,unit-tests}`

## Phase 2: Foundational (stack definition)

- [x] T003 [P] `monitoring/docker-compose.yml`: prometheus (remote-write receiver, 15d retention,
      9095), grafana (10.4.2, 3030, admin password `${GRAFANA_ADMIN_PASSWORD:?}`, anonymous Viewer,
      read-only provisioning + dashboards), kafka-exporter, postgres-exporter (`${DB_PASSWORD:?}`),
      cadvisor and node-exporter on by default, external network `${CCE_NETWORK:-cce-net}`
- [x] T004 [P] `monitoring/.env.example` with variable names only
- [x] T005 [P] `monitoring/prometheus/prometheus.yml`: 5s scrape, CCE job names, commented host-port block
- [x] T006 [P] `monitoring/grafana/provisioning/datasources/datasources.yml` (Prometheus, uid prometheus, default)
- [x] T007 [P] `monitoring/grafana/provisioning/dashboards/dashboards.yml` (file provider, folder "CCE Performance")

## Phase 3: User Story 1 - Watch a load test on a laptop (P1)

- [x] T010 [US1] `monitoring/grafana/dashboards/cce-performance-overview.json` (uid `cce-perf-overview`):
      k6, collector, matcher, Step SLA, Hikari, heap, GC, containers, disk, Postgres, WAL/slots
- [x] T011 [P] [US1] `monitoring/grafana/dashboards/cce-collector-service-performance.json` (uid `cce-perf-collector`)
- [x] T012 [P] [US1] `monitoring/grafana/dashboards/cce-matcher-service-performance.json` (uid `cce-perf-matcher`)
- [x] T013 [P] [US1] `monitoring/grafana/dashboards/k6-load-test.json` (uid `cce-perf-k6`)
- [x] T014 [US1] `monitoring/grafana/dashboards/README.md` (header for the JSON files)

## Phase 4: User Story 2 - Find a Step SLA run (P1)

- [x] T020 [US2] `monitoring/grafana/dashboards/cce-step-sla-service-performance.json` (uid `cce-perf-step-sla`)
      with a "how to find your run" text panel
- [x] T021 [US2] Every dashboard: `testid` multi + All + custom values; annotations k6 region,
      "Run markers (selected run)" on tags `cce-performance` + `$testid`, "Run markers (every run)"

## Phase 5: User Story 3 - CCE's Grafana (P2)

- [x] T030 [P] [US3] `monitoring/cce-grafana-import/README.md` (import steps, DS_PROMETHEUS choice,
      remote-write receiver or "Prometheus-LoadTest" datasource, annotation API token, what NOT to change)
- [x] T031 [P] [US3] `monitoring/cce-grafana-import/prometheus-scrape-jobs.example.yml` (not applied)

## Phase 6: Polish

- [x] T032 `monitoring/README.md` (start/stop, ports, remote write, labels, annotations + auth, Step SLA
      run by typed id, verify-at-first-scrape list, laptop vs CCE Grafana)
- [x] T033 `monitoring/unit-tests/dashboards.spec.mjs`: JSON parse, unique uids, `${DS_PROMETHEUS}`,
      allow-list, descriptions, `testid` custom values, annotation tags, provisioning + compose text checks
- [x] T034 Header comment / description on every file of `monitoring/` and this spec folder (000 §2.4)

## Phase 7: Verification (static only, D14)

- [x] T035 `node --test "monitoring/unit-tests/*.spec.mjs"` passes; ESLint and Prettier check clean on `monitoring/`
- [x] T036 `node --check monitoring/unit-tests/dashboards.spec.mjs`; every JSON file parses
- [x] T037 `docker compose -f monitoring/docker-compose.yml config` with dummy `GRAFANA_ADMIN_PASSWORD` /
      `DB_PASSWORD` in that command's environment only; also confirm it fails when they are unset (no `up`)
- [x] T038 Secret scan of `monitoring/` (no password/token values) and generic-name check (no "ebuzima")
- [x] T039 Record deviations and requests in `plan.md` § Deviations / requests
- [x] T041 Offline `promtool check config` (prometheus.yml, example jobs) and `promtool check rules` over every
      dashboard query, in `prom/prometheus:v2.51.2` with `--network none`
- [ ] T040 DEFERRED (owner): first `up` and check of the verify-at-first-scrape metric names
      (`docker compose -f monitoring/docker-compose.yml up -d` with local-stack running; confirm Tomcat
      threads, `k6_kafka_writer_*`, `spring_kafka_listener_seconds_*`, `pg_replication_slot_*`,
      `pg_wal_size_bytes`, cAdvisor `name` labels, that a typed `testid` works on Grafana 10.4, and that
      the overview shows one smoke run end to end)
