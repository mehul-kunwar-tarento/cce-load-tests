<!--
  What:    Implementation plan of work package A4 (monitoring and Grafana): approach, every file, the
           interfaces other packages rely on (ports, URLs, labels, annotation tags, metric allow-list) and
           the deviations from the 000 blueprint.
  How:     Read after spec.md. tasks.md (same folder) is the ordered checklist built from this plan.
  Needs:   specs/000-performance-testing-setup/plan.md §1, §2.4, §3.1, §3.2, §9.1–§9.5, §12, §14.
  Outputs: The contract for monitoring/; deviations for the orchestrator and C1 (docs/open-questions.md).
-->

# Implementation Plan: Monitoring and Grafana

**Branch**: n/a (folder only; suggested branch feature/monitoring-and-grafana) · **Date**: 2026-11-06 ·
**Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md) · **Contract**: 000 plan §9

## Approach

1. **Copy CCE's conventions, not its files.** Image versions (Prometheus v2.51.2, Grafana 10.4.2,
   exporters), scrape job names, datasource name/uid (`Prometheus` / `prometheus`) and the dashboard
   style (`${DS_PROMETHEUS}` datasource variable, schemaVersion 39, rows + timeseries) are taken from
   `openphc-repos/deploy-scripts`, so the same JSON works in both Grafanas. Nothing in `deploy-scripts`
   is changed.
2. **Laptop stack = one compose file joined to the CCE network.** Every container joins the external
   network `${CCE_NETWORK:-cce-net}` created by local-stack, so Prometheus scrapes
   `cce-collector-service:8080` etc. by container name and the exporters reach `kafka:9092` and
   `postgres:5432`. Host ports 9095 (Prometheus) and 3030 (Grafana) avoid CCE's 9090/3000 and the
   laptop's 3001. Container names start with `perf-` so they never clash with CCE's `cce-prometheus` /
   `cce-grafana` and stay out of the `name=~"cce-.*"` container panels.
3. **k6 → Prometheus by remote write.** Prometheus runs with `--web.enable-remote-write-receiver`; A2's
   k6 runner adds `-o experimental-prometheus-rw` and `K6_PROMETHEUS_RW_*` (000 §9.3). This package only
   provides the receiver and documents the wiring.
4. **Dashboards as plain JSON (the source of truth).** Written once by a throw-away generator in the build
   session's scratchpad (not shipped; one source only), then kept and edited as JSON — in an editor or by
   exporting from Grafana ("Export → Save to file", *without* "Export for sharing externally", so the
   `${DS_PROMETHEUS}` variable stays). Each dashboard's header is its `description`; the folder README
   documents all five.
5. **Run markers for every run type.** A Prometheus annotation on `k6_vus` shades k6 runs; a Grafana
   annotation query on tags `cce-performance` + `$testid` shows the runner's markers, the only marker a
   Step SLA run (no k6) gets. `testid` accepts typed values for that reason.
6. **Static verification only** (D14): a `node --test` spec checks dashboards, provisioning and compose by
   parsing JSON and reading YAML as text (no YAML dependency); `docker compose config` validates the
   compose file with dummy secrets in that one command's environment. Never `up`, never contact
   Prometheus or Grafana.

## Files

| File | Purpose |
|---|---|
| `monitoring/README.md` | Start/stop (documented, not run), ports, remote write and `K6_PROMETHEUS_RW_*`, labels, annotations and their auth, finding a Step SLA run, metrics to verify at first scrape, laptop vs CCE Grafana |
| `monitoring/docker-compose.yml` | prometheus, grafana, kafka-exporter, postgres-exporter, cadvisor, node-exporter (all on by default), external network |
| `monitoring/.env.example` | Names of the variables compose reads (no values) |
| `monitoring/prometheus/prometheus.yml` | Scrape config: 5s interval, CCE job names, commented host-port alternative |
| `monitoring/grafana/provisioning/datasources/datasources.yml` | Datasource `Prometheus`, uid `prometheus`, `http://prometheus:9090`, default |
| `monitoring/grafana/provisioning/dashboards/dashboards.yml` | File provider → folder "CCE Performance" |
| `monitoring/grafana/dashboards/README.md` | Header for the five JSON files: what each shows, variables, annotations, editing rules |
| `monitoring/grafana/dashboards/cce-performance-overview.json` | uid `cce-perf-overview`: k6 + all three services + Kafka + Postgres/WAL + containers + disk |
| `monitoring/grafana/dashboards/cce-collector-service-performance.json` | uid `cce-perf-collector` |
| `monitoring/grafana/dashboards/cce-matcher-service-performance.json` | uid `cce-perf-matcher` |
| `monitoring/grafana/dashboards/cce-step-sla-service-performance.json` | uid `cce-perf-step-sla` |
| `monitoring/grafana/dashboards/k6-load-test.json` | uid `cce-perf-k6`: generic k6 view by `testid`, per scenario and level |
| `monitoring/cce-grafana-import/README.md` | Importing into CCE's Grafana; prerequisites; annotation auth; what NOT to change |
| `monitoring/cce-grafana-import/prometheus-scrape-jobs.example.yml` | Matcher + Step SLA (+ protocol) jobs ops would add to CCE's Prometheus (not applied) |
| `monitoring/unit-tests/dashboards.spec.mjs` | `node --test`: dashboards, allow-list, provisioning and compose rules |

