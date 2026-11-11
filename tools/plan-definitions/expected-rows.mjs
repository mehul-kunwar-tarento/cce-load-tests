/**
 * expected-rows.mjs — how many database rows one event should create, for a plan-definition set
 *
 * What:    For the first event of a new patient (an enrolment event such as visit-encounter), counts the rows
 *          the matcher writes in each table, summed over every plan definition of the set that has the
 *          triggered action. Data checks compare these with what the database holds; Step SLA uses
 *          dueAlarms (DUE_DATE_REACHED rows per event) for STEP_SLA_PEAK_ALARM_RATE=auto.
 *          Rule per plan definition (verify at the first smoke run, plan §7.3):
 *            1 protocol_instance + 1 protocol_instance_history (the enrolment),
 *            1 step_instance for the triggered action + 2 step_instance_history rows (created, completed),
 *            per MANDATORY direct successor: +1 step_instance, +1 history row, +1 DUE_DATE_REACHED alarm and
 *            +1 MISSED_DATE_REACHED row when it has tolerance-days (optional successors get no schedule).
 * How:     import { computeExpectedRows } from './expected-rows.mjs'; computeExpectedRows(set, 'visit-encounter')
 * Needs:   A loaded set (sets.mjs) whose planDefinitions carry their json.
 * Outputs: { matcher_event_log, protocol_instance, protocol_instance_history, step_instance,
 *            step_instance_history, step_sla_state_transition, dueAlarms }
 */
import { flattenSteps, toleranceDaysOf } from './triggers.mjs';

/**
 * Steps that directly follow `actionId`: they declare relatedAction(actionId, after*), or `actionId` declares
 * relatedAction(them, before*). Why: those are the steps the matcher creates (with deadlines) right away.
 */
export function directSuccessors(planDefinition, actionId) {
  const steps = flattenSteps(planDefinition).filter((s) => !s.group);
  const triggered = steps.find((s) => s.id === actionId)?.action;
  const ids = new Set();
  for (const { action } of steps) {
    for (const rel of action.relatedAction ?? []) {
      if (rel.actionId === actionId && String(rel.relationship ?? '').startsWith('after'))
        ids.add(action.id);
    }
  }
  for (const rel of triggered?.relatedAction ?? []) {
    if (String(rel.relationship ?? '').startsWith('before')) ids.add(rel.actionId);
  }
  return steps.filter((s) => ids.has(s.id)).map((s) => s.action);
}

/**
 * Expected rows for one event of `actionId` across the set.
 * Why: one formula shared by data checks (B2), Step SLA peak rate (A2 settings) and the docs.
 */
export function computeExpectedRows(set, actionId) {
  const rows = {
    matcher_event_log: 1, // one log row per event, whatever the fan-out
    protocol_instance: 0,
    protocol_instance_history: 0,
    step_instance: 0,
    step_instance_history: 0,
    step_sla_state_transition: 0,
    dueAlarms: 0,
  };
  let matched = 0;
  for (const pd of set.planDefinitions ?? []) {
    const steps = flattenSteps(pd.json).filter((s) => !s.group);
    if (!steps.some((s) => s.id === actionId)) continue; // this definition does not react to the action
    matched += 1;
    rows.protocol_instance += 1;
    rows.protocol_instance_history += 1;
    rows.step_instance += 1;
    rows.step_instance_history += 2;
    for (const next of directSuccessors(pd.json, actionId)) {
      if (next.requiredBehavior !== 'must') continue; // optional steps have no schedule (matcher V4)
      rows.step_instance += 1;
      rows.step_instance_history += 1;
      rows.step_sla_state_transition += 1; // DUE_DATE_REACHED
      rows.dueAlarms += 1;
      if (toleranceDaysOf(next) !== null) rows.step_sla_state_transition += 1; // MISSED_DATE_REACHED
    }
  }
  if (matched === 0)
    throw new Error(`No plan definition of set '${set.name}' has the action '${actionId}'`);
  return rows;
}
