/**
 * matcher-consumer-group.mjs — preflight check `matcher-consumer-group`: the matcher is consuming
 *
 * What:    The matcher's consumer group must be Stable with members and every partition assigned; otherwise
 *          events pile up in Kafka and the backlog numbers measure a rebalance, not the matcher.
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.kafkaAdmin.describeGroup(groupId) → { state, members, assignedPartitions }.
 * Outputs: { status, detail, data: { groupId, state, members, assignedPartitions } }
 */
import { fail, kafkaAdmin, needsKafka, pass, testsSubject } from '../check-helpers.mjs';

/** Why: A2's admin may return counts or lists; count either. */
const count = (value) => (Array.isArray(value) ? value.length : Number(value ?? 0));

export default {
  id: 'matcher-consumer-group',
  title: 'Matcher consumer group Stable, members > 0, all partitions assigned',
  appliesTo: (ctx) => needsKafka(ctx),
  severity: (ctx) => (testsSubject(ctx, 'matcher') ? 'required' : 'warning'),
  async run(ctx) {
    const kafka = ctx.environment?.kafka ?? {};
    const admin = await kafkaAdmin(ctx);
    const group = await admin.describeGroup(kafka.matcherConsumerGroup);
    const members = count(group?.members);
    const assigned = count(group?.assignedPartitions);
    const known = ctx.memo.has('kafka:partitions') ? await ctx.memo.get('kafka:partitions') : null;
    const partitions = known ?? kafka.expectedPartitions ?? null;
    const data = {
      groupId: kafka.matcherConsumerGroup,
      state: group?.state ?? null,
      members,
      assignedPartitions: assigned,
      partitions,
    };
    if (group?.state !== 'Stable')
      return fail(`group ${kafka.matcherConsumerGroup} is ${group?.state ?? 'unknown'}`, data);
    if (members === 0) return fail('no consumers in the group (is the matcher running?)', data);
    if (partitions && assigned < partitions)
      return fail(`${assigned} of ${partitions} partitions assigned`, data);
    return pass(`Stable, ${members} member(s), ${assigned} partitions assigned`, data);
  },
};
