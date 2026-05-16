/**
 * Raw HTTP wrapper for Pluggy "premium" endpoints the SDK does not surface.
 *
 * The SDK's `PluggyClient` covers the documented `api.pluggy.ai` surface
 * area, but two upcoming PR4 tools target sibling hosts that the SDK does
 * not know about:
 *   - `enrichment-api.pluggy.ai/recurring-payments` (subscription detection)
 *   - `insights-api.pluggy.ai/book` (account KPIs)
 *
 * Both hosts authenticate with the same `X-API-KEY` short-lived token the
 * SDK already manages internally. Rather than redo the auth handshake by
 * hand, we extend the SDK's `BaseApi` so we can call its `protected`
 * `getApiKey()` and reuse the same token cache / refresh that backs every
 * other Pluggy call. That keeps our error shapes consistent with what the
 * `extractStatus` classifier in `../util/errors.ts` already understands.
 *
 * Note: these endpoints are PREMIUM. Pluggy returns 403 for accounts
 * whose plan does not include enrichment / insights. We do NOT auto-retry
 * 403 — the tool descriptions warn the LLM that a 403 means the upstream
 * feature is not unlocked, not a transient failure.
 */

import { PluggyClient } from 'pluggy-sdk';
import { loadPluggyConfig } from '../config.js';
import { MissingCredentialsError } from './client.js';

/**
 * Minimal shape we throw on non-2xx responses. Mirrors the fields that
 * `../util/errors.ts:extractStatus` probes (`response.statusCode`,
 * `statusCode`, `body.statusCode`) so the existing classifier maps a raw
 * fetch failure to the same `errorCode` an SDK call would have produced.
 *
 * We deliberately do NOT carry the response body into `message` — the
 * upstream JSON could contain customer data and would land in the LLM
 * context via the classifier. The structured `body` field is available
 * to the operator at debug-log time only.
 */
export class PluggyRawFetchError extends Error {
  readonly statusCode: number;
  readonly response: { statusCode: number; body?: unknown };
  readonly body?: unknown;
  constructor(statusCode: number, body?: unknown) {
    super(`Pluggy raw fetch failed with HTTP ${statusCode}`);
    this.name = 'PluggyRawFetchError';
    this.statusCode = statusCode;
    this.body = body;
    // Duplicate the status under `response` so `extractStatus()` finds it
    // through any of its probe paths. Cheap and keeps the existing error
    // classifier oblivious to the source (SDK vs raw fetch).
    this.response = { statusCode, body };
  }
}

/**
 * Subclass exists solely so we can promote the SDK's `protected getApiKey()`
 * to a callable method from our module. We deliberately do NOT widen any
 * other internal — `serviceInstance`, `baseUrl`, `defaultHeaders` are still
 * protected, so call sites here cannot accidentally bypass the SDK's
 * configured behavior (e.g. base URL override via `PLUGGY_API_URL`).
 */
class PluggyClientApiKeyExposed extends PluggyClient {
  fetchApiKey(): Promise<string> {
    // The base implementation returns a cached JWT and refreshes it when
    // it's within 30s of expiry. Calling on every request is safe (and
    // cheap when the cache is warm) — same behavior as `createGetRequest`.
    return this.getApiKey();
  }
}

let cached: PluggyClientApiKeyExposed | null = null;

function getApiKeyClient(): PluggyClientApiKeyExposed {
  if (cached) return cached;
  const config = loadPluggyConfig();
  if (!config) {
    // Throw the same `MissingCredentialsError` the SDK-backed client uses so
    // `classifyAndReport` maps a credentials gap to `MISSING_CREDENTIALS`
    // here too — no special-casing in the tool handlers.
    throw new MissingCredentialsError();
  }
  cached = new PluggyClientApiKeyExposed({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  return cached;
}

export type PluggyRawFetchMethod = 'GET' | 'POST';

/**
 * Fetch a Pluggy "premium" endpoint that the SDK does not surface.
 *
 * - Pulls a fresh `X-API-KEY` via the shared SDK client (so the token
 *   cache and refresh policy stay consistent across tools).
 * - Sends `Content-Type: application/json` when a body is provided.
 * - Parses the response as JSON; non-2xx responses throw a
 *   `PluggyRawFetchError` shaped so `classifyAndReport` maps it to the
 *   same `errorCode` as an SDK call would (`UNAUTHORIZED`, `FORBIDDEN`,
 *   `NOT_FOUND`, `RATE_LIMITED`, `UPSTREAM_5XX`).
 *
 * Uses the platform `fetch` (Node 18+). The SDK uses `got` internally;
 * we deliberately do NOT depend on `got` here to keep this module's
 * surface area small and avoid a second HTTP stack worth of configuration.
 */
export async function pluggyRawFetch(
  url: string,
  method: PluggyRawFetchMethod,
  body?: unknown,
): Promise<unknown> {
  const apiKey = await getApiKeyClient().fetchApiKey();
  const headers: Record<string, string> = {
    'X-API-KEY': apiKey,
    // Pluggy returns JSON; ask for it explicitly so any future content
    // negotiation default doesn't bite us.
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  // Read body once. Some premium endpoints return text on 403 (e.g.
  // "feature not enabled"); fall back gracefully so we don't crash on a
  // non-JSON response.
  let parsed: unknown = undefined;
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Preserve the raw text — operator-visible at debug time only;
      // tool callers never surface this in the LLM channel.
      parsed = { rawBody: text };
    }
  }

  if (!res.ok) {
    throw new PluggyRawFetchError(res.status, parsed);
  }
  return parsed;
}
