/**
 * active.mjs — which plan definitions are ACTIVE in an environment right now
 *
 * What:    Asks the protocol service (list, size 200) and keeps the ACTIVE ones; when the API cannot be
 *          reached, reads protocol_definition from Postgres instead (read-only). Used by `plan-definitions
 *          list-active`, preflight and A2's conditions capture (imported lazily there).
 * How:     await getActivePlanDefinitions(environment, { protocolApi, pgPool })
 * Needs:   A protocol API client (protocol-api.mjs) and/or a pg Pool/Client with query(); no writes.
 * Outputs: [{ id, url, version, canonical, status, updatedAt, source: 'api'|'database' }]
 */

/** Read-only fallback query (protocol_definition has url, version, status, updated_at). */
export const ACTIVE_DEFINITIONS_SQL =
  "SELECT id::text AS id, url, version, status, updated_at FROM protocol_definition WHERE status = 'ACTIVE' ORDER BY url, version";

/**
 * List ACTIVE plan definitions.
 * Why: the plan-definition set is a test parameter; what else is ACTIVE changes the matcher's fan-out,
 * so every result records it.
 */
export async function getActivePlanDefinitions(
  environment,
  { protocolApi = null, pgPool = null } = {},
) {
  let apiError = null;
  if (protocolApi) {
    try {
      const rows = await protocolApi.list({ size: 200 });
      return rows
        .filter((r) => r.status === 'ACTIVE')
        .map((r) => ({
          id: r.id,
          url: r.url,
          version: r.version,
          canonical: r.canonical ?? `${r.url}|${r.version}`,
          status: r.status,
          // The DTO has loadedAt but no updatedAt; loadedAt is the closest "last changed" it offers.
          updatedAt: r.updatedAt ?? r.loadedAt ?? null,
          source: 'api',
        }));
    } catch (error) {
      apiError = error; // fall through to the database
    }
  }
  if (pgPool) {
    const result = await pgPool.query(ACTIVE_DEFINITIONS_SQL);
    const rows = Array.isArray(result) ? result : result.rows;
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      version: r.version,
      canonical: `${r.url}|${r.version}`,
      status: r.status,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : (r.updated_at ?? null),
      source: 'database',
    }));
  }
  throw apiError ?? new Error(`No protocol API or database available for ${environment?.name}`);
}
