<!--
  What:    Implementation plan (future work) of the UAT/Dev traffic analysis: approach, files, the read-only
           aggregate queries, the privacy rules, the workload-profile JSON schema and how each profile field
           maps to a setting (PEAK_RATE, EXPECTED_HEADROOM, STEP_SLA_PEAK_ALARM_RATE, …) or to the reserved
           WORKLOAD_PROFILE / EVENT_MODE=journey.
  How:     Read after spec.md (same folder); tasks.md lists the steps (all open).
  Needs:   specs/000-performance-testing-setup/plan.md §2.3 (uuidV7Floor), §3.2 (settings), §4.1 (phase plan),
           §6.8 (index-friendly SQL); CCE schema on release-2.0.0 (inbound_event_log, matcher_event_log,
           protocol_instance, step_instance, step_sla_state_transition) and its indexes.
  Outputs: The plan the future work is built and checked against. Nothing is built yet.
-->

# Implementation Plan: UAT/Dev traffic analysis and workload profile

**Branch**: n/a (folder only; suggested branch feature/uat-dev-traffic-analysis) · **Date**: 2026-11-06 ·
**Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md) · **Status**: future work

## Approach

1. **Agree first** (team): analysis window, minimum group size, percentile rule for the peak, growth margin,
   who runs the queries and with which read-only role.
2. **Extract read-only aggregates** with the queries below, run by someone allowed to read UAT, with
   `SET statement_timeout = '5min'` and `SET default_transaction_read_only = on` in the session. The queries
   return only counts, rates and percentiles. They can run in `psql` or, later, through a read-only
   sub-command of the suite (e.g. `node tools/cli.mjs traffic-profile <env>`; name to be decided in its own spec)
   reusing `tools/core/clients/postgres.mjs`.
3. **Cross-check** the Postgres counts against Kafka end offsets of `cce.events.inbound` and the Prometheus
   counters over the same window (they must agree within the rejected/duplicate share).
4. **Write the workload profile** (schema below) from the aggregates; review it for identifiers; store it in
   `test-data/workload-profiles/`.
5. **Propose settings** from the profile (mapping table below), get them reviewed, and record decisions in
   `docs/open-questions.md`.
6. **Baseline**: run load and stress per service three times on UAT/Dev with the new settings (k6 on its own
   host), save `baselines/<env>-<set>.json`.
7. **Later spec**: implement `WORKLOAD_PROFILE` (profile day shape → `ramping-arrival-rate` stages, phase kind
   `profile`) and `EVENT_MODE=journey` (mix → dataset journeys).

### Extraction queries (read-only, aggregate-only)

`$from`/`$to` bound the window; `$source` filters an EMR when several are active. Every query excludes test
data. Times in UTC; convert to local time in the note only.

