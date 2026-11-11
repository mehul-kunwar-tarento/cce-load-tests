<!--
  What:    What a baseline is, the rules for saving and comparing one, and the format of baselines/<name>.json.
  How:     Read before `node tools/cli.mjs baseline save|compare` (or scripts/manage-baselines.sh).
  Needs:   Nothing.
  Outputs: Documentation only. Baseline files in this folder are written by tools/baseline/baseline-store.mjs.
-->

# Baselines

A **baseline** is "the numbers we normally get" for some tests under known conditions, saved under a name
(e.g. `local-emr-service`). Later runs are compared with it to see what got better or worse, and by how much.
No baseline is shipped: the first ones come from real runs (the first version's laptop numbers are history,
summarised in [known-results-and-lessons.md](../docs/known-results-and-lessons.md)).

## Commands

```bash
node tools/cli.mjs baseline save local-emr-service results/<run1> results/<run2> results/<run3> --note "laptop, emr-service"
node tools/cli.mjs baseline compare local-emr-service results/<new run>      # writes baseline-comparison.json
node tools/cli.mjs baseline list
node tools/cli.mjs baseline show local-emr-service
BASELINE=local-emr-service scripts/run-test.sh local collector load         # compare right after a run
```

## Rules

- **At least 3 runs per test** (`BASELINE_MIN_RUNS`), each `passed` or `failed` (an `error` run has no numbers).
  With fewer, saving is refused unless `--allow-fewer`; the baseline is then **provisional** and every comparison
  says so.
- **Same conditions**: all runs must share environment, plan-definition set, dataset and the rate/duration/limit
  settings; otherwise saving is refused and the differences are listed.
- An existing name is refused unless `--force`.
- **Comparing**: the current value is the mean of the given runs. A metric is "same" when the change is within
  `BASELINE_TOLERANCE` (20 %) **or** below the unit floor (5 ms, 2 s, 100 events, 5 events/s, 20 alarms/s), so
  laptop noise is not flagged; otherwise better or worse depending on the metric's direction.
- A catch-up that did not happen is shown as **"not caught up"**, never as a number.
- Differences in conditions (environment, machine, k6 image, plan-definition set, dataset, settings, data volume
  more than 50 % apart, suite commit) are listed as warnings.
- A comparison is **informational**: it never changes a run's status.
- Only `result.json` files are read (never reports or logs).

## Which metrics

Each service module decides (`baselineMetrics(result)` in its `service-module.mjs`), at least: collector load/stress
p95 and average rate, breakpoint held-up-to and broke-at; matcher backlog, catch-up, processed per second,
processing time, flood drain rate; Step SLA maximum and p95 wait, storm drain rate and catch-up. A subject without a
module gets generic metrics (p95, average rate, breakpoint figures).

## File format (`baselines/<name>.json`)

```json
{ "$comment": "What: … How: … Needs: … Outputs: …",
  "schemaVersion": "1.0.0", "kind": "cce-performance-baseline", "name": "local-emr-service", "note": "",
  "savedAt": "2026-11-05T18:00:00.000+05:30", "provisional": false,
  "conditions": { "environment": "local", "host": { "hostname": "…", "cpus": 16 }, "k6Image": "…",
                  "planDefinitionSet": { "name": "emr-service", "fanOut": 1, "canonicals": ["…"] },
                  "dataset": "ebuzima-emr", "settings": { "PEAK_RATE": 50, "LOAD_RATE": 50, "…": "…" },
                  "dataVolume": { "dbSizeBytes": 0, "rows": {} }, "suiteCommit": "abc1234" },
  "runs": [ { "dir": "results/…", "runId": "…", "subject": "collector", "testType": "load", "status": "passed" } ],
  "metrics": { "collector.load.p95Ms": { "label": "Collector load p95", "unit": "ms", "better": "lower",
               "values": [15.4, 16.0, 14.9], "mean": 15.433, "min": 14.9, "max": 16, "stddev": 0.45, "runs": 3,
               "notCaughtUp": 0 } } }
```

The generated `$comment` header is dropped by the loader. Do not edit baseline files by hand: save again with
`--force`.
