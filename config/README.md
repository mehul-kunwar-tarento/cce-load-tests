<!--
  What:    Guide to config/: environment files (where the CCE services are) and the settings definitions
           (every test setting with its default), how a setting's value is chosen, how to add an environment.
  How:     Read before running against a new environment or changing a default.
  Needs:   Nothing.
  Outputs: Documentation only. The files are read by tools/core/environment.mjs and tools/core/settings.mjs.
-->

# Configuration

| File | What it holds |
|---|---|
| `environments/local.json` | The laptop: `openphc-repos/local-stack` (collector 8093, matcher 8097, Step SLA 8099, protocol 8096, Postgres 15433, Kafka 29092, laptop monitoring Prometheus 9095 / Grafana 3030) |
| `environments/dev.example.json`, `uat.example.json` | Templates for the shared environments: copy to `dev.json` / `uat.json` and replace every `REPLACE-ME` |
| `environments/environment.schema.json` | JSON Schema of an environment file (editor help; the tool checks the same rules) |
| `settings/defaults.json` | **The single source of every test setting**: default, type, unit, which tests it applies to, description, "to be confirmed" flag |
| `settings/settings.schema.json` | JSON Schema of `defaults.json` entries |

JSON cannot hold comments, so every file here starts with a `"$comment"` key (What / How / Needs / Outputs).
The tools drop it when they load the file: it is never a setting and never sent to a service.

## Environments

An environment file says where everything is: the services' direct URLs (never the gateway, which
rate-limits `/v1/events`), Kafka brokers and topics, the Postgres host and database (the **password is never
in a file**: `database.passwordEnvVar` names the environment variable, normally `DB_PASSWORD`), the k6 image and
Docker network, monitoring URLs and the safety switches.

| Field | Meaning |
|---|---|
| `kind` | `local`, `dev` or `uat`. Anything named or marked `prod` is refused by every command (exit 2). |
| `services.<key>` | `collector`, `matcher`, `stepSla` (subject `step-sla`), `protocol`: `baseUrl`, `healthPath`, `metricsPath`; Step SLA also `pollIntervalSeconds`: must equal the deployed `CCE_SLA_POLL_INTERVAL_MS` / 1000 (5 for the service's default profile, as in `local-stack`; 15 for the `prod` profile that `deploy-scripts` use, hence 15 in the Dev/UAT examples). Used by preflight `step-sla-scheduler` (waits value + 2 s for a scheduler cycle) and `STEP_SLA_MAX_WAIT=auto` (2 × value) |
| `kafka` | brokers, inbound topic, dead-letter topic, the matcher's consumer group, expected partitions |
| `database` | host, port, name, user, `passwordEnvVar`, tables preflight expects, replication slots to watch |
| `k6` | image and Docker network (`host` on a laptop) |
| `monitoring` | `enabled`, Prometheus URL and remote-write URL (k6 metrics go there), Grafana URL and user for annotations |
| `safety` | `allowCleanup`, `allowTempIndex` (cleanup's temporary index), `allowPlanDefinitionChanges` (load/retire/delete plan definitions), `minFreeDiskGb` |
| `settings` | Environment-specific setting values (same names as `defaults.json`) |

Secrets come only from environment variables: `DB_PASSWORD`, `GRAFANA_API_TOKEN` (or `GRAFANA_ADMIN_PASSWORD`
with `monitoring.grafanaUser` for the laptop Grafana). They are never printed or saved in results.

**Personal overrides**: `config/environments/<env>.local.json` (git-ignored) is deep-merged over `<env>.json`,
e.g. to point `local` at different ports without changing the shared file.

### Adding an environment

1. Copy `dev.example.json` to `<name>.json` (lowercase, e.g. `dev2.json`); set `name` and `kind` (`dev` or `uat`).
2. Replace every `REPLACE-ME` with real hosts; keep `allowTempIndex` and `allowPlanDefinitionChanges` false
   until the team agrees (open questions Q3, Q5, Q15).
3. Check it: `node tools/cli.mjs settings <name>` (no connection), then `scripts/check-services.sh <name>`.
4. Commit it only if it holds no secrets.

## Settings

Every setting is defined once in `settings/defaults.json` and resolved by `tools/core/settings.mjs`. For one run,
the value is taken from (lowest to highest precedence):

1. `defaults.json` `default`
2. the environment file's `settings` block (and `safety.minFreeDiskGb` for `MIN_FREE_DISK_GB`)
3. an environment variable with the same name (`LOAD_RATE=100 scripts/run-test.sh …`)
4. `--set NAME=value` on the command line (an unknown name is an error)

Values get fixed types: durations become **seconds** (`10m` → 600, `500ms` → 0.2; garbage is refused instead of
becoming 0), `LEVELS` becomes a number list, booleans `true/false/1/0`, `""` means unset (`null`).

**Derived values** (source `derived` in the printout):

- `<TYPE>_EVENTS` (SMOKE, LOAD, STRESS, MATCHER_FLOOD): when set, `<TYPE>_DURATION = ceil(events / rate)`; the
  events count wins over an explicit duration (with a warning). Events count the **measured phase only**
  (warm-up excluded). Example: `--set LOAD_EVENTS=1000` at 50/s → `LOAD_DURATION` 20 s.
- `STEP_SLA_MAX_WAIT=auto` → 2 × `services.stepSla.pollIntervalSeconds`.
- `STEP_SLA_PEAK_ALARM_RATE=auto` → `ceil(PEAK_RATE × DUE alarms per event)` of the plan-definition set.
- `RUN_ID` empty → `yyyymmdd-hhmmss` of the run start. A custom id is 1–20 letters/digits (no hyphen).
- `DATASET` empty → the first `compatibleDatasets` entry of the plan-definition set (`emr-service` →
  `ebuzima-emr`, `kenya-sha-emr-service` → `tiberbu-emr`); shown as `derived`.
- `EVENT_ACTION_ID`, `EVENT_SOURCE`, `FACILITY_ID` empty → the dataset's defaults.

Reserved for later work and refused today: `EVENT_MODE=journey`, a non-empty `WORKLOAD_PROFILE`.

See every value in force without running anything:

```bash
node tools/cli.mjs settings local collector load --set LOAD_EVENTS=1000   # relevant settings + phase plan
node tools/cli.mjs settings local                                           # every value, no subject
```

The settings printed at the start of a run are saved with its result (`result.json` `conditions.settings`,
`{ NAME: { value, source } }`) and handed to k6 in `run-context.json`; k6 never reads settings from env vars.

### Adding a setting

Add an entry to `defaults.json` (`default`, `type`, `unit`, `appliesTo`, `description`, `toBeConfirmed`, and
`enum` / `allowAuto` when needed), then read it from the resolved `settings` in code. Never hard-code a value
that a tester might want to change.