```sql
-- Q-A  events per minute (base for 1-min and 10-min rates, peaks, percentiles)
SELECT date_trunc('minute', received_at) AS minute, count(*) AS events,
       count(*) FILTER (WHERE status = 'ACCEPTED') AS accepted,
       count(*) FILTER (WHERE status = 'REJECTED') AS rejected
       -- no DUPLICATE column: the collector answers a duplicate with 200 "duplicate" and stores no row
       -- (InboundStatus.DUPLICATE exists but is never written); the duplicate share comes from the
       -- Prometheus counter cce_collector_events_duplicate_total instead (cross-check below)
FROM inbound_event_log
WHERE received_at >= $from AND received_at < $to
  AND coalesce(raw_payload->>'subject', '') NOT LIKE 'LOADTEST-%'
GROUP BY 1 ORDER BY 1;

-- Q-B  busiest 10-minute window per day (from Q-A in the analysis, or directly)
SELECT day, max(events_10m) / 600.0 AS peak_events_per_second
FROM (SELECT date_trunc('day', received_at) AS day,
             date_bin('10 minutes', received_at, $from) AS bucket, count(*) AS events_10m
      FROM inbound_event_log
      WHERE received_at >= $from AND received_at < $to
        AND coalesce(raw_payload->>'subject', '') NOT LIKE 'LOADTEST-%'
      GROUP BY 1, 2) b
GROUP BY day ORDER BY day;

-- Q-C  event-type mix (CloudEvent type; Encounter type display)
SELECT raw_payload->>'type' AS event_type,
       raw_payload->'data'->'type'->0->'coding'->0->>'display' AS encounter_type,
       count(*) AS events
FROM inbound_event_log
WHERE received_at >= $from AND received_at < $to
  AND coalesce(raw_payload->>'subject', '') NOT LIKE 'LOADTEST-%'
GROUP BY 1, 2 ORDER BY 3 DESC;

-- Q-D  events per patient per day: distribution only (the subject never leaves the database)
SELECT percentile_disc(ARRAY[0.5, 0.9, 0.99]) WITHIN GROUP (ORDER BY n) AS p50_p90_p99, max(n) AS max,
       count(*) AS patient_days
FROM (SELECT date_trunc('day', received_at) AS day, raw_payload->>'subject' AS s, count(*) AS n
      FROM inbound_event_log
      WHERE received_at >= $from AND received_at < $to
        AND coalesce(raw_payload->>'subject', '') NOT LIKE 'LOADTEST-%'
      GROUP BY 1, 2) per_patient_day;

-- Q-E  upload lag and backlogs (burst shape): received_at − event_time
SELECT width_bucket(extract(epoch FROM received_at - event_time), ARRAY[0, 60, 600, 3600, 86400, 604800]) AS lag_bucket,
       count(*) AS events
FROM inbound_event_log
WHERE received_at >= $from AND received_at < $to AND event_time IS NOT NULL
  AND coalesce(raw_payload->>'subject', '') NOT LIKE 'LOADTEST-%'
GROUP BY 1 ORDER BY 1;

-- Q-F  matcher outcome per hour (fan-out context). matcher_event_log has no index on received_at and its
--      ids are random (gen_random_uuid / GenerationType.AUTO, not UUIDv7), so it is reached from the
--      indexed inbound_event_log time range through its UNIQUE (cloudevents_id, source) index.
SELECT date_trunc('hour', m.received_at) AS hour, m.processing_status, count(*) AS events
FROM inbound_event_log i
JOIN matcher_event_log m ON m.cloudevents_id = i.cloudevents_id AND m.source = i.source
WHERE i.received_at >= $from AND i.received_at < $to
  AND coalesce(i.raw_payload->>'subject', '') NOT LIKE 'LOADTEST-%'
GROUP BY 1, 2 ORDER BY 1, 2;

-- Floors for the UUIDv7 primary-key ranges below (same value as tools/core/run-id.mjs uuidV7Floor()):
--   $fromFloor = uuidV7Floor($from), $toFloor = uuidV7Floor($to),
--   $slaFloor  = uuidV7Floor($from − $slaHorizon)   ($slaHorizon = longest DUE/MISSED offset of the active
--                                                    plan definitions, agreed in T003)
-- In psql: SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-7000-8000-000000000000')::uuid
--          FROM (SELECT lpad(to_hex((extract(epoch FROM $from) * 1000)::bigint), 12, '0') AS h) x;

-- Q-G1 enrolments per hour. protocol_instance.created_at has no index; its ids are UUIDv7
--      (UuidV7Generator), so the PK range bounds the scan and created_at only refines it.
SELECT date_trunc('hour', pi.created_at) AS hour, count(*) AS enrolments
FROM protocol_instance pi
WHERE pi.id >= $fromFloor AND pi.id < $toFloor
  AND pi.created_at >= $from AND pi.created_at < $to
  AND pi.patient_id NOT LIKE 'LOADTEST-%'
GROUP BY 1 ORDER BY 1;

-- Q-G2 alarms per hour by the hour they ring. idx_sslt_due_order (process_by) is partial
--      (WHERE is_processed = FALSE) and past alarms are processed, so it cannot serve a past window. Rows
--      that ring inside the window were created at most $slaHorizon before it: their UUIDv7 ids bound
--      the scan, then process_by filters. step_instance and protocol_instance are reached by primary key.
SELECT date_trunc('hour', t.process_by) AS hour, t.transition_type, count(*) AS alarms
FROM step_sla_state_transition t
JOIN step_instance si ON si.id = t.step_instance_id
JOIN protocol_instance pi ON pi.id = si.protocol_instance_id
WHERE t.id >= $slaFloor AND t.id < $toFloor
  AND t.process_by >= $from AND t.process_by < $to
  AND pi.patient_id NOT LIKE 'LOADTEST-%'
GROUP BY 1, 2 ORDER BY 1, 2;
```

