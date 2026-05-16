/**
 * Safe error mapping for tool handlers.
 *
 * Goals:
 *  - Never leak HTTP response bodies, stack traces, raw SDK errors, or
 *    anything that might contain customer data / secrets to the LLM.
 *  - Always log the full error to stderr (NEVER stdout — that channel
 *    is reserved for JSON-RPC traffic on stdio transports).
 *  - Give the operator a correlatable request id they can grep in logs.
 */

import { randomUUID } from 'node:crypto';

/**
 * A short, user-safe message returned to the LLM, plus the request id
 * that was logged to stderr for correlation.
 */
export type SafeErrorResult = {
  /** Human-readable message safe to surface to the model. */
  message: string;
  /** Correlation id printed alongside the full error on stderr. */
  requestId: string;
};

/**
 * Map an arbitrary thrown value to a sanitized message for the LLM.
 *
 * The full original error is logged to `stderr` (with a `request-id` so
 * an operator can correlate the log entry with the model-facing message);
 * the returned `message` is intentionally generic and contains no stack,
 * no HTTP body, and no environment data.
 */
export function toSafeError(
  err: unknown,
  context: { tool: string; operation?: string },
): SafeErrorResult {
  const requestId = randomUUID();

  // Log everything we know to stderr for the operator. console.error is
  // already routed to stderr by Node, which keeps the stdout JSON-RPC
  // channel clean on stdio transports.
  console.error(
    `[pluggy-mcp] request-id=${requestId} tool=${context.tool}${
      context.operation ? ` op=${context.operation}` : ''
    } error=`,
    err,
  );

  const op = context.operation ? ` (${context.operation})` : '';
  return {
    requestId,
    message: `Failed to call Pluggy${op}. request-id=${requestId}. See server logs for details.`,
  };
}
