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
  /** True for tools that expose unmasked PII on success. */
  sensitive?: boolean;
  /** Correlation id from the error path, when available. */
  requestId?: string;
}

/**
 * Cheap 12-char fingerprint of a value. Use only for log correlation —
 * never as a security token.
 */
export function hashForAudit(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

/**
 * Emit one structured audit line to stderr. Caller-friendly — no throws,
 * no async, no awaiting; meant to be safe in a `finally` block.
 */
export function audit(ev: AuditEvent): void {
  if (process.env.PLUGGY_MCP_AUDIT === 'false') return;
  const line = {
    ts: new Date().toISOString(),
    event: 'audit',
    ...ev,
  };
  console.error(JSON.stringify(line));
}
