<!--
  What:    Task list (future work) of the UAT/Dev traffic analysis: agree, extract, profile, propose settings,
           baseline. Every task is open: nothing has been started.
  How:     Work top to bottom once access to UAT/Dev is agreed; tick a task ("- [x]") when done and checked.
           [P] = can run in parallel with other [P] tasks of the same phase.
  Needs:   spec.md and plan.md (same folder); read-only access to UAT/Dev; team answers (window, group size,
           percentile rule, headroom).
  Outputs: Progress record of the analysis.
-->

# Tasks: UAT/Dev traffic analysis and workload profile

**Input**: `spec.md`, `plan.md` (this folder) · **Status**: future work, all tasks open
**Format**: `- [ ] T### [P] [USn] Description with exact file path`

## Phase 1: Setup

- [ ] T001 Agree with the team: analysis window, minimum group size for facility rows, percentile rule for
      `PEAK_RATE`, growth margin for `EXPECTED_HEADROOM`; record the answers in `docs/open-questions.md`
- [ ] T002 Get a read-only database role (or replica) and Kafka/Prometheus read access on UAT (and Dev); fill
      `config/environments/uat.json` (no secrets)
- [ ] T003 Check every column and JSON path used by the plan.md queries against the `release-2.0.0` schema
      (`inbound_event_log`, `matcher_event_log`, `protocol_instance`, `step_instance`,
      `step_sla_state_transition`) and the indexes they rely on, on the target environment (`EXPLAIN` only);
      confirm the "Range bound per query" table in `specs/007-uat-dev-traffic-analysis/plan.md` (received_at
      for inbound, join on `(cloudevents_id, source)` for matcher, UUIDv7 id floor for protocol instances and
      alarms), agree `$slaHorizon`, and adjust the queries there

## Phase 2: Foundational

- [ ] T004 Write `test-data/workload-profiles/workload-profile.schema.json` and
      `test-data/workload-profiles/README.md` (with the owner of `test-data/`)
- [ ] T005 [P] Privacy review checklist per query (no ids, no payload, group size) in
      `specs/007-uat-dev-traffic-analysis/plan.md` "Privacy rules"

## Phase 3: User Story 1 - Measure the real peak (P1)

- [ ] T006 [US1] Run Q-A and Q-B (per-minute rates, busiest 10-minute window per day) on UAT for the window;
      exclude LOADTEST data; keep only the aggregate result files
- [ ] T007 [US1] Cross-check totals with Kafka end offsets of `cce.events.inbound` and the Prometheus counters
- [ ] T008 [US1] Propose `PEAK_RATE` and `LOAD_RATE` with the agreed rule

## Phase 4: User Story 2 - Mix and bursts (P2)

- [ ] T009 [P] [US2] Run Q-C (event-type mix) and map types to dataset action ids
- [ ] T010 [P] [US2] Run Q-D (events per patient per day, distribution only)
- [ ] T011 [P] [US2] Run Q-E (upload lag / backlog bursts)
- [ ] T012 [P] [US2] Run Q-F and Q-G (matcher outcomes, enrolments, DUE alarms per event, effective fan-out)
- [ ] T013 [US2] Write `test-data/workload-profiles/<env>-<yyyymmdd>.json`; validate against the schema; grep
      it for UUIDs, `LOADTEST` and patient-id patterns
- [ ] T014 [US2] Write the analysis note `docs/uat-dev-traffic-analysis-<yyyymmdd>.md`

## Phase 5: User Story 3 - First real baseline (P2)

- [ ] T015 [US3] Propose settings changes (`PEAK_RATE`, `LOAD_RATE`, `STRESS_RATE`, `EXPECTED_HEADROOM`,
      `STEP_SLA_PEAK_ALARM_RATE`, `toBeConfirmed` flags) to the owner of `config/settings/defaults.json`
- [ ] T016 [US3] Run load and stress per service 3 times on UAT/Dev with k6 on its own host
      (`scripts/run-test.sh uat <subject> <type> --set NOTE="profile <name>"`)
- [ ] T017 [US3] `node tools/cli.mjs baseline save <env>-<set> <dirs…>` per service

## Phase 6: Polish

- [ ] T018 Answer or narrow Q1, Q8, Q20 in `docs/open-questions.md`; update `docs/workload-model.md` §9
- [ ] T019 Open the follow-up spec for `WORKLOAD_PROFILE` stages and `EVENT_MODE=journey`

## Phase 7: Verification

- [ ] T020 Every query is `SELECT`-only with a `statement_timeout` and the indexed bound recorded for it in
      plan.md "Range bound per query" (review)
- [ ] T021 The profile validates and contains no identifier (SC-001); spec.md acceptance criteria 1–7 checked
