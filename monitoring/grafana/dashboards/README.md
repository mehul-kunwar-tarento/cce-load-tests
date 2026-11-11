<!--
  What:    Header for the five Grafana dashboard JSON files in this folder (JSON cannot hold comments;
           each dashboard also carries What/How/Needs/Outputs in its own "description" field).
  How:     Grafana loads every *.json here (provisioning/dashboards/dashboards.yml) and ignores this
           README. To use them in CCE's Grafana see ../../cce-grafana-import/README.md.
  Needs:   A Prometheus datasource holding k6 remote-write series and the scrape jobs of
           ../../prometheus/prometheus.yml.
  Outputs: Nothing; documents the dashboards, their variables, annotations and how to edit them.
-->

# Performance dashboards

| File | uid | Title |
|---|---|---|
| `cce-performance-overview.json` | `cce-perf-overview` | CCE Performance — Overview |
| `cce-collector-service-performance.json` | `cce-perf-collector` | CCE Collector Service — Performance |
| `cce-matcher-service-performance.json` | `cce-perf-matcher` | CCE Matcher Service — Performance |
| `cce-step-sla-service-performance.json` | `cce-perf-step-sla` | CCE Step SLA Service — Performance |
| `k6-load-test.json` | `cce-perf-k6` | k6 Load Test (CCE) |

The uids start with `cce-perf-` so they never collide with CCE's own dashboards (`cce-collector-service`, …).
All five carry the tag `cce-performance` and link to each other (top-right "CCE Performance dashboards",
keeping time range and variables).

## Conventions (same as CCE's dashboards in deploy-scripts)

- `schemaVersion` 39 (Grafana 10.4); every panel and query uses the datasource **variable**
  `${DS_PROMETHEUS}` (type datasource, query `prometheus`), so the dashboard works with whichever
  Prometheus you pick, here or in CCE's Grafana.
- Rows group panels from cause to effect: what k6 sent → what the service counted → pool/JVM →
  containers/disk → Postgres.
- Rate windows are `[30s]` for counters (6 scrapes at 5 s) and `[1m]` for timers and cAdvisor.
- k6 trend metrics are seconds; panels in milliseconds multiply by 1000.
- Dashed lines are the **default** pass limits of `config/settings/defaults.json` (e.g. `HTTP_P95_LIMIT_MS`
  500 ms, `MATCHER_MAX_BACKLOG` 1,000, `MIN_FREE_DISK_GB` 20 GB, `CLEANUP_MIN_SAFE_WAL_GB` 2 GB); a run may
  override them, and the run report is the authority on pass/fail.
- Every panel has a `description` for someone new to performance testing; panels that may be empty say why.

## Variables

| Variable | Type | Notes |
|---|---|---|
| `DS_PROMETHEUS` | datasource (`prometheus`) | Pick "Prometheus-LoadTest" here when k6 metrics live in a separate Prometheus |
| `service` | query `label_values(k6_vus, service)` (overview, k6) / hidden constant (service dashboards) | Filters k6 panels only |
| `test_type` | query `label_values(k6_vus{service=~"$service"}, test_type)` | Filters k6 panels only |
| `testid` | query `label_values(k6_vus{service=~"$service",test_type=~"$test_type"}, testid)`, multi, All (`.*`), custom values allowed, newest first | The run id. Type a Step SLA run id here (no k6 series), or add `&var-testid=<runId>` to the URL |

Service panels are **not** filtered by run: the services do not know the run id. Use the time range and
the annotations.

## Annotations

| Name | Source | Default |
|---|---|---|
| k6 test runs | Prometheus: `max by (testid, service, test_type) (k6_vus{testid=~"$testid"})` → shaded region per run | on |
| Run markers (selected run) | Grafana annotations with tags `cce-performance` AND `$testid` (posted by the test runner) | on |
| Run markers (every run) | Grafana annotations with tag `cce-performance` | off (turn on when *Run id* = All) |

## Metric names

Every metric a panel may use is on the allow-list `METRIC_ALLOW_LIST` in
`../../unit-tests/dashboards.spec.mjs` (the names of plan 000 §9.4). Adding a panel with a new metric
means adding the name there, after checking it exists (Prometheus → Graph, or the service's
`/actuator/prometheus` page). Names still to be confirmed at the first scrape: see `../../README.md` §7.

## Editing a dashboard

1. Change it in Grafana (the laptop stack allows UI edits; they are not saved to the repository).
2. *Share → Export → Save to file* with **"Export for sharing externally" OFF** (ON would replace
   `${DS_PROMETHEUS}` with `__inputs` and break the import into CCE's Grafana).
3. Replace the file here, keep the `uid`, `description` (What/How/Needs/Outputs) and `schemaVersion`,
   and remove the `id` value (set it to `null`).
4. Run `node --test "monitoring/unit-tests/*.spec.mjs"` (or `npm test`).
