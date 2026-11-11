<!--
  What:    Feature specification (future work) for analysing the real event flow on UAT/Dev — events per
           second, peak, burst shape, event-type mix, events per patient, alarms per event — with read-only,
           aggregate-only queries, and turning the result into a workload profile and a baseline for the
           performance tests.
  How:     Read before planning the analysis; plan.md (same folder) has the queries, privacy rules and the
           workload-profile JSON schema; tasks.md lists the work (all open).
  Needs:   specs/000-performance-testing-setup/{spec,plan}.md (R9, §3.2 reserved settings EVENT_MODE and
           WORKLOAD_PROFILE, §14 Q1/Q8/Q20); docs/workload-model.md §9.
  Outputs: Requirements and acceptance criteria for the future analysis; no code yet.
-->

# Feature Specification: UAT/Dev traffic analysis and workload profile

**Feature Branch**: n/a (folder only; suggested branch feature/uat-dev-traffic-analysis)
**Created**: 2026-11-06
**Status**: Future work — specified, not started (every task in tasks.md is open)
**Input**: Team lead's review point 9 ("events per interval configurable by the tester; baseline later from
UAT/Dev event-flow analysis — include a spec for how to extract it"); blueprint open questions Q1 (real
peak), Q8 (which plan definitions run), Q20 (workload realism).

## Goal

Every load figure in the suite today is an assumption: the 50 events/s peak comes from a design document and
the event mix of the first test round was our own. This work measures the real event flow on UAT (and Dev)
— how many events arrive per second, when the peaks come, how bursty they are, which event types and how many
events per patient — **without any patient data leaving the environment**, and turns it into a versioned
workload-profile JSON. That profile then sets `PEAK_RATE`, the load and stress rates, `EXPECTED_HEADROOM`,
`STEP_SLA_PEAK_ALARM_RATE`, and later drives `WORKLOAD_PROFILE` and `EVENT_MODE=journey`; the first baseline
on Dev/UAT is taken with it.

## Scope

### In scope
- Read-only extraction queries over the CCE Postgres (`inbound_event_log`, `matcher_event_log`,
  `protocol_instance`, `step_sla_state_transition`), Kafka topic offsets, and Prometheus counters, bucketed in
  time (1 min, 10 min, 1 h, day) over an agreed window (at least 4 weeks when available).
- Metrics: events per interval (average, p50, p95, p99, maximum), the busiest 10-minute window per day, burst
  shape (seconds above 2 × the hourly mean, longest burst, upload backlogs from `event_time` vs `received_at`),
  event-type mix, events per patient per visit/day and their distribution, distinct facilities active per
  interval, ACTIVE plan definitions and the effective fan-out, DUE alarms per event, rejected/duplicate share.
- A privacy rule: only aggregates (counts, rates, percentiles, shares) leave the environment; no patient id,
  no payload, no facility name below an agreed minimum group size.
- The workload-profile JSON format (`workloadProfile` schema version 1.0.0) and where it is stored
  (`test-data/workload-profiles/<env>-<yyyymmdd>.json`).
- How the profile maps to existing settings and to the reserved `WORKLOAD_PROFILE` / `EVENT_MODE=journey`.
- How the first Dev/UAT baseline is taken with the profile.

### Out of scope
- Implementing `WORKLOAD_PROFILE` stages and `EVENT_MODE=journey` in `lib/phase-plan.js` / the k6 scenarios
  (a separate spec once the profile exists).
- Any write to UAT/Dev, any schema change, any index creation, any query on production.
- Analytics-path (ClickHouse) load; soak and spike test types (they will consume the profile later).
- Choosing the thresholds themselves (team decision Q1); this work provides the numbers.

## Inputs

- Read-only Postgres access to UAT/Dev (`ccedb`, a read-only role or a replica), the Kafka admin API (topic end
  offsets of `cce.events.inbound`), Prometheus (`cce_collector_events_received_total`,
  `cce_collector_events_accepted_total`, `cce_collector_events_duplicate_total` (duplicates leave no database
  row), `cce_events_processed_total`, `cce_sla_transitions_applied_total`).
- Environment files `config/environments/uat.json` / `dev.json` and `DB_PASSWORD` (never stored).
- `config/settings/defaults.json` (the settings the profile informs), `test-data/datasets/ebuzima-emr/dataset.json`
  (action ids and journeys the mix maps onto), `test-data/plan-definition-sets/` (fan-out).
- Team answers: analysis window, minimum group size for facility-level aggregates, who may run the queries.

## Outputs

- `test-data/workload-profiles/<env>-<yyyymmdd>.json` (schema in plan.md) with a `$comment` header — aggregates
  only.
- An analysis note (Markdown) with the charts/tables behind the profile and the decisions taken from it.
- Proposed settings changes (`PEAK_RATE`, `LOAD_RATE`, `STRESS_RATE`, `EXPECTED_HEADROOM`,
  `STEP_SLA_PEAK_ALARM_RATE`, clearing `toBeConfirmed` where answered) as a reviewed change to
  `config/settings/defaults.json` or the environment's `settings` block.
- A first Dev/UAT baseline per service (`baselines/<env>-<set>.json`, ≥ 3 runs each).

## Acceptance criteria

1. Every extraction query in plan.md is read-only (`SELECT` only, no temporary tables, no functions with side
   effects), runs with a `statement_timeout`, and is bounded by an indexed range: an indexed time column, a
   UUIDv7 primary-key range, or a join on a unique index from such a range; plan.md records the bound and
   the index used per query.
