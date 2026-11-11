<!--
  What:    Fixture result folders for the report, series-report, baseline and command unit tests.
  How:     Read (or copied into temporary folders) by the specs; never by the tools.
  Needs:   Nothing.
  Outputs: Nothing.
-->

# Report fixtures (`results/`)

| Folder | Content |
|---|---|
| `matcher-stress-20261105-142233/` | The `result.json` example of plan §5.2, completed: matcher stress at 200/s, backlog up to 28,811, not caught up (11,474 still waiting after 120 s), DB-pool diagnostic, overlapping-4 set (removed on 2026-11-11; kept as recorded) |
| `collector-breakpoint-20261105-142233/` | Built by `buildResult` from A1's synthetic staircase summary (`lib/unit-tests/fixtures/k6-summary-breakpoint.json`): held 1,600/s, broke at 3,200/s on p95 812.5 ms, 6,400/s not reached; passed on capacity (≥ 200/s) |
| `matcher-breakpoint-20261105-150955/` | Built by `buildResult` from A1's synthetic Kafka flood summary plus a backlog-watcher outcome: drain rate 312.5 events/s, caught up after 341 s |
| `collector-load-20261105-120000/` | Edited copy of the matcher example: collector load passed, p95 15.4 ms, 30,000 events in 10 min |
| `step-sla-breakpoint-20261105-160000/` | Edited copy: Step SLA storm of 100,000 alarms, seeded timing, drain rate 826.4 alarms/s, 9 cycle-cap hits |
| `collector-load-1103003810/` | A v1-style folder with only `report.md` and no `result.json`: must be ignored by series reports |

The built ones were produced once by a throwaway script outside the repository (recorded in
`specs/002-node-tooling-core/plan.md`); regenerate them the same way if `result.json` changes shape.
