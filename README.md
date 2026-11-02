# CCE load tests (eBUZIMA)

k6 load tests for the CCE services on eBUZIMA's path: OpenHIM adaptor → collector → Kafka → matcher →
Step SLA. All test data is eBUZIMA-shaped (`lib/ebuzima.js`), and the protocol is eBUZIMA's
`emr-service-protocol` v1.0.0 (`protocol/emr-service-protocol.json`, a copy of
`cce-protocol-service` release-2.0.0 `rwanda-ebuzima-emr-service-protocol-nested.json`).

There are three ways to run them, from smallest to largest:

| What | Command | What it tests | Report |
|---|---|---|---|
| **One service at a time** | `./run.sh <env> <service test>` | One service, fed directly (adaptor, collector, matcher via Kafka, Step SLA via seeded alarms): its own limits and breaking point | k6's summary (Step SLA: `report-sla.sh`) |
| **The flow** (the eBUZIMA journey) | `./flow.sh <env> <profile>`, which runs `flow/ebuzima-flow.js` | All services working together: patients walk the eBUZIMA protocol through the adaptor, as eBUZIMA would, and the database is checked at every stage | `results/flow-<profile>-<run>/report.md` |
| **A full round** | `./round.sh <env>` | Both of the above in order: every service on its own (smoke, load, stress, breakpoint), then the flow (smoke, full, stress) | `results/round-<env>-<time>/REPORT.md`, written by `report-round.sh` |

`flow/ebuzima-flow.js` is the **test** of the whole journey; `flow.sh` runs it and does the checks k6
can't. `round.sh` is **not a test**: it only runs the existing tests in order, unattended, and
`report-round.sh` turns their results into one report. A round needs the flow for its Part 2; the flow
alone can't tell which service is the weak one, which is what the single-service tests are for.

## A full round: `round.sh` and `report-round.sh`

```bash
DB_PASSWORD=<password> ./round.sh <env> --quick     # smoke tests only, ~10 min: checks the stack and the round work
DB_PASSWORD=<password> ./round.sh <env>             # the full round, ~3–3.5 hours
DB_PASSWORD=<password> ./report-round.sh results/round-<env>-<time>   # rebuild a round's report from its files
DB_PASSWORD=<password> ./cleanup.sh <env>           # afterwards, before the next day
```

1. **Pre-flight:** every service answers, the database is reachable, the eBUZIMA protocol is ACTIVE.
   The ACTIVE protocols are recorded: they change the results a lot (see "Several plan definitions").
2. **Part 1, each service on its own:** adaptor, then collector (smoke, load, stress, breakpoint staircase
   and a finer staircase between the last good level and the broken one), matcher (smoke, load, stress,
   flood), Step SLA (smoke, load, stress, storm, each with `report-sla.sh`).
3. **Part 2, the whole journey:** `flow.sh` smoke, full, stress.
4. **Report:** `report-round.sh` writes `REPORT.md`: a summary (each service's results, breaking point and
   × peak, the weakest link, whether the flow broke where Part 1 predicts), Part 1 per service (results,
   breakpoint levels, events sent vs rows in the database), Part 2 (each flow run and the time at each stage).

Between runs it waits until the matcher has processed nothing for 30 s, so one run's events don't spill
into the next. A failed test doesn't stop the round. On Linux it keeps the machine awake
(`systemd-inhibit`); elsewhere, don't let the machine sleep during a round: it freezes the services.
`report-round.sh` only reads the saved files, so it can be run again on an old round; run it with
`DB_PASSWORD` before `cleanup.sh` to include the database counts.

**Before a round on another machine:** Docker, `curl` and `jq`; an `env/<name>.json` for your stack
(copy `env/local.json` and change the ports); the database password; `./protocol-setup.sh <env>`. On
Dev/UAT you also need direct access to Kafka and Postgres (port-forwards): the matcher test writes to
Kafka and the Step SLA test seeds the database. Results depend on the machine; the thresholds don't.

