<!--
  What:    The reasoning behind the collector performance tests: why these test types, why an open load
           model, how the collector is fed and measured, what "breaking" means for an HTTP service, how to
           tell a k6 limit from a collector limit, and how single results become baselines.
  How:     Read after ../README.md and before changing a test or a pass rule; the concrete numbers are in
           test-plan.md.
  Needs:   ./test-plan.md; the suite-wide strategy in ../../docs/test-strategy.md.
  Outputs: Nothing; the agreed approach for this service.
-->

# CCE Collector Service Performance Tests — Test Strategy

## Why test the collector on its own

The collector is CCE's only write entry point: every EMR event passes through `POST /v1/events` before
anything else happens. If it slows down, adaptors queue or time out and clinics see failures. Testing it
directly (k6 → collector, no adaptor in front) gives a number that belongs to the collector alone; the
adaptors get their own independent modules later, and the end-to-end flow its own module.

What makes the collector's cost: each request does an INSERT, a **synchronous** Kafka publish with
`acks=all` and an UPDATE, using a Hikari pool of 10 connections (`cce-collector-pool`). So its limit is set
by Postgres and Kafka round-trips, and it shares Postgres with the matcher that consumes what it publishes.

## The four test types

| Type | Question it answers | When to run |
|---|---|---|
| **smoke** | Does the path work at all? (1/s, 30 s, no warm-up) | after every deployment or config change; before any longer test |
| **load** | Does it hold the expected peak (1 × `PEAK_RATE`) for 10 minutes within the rules? | regularly; the baseline for regressions |
| **stress** | Does it hold `EXPECTED_HEADROOM` × peak (4 ×), and if not, when and how does it start breaking? | before releases; after infrastructure changes |
| **breakpoint** | What is the highest rate it holds? (staircase until a level breaks) | to size capacity; after performance work |

Load and stress hold one rate; a fail tells you *that* it broke and *when*. The breakpoint climbs a
staircase and tells you *where*. A staircase is the right shape for an HTTP service: it answers every
request, so it breaks by getting slow or failing at a certain rate. (Queue-fed services such as the matcher
break differently — they fall behind — so they use a flood and measure the drain rate.)

`soak` and `spike` are reserved names for later.

## Open load model

Every test uses k6 **arrival-rate** executors: k6 starts a fixed number of requests per second no matter
how long the previous ones take. Real clinics do not wait for the collector before sending the next
event, so a closed model (a fixed number of users each waiting for its answer) would hide slowdowns: it
sends less exactly when the service is slow.

Consequence: when the collector slows down, k6 needs more virtual users (VUs) to keep the rate. If it runs
out (`MAX_VUS`) or cannot schedule in time, the iteration is **dropped**. Dropped iterations are therefore
a signal, and they are always reported exactly.

## How to tell a k6 limit from a collector limit

| What you see | Reading |
|---|---|
| Dropped iterations or "k6 could not send on time", **p95 high** | the collector is slow; VUs pile up waiting — a collector limit |
| Dropped iterations or shortfall, **p95 below `K6_LIMIT_P95_MS` (100 ms)** | the collector answered fast; k6 itself could not keep up — a **k6 limit**: "at least X/s" |
| Failed requests or failed checks | the collector refused or errored — a collector limit, whatever the p95 |

The k6-limit reading never makes a run pass: the run is still `failed` on the k6 rule, but the report and
`statusReason` say it is a load-generator limit, and the breakpoint reports "at least X/s (k6 limit)".
On a laptop this is common; real capacity numbers need k6 on its own host.

## Measuring

- **Client side (k6)**: latency percentiles, failures, checks, sent/accepted counters — per scenario
  (warm-up excluded), per 10 s report window (to find *when* it started breaking) and per staircase level.
  The collector exports no histogram buckets, so **p95 is k6's**.
- **Server side (actuator, sampled every 5 s)**: server time per request (average and max), the
  collector's own counters, Kafka publish failures, Hikari pool, heap, GC, CPU. These explain a break
  (diagnostics); they never decide the verdict.
- **Database (after the run)**: stored = accepted, no rejections, matcher-logged and the matcher backlog
  left. The v1 suite's most valuable finding was that data correctness held in every run — keep proving it.
- **Grafana** shows all of it on one timeline (k6 pushes its metrics by Prometheus remote write, tagged
  with run id, service and test type), because the visible symptom is often several hops from the cause.

## What "breaking" means here

A 10-second window breaks when p95 > `HTTP_P95_LIMIT_MS`, failed > `HTTP_MAX_FAILED_RATE`, checks <
`MIN_CHECKS_RATE`, or k6 sent less than (1 − `RATE_SHORTFALL_TOLERANCE`) of the plan.
"Started breaking" is the first of `BREAK_CONSECUTIVE_WINDOWS` broken windows in a row, reported as a clock
time, seconds into the measured phase and the rate at that moment. For the staircase, each level is judged
with the same rules; "held up to" is the highest level with nothing broken at or below it.

The first sign of trouble in the collector is usually **Hikari pending > 0** (requests waiting for one of
the 10 DB connections); then p95 rises; then failures. Kafka publish failures mean the broker, not the
collector, is the bottleneck.

## Isolation and side effects

- **Wait for the matcher first.** Collector and matcher share Postgres, and a matcher still draining the
  previous test slows the collector (v1 lesson). Every collector run waits until the matcher's lag is 0
  and its counters are flat, and reports the backlog it leaves behind.
- **One test at a time**: actuator counters are global.
- **Test data is tagged** `LOADTEST-<runId>-col-…` and enumerable from the phase plan, so data checks and
  cleanup find it through the unique index instead of scanning.
- **Clean up after each session** and let autovacuum finish before the next measured run.

## Plan definitions are a parameter

The collector's own work does not change with plan definitions, but the matcher's does (N plan definitions
matched ≈ N × the work), and that load lands in the same Postgres. So the collector's breakpoint depends on
`PLAN_DEFINITION_SET` (v1 laptop: 1,600/s with one plan definition, 500/s with four). The set is a test
parameter, recorded with every result, and results are compared only within the same set.

## From results to baselines

Thresholds are fixed rules; breaking points are measurements that change with machine, data volume,
warm-up and plan definitions. So:

1. Every result stores its conditions (environment, host, commit, plan definitions, dataset, data volume,
   every setting and its source).
2. A baseline is the mean of at least 3 runs under the same conditions
   (`scripts/manage-baselines.sh save …`); later runs are compared with it (better / worse / same within
   `BASELINE_TOLERANCE`), with warnings when conditions differ.
3. Collector baseline numbers: `collector.load.p95Ms`, `collector.load.averageRate`,
   `collector.stress.p95Ms`, `collector.stress.averageRate`, `collector.breakpoint.heldUpTo`,
   `collector.breakpoint.brokeAtRate`.
4. Real rates and expectations replace the design figures once the UAT/Dev event-flow analysis is done
   (spec 007); until then every expectation is marked "to be confirmed".
