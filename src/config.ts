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
 * Load Pluggy credentials. Returns `null` when either credential is missing
 * so callers can render a friendly error to the LLM instead of crashing.
 */
export function loadPluggyConfig(): PluggyConfig | null {
  const clientId = process.env.PLUGGY_CLIENT_ID;
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
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
