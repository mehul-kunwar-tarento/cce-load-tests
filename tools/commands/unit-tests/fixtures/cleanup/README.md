<!--
  What:    Fixtures of the cleanup command tests.
  How:     Copied to a temporary results folder by tools/commands/unit-tests/cleanup.spec.mjs (npm test).
  Needs:   Nothing.
  Outputs: Nothing; documentation of the fixture files.
-->

# cleanup command fixtures

| Path | What |
|---|---|
| `run-folder/matcher-smoke-20261105-142233/run-context.json` | the results folder of an aborted matcher smoke run (no result.json): cleanup must find it by run id, bound its scans with the run's start, source and phase plan, and write its JSON next to it |

The test copies the folder to a temporary directory first, so the fixture itself is never written to.
