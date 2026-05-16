/**
 * Safe error classification for tool handlers.
 *
 * Goals:
 *  - Never leak HTTP response bodies, stack traces, raw SDK errors, or
 *    anything that might contain customer data / secrets to the LLM.
 *  - Always log a structured single-line JSON entry to stderr (NEVER
 *    stdout — that channel is reserved for JSON-RPC traffic on stdio
 *    transports). Verbose dumps are gated behind PLUGGY_MCP_DEBUG=1.
 *  - Give the operator a correlatable request id they can grep in logs.
 *  - Map errors to a small enum the LLM can branch on (auth vs. rate
 *    limit vs. transient upstream failure) — much more useful than a
 *    single opaque "failed" message.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MissingCredentialsError } from '../pluggy/client.js';

/**
 * Stable enum the LLM can pattern-match on. The values double as
 * documentation: each one corresponds to a well-defined upstream
 * situation, never to "something else went wrong".
 *
 * The Zod mirror (`ErrorCodeEnum`) is the canonical declaration; the TS
 * `ErrorCode` type is derived from it so the two cannot drift.
 */
export const ErrorCodeEnum = z.enum([
  'MISSING_CREDENTIALS',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'UPSTREAM_5XX',
  'NETWORK',
  'UNKNOWN',
]);
export type ErrorCode = z.infer<typeof ErrorCodeEnum>;

/**
 * Envelope returned to the tool — embedded as `structuredContent` when
 * the tool result is the failure variant of its discriminated union.
 */
export interface SafeError {
  /** Stable, branchable category. */
  errorCode: ErrorCode;
  /** Short, model-actionable message. No secrets, no stack, no body. */
  message: string;
  /** UUID correlating this response with the stderr log line. */
  requestId: string;
}

/**
 * Best-effort extraction of HTTP status / code from heterogeneous error
 * shapes (`got` HTTPError, pluggy-sdk's wrappers, plain `fetch` errors,
 * Node system errors).
 */
function extractStatus(err: unknown): { status: number | null; code: string | null } {
  // got's HTTPError exposes `.response.statusCode`; some wrappers store
  // it on `.statusCode` directly. Both are read defensively.
  const anyErr = err as { response?: { statusCode?: number }; statusCode?: number; code?: string };
  let status: number | null = null;
  if (typeof anyErr?.response?.statusCode === 'number') {
    status = anyErr.response.statusCode;
  } else if (typeof anyErr?.statusCode === 'number') {
    status = anyErr.statusCode;
  }
  const code = typeof anyErr?.code === 'string' ? anyErr.code : null;
  return { status, code };
}

/**
 * Classify an arbitrary thrown value into a `SafeError` and emit a
 * single-line structured stderr log for the operator.
 *
 * The returned `message` is intentionally short and contains no stack,
 * no HTTP body, and no environment data. Set `PLUGGY_MCP_DEBUG=1` to
 * additionally dump the raw error object to stderr — useful when an
 * operator is actively diagnosing an issue, never on by default.
 *
 * SECURITY: never include upstream-derived strings in the user-facing
 * message. Pluggy error messages could contain markdown or
 * instruction-like content that would become an indirect prompt-injection
 * vector in the LLM context. Every branch below assigns a hardcoded
 * string constant — no interpolation of `err.message`, `err.response.body`,
 * or `(err as Error).message`. The stderr log can still carry upstream
 * fields (gated by PLUGGY_MCP_DEBUG), but the LLM-facing channel must
 * stay 100% server-controlled.
 */
export function classifyAndReport(
  err: unknown,
  ctx: { tool: string; operation?: string },
): SafeError {
  const requestId = randomUUID();
  const ts = new Date().toISOString();

  // 1) Missing credentials is a configuration problem, not an upstream
  //    failure — log a short line (no error object, nothing to redact)
  //    and return a distinct enum value so the model can prompt the
  //    operator to set env vars instead of suggesting a retry.
  if (err instanceof MissingCredentialsError) {
    console.error(
      JSON.stringify({
        ts,
        tool: ctx.tool,
        operation: ctx.operation ?? null,
        requestId,
        errorCode: 'MISSING_CREDENTIALS',
      }),
    );
    return {
      errorCode: 'MISSING_CREDENTIALS',
      requestId,
      message:
        'Pluggy credentials are not configured on this MCP server. Set PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET.',
    };
  }

  // 2) Map HTTP / network errors to a stable enum.
  const { status, code } = extractStatus(err);
  let errorCode: ErrorCode = 'UNKNOWN';
  let message = 'Unexpected error talking to Pluggy. See server logs.';

  // Pluggy's /auth handshake returns 400 — not 401 — for malformed or
  // invalid credentials, and the SDK only surfaces a raw HTTPError for
  // that pre-flight call (data calls have their non-2xx bodies caught
  // and rejected as plain objects instead). Treating a bare 400 from a
  // tool call as UNAUTHORIZED gives the model the right next step.
  const STATUS_MAP: Record<number, { errorCode: ErrorCode; message: string }> = {
    400: {
      errorCode: 'UNAUTHORIZED',
      message: 'Pluggy rejected the credentials (400 on /auth). Verify PLUGGY_CLIENT_ID/SECRET.',
    },
    401: {
      errorCode: 'UNAUTHORIZED',
      message: 'Pluggy rejected the credentials (401). Rotate PLUGGY_CLIENT_ID/SECRET.',
    },
    403: {
      errorCode: 'FORBIDDEN',
      message: 'Pluggy returned 403 — premium feature or item not authorized for these credentials.',
    },
    404: {
      errorCode: 'NOT_FOUND',
      message: 'Pluggy returned 404 — the requested resource does not exist or was deleted.',
    },
    429: {
      errorCode: 'RATE_LIMITED',
      message: 'Pluggy returned 429 — rate limited. Back off and retry.',
    },
  };

  const mapped = status !== null ? STATUS_MAP[status] : undefined;
  if (mapped) {
    errorCode = mapped.errorCode;
    message = mapped.message;
  } else if (status !== null && status >= 500) {
    errorCode = 'UPSTREAM_5XX';
    message = 'Pluggy returned a transient server error. Retry shortly.';
  } else if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND') {
    errorCode = 'NETWORK';
    // Hardcoded — do not interpolate `code` into the LLM-facing string,
    // even though it's constrained to the three values above. The exact
    // syscall code is available to the operator in the stderr log.
    message = 'Network error talking to Pluggy. Retry shortly.';
  }

  // 3) Structured single-line stderr log. We deliberately do NOT include
  //    the response body or the stack: those are the channels through
  //    which secrets / customer data leak. The error name + message are
  //    enough to triage, and PLUGGY_MCP_DEBUG=1 unlocks the rest.
  const errAsAny = err as { name?: unknown; message?: unknown };
  const logLine = {
    ts,
    tool: ctx.tool,
    operation: ctx.operation ?? null,
    requestId,
    errorCode,
    status,
    code,
    name: typeof errAsAny?.name === 'string' ? errAsAny.name : null,
    msg: typeof errAsAny?.message === 'string' ? errAsAny.message : null,
  };
  console.error(JSON.stringify(logLine));

  if (process.env.PLUGGY_MCP_DEBUG === '1') {
    // Operator opt-in: dump the raw error (including any body / stack).
    // This is gated because the body can contain customer data.
    console.error('[PLUGGY_MCP_DEBUG] raw error:', err);
  }

  return { errorCode, requestId, message: `${message} request-id=${requestId}` };
}