## Interfaces

**Endpoints** (000 §3.1 `monitoring` block of `config/environments/local.json`, owned by A2):

| Key | Value | Served by |
|---|---|---|
| `prometheusUrl` | `http://localhost:9095` (`${PROMETHEUS_PORT:-9095}`) | prometheus container port 9090 |
| `remoteWriteUrl` | `http://localhost:9095/api/v1/write` | same, needs `--web.enable-remote-write-receiver` |
| `grafanaUrl` | `http://localhost:3030` (`${GRAFANA_PORT:-3030}`) | grafana container port 3000 |
| `grafanaUser` | `admin` | `GF_SECURITY_ADMIN_USER=admin`, password `GRAFANA_ADMIN_PASSWORD` |

Readiness (used by A3's `monitoring` preflight check): `GET <prometheusUrl>/-/ready`, `GET <grafanaUrl>/api/health`.

**k6 labels** (000 §9.3, set by A2/A1): `testid`, `service` (`collector` | `matcher` | `step-sla`),
`test_type` (`smoke` | `load` | `stress` | `breakpoint`), `plan_definition_set`, `environment`, plus
k6's `scenario`, `phase`, `level`, `window`, `name`, `status`, `expected_response`. Dashboards read
`testid`, `service`, `test_type`, `scenario`, `level`, `status`, `expected_response`.

**Annotations** (written by A2 `tools/core/clients/grafana.mjs` `postAnnotation`): tags
`["cce-performance", "<runId>", "<subject>", "<testType>"]`; dashboards query tags
`cce-performance` AND `$testid` (enabled) and `cce-performance` alone ("every run", off by default).
Auth: `GRAFANA_API_TOKEN` (Bearer), else basic `grafanaUser` + `GRAFANA_ADMIN_PASSWORD` (laptop).

**Dashboards** (000 §9.4): uids `cce-perf-overview`, `cce-perf-collector`, `cce-perf-matcher`,
`cce-perf-step-sla`, `cce-perf-k6`; variables `DS_PROMETHEUS` (datasource, query `prometheus`),
`service` (overview/k6: query `label_values(k6_vus, service)`; service dashboards: constant `collector` |
`matcher` | `step-sla`), `test_type` (query on `k6_vus`), `testid`
(`label_values(k6_vus{service=~"$service",test_type=~"$test_type"}, testid)`, multi, include All with
`allValue` `.*`, `allowCustomValue: true`, newest first).

**Unit-test exports** (`monitoring/unit-tests/dashboards.spec.mjs`):
```js
export const METRIC_ALLOW_LIST      // ReadonlySet<string>: every metric name a dashboard may query (000 §9.4)
export const VERIFY_AT_FIRST_SCRAPE // ReadonlySet<string>: names whose presence is unconfirmed until the first `up`
export const DASHBOARD_UIDS         // Readonly<Record<fileName, uid>>
export function extractMetricNames(expr) → string[]   // metric names in one PromQL expression
```
The allow-list is the §9.4 table with its shorthand written out: `{received,accepted,duplicate}` →
three names; "duplicates" → `cce_events_duplicate_total` (matcher); "skipped/s" →
`cce_sla_transitions_skipped_total`; "`_max`" / "`cce_step_matching_duration_seconds_*`" → `_sum`,
`_count`, `_max`; "Hikari active/idle/pending/max" → `hikaricp_connections_{active,idle,pending,max}`;
the generic k6 view → `k6_iterations_total`, `k6_checks_rate`, `k6_data_sent_total`,
`k6_data_received_total`, `k6_http_req_duration_{avg,max,p95,p99}`; the "verify at first scrape" note →
`spring_kafka_listener_seconds_{sum,count,max}`. Names verified in the service source on `release-2.0.0`.

## Technical Context

| Item | Value |
|---|---|
| Images | `prom/prometheus:v2.51.2`, `grafana/grafana:10.4.2`, `danielqsj/kafka-exporter:v1.7.0`, `prometheuscommunity/postgres-exporter:v0.15.0`, `gcr.io/cadvisor/cadvisor:v0.49.1`, `prom/node-exporter:v1.8.1` |
| Network | external `${CCE_NETWORK:-cce-net}` (local-stack's default network) |
| Ports | 9095 → Prometheus 9090; 3030 → Grafana 3000; exporters not published |
| Storage | named volumes `prometheus-data` (15 d retention), `grafana-data` |
| Test runner | Node 22 `node --test`, no dependencies (`node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:url`) |
| Verification | `node --test "monitoring/unit-tests/*.spec.mjs"`, `docker compose -f monitoring/docker-compose.yml config` with dummy secrets, JSON parse, `node --check`, ESLint + Prettier check, `promtool check config` on both Prometheus files and `promtool check rules` on every dashboard query (all in `prom/prometheus:v2.51.2` with `--network none`) |

## Deviations / requests

1. **`testid` query is filtered** by `$service` and `$test_type`
   (`label_values(k6_vus{service=~"$service",test_type=~"$test_type"}, testid)` instead of
   `label_values(k6_vus, testid)`), so the per-service dashboards list only that service's runs. Same
   metric, same label; the unit test accepts both forms.
2. **Typed run ids on Grafana 10.4**: `allowCustomValue: true` is set on `testid`, but Grafana 10.4's
   picker may not offer free text for query variables (the property is honoured by later versions). The
   README documents the reliable fallback: open the dashboard with `&var-testid=<runId>` in the URL.
   Confirm at the first `up` (DEFERRED task T040). Open question for C1.
3. **Two runner-annotation queries** instead of one: "Run markers (selected run)" on tags
   `cce-performance` + `$testid` (enabled) and "Run markers (every run)" on `cce-performance` only (off by
   default). Reason: with `testid` = All, `$testid` becomes `.*` and a tag filter matches nothing.
4. **Step SLA due gauge runs a SQL count on every scrape** (`ObservabilityConfig.readyNow` →
   `countDueTransitions`); with the 5 s scrape of 000 §9.2 that is 12 extra queries per minute on a pool
   of 3 (the A2 sampler adds its own). Kept at 5 s as specified; README and the panel description say so.
   Open question for C1: should the `cce-step-sla-service` job scrape every 15 s during storms?
5. **Service panels use the job label** (`job=~"cce-collector-service|cce-matcher-service|cce-step-sla-service"`)
   for generic JVM/Hikari metrics so CCE's other services (compliance, scheduler, intelligence) do not
   mix in on CCE's Grafana. Metric names unchanged.
6. **Host CPU** (000 §9.1 mentions node-exporter for host CPU) has no panel: `node_cpu_seconds_total` is
   not in the §9.4 allow-list; container CPU (cAdvisor) covers the services. Add it later if wanted.
7. **Formatting**: A2's `prettier.config.mjs` and Prettier 3.9.10 appeared in `node_modules/` while this
   package ran, so `npx prettier --write monitoring/` was run with them (JSON, YAML, MJS; Markdown is
   ignored by `.prettierignore`) and `npx eslint monitoring/` passes. The wave-A integration task (000 T014)
   still runs `npm run format` over the whole tree.
8. **Test command**: Node 22's `node --test` takes files or globs, not a folder, so the command is
   `node --test "monitoring/unit-tests/*.spec.mjs"` (A2's `npm test` already uses `"monitoring/**/*.spec.mjs"`).
9. **Extra static checks** (not in 000 §12, all offline): `promtool check config` of `prometheus.yml` and the
   example scrape jobs, and `promtool check rules` of a scratch rules file wrapping all 112 dashboard
   queries (proves every PromQL expression parses). The image `prom/prometheus:v2.51.2` was pulled for
   this and run with `--network none`; nothing was started or contacted.
10. Requests to other packages (no change made by A4): **A2** `.gitignore` lists `monitoring/.env`
    (checked: already present); **A3** the `monitoring` preflight check should use `/-/ready` and
    `/api/health` as above; **C1** link `monitoring/README.md` from `docs/runbook.md` and copy
    deviations 2 and 4 into `docs/open-questions.md`.
