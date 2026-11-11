/**
 * protocol-api.mjs — small client for the CCE protocol service's plan-definition API
 *
 * What:    Wraps the endpoints of /v1/protocol/protocol-definitions (cce-protocol-service release-2.0.0):
 *          GET by-url-version, GET list (?size=200), GET /{id}, POST load (body {planDefinitionJson: "<json string>"}),
 *          POST /{id}/retire, DELETE /{id}. 404 on lookups becomes null; 409 on delete (instances still
 *          reference the definition) becomes a ProtocolApiError with status 409.
 * How:     const api = createProtocolApi(environment); await api.getByUrlVersion(url, version)
 * Needs:   services.protocol.baseUrl + apiPath in the environment file; network access to the service
 *          (never during the static build: tests inject a fake `http`).
 * Outputs: Protocol definition DTOs { id, url, version, canonical, status, loadedAt, definition }.
 */
import { serviceConfig } from '../core/environment.mjs';

/** Error carrying the HTTP status, so callers can tell "conflict" from "down". */
export class ProtocolApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ProtocolApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Default HTTP transport over Node 22's fetch, with a timeout.
 * Why: the protocol API is the only JSON API A3 calls with POST/DELETE; tests replace this object.
 */
export function createFetchHttp({ timeoutMs = 10_000 } = {}) {
  return {
    async request({ method, url, body }) {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text; // error pages are sometimes plain text
      }
      return { status: response.status, body: parsed };
    },
  };
}

/**
 * Create the client for one environment.
 * @param {object} environment loaded environment (services.protocol)
 * @param {{ http?: { request({method, url, body}) → Promise<{status, body}> } }} [options]
 */
export function createProtocolApi(environment, { http = createFetchHttp() } = {}) {
  const protocol = serviceConfig(environment, 'protocol');
  if (!protocol?.baseUrl)
    throw new Error(`Environment ${environment?.name} has no services.protocol.baseUrl`);
  const base = `${protocol.baseUrl.replace(/\/$/, '')}${protocol.apiPath ?? '/v1/protocol/protocol-definitions'}`;

  /** Why: one place turns non-2xx answers into errors with the service's own message. */
  async function call(method, url, body, { allow404 = false } = {}) {
    const { status, body: answer } = await http.request({ method, url, body });
    if (allow404 && status === 404) return null;
    if (status < 200 || status >= 300) {
      const detail =
        typeof answer === 'object' && answer
          ? (answer.message ?? JSON.stringify(answer))
          : String(answer ?? '');
      throw new ProtocolApiError(
        `${method} ${url} → HTTP ${status}${detail ? `: ${detail}` : ''}`,
        status,
        answer,
      );
    }
    return answer;
  }

  return {
    baseUrl: base,
    /** One definition by url + version, or null when it does not exist. */
    getByUrlVersion: (url, version) =>
      call(
        'GET',
        `${base}/by-url-version?url=${encodeURIComponent(url)}&version=${encodeURIComponent(version)}`,
        undefined,
        {
          allow404: true,
        },
      ),
    /** Every definition (one page; the API is a Spring Page, so the rows are in `content`). */
    list: async ({ size = 200 } = {}) => {
      const page = await call('GET', `${base}?size=${size}`);
      return Array.isArray(page?.content) ? page.content : Array.isArray(page) ? page : [];
    },
    /** One definition by id, or null. */
    get: (id) => call('GET', `${base}/${encodeURIComponent(id)}`, undefined, { allow404: true }),
    /** Load a PlanDefinition: the API wants it as a JSON *string* inside { planDefinitionJson }. */
    load: (json) => call('POST', base, { planDefinitionJson: JSON.stringify(json) }),
    /** Retire: status RETIRED, trigger rows removed; irreversible for that url + version. */
    retire: (id) => call('POST', `${base}/${encodeURIComponent(id)}/retire`),
    /** Delete: refused by the service with 409 while protocol_instance rows reference it. */
    remove: (id) => call('DELETE', `${base}/${encodeURIComponent(id)}`),
  };
}
