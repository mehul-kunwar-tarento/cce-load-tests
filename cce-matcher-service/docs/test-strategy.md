<!--
  What:    Test strategy of the CCE matcher service performance tests: why the matcher is tested on its own,
           why these four test types (with a flood instead of a staircase), how a queue consumer is fed and
           measured, what "breaking" means for it, how runs are kept safe and comparable, and how results
           become baselines.
  How:     Read once before the test plan (test-plan.md has the numbers and commands).
  Needs:   ../README.md; specs/000-performance-testing-setup/plan.md §4.7, §6.5, §6.6, §6.9, §8.3.
  Outputs: Documentation only.
-->

# CCE Matcher Service Performance Tests — Test Strategy

## Why test the matcher on its own

In the whole CCE flow (adaptor → collector → Kafka → matcher → Step SLA) the matcher has been the
**weakest link**. On a laptop the collector accepts several hundred events per second over HTTP, while the
matcher processed about 551 events/s with one plan definition and about 156–179 events/s with four. A flow
test can only show that "something fell behind". A matcher-only test shows how far behind the matcher
falls, when it starts, and how fast it recovers. It does this without the collector's HTTP path or an
adaptor in the way, and it can repeat the measurement with any plan-definition set.

Feeding the matcher directly is possible because its only input is the Kafka topic `cce.events.inbound`.
k6 writes the same CloudEvents the collector would publish (same key = patient id, same JSON, no headers),
so for the matcher a test event looks exactly like a real one.

## The four test types

| Type | Question | Why this shape |
|---|---|---|
| smoke | Does the whole path work, and are the data checks right? | 30 events at 1/s: cheap, run before every series and after every stack change |
| load | Does the matcher keep up at the expected peak? | 1 × `PEAK_RATE` for 10 min: long enough for the JVM, the connection pool and Kafka to settle |
| stress | Does it withstand 4 × peak? If not, when does it fall behind, and does it recover? | 4 × peak (`EXPECTED_HEADROOM`) for 10 min: the headroom the signed-off plan asks for |
| breakpoint (flood) | What is its capacity? | 2,000/s for 1 min, far above capacity, then the drain rate is measured |

**Why a flood instead of a staircase.** HTTP services (the collector) are measured by response time, so a
staircase of rising rates shows where p95 or errors break. A queue consumer never answers the sender: the
backlog simply grows when arrivals exceed capacity. The cleanest way to measure its capacity is to create a
big backlog fast and watch how quickly it shrinks. That speed (the **drain rate**) is the matcher's capacity,
whatever rate k6 managed to send. A breakpoint for a queue service therefore equals its capacity.

## Open load model

Every test uses k6 arrival-rate executors: k6 starts N iterations per second, whether or not earlier ones
have finished. This is how real traffic behaves (EMRs do not wait for CCE). If k6 cannot keep the schedule,
it drops iterations and counts them exactly (`dropped_iterations`). Fewer than 0.1 % dropped is allowed
(`MAX_DROPPED_RATE`, to be confirmed by the team), and the report always gives the exact count.

Each k6 virtual user owns one Kafka producer, and producers are expensive (threads and buffers). Kafka tests
therefore have their own, smaller VU limits (`KAFKA_PRE_ALLOCATED_VUS` 100, `KAFKA_MAX_VUS` 500) instead of
the HTTP `MAX_VUS`.

## Measuring a queue consumer

k6 cannot see the matcher. It only knows that it handed a message to its producer. Everything about the
matcher is measured from outside by the Node **backlog watcher**:

- **Backlog** = the consumer group's lag on the inbound topic. The matcher commits its Kafka offset only
  after its database transaction, so lag 0 means "everything is stored".
- **Processed** = matched + duplicate counters. The matcher's "processed" counter counts retries twice and
  is not used.
- **Catch-up**: after sending stops, the watcher waits until the backlog is ≤ 10 (a few events are always
  in flight). That gives "caught up after N s". If the limit (`CATCH_UP_LIMIT` 2 min, or
  `BREAKPOINT_CATCH_UP_LIMIT` 15 min after a flood) passes first, the result is "not caught up: N events still waiting after S s". The first version reported
  that give-up time as a catch-up time, which made a failing stress run look like a slow pass. That is now
  impossible: a run that did not catch up has no catch-up number, in the report and in baselines.