**Thresholds vs breaking points.** Thresholds are the fixed pass/fail rules in the tests. A breaking
point is a measurement: the load at which a service stops meeting those rules, on that machine, with
those protocols and that much data. Run a round twice to see how much it moves.

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
./run.sh <env> <test> -e PROFILE=breakpoint  # smoke, then find the breaking point (below)
```

Every run gets a run ID (printed at the start; set your own with `RUN_ID=…`). Test patients are
`LOADTEST-<run>-<scenario>-<n>`, so one run's rows can be counted in the database.

The rates come from the expected traffic: 600,000 events a day, about 7/s on average and 50/s in
10-minute peaks (cce-data-pipeline docs §7.1).

| Profile | Rate | Duration | Passing means |
|---|---|---|---|
| smoke | 1/s | 30 s | the script and setup work; if it fails, k6 stops at once |
| load (default) | 50/s, the expected peak | 10 min | the service handles a normal busy period |
| stress | 200/s, 4× the peak | 10 min | the service handled 120,000 events in 10 minutes |
| breakpoint | rising until it breaks | up to 6 min | gives the breaking point; it is expected to fail |

Load and stress use the same pass/fail rules. A stress run stops early if errors pass 10%. It
leaves a lot of data; wait for the matcher's Kafka lag to reach 0 before running `cleanup.sh`.

**Breakpoint** (test plan D1, D3, D5) depends on the kind of service:
- **Adaptor, collector** (`lib/breakpoint.js`): a staircase 200 → 400 → 800 → 1,600 → 3,200 → 6,400 requests/s,
  1 minute per level. Each level is judged on its own with the load rules; the run stops at the first
  broken level. Result: "handled X/s, broke at Y/s". For a finer answer, run again between the two:
  `-e LEVELS=1600,1800,2000,2200,2400,2600,2800,3000` (`round.sh` does this for you). If k6 drops over
  1,000 requests while the service is still fast, k6 or the machine ran out, not the service (D4).
- **Matcher:** a flood of 2,000 events/s for 1 minute, far more than it can do. `matcher_drain_rate`
  (median) is how many events per second it gets through while flat out: its breaking point.
- **Step SLA:** `seed-sla.sh <env> storm` (100,000 alarms at once); `step_sla_drain_rate` (median) is its
  breaking point in alarms per second. `COUNT_OVERRIDE=<n> ./seed-sla.sh <env> storm` seeds a bigger storm,
  to find where its 300 s rule breaks.

Queue services (matcher, Step SLA) never refuse work; above their drain rate they fall behind, so the
backlog grows without limit. That's why their breaking point is a rate, not a failing request.

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

## Several plan definitions

With only eBUZIMA ACTIVE, each event enrols a patient in one protocol. `protocol/variants/` holds three
load-test copies of eBUZIMA with the same steps and triggers, so every eBUZIMA event matches all four;
only which steps are mandatory differs:

| Protocol | Mandatory steps |
|---|---|
| eBUZIMA (`emr-service-protocol`) | 3: vitals, consultation, diagnosis |
| `emr-service-protocol-light` | 1: vitals |
| `emr-service-protocol-lab-focus` | 5: consultation, lab-order, lab-results, treatment, referral |
| `emr-service-protocol-strict` | 7: vitals, consultation, chief-complaints, history, lab-order, diagnosis, treatment |

```bash
./protocol-variants.sh <env> load      # load the three (the matcher picks them up within 60 s)
./protocol-variants.sh <env> retire    # retire them (asks first; a retired version can't come back, bump "version")
```

Each extra match is another enrolment, steps and alarms in Postgres, so the matcher slows down in
proportion. Mandatory steps get deadlines, so they also give Step SLA work; optional steps don't. A
mandatory step needs a `tolerance-days` deadline and an optional one must not have one, or the protocol
service rejects the protocol. On a laptop (2 Nov) the matcher drained ~550 events/s with eBUZIMA alone and
~180 events/s with all four.

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
| `env/local.json` | The local stack (`extras/cce-local-setup`, default ports) |
| `env/local-machine.json` | One laptop's stack (`openphc-repos/local-stack`), with its own ports: Postgres on 15433, Kafka on 29092 |

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
- **`round.sh` and `report-round.sh` have not had a full run yet** (written 3 Nov). Start with
  `./round.sh <env> --quick` and fix what it shows.
- **One dropped request fails a load run** (`dropped_iterations: count==0`). On 2 Nov a 50/s adaptor run
  failed on 1 drop in 30,030, during a 1.1 s stall when the collector's database pool was full (10 of 10).
  Decide whether that should fail, or allow a small rate.
- **Grafana/Prometheus (later):** send k6's own metrics to Prometheus (`-o experimental-prometheus-rw`)
  and add the k6 dashboard to Grafana. Needs `--web.enable-remote-write-receiver` on Prometheus in
  `deploy-scripts`. Until then, watch the service's existing Grafana dashboard during a run.
