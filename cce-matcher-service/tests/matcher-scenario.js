/**
 * matcher-scenario.js — what every matcher k6 test does: write one CloudEvent per iteration into Kafka.
 *
 * What:    The matcher reads clinical events from the Kafka topic cce.events.inbound (normally the
 *          collector puts them there). To test the matcher on its own, k6 writes them there directly, at
 *          the rate of the phase plan (open model: k6 starts iterations on schedule, whether or not the
 *          previous ones finished). Each iteration:
 *            1. tags itself with its phase and report window (for "when did it start breaking"),
 *            2. builds a NEW patient's event from the dataset template (ids LOADTEST-<runId>-mat-<phase>-<n>,
 *               event id <patientId>-1, CloudEvent with lowercase attribute names, dated now),
 *            3. writes it with key = patient id (as the collector does: one patient → one partition, in order),
 *            4. records events_sent / events_accepted and a check.
 *          "Accepted" only means xk6-kafka handed the message to its producer; whether the matcher kept up
 *          is measured outside k6 by the Node backlog watcher (watchers/backlog-watcher.mjs).
 * How:     Used by the four thin test files:  const matcher = createMatcherTest('load');
 *          They are run by the shared runner:  scripts/run-test.sh local matcher load
 * Needs:   RUN_CONTEXT (run-context.json written by the runner), the image cce-load-tests/k6:2.3.0-kafka2.2.0,
 *          Kafka brokers reachable at run time (environment.kafka.brokers / inboundTopic in the run context).
 * Outputs: Kafka messages; k6 metrics events_sent, events_accepted, checks, kafka_writer_*; k6-summary.json
 *          (through writeSummary).
 */
import { check } from 'k6';
import exec from 'k6/execution';
import {
  assertRunContextFor,
  buildIterationEvent,
  buildOptions,
  createProducer,
  getRunContext,
  produceEvent,
  recordSend,
  tagIteration,
  writeSummary,
} from './shared-lib.js';

/** The check name shown in the summary; one per send attempt. */
const CHECK_NAME = 'event handed to Kafka';

/**
 * Prepares one matcher test. Call it ONCE at the top level of a test file (k6 "init context").
 * Why: the four test files differ only in their test type; everything else lives here once.
 * @param {'smoke'|'load'|'stress'|'breakpoint'} testType the test file's own type (checked against the run context)
 * @returns {{context:object, options:object, sendEvent:() => void, writeSummary:(data:object) => object}}
 */
export function createMatcherTest(testType) {
  const context = getRunContext();
  // Refuse a run context made for another service or test type (it would mislabel the results).
  assertRunContextFor(context, { subject: 'matcher', testType });
  const kafka = context.environment.kafka;
  // One producer per VU (this code runs once per VU in the init context): producers are expensive.
  const producer = createProducer({ brokers: kafka.brokers, topic: kafka.inboundTopic });

  /** One iteration = one event for one new patient. */
  function sendEvent() {
    const { phaseIndex } = tagIteration(context); // first: phase / window tags for this iteration
    // iterationInTest counts per scenario (= per phase), so phaseIndex + n is unique within the run.
    const { patientId, cloudEvent } = buildIterationEvent({
      context,
      phaseIndex,
      n: exec.scenario.iterationInTest,
    });
    let handed = false;
    try {
      produceEvent(producer, { key: patientId, value: JSON.stringify(cloudEvent) });
      handed = true;
    } catch (error) {
      // xk6-kafka throws when it cannot even queue the message; the event counts as not accepted.
      console.error(`Kafka write failed for ${patientId}: ${error}`);
    }
    check(handed, { [CHECK_NAME]: (ok) => ok === true });
    recordSend(handed);
  }

  return {
    context,
    // Arrival-rate scenarios with the Kafka VU limits (KAFKA_PRE_ALLOCATED_VUS / KAFKA_MAX_VUS), rules, tags.
    options: buildOptions({ context, kind: 'kafka' }),
    sendEvent,
    writeSummary: (data) => writeSummary(data, context),
  };
}
