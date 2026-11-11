/**
 * expected-rows.spec.mjs — unit tests of tools/plan-definitions/expected-rows.mjs (rows per event, plan §7.3)
 *
 * What:    Pins the expected database rows for one enrolment event: emr-service / visit-encounter and
 *          kenya-sha-emr-service / consent-request = 1,1,1,2,3,2 with 1 due alarm; two definitions with the
 *          action add up (fan-out 2 = 1,2,2,4,6,4 with 2) (matcher_event_log, protocol_instance,
 *          protocol_instance_history, step_instance, step_instance_history, step_sla_state_transition).
 *          Data checks (B2) and STEP_SLA_PEAK_ALARM_RATE=auto (A2) depend on these numbers.
 * How:     npm test   (or: node --test tools/plan-definitions/unit-tests/expected-rows.spec.mjs)
 * Needs:   test-data/ (A1).
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeExpectedRows, directSuccessors } from '../expected-rows.mjs';
import { loadPlanDefinitionSet } from '../sets.mjs';

/** The plan's numbers as an object, in table order. */
const rows = (mel, pi, pih, si, sih, sst, dueAlarms) => ({
  matcher_event_log: mel,
  protocol_instance: pi,
  protocol_instance_history: pih,
  step_instance: si,
  step_instance_history: sih,
  step_sla_state_transition: sst,
  dueAlarms,
});

describe('computeExpectedRows', () => {
  it('emr-service / visit-encounter = 1,1,1,2,3,2 and 1 due alarm', async () => {
    assert.deepEqual(
      computeExpectedRows(await loadPlanDefinitionSet('emr-service'), 'visit-encounter'),
      rows(1, 1, 1, 2, 3, 2, 1),
    );
  });

  it('kenya-sha-emr-service / consent-request = 1,1,1,2,3,2 and 1 due alarm', async () => {
    // Enrolment on the proposed Consent; its one direct successor (consent-verification) is mandatory
    // with tolerance-days 1, so one alarm.
    assert.deepEqual(
      computeExpectedRows(await loadPlanDefinitionSet('kenya-sha-emr-service'), 'consent-request'),
      rows(1, 1, 1, 2, 3, 2, 1),
    );
  });

  it('sums over every plan definition of the set that has the action (fan-out 2)', async () => {
    // No shipped set has two definitions any more; two copies of the same one stand in for an overlap.
    const one = await loadPlanDefinitionSet('emr-service');
    const two = { ...one, planDefinitions: [one.planDefinitions[0], one.planDefinitions[0]] };
    assert.deepEqual(computeExpectedRows(two, 'visit-encounter'), rows(1, 2, 2, 4, 6, 4, 2));
  });

  it('is independent of the version suffix', async () => {
    const plain = computeExpectedRows(
      await loadPlanDefinitionSet('kenya-sha-emr-service'),
      'consent-request',
    );
    const suffixed = computeExpectedRows(
      await loadPlanDefinitionSet('kenya-sha-emr-service', { versionSuffix: '-x' }),
      'consent-request',
    );
    assert.deepEqual(plain, suffixed);
  });

  it('refuses an action no plan definition of the set has', async () => {
    const set = await loadPlanDefinitionSet('emr-service');
    assert.throws(() => computeExpectedRows(set, 'no-such-action'), /no-such-action/);
  });

  it('finds direct successors through relatedAction', async () => {
    const [pd] = (await loadPlanDefinitionSet('emr-service')).planDefinitions;
    assert.ok(directSuccessors(pd.json, 'visit-encounter').length >= 1);
  });
});
