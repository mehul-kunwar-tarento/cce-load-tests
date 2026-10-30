# CCE load test plan

Status: **signed off** (30 Oct 2026). Once signed off, the code follows this file; if the code
has to differ, this file is changed first.

## 1. Common rules

**Expected traffic** (cce-data-pipeline docs §7.1): 600,000 events a day, about 7/s on average and
50/s in 10-minute peaks.

**Three profiles for every service**

| Profile | What | Passing means |
|---|---|---|
| smoke | 1/s for 30 s | the script and setup work; a failure stops the run at once |
| load | the expected peak, 50/s for 10 min | the service handles a normal busy period |
| stress | push past the service's limit until it breaks | the report says **at how many events per second it broke**, and how many times the peak that is |

**Breaking point** depends on the kind of service (D1), but the result always reads the same way:
**"broke at X events/s (Y × the peak)"**, plus the last rate it still handled (D2).

- **HTTP services** (the adaptor and collector, when they are tested again) answer each request, so they break by getting slow or failing. Stress is a staircase
  that doubles the rate every minute: 200 → 400 → 800 → 1600 → 3200 → 6400/s. The run stops at the first
  level that fails the pass rules. Result: "handled 800 events/s, broke at 1,600 events/s (32 × peak)".
- **Queue and database-fed services** never answer, so they break by falling behind. Stress gives them far
  more work than they can do, then measures the most they get through per second. Any rate above that
  makes work pile up. Result: "broke above 310 events/s (6 × peak)".

**Pass rules shared by every test:** under 1% failed requests, over 99% of checks passed, and no dropped
requests (k6 kept the set rate). A smoke failure stops the test at once.

**k6 or service?** If k6 drops requests while the service's latency is still low, the sender ran out, not
the service. The result is then reported as "at least X/s (k6 limit)" (D4).

**Test data:** every test patient starts with `LOADTEST-`; `cleanup.sh` deletes it, and only once the
services have finished processing. **Results on a laptop are relative**: k6 and every service share one
machine. Real limits come from Dev and UAT.

## 2. Per service

### 2.1 Matcher

- **What it does:** reads `cce.events.inbound`, matches each event against the active protocols, and
  writes enrolments, steps and their deadline alarms.
- **How load gets in:** k6 writes the collector's CloudEvent straight to Kafka (xk6-kafka), key = patient.
- **Measured by:** a watcher reading `cce_events_processed_total` every 5 s: backlog = sent − processed,
  throughput, catch-up time after sending stops.
- **Load:** 50/s for 10 min. Pass: backlog never above 1,000, cleared < 30 s after sending stops, 0 Kafka
  write errors.
- **Stress:** flood: 2,000 events/s for 1 min (120,000), far above what it can read. Maximum throughput =
  its median events/s while a backlog exists.
- **Status:** test exists (`matcher/matcher.js`). Load passed (backlog 0). Old stress (200/s) passed;
  **breaking-point stress to build.** Earlier staircase runs suggest about 260–340/s with its default 3
  consumer threads.

### 2.2 Step SLA

- **What it does:** every 5 s (15 s on prod) finds deadline alarms that have rung, marks the step OVERDUE or
  MISSED, writes a deviation.
- **How load gets in:** `seed-sla.sh` inserts test steps and their alarms straight into Postgres; the ring
  times set the load. Nothing is sent during the test.
- **Measured by:** a watcher on `cce_sla_transitions_due` and the handled counters, then `report-sla.sh`:
  each alarm's wait from ringing to handled (`processed_at − process_by`).
- **Load:** 30,000 alarms ringing 50/s. Pass: every alarm handled, longest wait < 2 check intervals
  (10 s locally, 30 s on prod), each step OVERDUE with one deviation.
- **Stress:** storm: 100,000 alarms ringing at the same moment. Maximum throughput = alarms handled per
  second while they drain. Pass: all cleared < 5 min.
- **Status:** test exists. Load and storm passed (storm: 100,000 in 77.5 s, about 1,290/s).
  **To add:** the storm's throughput in the report.

### 2.3 End to end

- **What it does:** all the CCE services at once: adaptor → collector → Kafka → matcher → Postgres →
  Step SLA.
- **How load gets in:** k6 HTTP into the adaptor, shaped like a real day: 7/s steady with a 50/s burst for
  10 min. Most visits are dated now; **10%** are dated 20 days back, so their deadlines have already
  passed and Step SLA has work too. The share is one setting with a default of 10, changed per run without
  editing code: `./run.sh local end-to-end/end-to-end.js -e PAST_DATED_PERCENT=25` (0 leaves Step SLA idle).
