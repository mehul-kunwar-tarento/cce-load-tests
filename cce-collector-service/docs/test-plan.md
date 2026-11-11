<!--
  What:    The performance test plan of cce-collector-service: what is tested, how it is fed and measured,
           the four test types with their defaults, the pass rules and expectations, data checks, Grafana
           panels, plan-definition variations, recorded conditions, risks and the commands.
  How:     Read before running a collector test or changing its defaults; review with the team (every
           "to be confirmed" item is a decision still open). Numbers are the shipped defaults from
           config/settings/defaults.json; any of them can be changed per run with --set NAME=value.
  Needs:   ../README.md (quick start); ./test-strategy.md (the why); config/settings/defaults.json.
  Outputs: Nothing; the agreed plan for this service.
-->

# CCE Collector Service Performance Tests — Test Plan

**Service** cce-collector-service (release-2.0.0) · **Subject** `collector` · **Id code** `col` ·
**Prometheus job** `cce-collector-service` · **Spec** [001-collector-performance-tests](../specs/001-collector-performance-tests/spec.md)

Items marked **TBC** are *to be confirmed from UAT/Dev data* (rates, expectations) or *by the team*
(pass rules). They are working values, not agreed limits.

## 1. What is tested

The collector on its own: the HTTP endpoint `POST /v1/events` that every EMR adaptor calls. For each
request it validates the CloudEvent, inserts a row into `inbound_event_log`, publishes the event to Kafka
topic `cce.events.inbound` (synchronously, `acks=all`), updates the row to `ACCEPTED` and answers `202`. So
the latency k6 measures is **INSERT + Kafka publish + UPDATE**, not just HTTP.

