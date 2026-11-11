<!--
  What:    How to use the performance dashboards in CCE's existing Grafana (Dev/UAT), what CCE's
           Prometheus must offer for each panel group, how run annotations authenticate there, and what
           NOT to change. Nothing here is applied automatically: deploy-scripts is never modified (D6).
  How:     Follow §2 to import; send §3 and prometheus-scrape-jobs.example.yml to CCE ops for the
           prerequisites; set GRAFANA_API_TOKEN (§4) on the machine that runs the tests.
  Needs:   A Grafana login with Editor rights on CCE's Grafana (10.4.x), the JSON files in
           ../grafana/dashboards/, and ops for the Prometheus prerequisites.
  Outputs: Five dashboards in CCE's Grafana (uids cce-perf-*), optionally a "Prometheus-LoadTest"
           datasource and a service-account token for annotations.
-->

# Using the performance dashboards in CCE's Grafana

CCE already runs Grafana 10.4.2 and Prometheus v2.51.2 (`openphc-repos/deploy-scripts`, docker compose
and `k8s/base/monitoring/`). The five dashboards in `../grafana/dashboards/` are written in the same
style as CCE's own dashboards (datasource variable `${DS_PROMETHEUS}`, schemaVersion 39), so they import
as they are. Open question Q2 (`docs/open-questions.md`) records what the team still has to decide.

## 1. What works where

| Panel group | Needs in CCE's Prometheus | On deploy-scripts release-2.0.0 |
|---|---|---|
| k6 (rate, latency, failures, dropped, VUs; k6 region annotation) | k6 metrics arriving by **remote write** | No: receiver not enabled → see §3.1 |
| Collector | job `cce-collector-service` | Yes, every 15 s |
| Matcher, Step SLA | jobs `cce-matcher-service`, `cce-step-sla-service` | No jobs → `prometheus-scrape-jobs.example.yml` |
| Kafka lag, DLQ | job `kafka` (kafka-exporter) | Yes |
| Postgres, WAL, replication slots | job `postgres` (postgres-exporter) | Yes (slot/WAL metrics: verify, see ../README.md §7) |
| Free disk | job `node-exporter` | Yes (mountpoint `/` of the host) |
| Container CPU/memory | cAdvisor | No: CCE runs no cAdvisor → those panels stay empty |
| Runner markers (green) | annotation API access (§4) | needs a token |

Rate windows of `[30s]` need at least two scrapes: with CCE's 15 s interval they work but are coarse.

## 2. Import (Dashboards → New → Import)

1. In CCE's Grafana: **Dashboards → New → Import → Upload dashboard JSON file**, pick one file from
   `monitoring/grafana/dashboards/` (repeat for all five).
2. Choose a folder, e.g. "CCE Performance". Keep the **uid** (`cce-perf-…`): it does not collide with
   CCE's dashboards, and a later re-import overwrites the same dashboard. Keep the tag `cce-performance`:
   the links between the five dashboards find each other by that tag.
3. Grafana does not ask for a datasource (the files use a datasource *variable*, like CCE's own
   dashboards). After import, open the dashboard and pick the datasource in the **Data source**
   (`DS_PROMETHEUS`) drop-down at the top:
   - `Prometheus` (CCE's, uid `prometheus`): service panels work; k6 panels only if §3.1 option A is done.
   - `Prometheus-LoadTest` (§3.1 option B): k6 panels work; service panels only if that Prometheus also
     scrapes the services.
4. To make the choice stick: pick it, then **Save dashboard** with "Save current variable values as
   dashboard default" ticked.

Re-importing a newer version: import again with the same uid and choose **Overwrite**.

## 3. Prerequisites to ask CCE ops for (not done by this repository)

### 3.1 Somewhere for k6 to write its metrics (one of)

- **Option A – enable the receiver on CCE's Prometheus.** Add the flag
  `--web.enable-remote-write-receiver` to the Prometheus command (docker compose `command:` in
  `deploy-scripts/docker-compose.yml`, or `args:` in `k8s/base/monitoring/prometheus.yaml`) and make
  `/api/v1/write` reachable from the k6 host. Then set `monitoring.remoteWriteUrl` in
  `config/environments/<env>.json` to `http://<prometheus-host>:9090/api/v1/write`.
  Consider: anyone who can reach that URL can write series; restrict it to the k6 host.
- **Option B – a separate perf Prometheus.** Run `monitoring/docker-compose.yml` (or just its Prometheus)
  on the k6 host, point `monitoring.remoteWriteUrl` at it, and add it to CCE's Grafana as a second
  datasource named **`Prometheus-LoadTest`** (Connections → Data sources → Add → Prometheus, URL of that
  Prometheus). Choose it for `DS_PROMETHEUS` on the k6 dashboard. Nothing in CCE's Prometheus changes.

### 3.2 Scrape jobs for the 2.0 services

`prometheus-scrape-jobs.example.yml` (this folder) holds the `cce-matcher-service`,
`cce-step-sla-service` and `cce-protocol-service` jobs, with the job names the dashboards filter on.
Ops add them once these services are deployed there.

### 3.3 Optional: server-side percentiles

The services export timers without histogram buckets, so p95/p99 come only from k6. Enabling
`management.metrics.distribution.percentiles-histogram.http.server.requests=true` (a deployment
environment variable) would allow server-side p95 panels later (open question Q7).

## 4. Run annotations on CCE's Grafana

The test runner posts annotations (run start/end, phases, "started breaking") to
`monitoring.grafanaUrl` with tags `cce-performance`, `<runId>`, `<subject>`, `<testType>`.
On CCE's Grafana use a **service-account token**, never the admin password:

1. Administration → Users and access → **Service accounts** → Add service account (e.g.
   `performance-tests`), role **Editor** (needed to create annotations).
2. Add a token; copy it once.
3. On the machine that runs the tests: `export GRAFANA_API_TOKEN='<token>'` (environment only, never
   in a file; the runner prefers it over `GRAFANA_ADMIN_PASSWORD`).
4. Set `monitoring.grafanaUrl` in `config/environments/<env>.json` to CCE's Grafana URL.

No token → tests still run; annotations are skipped with one warning. Step SLA runs are then only
locatable by time.

## 5. What NOT to change

- Do **not** edit `openphc-repos/deploy-scripts` from this repository, and do not change CCE's existing
  dashboards (`cce-collector-service.json`, …): ask the team first.
- Do **not** change the provisioned `Prometheus` datasource (name/uid `prometheus`); CCE's dashboards
  bind to it. Add a second datasource instead (§3.1 option B).
- Do **not** export the dashboards "for sharing externally" before importing: that replaces the
  `${DS_PROMETHEUS}` variable with an `__inputs` prompt and the files stop matching this repository.
- Do **not** change the uids `cce-perf-*` or remove the tag `cce-performance` (re-imports and the
  links between the dashboards rely on them).
- Do **not** use the Grafana admin password for annotations on shared Grafana; use a token (§4).