**Range bound per query** (checked against the `release-2.0.0` migrations on 2026-11-06; task T003 re-checks
them on the target environment before the first run, with `EXPLAIN` only):

| Query | Table(s) | Bound used | Index behind it |
|---|---|---|---|
| Q-A … Q-E | `inbound_event_log` | `received_at` range | `idx_inbound_event_log_received` (collector V1) |
| Q-F | `matcher_event_log` | via `inbound_event_log.received_at`, joined on `(cloudevents_id, source)` | `idx_inbound_event_log_received` + `matcher_event_log_cloudevents_id_source_key` (matcher V1). Not `received_at` (no index) and not a UUIDv7 floor (ids are random v4) |
| Q-G1 | `protocol_instance` | UUIDv7 `id` range (`$fromFloor`…`$toFloor`), then `created_at` | `protocol_instance_pkey`; `created_at` has no index |
| Q-G2 | `step_sla_state_transition` (+ `step_instance`, `protocol_instance` by PK) | UUIDv7 `id` range (`$slaFloor`…`$toFloor`), then `process_by` | `step_sla_state_transition_pkey`; `idx_sslt_due_order` / `idx_sslt_due` are partial on `is_processed = FALSE` and cannot serve a past window |

Caveats for T003: rows back-filled by matcher migrations V2/V3/V7 (`gen_random_uuid()`) are not time-ordered;
the `created_at` / `process_by` filters keep them out of the counts, and their number is checked once. The
`$slaHorizon` must cover the longest DUE/MISSED offset of the active plan definitions, otherwise alarms of
older steps are missed (T003 compares the Q-G2 total with an unbounded count on a one-day window).
The Encounter type path in Q-C is also checked against real payloads in T003.
Kafka: end offsets of `cce.events.inbound` at `$from` and `$to` (kafkajs `fetchTopicOffsetsByTimestamp`).
Prometheus: `increase(cce_collector_events_received_total[10m])` and `increase(cce_events_processed_total[10m])`
over the window, as a cross-check; `increase(cce_collector_events_duplicate_total[…])` over the window gives
the duplicate share (duplicates leave no row in `inbound_event_log`).

### Privacy rules

- Only aggregates leave the environment: counts, rates, percentiles, shares, histograms.
- Never exported: patient ids (`subject`, `patient_id`), CloudEvent ids, correlation ids, payloads, free text.
- Facility-level rows only when the group has at least the agreed minimum of distinct patients; otherwise merged
  into "other".
- Queries run inside the environment (or through its read-only replica); the result files are reviewed before
  they are copied out; the profile is checked with a grep for UUIDs, `LOADTEST` and patient-id patterns.

## Files

| File | Purpose |
|---|---|
| `specs/007-uat-dev-traffic-analysis/{spec,plan,tasks}.md` | This spec (written now) |
| `test-data/workload-profiles/README.md` | What a profile is, schema summary, privacy rule (future, owner of `test-data/`) |
| `test-data/workload-profiles/<env>-<yyyymmdd>.json` | One profile per analysis (future) |
| `test-data/workload-profiles/workload-profile.schema.json` | JSON Schema of the profile (future) |
| `docs/uat-dev-traffic-analysis-<yyyymmdd>.md` | Analysis note: tables behind the profile, decisions (future) |
| `config/settings/defaults.json` or `config/environments/<env>.json` `settings` | Settings proposals after review (future, owner A2) |
| `baselines/<env>-<set>.json` | First real baseline (future, written by the tool) |

## Interfaces

**Workload profile JSON** (`kind: cce-workload-profile`, `schemaVersion: 1.0.0`):

