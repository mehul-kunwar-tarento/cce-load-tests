# CCE load tests (eBUZIMA)

k6 load tests for the CCE services on eBUZIMA's path: OpenHIM adaptor → collector → Kafka → matcher →
Step SLA. All test data is eBUZIMA-shaped (`lib/ebuzima.js`), and the protocol is eBUZIMA's
`emr-service-protocol` v1.0.0 (`protocol/emr-service-protocol.json`, a copy of
`cce-protocol-service` release-2.0.0 `rwanda-ebuzima-emr-service-protocol-nested.json`).

There are two kinds of test:
- **The flow** (`flow.sh`): the services working together, and the main test.
- **One service at a time** (`run.sh <env> <service test>`): to find which service is slow once the flow shows a problem.

## The eBUZIMA flow: `flow.sh`

```bash
./protocol-setup.sh <env>                               # once: eBUZIMA protocol loaded and ACTIVE
DB_PASSWORD=<password> ./flow.sh <env> smoke            # 30 s, about 1.5 min with the checks
DB_PASSWORD=<password> ./flow.sh <env> full             # smoke, then 10 min at the expected peak
DB_PASSWORD=<password> ./flow.sh <env> stress           # smoke, then 10 min at 4× the peak
```

Each simulated patient sends their eBUZIMA visit to the adaptor, one FHIR resource per protocol step,
in order: visit Encounter → vitals Observation → consultation Encounter → chief complaints → history →
lab order (ServiceRequest) → lab result → diagnosis (Condition) → treatment (MedicationRequest) →
referral Encounter. The mix is fixed, 10 patients at a time: 1 only checks in, 2 stop after the chief
complaints, 6 complete the visit, 1 is also referred. That's 7.3 events per patient.

| Profile | Patients/s | Events/s | Duration |
|---|---|---|---|
| smoke | 1 | ~7 | 30 s |
| full | 7 | ~51 (the expected peak) | 30 s smoke + 10 min |
| stress | 27 | ~197 (4× the peak) | 30 s smoke + 10 min |

