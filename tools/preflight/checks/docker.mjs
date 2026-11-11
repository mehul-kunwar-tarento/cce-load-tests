/**
 * docker.mjs — preflight check `docker`: Docker works and the k6 image is present
 *
 * What:    k6 runs inside the image cce-load-tests/k6:2.3.0-kafka2.2.0; a missing image or a stopped Docker
 *          daemon would only show up after settings were printed and the run folder created.
 * How:     Listed in checks/index.mjs; run by tools/preflight/preflight.mjs.
 * Needs:   ctx.clients.exec (runs `docker version` and `docker image inspect`), environment.k6.image.
 * Outputs: { status, detail, data: { serverVersion, image } }
 */
import { fail, pass } from '../check-helpers.mjs';

export default {
  id: 'docker',
  title: 'Docker works and the k6 image is present',
  /** k6 tests need it; a stack check looks too (as a warning). Step SLA (seeded) does not. */
  appliesTo: (ctx) => ctx.stackCheck || ctx.subjects.some((s) => s.kind === 'k6'),
  severity: (ctx) => (ctx.subjects.some((s) => s.kind === 'k6') ? 'required' : 'warning'),
  async run(ctx) {
    const image = ctx.environment?.k6?.image ?? 'cce-load-tests/k6:2.3.0-kafka2.2.0';
    const version = await ctx.clients.exec('docker', [
      'version',
      '--format',
      '{{.Server.Version}}',
    ]);
    if (version.code !== 0)
      return fail(`docker is not usable: ${String(version.stderr ?? '').trim() || 'no daemon'}`, {
        image,
      });
    const serverVersion = String(version.stdout ?? '').trim();
    const inspect = await ctx.clients.exec('docker', [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      image,
    ]);
    if (inspect.code !== 0) {
      return fail(`image ${image} not found: build it with scripts/build-k6-image.sh`, {
        serverVersion,
        image,
      });
    }
    return pass(`Docker ${serverVersion}, image ${image} present`, { serverVersion, image });
  },
};