Questions each run answers (team lead's point 1):

- How many events went through in the configured interval, at what rate and latency?
- Did every accepted event get stored (sent = accepted = stored)?
- Stress and breakpoint: when did it start breaking (clock time, seconds into the measured phase, rate),
  and what broke (latency, errors, k6 could not send, DB pool)?
- Expectation vs result: did it withstand what we expected?

Not tested here: the adaptors (OpenHIM, Tiberbu — independent modules later), the matcher (its own folder,
fed directly from Kafka) and the end-to-end flow (later module).

## 2. How it is fed and measured

**Fed by** k6 (image `cce-load-tests/k6:2.3.0-kafka2.2.0`) with **arrival-rate executors** (open model):
k6 starts N iterations per second whatever the collector's speed; an iteration k6 could not start on time
is a *dropped iteration*. One iteration = one new event:

| Field | Value |
|---|---|
| URL | `services.collector.baseUrl` + `/v1/events` (the direct service URL, never the gateway: it rate-limits this path) |
| Headers | `Content-Type: application/json`; no auth |
| Body | Structured-mode CloudEvent, lowercase fields: `specversion`, `id`, `source`, `type`, `subject`, `time`, `facilityid`, `correlationid`, `datacontenttype`, `data` (FHIR resource) |
| `id` | `LOADTEST-<runId>-col-<phaseIndex>-<n>-1` — ≤ 50 characters (collector limit), unique per request (a repeat would be answered `200 duplicate`, concurrent repeats `500`) |
| `subject` | `LOADTEST-<runId>-col-<phaseIndex>-<n>` = the FHIR resource's patient (the collector requires them to match) |
| `source` / `facilityid` | dataset defaults `loadtest-emr` / `LOADTEST-FACILITY-01`, or `EVENT_SOURCE` / `FACILITY_ID` |
| `data` | dataset template for `EVENT_ACTION_ID` (default `visit-encounter`) from `DATASET` (default `ebuzima-emr`) |

An answer counts as **accepted** only when both checks pass: `status is 202` and `event accepted`
(`data.status == "accepted"`). Counters `events_sent` and `events_accepted` record every attempt and every
acceptance.

**Measured by**

| Source | What |
|---|---|
| k6 | `http_req_duration` (p95, p99, …), `http_req_failed`, `checks`, `dropped_iterations`, `events_sent`, `events_accepted` — per scenario (`warm-up`, `measure`), per 10 s report window and per staircase level |
| Collector actuator (sampled every `WATCH_INTERVAL` 5 s) | `http_server_requests_seconds_sum/_count/_max{uri="/v1/events"}` (server time: average and max — the service exports no histogram buckets, so **p95 comes from k6 only**), `cce_collector_events_received/accepted/duplicate_total`, `cce_collector_kafka_publish_failure_total`, plus JVM, Hikari pool `cce-collector-pool` and CPU |
| Postgres (after the run) | data checks (section 5) |
| Kafka admin | matcher consumer-group lag before (idle wait) and after (backlog left) |

Only the **measured phase** counts: the warm-up is excluded from every rule and from "events went through".

## 3. Test types and defaults

All rates are events per second. `<TYPE>_EVENTS` (count of measured events) replaces the duration when set:
duration = ceil(events / rate), shown with source `derived`.

| Test type | Warm-up | Measured phase | Planned events | Settings |
|---|---|---|---|---|
| `smoke` | none | 1/s for 30 s | 30 | `SMOKE_RATE`, `SMOKE_DURATION`, `SMOKE_EVENTS` |
| `load` | 10/s for 1 min | 50/s for 10 min (1 × peak) | 600 + 30,000 | `LOAD_RATE`, `LOAD_DURATION`, `LOAD_EVENTS`, `WARM_UP_RATE`, `WARM_UP_DURATION` |
| `stress` | 10/s for 1 min | 200/s for 10 min (4 × peak) | 600 + 120,000 | `STRESS_RATE`, `STRESS_DURATION`, `STRESS_EVENTS`, warm-up settings |
| `breakpoint` | 10/s for 1 min | staircase 200 → 400 → 800 → 1,600 → 3,200 → 6,400/s, 1 min each (TBC: lessons suggest longer) | 600 + up to 756,000 | `LEVELS`, `LEVEL_DURATION`, `BREAKPOINT_MAX_DROPPED` (1,000), warm-up settings |

Shared: `PEAK_RATE` 50 (TBC), `EXPECTED_HEADROOM` 4 (TBC), `MAX_VUS` 2,000, `REPORT_WINDOW` 10 s,
`BREAK_CONSECUTIVE_WINDOWS` 2, `PLAN_DEFINITION_SET` `emr-service`. k6 VUs per scenario follow the rate
(pre-allocated ½ × rate, at most 4 × rate, capped by `MAX_VUS`; the default staircase gets 100 / 2,000).

**Refining a breakpoint** (`--refine-from <result folder>`): the runner reads "held up to G, broke at B"
from that result, sets `LEVELS` to finer steps between G and B and `WARM_UP_RATE = G` — the warm-up runs at
the last good level, so the fine staircase does not start cold (a v1 lesson: cold one-minute levels
understated the limit).

Peak 50/s comes from the design figure (600,000 events/day, 10-minute peaks), not from measured traffic.
Real rates will come from the UAT/Dev event-flow analysis (spec 007).

## 4. Thresholds and expectations

**Pass rules** (k6 thresholds on the measured phase; the same values drive the report):

| Rule | Limit | Setting | Status |
|---|---|---|---|
| Latency p95 | < 500 ms | `HTTP_P95_LIMIT_MS` | TBC — to be confirmed from UAT/Dev data |
| Failed requests | < 1 % | `HTTP_MAX_FAILED_RATE` | TBC — to be confirmed from UAT/Dev data |
| Checks passed | > 99 % | `MIN_CHECKS_RATE` | — |
| Dropped iterations | < 0.1 % of planned (≤ floor(planned × 0.001), e.g. 30 of 30,000) | `MAX_DROPPED_RATE` | TBC by team |
| Accepted per second (`collector.throughput`) | ≥ 95 % of the target rate | `RATE_SHORTFALL_TOLERANCE` | TBC |
| Warm-up sanity | checks > 99 % in the warm-up, else abort | `MIN_CHECKS_RATE` | — |
| Stress abort | failed > 10 % for 10 s → stop early | fixed | — |
| Breakpoint, per level | p95, failed, checks as above, judged per level; the first level that breaks stops the staircase | as above | TBC |
| Breakpoint, k6 | stop after 1,000 dropped iterations | `BREAKPOINT_MAX_DROPPED` | — |

**Dropped iterations and the k6 limit.** The exact dropped count, its share and the allowed count are
always reported. When the only rules that failed are dropped iterations / "k6 could not send on time" and
the collector's p95 stayed below `K6_LIMIT_P95_MS` (100 ms), the load generator ran out of capacity, not
the collector: the report says **"at least X/s (k6 limit)"** and marks the failure as a load-generator
limit. Run k6 on its own host (Dev/UAT) to measure further.

**Expectations** (printed at the top of every report as "Expected: …" next to "Result: …"; all TBC):

| Test type | Expectation |
|---|---|
| smoke | 1/s for 30 s: every event answered 202 "accepted" and stored |
| load | withstand 50/s = **1 × peak** for 10 min after warm-up within the pass rules; every accepted event stored |
| stress | withstand 200/s = **4 × peak** (`EXPECTED_HEADROOM`) for 10 min within the pass rules |
| breakpoint | hold at least 200/s (4 × peak) on the staircase; report held-up-to / broke-at and how they compare (above / below by N/s) |

**What "breaking" means for the collector**: a 10 s window (or a staircase level) breaks when p95 >
500 ms, failed > 1 %, checks < 99 %, or k6 sent < 95 % of the planned requests. "Started breaking" = the
first of 2 broken windows in a row. The report then lists what broke, plus diagnostics within ±1 window:
**Hikari pending > 0** on `cce-collector-pool` (10 connections — the first sign of trouble), Kafka publish
failures, heap > 90 %, GC pauses > 500 ms. Diagnostics explain; they never change the verdict.

## 5. Data checks

Run after every test against Postgres. Rows are found by generating every event id the run can have
produced from its phase plan and joining on the unique index `(cloudevents_id, source)` — no `LIKE` scan;
each query runs under a 5-minute `statement_timeout`, and its SQL and duration are saved in the result.

| Check | Severity | Expected | Why |
|---|---|---|---|
| `collector.stored-equals-accepted` | required | `ACCEPTED` rows = k6 `events_accepted` (all phases). Breakpoint or a run that stopped early: **between** accepted and sent (a request cut off on the client may still have been stored) | The collector stored what it said it accepted |
| `collector.no-rejections` | required | `REJECTED` rows = 0 (rows still `RECEIVED` are named) | 422/500 answers are stored as REJECTED; a valid load must have none (400s are not stored at all and show up as failed checks) |
| `collector.downstream-logged` | info | `matcher_event_log` rows = stored ACCEPTED | How far the matcher got; it may still be draining |
| `collector.downstream-backlog-left` | info | matcher consumer lag = 0 | "Matcher still draining N events" — the next test waits for it |

Sent vs stored vs processed: k6 `events_sent` → `events_accepted` → `ACCEPTED` rows (= `eventsProcessed`
in the result) → matcher-logged (info). Data checks can be re-run later with
`node tools/cli.mjs check-data local results/collector-<type>-<stamp>`.

## 6. Grafana panels to watch

Dashboard **CCE Collector Service — Performance** (`monitoring/grafana/dashboards/cce-collector-service-performance.json`,
filtered by Run id and Test type), alongside **k6 Load Test (CCE)**:

| Row | Panels | Look for |
|---|---|---|
| k6 → collector | requests/s by status; latency p95/p99; failed share; dropped iterations/min | the rate holding flat; p95 rising before errors |
| Collector counters | received / accepted / duplicate per s; rejected by reason; Kafka publish success/failure | accepted = sent; duplicates 0; publish failures 0 |
| Server-side time | `/v1/events` average and max; ingestion pipeline average | server time vs k6 p95 (a gap = network or k6) |
| Database pool | Hikari connections (`cce-collector-pool`); time-outs per minute | **pending > 0 is the first sign of breaking** |
| JVM and container | heap, longest GC pause, threads (busy Tomcat), container CPU and memory | saturation that explains a break |
| k6 Load Test | p95 and requests/s **by staircase level**; VUs | which level broke; VUs reaching `MAX_VUS` (k6 limit) |

Also open **CCE Performance Overview** for the matcher lag and Postgres (connections, WAL) on the same
timeline — collector slowdowns are often caused there. Grafana annotations mark each run's start, measured
phase, end of sending, "started breaking" and end.

## 7. Plan-definition variations

The collector does not read plan definitions, yet its limit depends on them: every accepted event goes to
the matcher, which does roughly N × the work for an event matching N plan definitions, **in the same
Postgres**. More matcher work → more DB contention → slower collector inserts. v1 on a laptop: the
collector held 1,600/s with 1 ACTIVE plan definition but only 500/s with 4 overlapping ones (a condition
whose sets were removed on 2026-11-11; the shipped sets hold one real protocol each).

| `PLAN_DEFINITION_SET` | What it is | Events sent (dataset, enrolment event) |
|---|---|---|
| `emr-service` (default) | the EMR Service protocol, 10 steps, 3 mandatory with a deadline | `ebuzima-emr`, `visit-encounter` |
| `kenya-sha-emr-service` | the Kenya SHA protocol, 15 steps, 5 mandatory (4 with a deadline) | `tiberbu-emr`, `consent-request` |

The set also picks the events: with `DATASET` empty the run sends the set's own dataset. Other ACTIVE plan
definitions that match the same events still add matcher work in the shared Postgres (the report shows the
*effective fan-out*).

Load a set with `scripts/manage-plan-definitions.sh load local --set <name>` (refreshes the matcher), then
run with `--set PLAN_DEFINITION_SET=<name>`. The set, its plan definitions and any other ACTIVE ones are
recorded with every result. Compare collector numbers only between runs with the same set.

## 8. Conditions recorded

Every `result.json` stores: environment and service URLs; host (name, CPUs, memory, OS, Node, k6 image
and version); suite commit; plan-definition set with canonical urls, versions and mandatory steps, plus
other ACTIVE plan definitions; dataset, source, facility and action id; data volume (DB size, live rows of
the main tables); every setting with its source (default / environment / env-var / cli / derived);
preflight status and warnings; `NOTE`.
Breaking points are measurements under these conditions, not fixed facts: compare only like with like.

## 9. Risks and known limits

- **Laptop numbers are relative only.** k6, the CCE services, Postgres, Kafka and monitoring share one
  machine; a "k6 limit" result is common there. Real capacity numbers need Dev/UAT with k6 on its own host.
  The staging and production profiles also use bigger DB pools (15 and 20 connections) than local (10).
- **JVM warm-up**: the first minute after a restart is slow (v1: first event ~3.9 s, an 884 ms spike).
  Load, stress and breakpoint warm up first (`WARM_UP_*`); smoke does not and is not a performance number.
- **Shared Postgres with the matcher** (lesson 10): a draining matcher slows the collector. The run waits
  for the matcher to be idle (lag 0, counters flat for `IDLE_FLAT_DURATION` 30 s, give up after
  `IDLE_TIMEOUT` 5 min → refused, exit 2). On Dev/UAT with real traffic the lag may never reach 0 — open
  question.
- **Global counters**: the collector's actuator counters count every caller. Run one test at a time.
- **Autovacuum after cleanup**: a big delete triggers autovacuum, which pushed collector p95 from ~18 ms to
  666 ms in v1. After cleanup, wait (the cleanup tool notes it) before the next run.
- **Side effects**: every accepted event creates matcher rows, Step SLA deadlines (alarms ring later),
  Kafka messages and WAL. Clean up after each session (`scripts/cleanup-test-data.sh`).
- **One-minute staircase levels** may understate the limit; refine with `--refine-from` and consider a
  longer `LEVEL_DURATION` (TBC).
- **No server-side histograms**: p95 is the client view from k6 (includes network and k6 scheduling).
- **Baselines** need ≥ 3 runs under the same conditions; one run is fragile.

## 10. How to run

From the repository root (`DB_PASSWORD` exported; monitoring optional: `monitoring/README.md`):

```bash
scripts/check-services.sh local --subject collector                  # preflight only (no load)
scripts/run-test.sh local collector smoke                             # 30 events
scripts/run-test.sh local collector load                              # 1 × peak, 10 min
scripts/run-test.sh local collector stress                            # 4 × peak, 10 min
scripts/run-test.sh local collector breakpoint                        # staircase 200 → 6400/s
scripts/run-test.sh local collector breakpoint --refine-from results/collector-breakpoint-<stamp>

# Change the load without editing code
scripts/run-test.sh local collector load --set LOAD_EVENTS=1000      # 1000 events at 50/s = 20 s
scripts/run-test.sh local collector stress --set STRESS_RATE=300 --set PLAN_DEFINITION_SET=kenya-sha-emr-service
scripts/print-settings.sh local collector breakpoint --set LEVELS=400,600,800
scripts/run-test.sh local collector load --dry-run                    # settings, phases, k6 command only

# Afterwards
scripts/build-report.sh --latest 4                                    # one summary across runs
scripts/manage-baselines.sh save local-emr-service results/collector-load-<stamp1> results/collector-load-<stamp2> results/collector-load-<stamp3>
scripts/cleanup-test-data.sh local --run-id <runId> --dry-run         # then without --dry-run
```

Exit codes: `0` passed · `1` a rule or required data check failed (or aborted) · `2` refused (preflight,
idle timeout, bad settings, prod) · `3` tool error. The verdict is in `result.json` / `report.md`.
