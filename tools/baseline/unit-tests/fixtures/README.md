<!--
  What:    Fixtures of tools/baseline/unit-tests/baseline.spec.mjs.
  How:     Read by the spec only.
  Needs:   Nothing.
  Outputs: Nothing.
-->

# Baseline fixtures

`local-sample.json` is a saved baseline (as `baseline save` writes it, generated `$comment` included) of three
collector load runs (p95 15.4 / 16.0 / 14.9 ms) and a matcher catch-up metric, on host `perf-laptop` with the
overlapping-4 set (a set removed on 2026-11-11; the fixture keeps the name it was recorded with). The run results the spec compares come from `tools/report/unit-tests/fixtures/results/`.
