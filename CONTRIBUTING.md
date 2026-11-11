<!--
  What:    How to contribute to the CCE performance tests: the spec-first workflow (spec → plan → tasks → code)
           with the mandatory headings and DEFERRED (owner) tasks, naming, Conventional Commits and generic
           branch names, how to add a test type, a service, an adaptor or the end-to-end module (including the
           two shims and the module-relative testFile), and the checks to run before asking for review.
  How:     Read before your first change. The full rules are in docs/conventions.md.
  Needs:   Node.js 22 and npm install done; Docker for k6 inspect.
  Outputs: Documentation only.
-->

# Contributing to the CCE Performance Tests

Thank you for improving the suite. It follows the same habits as CCE development: **spec first**, small
self-explanatory files, a header on every file, and checks that run without touching any live system.

## 1. The workflow: spec → plan → tasks → code

1. **Write the spec** in a new folder: `specs/NNN-kebab-name/` for shared parts, or
   `<service-folder>/specs/NNN-kebab-name/` for one service (index and next free numbers:
   [specs/README.md](specs/README.md)).
2. **`spec.md`**, in this order:
   - header lines `**Feature Branch**: n/a (folder only; suggested branch feature/<kebab-name>)`, `**Created**`,
     `**Status**`, `**Input**`;
   - `## Goal` (what and why, 2–5 lines), `## Scope` with `### In scope` and `### Out of scope`, `## Inputs`,
     `## Outputs`, `## Acceptance criteria` (numbered, each checkable without a live stack);
   - then the Spec Kit sections: `## User Scenarios & Testing` (user stories with priority and
     Given/When/Then, edge cases), `## Requirements` (`- **FR-001**: … MUST …`, unknowns as
     `[NEEDS CLARIFICATION: …]`), `## Success Criteria` (`- **SC-001**: …`).
3. **`plan.md`**: `## Approach`, `## Files` (every file created or changed, one line each), `## Interfaces`
   (exported functions and JSON shapes), `## Technical Context`, `## Deviations / requests` (anything that
   differs from the blueprint [specs/000-performance-testing-setup/plan.md](specs/000-performance-testing-setup/plan.md)
   or needs a change in a folder you do not own; "none" if none).
4. **`tasks.md`**: phases Setup → Foundational → user stories → Polish → Verification, one line per task:
   `- [ ] T001 [P] Description with exact file path` (`[P]` = can run in parallel).
5. **Code task by task**; tick `- [x]` when a task is done and its check passed.
6. A task that needs a live CCE stack and cannot be verified from your desk is written
   `- [ ] T0xx DEFERRED (owner): …`. It stays unticked, does not block "done", and is listed in
   [docs/open-questions.md](docs/open-questions.md) §3 with what it confirms.

Every file starts with a header comment answering **What / How / Needs / Outputs** for someone new to
performance testing; every function gets a "why" comment, every non-obvious line a short one
([docs/conventions.md](docs/conventions.md) §4).

## 2. Naming

| What | Rule | Example |
|---|---|---|
| Folders | kebab-case, full words | `plan-definition-sets/` |
| Service folders | exactly the service repository name | `cce-matcher-service/` |
| k6 tests | `<subject>-<test-type>.test.js` | `collector-stress.test.js` |
| Node modules / unit tests | kebab-case `.mjs` / `<module>.spec.mjs` in `unit-tests/` | `tools/core/settings.mjs` |
| Shell scripts | verb first, thin wrappers around the CLI | `cleanup-test-data.sh` |
| Docs | root uppercase (`README.md`), others kebab-case | `docs/workload-model.md` |
| Variables / functions / constants / settings | `camelCase` / verb-first `camelCase` / `UPPER_SNAKE_CASE` / `UPPER_SNAKE_CASE` | `waitForMatcherIdle`, `LOAD_RATE` |
| Test types | `smoke`, `load`, `stress`, `breakpoint` (later `soak`, `spike`) | |

Generic names only: an EMR's name (e.g. eBUZIMA) appears only as the name of its dataset (`ebuzima-emr`)
and in history. The check commands are in [docs/conventions.md](docs/conventions.md) §8.

## 3. Commits and branches

- **Branches** are generic and typed: `feature/<kebab-name>`, `fix/<kebab-name>`, `docs/<kebab-name>`,
  `chore/<kebab-name>` — e.g. `chore/restructure-performance-tests`, `feature/matcher-soak-test`,
  `docs/onboarding-runbook`. Never a spec number (`003-…`) and never an EMR name.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, e.g.
  `feat(collector): add breakpoint refine`, `fix(cleanup): stop when safe WAL is low`,
  `docs(runbook): add cleanup steps`, `test(matcher): cover the stall detector`, `chore(deps): bump pg`.
  Scopes are subjects (`collector`, `matcher`, `step-sla`) or parts (`tools`, `lib`, `monitoring`, `docs`).
