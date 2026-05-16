/**
 * Runtime configuration loader.
 *
 * Reads Pluggy credentials from the environment. We intentionally DO NOT
 * throw at module load: an MCP stdio server must initialize the JSON-RPC
 * transport even when credentials are missing, so the host can list tools.
 * Credentials are checked lazily when a tool actually needs to call Pluggy.
 */

import 'dotenv/config';

export type PluggyConfig = {
  clientId: string;
  clientSecret: string;
};

/**
 * Cached config — `loadPluggyConfig` is called from both `main()` (for the
 * startup warning) and `getPluggyClient` (on first tool use). Reading env
 * twice is harmless, but memoizing keeps the call sites cheap and makes
 * the intent obvious: env is read once per process.
 */
let cached: PluggyConfig | null = null;

/**
 * Load Pluggy credentials. Returns `null` when either credential is missing
 * so callers can render a friendly error to the LLM instead of crashing.
 * The result is memoized for the lifetime of the process.
 */
export function loadPluggyConfig(): PluggyConfig | null {
  if (cached) {
    return cached;
  }

  const clientId = process.env.PLUGGY_CLIENT_ID;
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET;

  // After capturing into memory, scrub the originals so future tools or
  // dependencies cannot read them out of process.env. The memoized
  // `cached` value above is the only place the secret lives from now on.
  // Note: a child process spawned BEFORE this point would still have
  // inherited the env, so this should run as early as possible during
  // startup (it runs on first call, which `main()` triggers up-front).
  // We scrub even when one credential is missing so a partially-set env
  // doesn't leak the half that was present.
  delete process.env.PLUGGY_CLIENT_ID;
  delete process.env.PLUGGY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  cached = { clientId, clientSecret };
  return cached;
}

/**
 * Process-wide server metadata (kept in one place so server.json and the
 * MCP server initialization stay in sync).
 */
export const SERVER_INFO = {
  name: 'pluggy-mcp',
  title: 'Pluggy MCP',
  version: '1.0.0',
} as const;