- **Measured by:** k6 (adaptor latency), the matcher watcher (backlog) and the Step SLA watcher (alarms
  due) at the same time; afterwards a report from Postgres: time from the event reaching the collector
  (`inbound_event_log.received_at`) to the enrolment existing (`protocol_instance.created_at`).
- **Pass:** adaptor p95 < 500 ms; matcher backlog never above 1,000; Step SLA's longest wait < 2 check
  intervals; event → enrolment p95 < 10 s. The 10 s is one setting too:
  `-e ENROLMENT_LIMIT_SECONDS=20`.
- **Stress:** none of its own: the chain breaks at its slowest service, which 2.1 and 2.2 already find.
- **Status:** **to build.**

### 2.4 Insights API

- **What it does:** 37 read-only endpoints that query ClickHouse for the dashboards.
- **Status:** **to discuss later** (decided 30 Oct). Notes for that discussion: results depend on how much
  data ClickHouse holds, so it needs seeding first; the targets in data-pipeline docs §7.2 are dashboards
  < 500 ms, drill-downs < 2 s, full scans < 10 s, CSV export < 30 s.

### 2.5 Not tested for now

| Part | Why | Decided |
|---|---|---|
| Data pipeline (Debezium, Kafka, ClickHouse) | infrastructure, not a CCE service. A test was written and its smoke passed (freshness about 9 s); kept out of the plan. Found on the way: the alert `e2e-latency-high` measures clinic → collector, not the pipeline | 30 Oct |
| Insights UI | only static files; its load is the Insights API's | 30 Oct |
| OpenHIM adaptor, Collector | not tested for now; their tests stay in the repo (`adaptor/openhim.js`, `collector/collector.js`, last run on older profiles). End to end (2.3) still sends its traffic through them | 30 Oct |
| TibERbu adaptor | deferred; same shape as the OpenHIM adaptor test when picked up | 22 Oct |
| Protocol service | left for now. Loads protocol definitions, a rare admin action; no event traffic passes through it | 30 Oct |
| Scheduler | left for now. A 1.x service; in release 2.0 Step SLA does its job | 30 Oct |
| Gateway | left for now. OAuth (Keycloak) + routing in front of the Insights API; testable only where Keycloak runs (Dev/UAT) | 30 Oct |

## 3. Decisions

| # | Date | Decision |
|---|---|---|
| D1 | 30 Oct | Breaking point = first failing staircase level for HTTP services; maximum drain throughput for queue and database-fed services |
| D2 | 30 Oct | `stress` = breaking point (replaces "4× peak for 10 min"). Every stress result says at how many events per second the service broke, how many times the peak that is, and the last rate it handled |
| D3 | 30 Oct | HTTP staircase doubles 200 → 6400/s, 1 min per level, stops at the first failing level |
| D4 | 30 Oct | Dropped requests with low latency = k6 or machine limit, reported as "at least X/s" |
| D5 | 30 Oct | Matcher: 2,000/s flood for 1 min; Step SLA: 100,000 alarms at once |
| D6 | 30 Oct | Laptop results are relative; real limits come from Dev/UAT |
| D10 | 30 Oct | Only the CCE services are tested, plus one end-to-end run across them. OpenHIM adaptor and Collector not tested for now. Data pipeline and Insights UI out; Insights API discussed later; Protocol, Scheduler, Gateway left for now |
| D11 | 30 Oct | End to end: 10% of visits dated 20 days back so Step SLA has work; one setting (`PAST_DATED_PERCENT`, default 10), changeable per run |
| D12 | 30 Oct | End to end passes when event → enrolment p95 < 10 s; one setting (`ENROLMENT_LIMIT_SECONDS`, default 10) |
| D7 | 23 Oct | Load = expected peak, 50/s for 10 min |
| D8 | 23 Oct | Step SLA passes on each alarm's wait, not on a count of alarms waiting |
| D9 | 22 Oct | Prod: no tests until discussed |

## 4. Order of work

1. Sign off this plan.
2. Change the stress tests to match it, one at a time: matcher flood (2.1), Step SLA storm throughput in
   the report (2.2).
3. Re-run 2.1 and 2.2 with the same rules; one results table.
4. Build 2.3 (end to end); 2.4 after its discussion.
