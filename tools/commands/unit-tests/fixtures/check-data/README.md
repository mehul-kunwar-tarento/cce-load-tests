<!--
  What:    Fixtures of tools/commands/unit-tests/check-data.spec.mjs (verbatim test data, no headers inside).
  How:     Read by the spec only (copied into a temporary folder before the command rewrites files).
  Needs:   Nothing.
  Outputs: Nothing.
-->

# check-data fixtures

`stub-load-20261105-142234/` holds `run-context.json` and `result.json` of a stub load run (2 s at 50/s, 100
events, passed), produced once by running the `run` command with the fakes of run-test.spec.mjs (a throwaway
script outside the repository). The stub's only data check is an informational one that always passes.
