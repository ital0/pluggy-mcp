/**
 * Thin wrapper around the official `pluggy-sdk` PluggyClient.
 *
 * Centralizing construction here means:
 *  - tool handlers don't each repeat credential plumbing,
 *  - we get one place to swap in mocks or fakes for tests later,
 *  - lazy instantiation: the MCP server can start (and list its tools)
 *    even when credentials are absent. The client is only built the
 *    first time a tool actually needs to call Pluggy.
 */

import { PluggyClient } from 'pluggy-sdk';
import { loadPluggyConfig } from '../config.js';

let cached: PluggyClient | null = null;

/**
 * Returned when credentials are missing. Tool handlers translate this
 * into a user-facing message; we deliberately do not throw so the model
 * sees a clean error instead of a raw stack trace.
 */
export class MissingCredentialsError extends Error {
  constructor() {
    super(
      'PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET environment variables are required.',
    );
    this.name = 'MissingCredentialsError';
  }
}

/**
 * Get (or lazily build) the PluggyClient singleton.
 *
 * Throws `MissingCredentialsError` if env vars are not set so callers can
 * differentiate a configuration problem from an upstream failure.
 */
export function getPluggyClient(): PluggyClient {
  if (cached) {
    return cached;
  }

  const config = loadPluggyConfig();
  if (!config) {
    throw new MissingCredentialsError();
  }

  cached = new PluggyClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  return cached;
}

/** Test/maintenance hook — reset the cached client (useful in future tests). */
export function __resetPluggyClient(): void {
  cached = null;
}