```json
{
  "$comment": "What: … How: … Needs: … Outputs: …",
  "schemaVersion": "1.0.0",
  "kind": "cce-workload-profile",
  "name": "uat-20261201",
  "source": { "environment": "uat", "window": { "from": "ISO", "to": "ISO", "days": 28 },
              "extractedAt": "ISO", "queryVersion": "007-1", "excluded": { "loadTestEvents": 0, "rejected": 0 },
              "eventSources": ["…"] },
  "rates": {
    "unit": "events/s",
    "average": 6.9,
    "perMinute": { "p50": 4.2, "p95": 21.0, "p99": 38.5, "max": 61.0 },
    "busiest10MinutePerDay": { "p50": 30.1, "p95": 44.0, "max": 52.3 },
    "dayShape": { "intervalSeconds": 3600, "rates": [0.4, 0.3, "… 24 values: average events/s per hour of day"] }
  },
  "bursts": {
    "uploadLag": { "buckets": ["<1m", "1–10m", "10m–1h", "1h–1d", "1d–7d", ">7d"], "shares": [0.9, 0.05, 0.03, 0.015, 0.004, 0.001] },
    "largestBacklogUpload": { "events": 0, "withinSeconds": 0 },
    "secondsAbove2xHourlyMean": { "share": 0.0, "longestSeconds": 0 }
  },
  "mix": {
    "byType": [ { "type": "Encounter", "encounterType": "VISIT_ENCOUNTER", "share": 0.21, "actionId": "visit-encounter" } ],
    "eventsPerPatientPerDay": { "p50": 6, "p90": 9, "p99": 12, "max": 30 },
    "journeys": [ { "actions": ["visit-encounter", "vitals-recording", "…"], "share": 0.6 } ]
  },
  "downstream": {
    "effectiveFanOut": 1.0,
    "activePlanDefinitions": ["url|version"],
    "dueAlarmsPerEvent": 0.0,
    "alarmsPerSecond": { "average": 0.0, "busiest10MinutePerDay": { "p95": 0.0, "max": 0.0 } }
  },
  "proposals": {
    "PEAK_RATE": { "value": 45, "rule": "ceil(p95 of busiest 10-minute window per day)" },
    "EXPECTED_HEADROOM": { "value": 4, "rule": "team decision" },
    "STEP_SLA_PEAK_ALARM_RATE": { "value": 0, "rule": "ceil(p95 alarms/s of busiest 10-minute window per day)" }
  }
}
```

**Mapping to the suite** (000 plan §3.2):

| Profile field | Feeds | When |
|---|---|---|
| `rates.busiest10MinutePerDay` + rule | `PEAK_RATE`, `LOAD_RATE` (= peak) | Now (settings change) |
| `proposals.EXPECTED_HEADROOM` | `EXPECTED_HEADROOM`, hence `STRESS_RATE` = headroom × peak | Now (team decision) |
| `downstream.dueAlarmsPerEvent`, `alarmsPerSecond` | `STEP_SLA_PEAK_ALARM_RATE` (instead of `auto`) | Now |
| `downstream.activePlanDefinitions`, `effectiveFanOut` | Choice of `PLAN_DEFINITION_SET` (or a new set) | Now |
| `rates.dayShape` | `WORKLOAD_PROFILE` → `ramping-arrival-rate` stages (a phase kind `profile`) | Later spec |
| `mix.byType`, `mix.journeys`, `eventsPerPatientPerDay` | `EVENT_MODE=journey` (dataset journeys weighted by share) | Later spec |
| `bursts.largestBacklogUpload`, `uploadLag` | A `spike` test type (backfill burst) | Later spec |
| `rates.perMinute` | Soak test rate and duration | Later spec |

## Technical Context

| Item | Value |
|---|---|
| Data sources | UAT/Dev Postgres `ccedb` (read-only role or replica), Kafka admin (offsets), Prometheus (counters) |
| Language | SQL in `psql` first; later a read-only Node sub-command (`pg`, `kafkajs`) |
| Privacy | Aggregates only; minimum group size; review before export |
| Constraints | No writes, no temp tables, no indexes, never production; `statement_timeout`; bounded by an indexed `received_at` range or a UUIDv7 primary-key range (table above) |
| Dependencies | Team answers (window, group size, percentile rule, headroom); access to UAT |

## Deviations / requests

1. **No settings added now**: the time-compression factor for replaying a day shape and any profile-specific
   setting are `[NEEDS CLARIFICATION]` in spec.md; `defaults.json` belongs to package A2 and is not changed by
   this spec.
2. **New folder `test-data/workload-profiles/`** (owner of `test-data/`, package A1) is proposed, not created.
3. **Possible new CLI sub-command** (`traffic-profile`, name to be decided) needs its own spec under the tooling
   owner.
