/**
 * kafka-admin.mjs — Kafka admin reads: topic offsets, consumer-group lag, group state (kafkajs).
 *
 * What:    The matcher reads events from Kafka; how many are still waiting (its "backlog" or lag) is
 *          not in the matcher's own metrics, so it is computed here: for each partition, the newest
 *          offset (high watermark) minus the offset the matcher's consumer group has committed.
 * How:     import { createKafkaAdmin } from './clients/kafka-admin.mjs';
 *          const admin = createKafkaAdmin(environment); await admin.connect();
 *          const { total } = await admin.getGroupLag({ groupId, topic }); await admin.disconnect();
 * Needs:   environment.kafka.brokers reachable (never during the build: tests inject a fake Kafka).
 * Outputs: Plain objects with numbers (lag per partition and in total, end offsets, group state).
 */
import kafkajs from 'kafkajs';

/**
 * Creates the admin wrapper.
 * Why: hides kafkajs details (string offsets, -1 for "nothing committed") behind plain numbers.
 * @param {object} environment loaded environment (kafka block)
 * @param {{Kafka?: typeof kafkajs.Kafka, clientId?: string}} [options] Kafka: injectable for tests
 */
export function createKafkaAdmin(
  environment,
  { Kafka = kafkajs.Kafka, clientId = 'cce-performance-tests' } = {},
) {
  const kafka = new Kafka({
    clientId,
    brokers: environment.kafka.brokers,
    // kafkajs logs every retry at ERROR level by default; warnings are enough for a test tool.
    logLevel: kafkajs.logLevel?.WARN ?? 2,
  });
  const admin = kafka.admin();

  /** Newest offset per partition of a topic; why: lag and DLQ growth both start from it. */
  async function topicEndOffsets(topic) {
    const offsets = await admin.fetchTopicOffsets(topic);
    return offsets.map((o) => ({
      partition: o.partition,
      high: Number(o.high),
      low: Number(o.low),
    }));
  }

  return {
    connect: () => admin.connect(),
    disconnect: () => admin.disconnect(),

    /**
     * Lag of a consumer group on a topic, per partition and in total.
     * Why: the matcher backlog (plan §6.6). A partition with no committed offset (-1) counts from the
     * oldest available message (low watermark).
     */
    async getGroupLag({ groupId, topic }) {
      const ends = await topicEndOffsets(topic);
      const [committedTopic] = await admin.fetchOffsets({ groupId, topics: [topic] });
      const committed = new Map(
        (committedTopic?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]),
      );
      const partitions = ends.map(({ partition, high, low }) => {
        const offset = committed.get(partition);
        const from = offset === undefined || offset < 0 ? low : offset;
        return { partition, high, committed: offset ?? null, lag: Math.max(0, high - from) };
      });
      return { total: partitions.reduce((sum, p) => sum + p.lag, 0), partitions };
    },

    /** Sum of the end offsets of a topic; why: DLQ growth = end total after − before. */
    async getTopicEndOffsetTotal(topic) {
      return (await topicEndOffsets(topic)).reduce((sum, p) => sum + p.high, 0);
    },

    /** State, member count and assigned partitions of a group; why: preflight's "matcher is consuming". */
    async describeGroup(groupId) {
      const { groups } = await admin.describeGroups([groupId]);
      const group = groups?.[0] ?? { state: 'Unknown', members: [] };
      let assignedPartitions = 0;
      for (const member of group.members ?? []) {
        try {
          const assignment = kafkajs.AssignerProtocol.MemberAssignment.decode(
            member.memberAssignment,
          );
          for (const partitions of Object.values(assignment?.assignment ?? {})) {
            assignedPartitions += partitions.length;
          }
        } catch {
          // An undecodable assignment (other protocol) is simply not counted.
        }
      }
      return { state: group.state, members: (group.members ?? []).length, assignedPartitions };
    },

    /** Topic names; why: preflight checks the inbound topic exists. */
    listTopics: () => admin.listTopics(),
  };
}
