<!--
  What:    Fixtures of the plan-definitions command tests.
  How:     Read by tools/commands/unit-tests/plan-definitions.spec.mjs (npm test) through --configDir / testDataRoot.
  Needs:   Nothing.
  Outputs: Nothing; documentation of the fixture files.
-->

# plan-definitions command fixtures

| Path | What |
|---|---|
| `environments/local.json` | copy of `config/environments/local.json` (plan-definition writes allowed) |
| `environments/locked.json` | same, `safety.allowPlanDefinitionChanges: false`: load, retire and delete must all be refused |
| `environments/shared-dev.json` | same, `kind: dev`: writes refused without `PLAN_DEFINITION_VERSION_SUFFIX`, allowed with one |
| `test-data/plan-definition-sets/broken/set.json` + `test-data/plan-definitions/broken.json` | a set whose plan definition has tolerance-days on a `could` step: `validate` must exit 1 |

Only `name`, `kind` and `safety` differ from the real environment file. Nothing here is used to connect: the
tests inject a fake protocol API.