- **Missing data never crashes and never passes silently.** A metric that cannot be read becomes `null`
  with one warning. Every series of a counter is summed; the first version read only the first series and
  crashed when a metric was missing. A rule that could not be measured is shown as "not measured".

The watcher samples on its own clock from before k6 starts. It interprets the samples on the **k6 clock**:
time 0 is the end of k6's `setup()`, which the runner learns from k6's REST API and, after the run, from
`k6-summary.json`. Creating hundreds of producers can take tens of seconds before `setup()`. The first
version measured from the Docker start, so every catch-up time included that delay. Now samples taken
before k6 was running are re-based once the k6 clock is known, and when k6 stops early the send end moves
to the moment it stopped.

## What "breaking" means here

| Test | Broken when | Reported as |
|---|---|---|
| smoke, load, stress | the backlog grows above `MATCHER_MAX_BACKLOG` (1,000) for 2 samples in a row, or it does not catch up within `MATCHER_MAX_CATCH_UP` (30 s) | started breaking at <clock time> (<s> into the measured phase); what broke: "up to N events waiting", "not caught up: N events still waiting after S s" |
| breakpoint (flood) | never "broken": the flood is meant to pile up | drain rate (median events/s while > 1,000 wait) against the target `EXPECTED_HEADROOM × PEAK_RATE` (200/s), plus whether it drained within 15 min |
| any | events go to the dead-letter topic, Kafka write errors, data checks fail | each failed rule in plain words |

Signals from the service (database pool waiting, long GC pauses, heap near its limit) that peak near the
moment the backlog started growing are added as explanations. They never change the verdict.

## Safe stops

The watcher stops the load (k6 gets SIGINT and still writes its summary) and marks the run **aborted** when:

- **stall**: more than 10 events wait and nothing is processed for `STALL_TIMEOUT` (30 s). Typical causes are
  Kafka being unreachable or the matcher being stuck. Waiting the full catch-up limit would only hide that;
- **restart**: the processed counter goes down, which means the matcher restarted and its numbers no longer
  add up.

Ctrl-C does the same. Samples are written to `watch-backlog.json` after every sample, so an aborted run keeps
everything measured so far.

## Isolation and side effects

- Counters and lag are **global**. Run one test at a time. Before every matcher run (and every collector
  run, because collector events reach the matcher too) the runner waits until the matcher is idle.
- Collector and matcher share one Postgres. A draining matcher slows the collector down, and the reverse.
- Test data is tagged `LOADTEST-<runId>-mat-…` and removed per run or all at once by the cleanup tool, which
  lists every table with before/after counts.
- The data checks read the database with index-friendly queries and a statement timeout, so they are safe
  on a large shared database.

## Plan definitions are a parameter

The matcher's cost per event grows with the number of plan definitions that match it. Each one adds an
enrolment, steps, history rows and SLA transitions. The suite has no eBUZIMA-specific logic: eBUZIMA is only
the first dataset, and its protocol is the plan-definition set `emr-service`; the second, `tiberbu-emr`, goes
with `kenya-sha-emr-service`. Every result records the set, its fan-out and a snapshot of the ACTIVE definitions.
Preflight refuses a matcher run while other ACTIVE definitions would also match the test events, unless you
allow it explicitly, in which case the data checks expect the larger fan-out. Results with different sets
are never compared silently.

## From results to baselines

Each run's `result.json` is the only input of reports and baselines; nothing is parsed from text. The
matcher contributes these numbers (`baselineMetrics`): load max backlog, catch-up seconds and processing
time per event; stress processed per second, max backlog, seconds until it started breaking and processing
time; the flood's drain rate. A baseline needs at least 3 runs with the same environment, plan-definition
set, dataset and rate settings. A comparison says better / worse / same within a tolerance, and it warns when
conditions differ (host, set, data volume, …). Real targets will come from the UAT/Dev event-flow analysis
(spec 007). Until then every limit is a setting marked "to be confirmed".
