/**
 * disk-data-stores.mjs — preflight check `disk.data-stores`: room where Postgres and Kafka keep their data
 *
 * What:    Test data fills Kafka (7-day retention took the laptop from 38 to 73 GB overnight) and Postgres
 *          WAL. On a laptop both live under Docker's data root, so its free space is measured (required).
 *          On dev/uat they are remote: the check reports database, WAL and topic sizes as a warning only
 *          (free-space limits there are an open question).
 * How:     Listed in checks/index.mjs.
 * Needs:   local: ctx.clients.exec (docker info) + statfs; dev/uat: ctx.clients.db, kafkaAdmin (optional).
 * Outputs: { status, detail, data: measureDataStores() + limitGb }
 */
import { fail, needsPostgres, pass, toGb, warn } from '../check-helpers.mjs';
import { measureDataStores, minFreeDiskGb } from '../probes.mjs';

export default {
  id: 'disk.data-stores',
  title: 'Free disk where Postgres/Kafka keep data (local) or their sizes (dev/uat)',
  appliesTo: (ctx) => needsPostgres(ctx),
  severity: (ctx) => (ctx.environment?.kind === 'local' ? 'required' : 'warning'),
  async run(ctx) {
    const limitGb = minFreeDiskGb(ctx.resolved, ctx.environment);
    const query = ctx.clients.db
      ? (sql) => ctx.clients.db.query(sql, [], { statementTimeoutMs: 5000 })
      : null;
    const measured = await measureDataStores({
      environment: ctx.environment,
      exec: ctx.clients.exec,
      statfs: ctx.clients.statfs,
      query,
      kafkaAdmin: ctx.environment?.kind === 'local' ? null : ctx.clients.kafkaAdmin,
      topic: ctx.environment?.kafka?.inboundTopic,
    });
    const data = { ...measured, limitGb };
    if (ctx.environment?.kind === 'local') {
      const text = `${measured.dataStoresFreeGb} GB free at Docker root ${measured.path} (limit ${limitGb} GB)`;
      return measured.dataStoresFreeGb >= limitGb ? pass(text, data) : fail(text, data);
    }
    const sizes = [
      `DB ${toGb(measured.dbSizeBytes) ?? '?'} GB`,
      `WAL ${toGb(measured.walBytes) ?? 'not measurable'}`,
      `Kafka ${toGb(measured.kafkaLogBytes) ?? 'not measurable'}`,
    ];
    return warn(
      `remote data stores: ${sizes.join(', ')}; free space not measurable from here`,
      data,
    );
  },
};
