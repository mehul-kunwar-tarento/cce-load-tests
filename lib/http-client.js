/**
 * http-client.js — small helpers for HTTP tests: post JSON, check the answer (K6)
 *
 * What:    Wraps k6/http and k6's check() so every HTTP test posts the same way: JSON body, a fixed
 *          `name` tag (so all requests to /v1/events count as one URL in metrics and Grafana, instead
 *          of one series per URL), and named checks whose pass rate is a threshold.
 * How:     const res = postJson(`${baseUrl}/v1/events`, cloudEvent, { name: 'POST /v1/events' });
 *          const ok = checkResponse(res, { 'status is 202': statusIs(202) });
 * Needs:   k6 (k6/http, k6).
 * Outputs: k6 Response objects; booleans from checks; http_req_* and checks metrics.
 */

import http from 'k6/http';
import { check } from 'k6';

/**
 * POSTs a JSON body.
 * Why: one place sets the content type and the name tag (avoids "URL label explosion" in metrics).
 * @param {string} url
 * @param {object|string} body object (serialised here) or an already serialised string
 * @param {{name?:string, tags?:object, headers?:object, timeout?:string}} [options]
 * @returns {object} k6 Response
 */
export function postJson(url, body, { name, tags = {}, headers = {}, timeout } = {}) {
  const params = {
    headers: { 'Content-Type': 'application/json', ...headers },
    tags: { ...tags, name: name || url },
  };
  // Only pass a timeout when given; k6's default (60 s) applies otherwise.
  if (timeout) params.timeout = timeout;
  return http.post(url, typeof body === 'string' ? body : JSON.stringify(body), params);
}

/**
 * Runs named checks on a response and returns true when all passed.
 * Why: the `checks` rate is a threshold (MIN_CHECKS_RATE) and "accepted" in events_accepted means
 * "all checks passed" (lib/event-metrics.js).
 * @param {object} response k6 Response
 * @param {Record<string, (r: object) => boolean>} checksByName
 * @param {object} [tags] extra tags for the check metrics
 * @returns {boolean}
 */
export function checkResponse(response, checksByName, tags) {
  return check(response, checksByName, tags);
}

/**
 * A check: the HTTP status equals `expected`.
 * Why: the most common check, written once.
 * @param {number} expected e.g. 202
 * @returns {(r: object) => boolean}
 */
export function statusIs(expected) {
  return (r) => r.status === expected;
}

/**
 * A check: a field of the JSON answer equals `value` (false when the body is not JSON).
 * Why: e.g. the collector answers 202 with data.status "accepted" or "duplicate"; only "accepted" counts.
 * @param {string} path k6 JSON path, e.g. 'data.status'
 * @param {unknown} value
 * @returns {(r: object) => boolean}
 */
export function jsonFieldEquals(path, value) {
  return (r) => {
    try {
      return r.json(path) === value;
    } catch {
      return false; // not JSON (e.g. an HTML error page): the check fails, the test goes on
    }
  };
}
