<!--
  What:    Fixtures of tools/commands/unit-tests/run-test.spec.mjs (verbatim test data, no headers inside).
  How:     Read by the spec only; never by the tools.
  Needs:   Nothing.
  Outputs: Nothing.
-->

# run-test fixtures

| File | Content |
|---|---|
| `k6-summary-stub-load.json` | Synthetic handleSummary of the stub load test with `WARM_UP_DURATION=0s`, `LOAD_EVENTS=100` (2 s at 50/s, one 10 s report window): 100 events sent and accepted, p95 12.5 ms, nothing dropped. The fake `runK6` copies it into the run folder and fills `context.k6StartedAt`, `runId` and `phasePlan`. |
| `refine-from/result.json` | Minimal breakpoint result (held 400/s, broke 800/s) for `--refine-from` (→ LEVELS 500,600,700, WARM_UP_RATE 400). |