2. No query result that leaves the environment contains a patient id, a CloudEvent id, a payload or a
   facility group smaller than the agreed minimum; a review checklist in tasks.md confirms it per query.
3. The workload-profile JSON validates against the schema in plan.md and states its source environment,
   window, extraction date, query version and the excluded data (LOADTEST rows, rejected events).
4. Test data (`LOADTEST-%` subjects, the load-test source) is excluded from every measurement.
5. Each profile field is mapped to a setting or to a later feature (table in plan.md); none is left unused
   without a note.
6. The proposed `PEAK_RATE` is the measured p99 (or agreed percentile) of the busiest 10-minute windows, with
   the rule stated; `EXPECTED_HEADROOM` is a team decision recorded in docs/open-questions.md.
7. The first baseline uses the profile's settings, k6 on a separate host, ≥ 3 runs per test, and records the
   profile file name in the run `NOTE`.

## User Scenarios & Testing

### User Story 1 - Measure the real peak (Priority: P1)

**Why this priority**: every "× peak" in every report divides by `PEAK_RATE`; a wrong peak makes every
expectation wrong.

**Independent Test**: run the rate queries on UAT for the agreed window; the result is a table of rates per
interval with no identifiers.

**Acceptance Scenarios**:
1. **Given** read-only access to UAT, **When** the analyst runs the per-minute and per-10-minute rate queries
   for 4 weeks, **Then** they get average, p95, p99 and maximum events/s and the busiest 10-minute window per
   day, excluding LOADTEST data.
2. **Given** the result, **When** the team picks the percentile rule, **Then** `PEAK_RATE` and `LOAD_RATE`
   are proposed with that rule written next to them.

### User Story 2 - Describe the mix and the bursts (Priority: P2)

**Acceptance Scenarios**:
1. **Given** the event-type and per-patient queries, **When** they run, **Then** the profile holds the share of
   each event type (mapped to dataset action ids) and the distribution of events per patient per day.
2. **Given** `event_time` and `received_at`, **When** the burst query runs, **Then** the profile states how
   often clinics upload backlogs (events whose `received_at − event_time` exceeds 1 h) and the largest such
   upload, which later feeds a spike test.

### User Story 3 - Take the first real baseline (Priority: P2)

**Acceptance Scenarios**:
1. **Given** a profile and agreed settings, **When** each service's load and stress run 3 times on UAT with
   k6 on its own host, **Then** `baseline save uat-<set> …` succeeds and later runs compare against it.

### Edge Cases
- UAT traffic is too low to show a peak: use Dev, or production aggregates provided by ops (never queried by
  this suite), and record which.
- Clock skew between EMR and CCE makes `event_time` later than `received_at`: count separately, exclude from
  the upload-lag figures.
- Different EMRs (sources) behave differently: the profile carries a per-source breakdown when more than one
  source is active.
- The ACTIVE plan definitions on UAT overlap: record the effective fan-out; pick the matching
  plan-definition set (or define a new one).

## Requirements

### Functional Requirements

- **FR-001**: Extraction MUST be read-only and aggregate-only; queries MUST bound scans by `received_at` (or the
  UUIDv7 primary key) and run with a `statement_timeout`.
- **FR-002**: Every measurement MUST exclude LOADTEST data (`raw_payload->>'subject' LIKE 'LOADTEST-%'` or the
  load-test `source`) and report how many rows were excluded.
- **FR-003**: Rates MUST be computed per 1 minute and per 10 minutes, with average, p50, p95, p99 and maximum,
  per day and over the window; the busiest 10-minute window per day MUST be listed.
- **FR-004**: The event-type mix MUST be expressed as shares per CloudEvent `type` and, for Encounters, per
  encounter type, and mapped to dataset action ids.
- **FR-005**: Events per patient MUST be given as a distribution (p50, p90, max) per day and per visit, without
  exporting patient ids.
- **FR-006**: DUE alarms per event and the effective fan-out MUST be measured from `step_sla_state_transition`
  and `protocol_instance` (aggregate counts per interval).
- **FR-007**: The workload profile MUST follow the schema in plan.md, carry a `$comment` header and record its
  provenance.
- **FR-008**: Facility-level figures MUST be suppressed below the agreed minimum group size
  [NEEDS CLARIFICATION: minimum group size, e.g. 10 patients].
- **FR-009**: The analysis window MUST be agreed with the team [NEEDS CLARIFICATION: 4 weeks? which months?].
- **FR-010**: Settings proposals MUST name the rule used (e.g. "`PEAK_RATE` = ceil(p99 of daily busiest
  10-minute windows)") [NEEDS CLARIFICATION: percentile rule and growth margin].
- **FR-011**: A later implementation of `WORKLOAD_PROFILE` MUST be able to replay the day shape faster than real
  time [NEEDS CLARIFICATION: time-compression factor setting, e.g. a profile speed-up, to be added to
  `defaults.json` by the package that owns it].

## Success Criteria

### Measurable Outcomes

- **SC-001**: A workload profile for UAT (or Dev) exists, validates, and contains no identifier (manual review
  plus a grep for `LOADTEST`, UUID patterns and patient-id patterns on the file).
- **SC-002**: `PEAK_RATE`, `STEP_SLA_PEAK_ALARM_RATE` and `EXPECTED_HEADROOM` are no longer marked
  "to be confirmed" (or the reason they still are is recorded in docs/open-questions.md).
- **SC-003**: One baseline per service on Dev/UAT from ≥ 3 runs with the profile's settings.
- **SC-004**: Questions Q1, Q8 and Q20 in docs/open-questions.md are answered or narrowed with data.
