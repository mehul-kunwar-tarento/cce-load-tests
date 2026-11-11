<!--
  What:    Fixtures of tools/commands/unit-tests/lint-headers.spec.mjs: a tiny repository-like folder.
  How:     Copied into a temporary folder by the spec; lint-headers runs over the copy.
  Needs:   Nothing.
  Outputs: Nothing.
-->

# lint-headers fixtures

`sample-repo/` has five in-scope files: `tools/good.mjs`, `scripts/run.sh` and `config/good.json` carry the
What/How/Needs/Outputs header; `tools/no-header.mjs` and `config/no-comment.json` deliberately do not.
