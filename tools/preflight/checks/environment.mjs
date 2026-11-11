/**
 * environment.mjs — preflight check `environment`: the environment file is usable and not prod
 *
 * What:    Confirms the environment kind is local/dev/uat, nothing about it says "prod", and the database
 *          password env var (only its NAME is in the file) is set when a database is needed.
 * How:     Listed in checks/index.mjs; run by tools/preflight/preflight.mjs.
 * Needs:   ctx.environment, ctx.env (process.env).
 * Outputs: { status, detail, data: { name, kind, configFile } } — never the password itself.
 */
import { fail, needsPostgres, pass } from '../check-helpers.mjs';

export default {
  id: 'environment',
  title: 'Environment file valid, not prod, DB password variable set',
  /** Always: every other check depends on the environment. */
  appliesTo: () => true,
  severity: () => 'required',
  /** Why: refusing prod again here is cheap and protects callers that built the environment themselves. */
  async run(ctx) {
    const env = ctx.environment ?? {};
    const data = {
      name: env.name ?? null,
      kind: env.kind ?? null,
      configFile: env.configFile ?? null,
    };
    if (!['local', 'dev', 'uat'].includes(env.kind))
      return fail(`kind "${env.kind}" is not local, dev or uat`, data);
    if (/prod/i.test(String(env.name)) || /prod/i.test(String(env.configFile ?? ''))) {
      return fail('environment looks like production: always refused', data);
    }
    const passwordVar = env.database?.passwordEnvVar;
    if (needsPostgres(ctx) && passwordVar && !ctx.env?.[passwordVar]) {
      return fail(
        `${passwordVar} is not set (export it in this shell; it is never stored in a file)`,
        data,
      );
    }
    return pass(`${env.name} (${env.kind})`, data);
  },
};
