/**
 * kafka-client.js — write events straight into Kafka from k6 (xk6-kafka 2.2.0) (K6)
 *
 * What:    The matcher has no HTTP endpoint; it reads CloudEvents from the Kafka topic
 *          cce.events.inbound. These helpers create one Kafka producer per virtual user and write one
 *          event, exactly as the first version did (the first version's matcher/matcher.js), using the
 *          xk6-kafka extension built into our k6 image (docker/k6/Dockerfile).
 * How:     At the top level of a test file (init context):
 *            const producer = createProducer({ brokers: context.environment.kafka.brokers,
 *                                              topic: context.environment.kafka.inboundTopic });
 *          In the iteration:  produceEvent(producer, { key: patientId, value: JSON.stringify(event) });
 * Needs:   The image cce-load-tests/k6:2.3.0-kafka2.2.0 (module k6/x/kafka); reachable brokers at run time.
 * Outputs: Messages in Kafka; xk6-kafka's metrics (kafka_writer_message_count, kafka_writer_error_count…).
 */

import { Producer } from 'k6/x/kafka';

/**
 * Creates a Kafka producer. Call it in the init context, so each VU makes one and reuses it.
 * Why: a producer holds connections, threads and buffers (librdkafka); one per event would be far
 * too expensive. That is also why Kafka tests have their own VU limits (lib/scenarios.js).
 * @param {{brokers:string[], topic:string}} config
 * @returns {object} xk6-kafka Producer
 */
export function createProducer({ brokers, topic }) {
  if (!Array.isArray(brokers) || brokers.length === 0)
    throw new Error('createProducer needs a list of brokers');
  if (!topic) throw new Error('createProducer needs a topic');
  return new Producer({ brokers, topic });
}

/**
 * Writes one message. Throws when xk6-kafka reports an error, so the caller can record it as not accepted.
 * Why: key = patient id, as the collector does: one patient's events go to the same partition, in
 * order. Important: xk6-kafka 2.2.0 hands the message to librdkafka and returns; it does NOT wait for
 * the broker. In the offline probe (broker unreachable, network none) produce() returned in ~30 ms
 * without an error and counted the message in kafka_writer_message_count, with kafka_writer_error_count 0.
 * So "accepted" here means "handed to the producer", not "stored in Kafka": the Node backlog watcher
 * (Kafka admin: topic end offsets and consumer lag) is the real proof, and it stops a stalled run.
 * @param {object} producer from createProducer
 * @param {{key:string, value:string}} message value = JSON string of the CloudEvent
 */
export function produceEvent(producer, { key, value }) {
  producer.produce({ messages: [{ key, value }] });
}
