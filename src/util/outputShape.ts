/**
 * Output-shape pre-validator for tool success payloads.
 *
 * Why this lives in `util/` and not `security/`: it is a plain Zod check
 * paired with a sentinel-branded Error. It does no auditing, no
 * redaction, no rate limiting — moving it out of `security/audit.ts`
 * keeps that module focused on stderr audit emission.
 *
 * Why a Symbol brand instead of a string `code`: a string sentinel like
 * `'OUTPUT_SCHEMA_MISMATCH'` could collide with an upstream error that
 * happens to set the same `.code`. A `Symbol.for(...)` key is unique per
 * intern key and cannot be produced by an external library by accident.
 */

import type { ZodTypeAny } from 'zod';

/**
 * Brand key carried on Errors thrown by `ensureOutputShape`. Use
 * `Symbol.for` so multiple module instances (e.g. dual-bundling) still
 * resolve to the same symbol identity.
 */
export const OUTPUT_SCHEMA_MISMATCH = Symbol.for('pluggy-mcp.output-schema-mismatch');

/**
 * Pre-validate a payload against an outputSchema BEFORE the tool returns it.
 *
 * Why: when a tool's success path returns `{ structuredContent }` whose
 * shape drifts from the registered outputSchema, the MCP SDK rejects the
 * envelope after the handler has already exited. The audit `finally` has
 * by then emitted `outcome: success`, while the client receives an
 * `MCP error -32602`. The two views disagree.
 *
 * Calling this helper in the success path turns a shape drift into a
 * thrown Error that funnels through the existing `try/catch +
 * classifyAndReport` machinery, so:
 *   - the audit line correctly records `outcome=error`,
 *   - the LLM sees a stable `errorCode` and hardcoded message,
 *   - the upstream Zod issue list is captured in the stderr log only.
 */
export function ensureOutputShape<T extends ZodTypeAny>(
  schema: T,
  payload: unknown,
  context: { tool: string },
): void {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    const err = new Error(
      `Output schema mismatch in ${context.tool}: ${issues}`,
    );
    (err as Error & { [OUTPUT_SCHEMA_MISMATCH]?: true })[OUTPUT_SCHEMA_MISMATCH] = true;
    throw err;
  }
}
