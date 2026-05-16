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
 * Server-wide security toggles. All default ON; operators opt OUT
 * explicitly via env. We surface them here so call sites can read
 * `loadSecurityConfig().redact` instead of repeating the `!== 'false'`
 * comparison and so misspelled env values (`"FALSE"`, `"0"`) don't
 * silently disable a control.
 */
export type SecurityConfig = {
  redact: boolean;
  audit: boolean;
  rateLimit: boolean;
};

/**
 * Cached config — `loadPluggyConfig` is called from both `main()` (for the
 * startup warning) and `getPluggyClient` (on first tool use). Reading env
 * twice is harmless, but memoizing keeps the call sites cheap and makes
 * the intent obvious: env is read once per process.
 */
let cached: PluggyConfig | null = null;
let cachedSecurity: SecurityConfig | null = null;

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
 * Read security toggles from the environment. All default ON; the only
 * way to disable a control is to explicitly set its env var to the
 * literal string `"false"` (case-sensitive — see comment on `SecurityConfig`).
 *
 * Memoized for the same reason as the credentials: env is read once per
 * process. We do NOT delete the toggle envs after reading — they are not
 * secrets, and downstream child processes (if any) seeing the same value
 * is the correct behavior.
 */
export function loadSecurityConfig(): SecurityConfig {
  if (cachedSecurity) return cachedSecurity;
  cachedSecurity = {
    redact: process.env.PLUGGY_MCP_REDACT !== 'false',
    audit: process.env.PLUGGY_MCP_AUDIT !== 'false',
    rateLimit: process.env.PLUGGY_MCP_RATELIMIT !== 'false',
  };
  return cachedSecurity;
}

/**
 * Emit a single-line summary of the resolved security toggles, plus a
 * loud warning when redaction is disabled. Called once from `main()`.
 *
 * Kept separate from `loadSecurityConfig()` because the loader is also
 * called from inside tool handlers and we only want the summary once at
 * startup — not on every tool call.
 */
export function logSecurityConfig(): void {
  const cfg = loadSecurityConfig();
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'security_config',
      redact: cfg.redact,
      audit: cfg.audit,
      rateLimit: cfg.rateLimit,
    }),
  );
  if (!cfg.redact) {
    console.error(
      '[pluggy-mcp] WARN: PII redaction DISABLED — raw CPF/account numbers will reach the LLM context. ' +
        'Set PLUGGY_MCP_REDACT=true to enable.',
    );
  }
  if (!cfg.audit) {
    // Sensitive-event audit lines are still emitted unconditionally (see
    // `audit()` in src/security/audit.ts) — this WARN flags only the
    // suppression of routine, non-sensitive audit traffic.
    console.error(
      '[pluggy-mcp] WARN: audit logging DISABLED — non-sensitive tool calls will not be recorded. ' +
        'Set PLUGGY_MCP_AUDIT=true to enable. (Sensitive-event audit is unbypassable.)',
    );
  }
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
