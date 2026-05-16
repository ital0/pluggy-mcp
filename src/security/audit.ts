/**
 * Structured stderr audit logger.
 *
 * Goals:
 *  - Exactly one JSON line per tool invocation, written to stderr (never
 *    stdout — the JSON-RPC pipe on stdio transports lives on stdout).
 *  - Never log raw tool arguments. We hash them (truncated SHA-256) so
 *    an operator can correlate calls without leaking PII or secrets.
 *  - Mark high-risk tools (`sensitive: true`) so log shipping pipelines
 *    can route them to a smaller audience.
 */

import { createHash } from 'node:crypto';
import { loadSecurityConfig } from '../config.js';

export interface AuditEvent {
  /** Tool name as registered with the MCP server. */
  tool: string;
  /** Whether the handler returned the success or error envelope. */
  outcome: 'success' | 'error';
  /** Set when `outcome === 'error'` — the classifier's enum value. */
  errorCode?: string;
  /** Wall-clock duration of the handler in milliseconds. */
  durationMs: number;
  /** Truncated SHA-256 of the JSON-serialized args. Omitted when none. */
  argsHash?: string;
  /** Truncated SHA-256 of `args.itemId`, when present. */
  itemIdHash?: string;
  /** Truncated SHA-256 of `args.accountId`, when present. */
  accountIdHash?: string;
  /** True for tools that expose unmasked PII on success. */
  sensitive?: boolean;
  /** Correlation id from the error path, when available. */
  requestId?: string;
}

/**
 * Hash only allowlisted fields of an args object. Returns an `argsHash`
 * of the FULL args plus a per-field hash for each name in `allowedFields`
 * that is present and stringy. Other fields are deliberately ignored —
 * tools may grow free-text params in the future and we don't want a new
 * field name to silently appear in audit output.
 */
export function hashArgsSafely(
  args: unknown,
  allowedFields: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    argsHash: hashForAudit(args),
  };
  if (args && typeof args === 'object') {
    const obj = args as Record<string, unknown>;
    for (const field of allowedFields) {
      const v = obj[field];
      if (typeof v === 'string') {
        out[`${field}Hash`] = hashForAudit(v);
      }
    }
  }
  return out;
}

/**
 * Cheap 12-char fingerprint of a value. Use only for log correlation —
 * never as a security token.
 *
 * Safety: must NEVER throw — callers invoke this from `finally` blocks.
 * `undefined` is coerced to a stable empty marker; serialization or hash
 * failures fall back to a constant sentinel.
 */
export function hashForAudit(value: unknown): string {
  try {
    const coerced = value === undefined ? '' : value;
    return createHash('sha256').update(JSON.stringify(coerced) ?? '').digest('hex').slice(0, 12);
  } catch {
    return 'hash_failed';
  }
}

/**
 * Emit one structured audit line to stderr. Caller-friendly — no throws,
 * no async, no awaiting; meant to be safe in a `finally` block.
 */
export function audit(ev: AuditEvent): void {
  // Sensitive events are NEVER suppressible — even when the operator
  // disabled audit globally, calls that expose PII must still produce
  // an audit trail. Non-sensitive events respect the cached toggle from
  // `loadSecurityConfig()` so it stays consistent with other controls
  // (avoiding the case where env was mutated mid-process).
  let cfg = { audit: true };
  try {
    cfg = loadSecurityConfig();
  } catch {
    // If config can't be loaded, fail open: emit the event.
  }
  if (!ev.sensitive && !cfg.audit) return;
  try {
    const line = {
      ts: new Date().toISOString(),
      event: 'audit',
      ...ev,
    };
    console.error(JSON.stringify(line));
  } catch (err) {
    // Last-ditch fallback: emit a minimal line so the operator at least
    // sees that an audit event was attempted. Wrapped in its own try/catch
    // because `console.error` itself can throw on a broken stderr pipe.
    try {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'audit_emit_failed',
          tool: ev?.tool,
          outcome: ev?.outcome,
          sensitive: ev?.sensitive,
          reason: (err as { message?: unknown })?.message ?? 'unknown',
        }),
      );
    } catch {
      // Nothing else we can do — silently drop.
    }
  }
}
