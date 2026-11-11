/**
 * kafka.mjs — preflight check `kafka`: broker reachable, inbound topic exists with the expected partitions
 *
 * What:    The matcher test writes straight to the inbound topic and its backlog is read from Kafka; the
 *          collector publishes to it. A missing topic or a different partition count changes the test.
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.kafkaAdmin (A2 kafka-admin: connect, listTopics, getGroupLag), environment.kafka.
 * Outputs: { status, detail, data: { topic, partitions, expectedPartitions } }
 */
import { fail, kafkaAdmin, needsKafka, pass, testsSubject, warn } from '../check-helpers.mjs';

export default {
  id: 'kafka',
  title: 'Kafka reachable, inbound topic present',
  appliesTo: (ctx) => needsKafka(ctx),
  severity: (ctx) => (testsSubject(ctx, 'matcher') ? 'required' : 'warning'),
  async run(ctx) {
    const kafka = ctx.environment?.kafka ?? {};
    const admin = await kafkaAdmin(ctx);
    const topics = await admin.listTopics();
    if (!topics.includes(kafka.inboundTopic))
      return fail(`topic ${kafka.inboundTopic} not found`, { topic: kafka.inboundTopic });
    // getGroupLag lists every partition of the topic (offsets), which also gives the partition count.
    const lag = await admin.getGroupLag({
      groupId: kafka.matcherConsumerGroup,
      topic: kafka.inboundTopic,
    });
    const partitions = lag?.partitions?.length ?? null;
    const data = {
      topic: kafka.inboundTopic,
      partitions,
      expectedPartitions: kafka.expectedPartitions ?? null,
    };
    ctx.memo.set('kafka:partitions', Promise.resolve(partitions));
    if (kafka.expectedPartitions && partitions !== kafka.expectedPartitions) {
      return warn(
        `${kafka.inboundTopic} has ${partitions} partitions, expected ${kafka.expectedPartitions}`,
        data,
      );
    }
    return pass(`${kafka.inboundTopic}, ${partitions} partitions`, data);
  },
};
