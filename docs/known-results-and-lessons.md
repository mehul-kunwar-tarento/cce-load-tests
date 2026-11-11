<!--
  What:    The results of the first test round (v1, 30 Oct – 3 Nov 2026, on one laptop), clearly marked
           "laptop, relative only", the corrections to how some of them were reported, and the lessons learned,
           each linked to the part of this suite that addresses it.
  How:     Read before interpreting new numbers or changing the design; quote v1 numbers only as relative
           comparisons, never as capacity.
  Needs:   Nothing. Sources (read-only): results/STRESS-REPORT-2026-11-03.md, results/SUMMARY-2026-10-30.md,
           results/SUMMARY-2026-11-02-breakpoint.md, results/round-local-machine-20261103-0038/,
           the v1 baseline local-4plans.json, the prompt set's 03-cce-background-and-lessons.md.
  Outputs: Documentation only.
-->

# CCE Performance Tests — Known Results and Lessons

> **Laptop, relative only.** Every number on this page comes from one 16-core laptop where k6, the CCE
> services, Postgres, Kafka and about 25 other containers shared the machine. The numbers show which service
> limits the system and how conditions move the limits; real capacity comes from Dev and UAT.

---

## 1. How to read this page

- The first version ("v1", on the `ebuzima-flow-tests` branch) tested the OpenHIM adaptor, the collector,
  the matcher, Step SLA and the end-to-end flow with the eBUZIMA EMR's data, at the expected peak of 50
  events/s (a design figure from CCE's data-pipeline documentation, not measured traffic). "× peak" = a rate ÷ 50.
- Two plan-definition conditions were tested: the eBUZIMA protocol **alone** (1 ACTIVE plan definition) and
  **4 overlapping** plan definitions (the protocol plus three variants with 7, 1 and 5 mandatory steps — later
  the `overlapping-4` set, removed on 2026-11-11 together with the variants; the numbers below stay as
  history).
- The database was nearly empty; the event mix was our own assumption (~7.3 events per patient).
- Every v1 number is **laptop, relative only**. Do not put them in a capacity statement; compare a new laptop
  run with them only to see a direction (better/worse).

## 2. v1 numbers (laptop, relative only)

### 2.1 Load and stress (3 Nov round, 4 overlapping plan definitions)

| Service | Smoke | Load 50/s, 10 min | Stress 200/s (4 × peak), 10 min |
|---|---|---|---|
| OpenHIM adaptor (archived) | pass | p95 20.2 ms; "failed" on 11 dropped of 30,020 (one 1.45 s stall) — see §3.2 | pass, p95 21.6 ms, 120,032 requests |
| Collector | pass | pass, p95 15.4 ms | pass, p95 21.3 ms, 120,031 requests, 0 errors |
| Matcher | pass | pass, backlog at most 12, caught up 2.7 s after sending | **fail** (expected): processed ~154/s (17.2 ms per event), backlog up to 28,811, over 1,000 waiting from 31 s into the stress; **not caught up within the 120 s limit** — see §3.1 |
| Step SLA | pass | pass, longest wait 5.0 s | pass, 120,000 alarms, wait avg 2.5 s, p95 4.8 s, max 5.1 s (rule < 10 s) |
| End-to-end flow (archived) | pass, 24/24 checks | pass (rerun): 30,880 events, HTTP p95 18.2 ms, matcher caught up 1 s, Step SLA 6.5 s | **fail** (expected) at ~197/s: HTTP p95 21.9 ms; matcher fell behind 44 s in and caught up 181 s after sending; events waited in Kafka up to 230 s |

Earlier smoke and load runs with the eBUZIMA protocol alone (30 Oct): collector p95 ~10 ms; the adaptor added
about 2–4 ms; matcher 3.9 ms per event; Step SLA longest wait ~4–5 s (one 5 s poll interval).

**Data correctness held in every run**: sent = stored = matched = enrolled (e.g. adaptor stress 120,032 sent =
stored = matched = patients, 480,128 enrolments = 4 per patient). No service crashed or lost data; each slowed
down or fell behind and then recovered.

### 2.2 Capacity and breaking points

| Service | 1 ACTIVE plan definition (2 Nov) | 4 overlapping plan definitions (2–3 Nov) |
|---|---|---|
| Collector (staircase, 1 min per level) | held 1,600/s, broke at 3,200/s (32 × / 64 × peak) | held 500/s, broke at 600/s (p95 555 ms): 10 × peak |
| OpenHIM adaptor (archived) | not run | held 800/s, broke at 1,000/s (p95 640 ms): 16 × |
| Matcher (2,000/s flood, median drain rate) | ~551 events/s, 3.6 ms per event: ~11 × | ~179 events/s (2 Nov), ~156 events/s (3 Nov, bigger database), ~16–17 ms per event: **3.1–3.6 × — the weakest link, below the 200/s stress target** |
| Step SLA (100,000-alarm storm) | ~1,650–2,000 alarms/s (100,000 in 61 s) | ~1,290–1,490 alarms/s; storm cleared in 70–78 s, longest wait 69.8 s (rule < 5 min) |

### 2.3 Resources

- **Disk**: with 4 plan definitions, Postgres wrote ~77 KB and Kafka ~40 KB per event across the stack (WAL,
  Debezium, matcher, Step SLA). Overnight, Kafka grew from 38 to 73 GB (7-day retention); free disk fell from 64
  to 19 GB and stopped the round.
- **Memory**: the JVMs run the Serial GC in 768 MiB containers — fine at 50/s.
- **CPU during the 4-plan matcher drain**: matcher ~180 %, Postgres ~120 %.

The v1 baseline (`local-4plans`, 28 numbers and their conditions) is history, not a baseline of this suite
(no baseline is shipped: [baselines/README.md](../baselines/README.md)).

## 3. Corrections

What some v1 reports said, and what the numbers really mean:

| # | v1 said | Correct reading | What the suite does now |
|---|---|---|---|
| 3.1 | Matcher stress "caught up in 121 s" (baseline `matcher.stress.catch_up = 121.4`) | **121.4 s was the give-up time, not a catch-up.** The v1 watcher waited at most 120 s after sending stopped and then recorded the time it gave up as "caught up after". The backlog had **not** cleared: roughly 10,000 events were still waiting (estimate from 28,811 peak and ~154/s; not measured) | The backlog watcher records `caughtUp: false`, `remainingBacklog` and `gaveUpAfterSeconds` separately; the report says "not caught up: N events still waiting after 120 s"; baselines show "not caught up", never a number |
| 3.2 | Adaptor load "FAIL" on 11 dropped of 30,020 (and 1 of 30,030 the night before), p95 20 ms | 0.04 % dropped during one stall while the service answered fast: within any reasonable rule | `MAX_DROPPED_RATE` = 0.1 % (to be confirmed by the team); exact count always reported; dropped with fast responses reads "at least X/s (k6 limit)" |
| 3.3 | Adaptor broke at 1,000/s | Possibly understated: the finer staircase started **cold** at each finer level | `--refine-from` warms up at the last level that held |
| 3.4 | Step SLA "drain rate" ~5/s in the stress report | Meaningless at a steady ring rate: it only echoes the rate chosen | Drain rate reported for the storm only |
| 3.5 | Flow full "FAIL": HTTP p95 666 ms, collector DB pool up to 59 waiting | Ran straight after a 27-million-row delete while **autovacuum** ran; the rerun on a settled database passed at 18.2 ms | Preflight `autovacuum` warning; cleanup notes "wait before the next test"; runbook §14 |
| 3.6 | End-to-end Step SLA 26.2 s for 42,201 alarms (rule 15 s) | Test artefact: `flow.sh` brought every alarm of the run forward to ring at once; real alarms spread over 1–2 days | The Step SLA storm tests "all at once" on purpose with its own rule (5 min); steady rates use the ring schedule |
| 3.7 | Collector "broke at 600/s" vs "1,600/s" | Both true under their conditions: with 4 plan definitions the matcher's ~4 × database work competes with the collector for the shared Postgres | Every result records the plan-definition set and other ACTIVE plan definitions; collector runs wait for the matcher to be idle |
| 3.8 | Reports and baselines built by grepping Markdown and TSV; a k6 stop on dropped requests was once read as "passed" | Fragile and wrong in edge cases | Reports, series summaries and baselines read `result.json` only; `status` is `passed / failed / aborted / error` |

v1's run ids were `mmddHHMMSS` (no year) and its event ids random, so per-run cleanup of v1 data needs
`--legacy-v1` ([runbook.md](runbook.md) §12). The v1 files are on the `ebuzima-flow-tests` branch; comments in the new code
that say "ported from the first version" refer to those files.

## 4. Lessons → design

Each lesson of the first round, and the part of this suite that answers it.

| # | Lesson | Design element |
|---|---|---|
| 1 | **Thresholds are rules; breaking points are measurements**, and breaking points move with the machine, data volume, warm-up and ACTIVE plan definitions | Thresholds are settings with a `toBeConfirmed` flag ([config/settings/defaults.json](../config/settings/defaults.json)); `result.json` `breaking` holds the measurement; every result stores its `conditions` (`tools/core/conditions.mjs`); baselines refuse mixed conditions and warn on differences ([test-strategy.md](test-strategy.md) §4) |
| 2 | **HTTP services and queue services fail differently** | Each service module declares its `breakpointKind`: `staircase` (collector), `flood` (matcher), `none` + storm (Step SLA) ([test-strategy.md](test-strategy.md) §2, §6) |
| 3 | **Plan definitions drive the cost** (1 → 4 cut the matcher from ~551 to ~156–179/s) | `PLAN_DEFINITION_SET` chooses the real protocol (`emr-service` or `kenya-sha-emr-service`; the synthetic overlapping sets were removed on 2026-11-11) ([test-data/README.md](../test-data/README.md)); preflight's overlap check and *effective fan-out* for other ACTIVE plan definitions; Step SLA `STEP_SLA_SEED_MODE=set`; the set recorded in every result |
| 4 | **Use an open load model; dropped iterations at low latency = k6 limit** | Arrival-rate scenarios only (`lib/scenarios.js`); "at least X/s (k6 limit)" for staircase levels and report windows (`tools/core/breaking-analysis.mjs`, `K6_LIMIT_P95_MS`) |
| 5 | **A "0 dropped" rule failed runs over 1 stalled request in 30,000**; thresholds unconfirmed | `MAX_DROPPED_RATE=0.001` (< 0.1 %), exact count reported; every unconfirmed limit printed "to be confirmed" ([open-questions.md](open-questions.md) Q1) |
| 6 | **Warm up and repeat**: cold 1-minute levels understated limits; one-run baselines are fragile | Warm-up phase (`WARM_UP_RATE`, `WARM_UP_DURATION`); `--refine-from` warms up at the held level; baselines need `BASELINE_MIN_RUNS` (3) runs |
| 7 | **Tests have side effects; cleanup is part of the test**: alarms ring days later, Kafka 38 → 73 GB overnight | Every id tagged `LOADTEST-<runId>-<idCode>-…`; preflight `leftover-test-data` warns about test alarms ringing in the next 24 h; `STEP_SLA_SEED_MISSED_ALARMS` off by default; disk checks in preflight and cleanup ([runbook.md](runbook.md) §12) |
| 8 | **Big cleanups must be batched**: one 27-million-row delete lost the Debezium slot, broke ClickHouse sync (40 M stale rows, 503s), and autovacuum then pushed p95 from 18 to 666 ms | `tools/cleanup/`: batches of `CLEANUP_BATCH_SIZE` in short transactions, pauses, slot/WAL and disk checks before and every 10 batches (stop at `CLEANUP_MIN_SAFE_WAL_GB`), refuses while services process, before/after counts per table with snapshot verification saved as JSON, `ANALYZE` and an autovacuum note |
| 9 | **The error you see is several hops from its cause** | Grafana Overview: k6, all services, Kafka lag, DB pools, JVM, container CPU/memory, disk, WAL on one timeline ([monitoring/README.md](../monitoring/README.md)); *diagnostics* near "started breaking" in `whatBroke` |
| 10 | **Measurement gaps**: Tomcat thread metrics off; collector DB pool (10) filled in short stalls; a connection "idle in transaction" through a whole run; home-made `docker stats` sampling hid *when* things broke | Metrics sampler records Hikari pending/active/timeouts, heap, GC, CPU per service (`service-metrics.json`); Postgres connections by state on the Overview dashboard; Tomcat panel marked "may be empty" ([monitoring/README.md](../monitoring/README.md) §7); Prometheus + Grafana instead of home-made sampling |
| 11 | **Practical issues**: the laptop slept; two databases on one port; containers "up" while the service crash-loops | `scripts/run-test.sh` uses `systemd-inhibit`; preflight `postgres-target` (database name, port, tables) and `service-health` (`/actuator/health`, not the container state) |
| 12 | **Test types still missing**: soak, spike/backfill, recovery, analytics path, matcher scaling | Listed with their plan in [test-strategy.md](test-strategy.md) §13; reserved names `soak`, `spike`; `WORKLOAD_PROFILE` reserved for bursts |

Findings of the restructure itself (not from the laptop round), also designed for:

| Finding | Design element |
|---|---|
| k6 starts scenarios only after VU init and `setup()`; counting from `docker run` skews every "seconds into the run" | The *k6 clock* ([architecture-overview.md](architecture-overview.md) §5.1) |
| Matcher and Step SLA counters are global; a draining backlog from the last run would be counted | Idle wait before every run (`IDLE_FLAT_DURATION`, `IDLE_TIMEOUT`); one test at a time |
| xk6-kafka returns from `produce()` without error even when the broker is unreachable | Delivery is proven by the backlog watcher (topic offsets, consumer lag) and stall detection, not by k6's error counter |
| `step_instance.matched_event_id` has no index, so deleting `matcher_event_log` rows is slow | Cleanup's temporary index (`CLEANUP_TEMP_INDEX`, only where `safety.allowTempIndex`), or small batches |
| The API gateway rate-limits `/v1/events` | Environment files use the services' direct URLs |
| Production profiles use bigger DB pools (collector 15–20) than local-stack (10) | Laptop pool diagnostics do not transfer one-to-one: recorded as a risk in the collector test plan |
