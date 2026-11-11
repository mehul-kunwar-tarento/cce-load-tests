/**
 * http-json.mjs — small JSON-over-HTTP helpers with a timeout (Node 22 global fetch).
 *
 * What:    Actuator health, the k6 REST API, the protocol service and Grafana all speak JSON over HTTP.
 *          These helpers add the one thing fetch lacks: a timeout, so a dead service cannot hang a run.
 * How:     import { getJson, postJson } from './clients/http-json.mjs';
 *          const { status, body } = await getJson('http://127.0.0.1:6565/v1/status', { timeoutMs: 1000 });
 * Needs:   Network access to the URL (never used during the build: tests pass a fake fetch).
 * Outputs: { status, body } where body is parsed JSON, or the raw text when it is not JSON.
 *          Network errors and timeouts are thrown (callers decide whether that is fatal).
 */

/** Default timeout: long enough for a busy service, short enough not to stall a run. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Sends one request and parses the reply.
 * Why: shared by getJson/postJson; AbortSignal.timeout gives the timeout without extra timers.
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, fetchFn?: typeof fetch}} options
 * @returns {Promise<{status:number, body:any, headers:Headers|null}>}
 */
async function request(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch, ...init }) {
  const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON (e.g. an HTML error page): keep the text so the caller can show it.
  }
  return { status: response.status, body, headers: response.headers ?? null };
}

/**
 * GET a JSON document.
 * @param {string} url
 * @param {{timeoutMs?: number, headers?: Record<string,string>, fetchFn?: typeof fetch}} [options]
 */
export async function getJson(url, { timeoutMs, headers = {}, fetchFn } = {}) {
  return request(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    timeoutMs,
    fetchFn,
  });
}

/**
 * POST a JSON body.
 * @param {string} url
 * @param {unknown} body serialised with JSON.stringify
 * @param {{timeoutMs?: number, headers?: Record<string,string>, fetchFn?: typeof fetch}} [options]
 */
export async function postJson(url, body, { timeoutMs, headers = {}, fetchFn } = {}) {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    timeoutMs,
    fetchFn,
  });
}

/**
 * GET plain text (e.g. Prometheus /actuator/prometheus).
 * Why: the metrics format is text, not JSON; same timeout handling.
 * @param {string} url
 * @param {{timeoutMs?: number, fetchFn?: typeof fetch}} [options]
 * @returns {Promise<{status:number, text:string}>}
 */
export async function getText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch } = {}) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, text: await response.text() };
}
