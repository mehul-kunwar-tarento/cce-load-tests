/**
 * disk-results.mjs — preflight check `disk.results`: enough free space where results are written
 *
 * What:    k6 summaries, watcher series and logs land in results/; a full disk mid-run loses the result.
 * How:     Listed in checks/index.mjs.
 * Needs:   ctx.clients.statfs, ctx.resultsRoot, MIN_FREE_DISK_GB (or safety.minFreeDiskGb).
 * Outputs: { status, detail, data: { path, freeGb, limitGb } }
 */
import { fail, pass } from '../check-helpers.mjs';
import { freeGbAt, minFreeDiskGb } from '../probes.mjs';

export default {
  id: 'disk.results',
  title: 'Free disk for results ≥ MIN_FREE_DISK_GB',
  appliesTo: () => true,
  severity: () => 'required',
  async run(ctx) {
    const limitGb = minFreeDiskGb(ctx.resolved, ctx.environment);
    const { path, freeGb } = await freeGbAt(ctx.clients.statfs, ctx.resultsRoot);
    const data = { path, freeGb, limitGb };
    return freeGb >= limitGb
      ? pass(`${freeGb} GB free (limit ${limitGb} GB)`, data)
      : fail(`only ${freeGb} GB free at ${path} (limit ${limitGb} GB)`, data);
  },
};
