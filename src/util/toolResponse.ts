/**
 * Shared MCP response builders for tool handlers.
 *
 * Every tool in this server shares two near-identical catch/return shapes:
 *
 *   1. The `try { … } catch (err)` block: classify the upstream error,
 *      validate the envelope against the tool's outputSchema, and return
 *      a structured MCP result with `isError: true`.
 *   2. The pre-flight rejections (LOCAL_RATE_LIMITED, ITEM_NOT_ALLOWED):
 *      return a hardcoded envelope without calling the upstream SDK.
 *
 * These helpers consolidate both patterns. They live in `util/` rather
 * than `security/` because they are pure response shaping — no auditing,
 * no rate-limit state, no redaction.
 *
 * Why a standalone helper, NOT a `withSecurity`/`withAudit` wrapper: a
 * wrapper would have to mutate handler-local closure variables
 * (`outcome`, `errorCode`, `requestId`, `rateLimitReason`) to keep the
 * `finally` audit line correct. That coupling makes the wrapper fragile
 * to refactor — explicit return values keep the data flow visible at
 * each call site.
 */

import type { ZodTypeAny } from 'zod';
import { classifyAndReport } from './errors.js';
import { ensureErrorEnvelope } from './outputShape.js';

/**
 * Shape of an MCP tool response carrying a structured error envelope.
 * The MCP SDK accepts arbitrary `structuredContent`, so we type the
 * envelope loosely here — the per-tool `outputSchema` is the contract.
 */
interface ToolErrorResponse {
  isError: true;
  structuredContent: {
    ok: false;
    errorCode: string;
    message: string;
    requestId?: string;
  };
  content: [{ type: 'text'; text: string }];
}

/**
 * Classify an error, validate the envelope against the tool's
 * outputSchema, and build the MCP error response.
 *
 * Returns the response alongside `errorCode` and `requestId` so the
 * caller's `finally` block can populate the audit line. We return these
 * explicitly rather than mutating closure variables — see file header.
 */
export function buildErrorResponse<T extends ZodTypeAny>(
  err: unknown,
  ctx: { tool: string; operation?: string },
  schema: T,
): { result: ToolErrorResponse; errorCode: string; requestId: string } {
  const safe = classifyAndReport(err, ctx);
  const envelope = ensureErrorEnvelope(
    schema,
    {
      ok: false as const,
      errorCode: safe.errorCode,
      requestId: safe.requestId,
      message: safe.message,
    },
    { tool: ctx.tool },
  );
  return {
    result: {
      isError: true,
      structuredContent: envelope,
      content: [{ type: 'text', text: safe.message }],
    },
    errorCode: safe.errorCode,
    requestId: safe.requestId,
  };
}

/**
 * Build an MCP error response for a pre-flight rejection that does NOT
 * involve an upstream Pluggy call (e.g. LOCAL_RATE_LIMITED,
 * ITEM_NOT_ALLOWED). The envelope is a hardcoded literal — no
 * outputSchema validation needed because the shape is built from
 * compile-time constants that every tool's outputSchema already accepts.
 */
export function buildLiteralErrorResponse(
  errorCode: string,
  message: string,
): ToolErrorResponse {
  return {
    isError: true,
    structuredContent: { ok: false, errorCode, message },
    content: [{ type: 'text', text: message }],
  };
}