- **Never commit** `results/`, `config/environments/*.local.json`, `monitoring/.env` or any password or token.

## 4. Adding things

The step lists live in [docs/conventions.md](docs/conventions.md) §7; the essentials:

### 4.1 A test type
New `<TYPE>_RATE` / `<TYPE>_DURATION` / `<TYPE>_EVENTS` settings in `config/settings/defaults.json`, the
derivation in `tools/core/settings.mjs`, phases in `lib/phase-plan.js`, rules in `lib/thresholds.js`, then one
`tests/<subject>-<type>.test.js` (or `.test.mjs` for seeded tests) per service and the type in each module's
`testTypes`.

### 4.2 A service
A folder named after its repository with `README.md`, `service-module.mjs`, `shared.mjs`, `docs/test-plan.md`,
`docs/test-strategy.md`, `specs/001-<subject>-performance-tests/`, `tests/`, `data-checks/`, `unit-tests/`
(and `watchers/` or `seeding/` when needed). The runner discovers it through `service-module.mjs`; the module
contract is in [tools/README.md](tools/README.md).

- **The two shims.** Only `shared.mjs` imports `../tools/core/…` and `../lib/…` (Node side); only
  `tests/shared-lib.js` imports `../../lib/…` (k6 side). Every other file in the folder imports those two, and
  never another service folder. Copy an existing `unit-tests/import-boundary.spec.mjs` to enforce it. When the
  folder later moves into its repository as `performance-tests/`, only the two shims change.
- **Module-relative `testFile`.** Return `new URL('./tests/<subject>-<type>.test.js', import.meta.url)` so the
  folder works wherever it lives; the runner turns it into the container path.

### 4.3 An adaptor (OpenHIM, Tiberbu — later)
An independent folder named after the adaptor's repository, laid out like a service: `kind: 'k6'`,
`breakpointKind: 'staircase'`, `requires.services: ['<adaptor key>']`, its own `adaptors.<key>` block in the
environment files and, if its EMR payload differs, its own dataset. Add its key metric to preflight's
`KEY_METRICS` (`tools/preflight/checks/service-metrics.mjs`) until a data-driven hook exists. Nothing in the
service folders or shared code may depend on it. Reference: the first version's OpenHIM test
(`adaptor/openhim.js` on the `ebuzima-flow-tests` branch).

### 4.4 The end-to-end module (later)
Folder `end-to-end-flow/` with a module `subject: 'end-to-end'`, dataset journeys (`EVENT_MODE=journey`, reserved
today), data checks ported from the archived flow, rule event → enrolment p95 < 10 s. The series report then
uses it for the "whole flow" section.

## 5. Checks before review

Everything here runs offline; **never** run tests, preflight, cleanup or `docker compose up` against a shared
environment as part of a review.

```bash
npm test                     # every unit test (fakes for Docker, Postgres, Kafka, HTTP)
npm run lint                 # ESLint + Prettier check + header comments + ShellCheck (see the note below)
npm run format               # Prettier for JS/MJS/JSON/YAML (Markdown is not reformatted)
npm run check:k6             # k6 inspect of every k6 test, in the image, --network none
node tools/cli.mjs lint-headers --paths <your files or folders>
scripts/run-test.sh local <subject> <test-type> --dry-run      # settings + phase plan + docker command
scripts/cleanup-test-data.sh local --run-id 20261105-142233 --print-sql   # cleanup SQL, no connection
node tools/cli.mjs plan-definitions validate --set <name>      # plan-definition set, offline
```

**ShellCheck is a one-time setup step.** `npm run lint` uses `shellcheck` from your PATH or the image
`koalaman/shellcheck:v0.10.0` if it is already pulled; it never downloads it. Without either, the last line
reads `run-shellcheck: SKIPPED — …` and the exit code is still 0, so **the lint is not complete**. Before your
first review run `docker pull koalaman/shellcheck:v0.10.0` once (or install `shellcheck`), and check that
the last line says `run-shellcheck: N file(s) clean`.

Then tick your tasks, fill `## Deviations / requests`, update the row of your spec in
[specs/README.md](specs/README.md), and — if you changed a command, a setting or a file name — the docs that
quote it ([docs/runbook.md](docs/runbook.md), [docs/workload-model.md](docs/workload-model.md)).