`flow.sh` runs these steps and writes `results/flow-<profile>-<run>/report.md`. It exits 1 if any check fails.
1. **Pre-flight:** all five services healthy, and the eBUZIMA protocol ACTIVE. It warns about other ACTIVE protocols.
2. **Contract:** one visit Encounter through the adaptor. Checks the CloudEvent the collector receives: source, type, subject (UPID), facility, the Encounter type display, `hospitalization.origin` and the correlation ID.
3. **Load:** `flow/ebuzima-flow.js`, with `monitor.sh` sampling every service's resources.
4. **Downstream, from the database** (this run's `LOADTEST-<run>-` patients only):
   - **Collector and matcher:**
     - every accepted event is stored
     - every stored event is processed by the matcher, and it catches up within 30 s
     - every patient is enrolled in the eBUZIMA protocol
     - each step is completed exactly once per event sent for it
     - timings for time waiting in Kafka and matcher processing
   - **Step SLA, live:** the matcher schedules a MET verdict for each step done on time; every one must be applied.
   - **Step SLA, brought forward:** the protocol's deadlines are 1–2 days out, so `flow.sh` moves this run's open DUE alarms to now (`next_attempt_at` and `process_by`).
     - every one must be applied within 2 poll intervals plus 5 s
     - an OVERDUE deviation is recorded for each step not done (the patients who stopped early)

Pass rules: k6's usual thresholds (95% under 500 ms, under 1% failed, over 99% checks, none dropped,
and each step's p95 under 500 ms), plus every downstream check above.

**Why `.sh` around the `.js`:** the load is k6 JavaScript. k6's JavaScript runs inside k6, not
Node.js, so it can't query Postgres, read `docker stats` or write a combined report. The shell
script does those parts.

**Other protocols:** a test protocol that starts on any Encounter would also enrol eBUZIMA patients, adding
matcher and Step SLA work that eBUZIMA wouldn't cause. `./protocol-setup.sh <env> --retire-others`
retires every other ACTIVE protocol. It asks before retiring, and retired protocols can't be
re-activated, only loaded again as a new version.

## The protocol service

It isn't on the event path. The matcher reads `protocol_definition` and `trigger_index` from the
database and refreshes its cache every 60 s (`CCE_PROTOCOL_REFRESH_INTERVAL_MS`). Nothing calls the
protocol service per event. Its performance scope is small:
- **Loading a protocol** (`POST /v1/protocol/protocol-definitions`: validate, store, build the trigger index). An admin action, done rarely.
- **Read endpoints** (`GET` by id, by url, list) for admin tools. Low traffic.
- **Time until a load or retire takes effect** in the matcher: up to the refresh interval.

`protocol-setup.sh` uses it to load the eBUZIMA protocol. No load test is planned for it unless the
admin UI starts calling it heavily.

## One service at a time

## How to run

Only Docker is needed: `run.sh` runs k6 from our own image (`docker/Dockerfile`: k6 2.3.0 plus the
xk6-kafka 2.2.0 extension, which the matcher test uses to write to Kafka). The first run on a machine
builds it (about a minute, needs internet); later runs reuse it.

```bash
./run.sh <env> <test>                    # e.g. ./run.sh local adaptor/openhim.js  (smoke, then load)
./run.sh <env> <test> -e PROFILE=smoke   # smoke only (30 s)
./run.sh <env> <test> -e PROFILE=stress  # smoke, then stress
```

The rates come from the expected traffic: 600,000 events a day, about 7/s on average and 50/s in
10-minute peaks (cce-data-pipeline docs §7.1).

| Profile | Rate | Duration | Passing means |
|---|---|---|---|
| smoke | 1/s | 30 s | the script and setup work; if it fails, k6 stops at once |
| load (default) | 50/s, the expected peak | 10 min | the service handles a normal busy period |
| stress | 200/s, 4× the peak | 10 min | the service handled 120,000 events in 10 minutes |

Load and stress use the same pass/fail rules. A stress run stops early if errors pass 10%. It
leaves a lot of data; wait for the matcher's Kafka lag to reach 0 before running `cleanup.sh`.

Each of these sends one eBUZIMA visit Encounter per request.

| Test | What it tests |
|---|---|
| `adaptor/openhim.js` | OpenHIM emitter adaptor `POST /inbound` (with the real collector behind it) |
| `collector/collector.js` | Collector `POST /v1/events` on its own, with the CloudEvent the adaptor sends |
| `matcher/matcher.js` | Matcher: writes the CloudEvent straight to Kafka; a watcher reads `cce_events_processed_total` every 5 s for backlog and throughput. Stops if nothing is processed for 30 s. The counter counts all traffic, so on a shared server other events make the matcher look faster |
| `step-sla/step-sla.js` | Step SLA: the work is seeded straight into the database (see below); this only watches it being handled |

**Step SLA** reads only the database, so its test seeds deadline alarms there instead of sending events:

```bash
DB_PASSWORD=<password> ./seed-sla.sh <env> <smoke|load|stress|storm>   # alarms ring from 60 s later
./run.sh <env> step-sla/step-sla.js                                     # watch them being handled
DB_PASSWORD=<password> ./report-sla.sh <env>                            # PASS/FAIL from each alarm's wait
```

`seed-sla.sh` copies the rows the matcher writes for an Encounter (enrolment, deadline step, its DUE
and MISSED alarms). The ring times set the load: smoke 30 at 1/s, load 30,000 at 50/s, stress 120,000
at 200/s, storm 100,000 all at once. `report-sla.sh` passes when every alarm was handled and the
longest wait after ringing is under 2 check intervals (`stepSla.pollIntervalSeconds`; storm: 300 s).
Run it before `cleanup.sh`, and run `cleanup.sh` only once Step SLA has nothing due, or the two collide.
The alarms are on the eBUZIMA protocol's `vitals-recording` step (`stepSla` in `env/<env>.json`).
Run one Step SLA test at a time, and wait for the last alarm to ring before seeding again. The
watcher reads Step SLA's overall counters, so alarms left from an earlier seed count as this run's.

**Resources:** `./monitor.sh <env> out.tsv &` samples the JVM (heap, GC, threads), database pools,
Kafka producer and the matcher's and Step SLA's own counters, plus each container's CPU, memory and
I/O, every 5 s. `./monitor.sh --summary out.tsv` gives min/avg/max. `flow.sh` runs it for you.

The smoke, load and stress settings and their pass/fail rules live in `lib/` (`smoke.js`, `load.js`,
`stress.js`), and `lib/options.js` picks one by `PROFILE`, so every test uses the same rules.

At the end k6 prints a summary; each threshold shows ✓ or ✗, and the run exits non-zero if any fails.

## Environments

Each environment has one file in `env/` with the URLs and IDs the tests use. The scripts contain
no URLs. The repo is cloned onto each environment's own server and run there, so the tests call the
services directly, not through the gateway (the gateway rate-limits `/v1/events`).

| File | Environment |
|---|---|
| `env/local.json` | The local stack (`extras/cce-local-setup`) |

Pick one with `-e ENV=<name>`. Passwords are never stored here; they come from environment variables.

## Test data

Every patient ID a test creates starts with `LOADTEST-`, so load-test data can be found and deleted
in shared environments. To delete it (the script shows the row counts and asks before deleting):

```bash
DB_PASSWORD=<password> ./cleanup.sh <env>
```

It deletes every Postgres row linked to a `LOADTEST-` patient, in one transaction. ClickHouse's main
tables follow on their own (Debezium carries the deletes); its summary tables do not, see Open items.
Locally, `extras/cce-local-setup/scripts/reset-data.sh` clears everything instead.

## Open items

- **Prod:** not decided yet whether load tests ever run against Prod. Needs a discussion first.
  Until then, do not run these tests on Prod. `cleanup.sh` refuses `prod`.
- **ClickHouse summary tables:** after `cleanup.sh`, the `mv_*` and `rollup_*` tables in
  `cce_analytics` still hold rows for `LOADTEST-` patients. Not yet checked whether the Insights
  dashboards show them.
- **Missing index in the matcher:** `step_instance.matched_event_id` has a foreign key to
  `matcher_event_log` but no index, so deleting matcher events scans all of `step_instance` per row.
  `cleanup.sh` works around it with an index that exists only during its transaction (writes to
  `step_instance` wait meanwhile). The real fix is a migration in `cce-matcher-service`; raise with the team.
- **Grafana/Prometheus (later):** send k6's own metrics to Prometheus (`-o experimental-prometheus-rw`)
  and add the k6 dashboard to Grafana. Needs `--web.enable-remote-write-receiver` on Prometheus in
  `deploy-scripts`. Until then, watch the service's existing Grafana dashboard during a run.
