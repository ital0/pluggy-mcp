/**
 * `getRecurringPayments` / `getInsightsBook` tools.
 *
 * These two endpoints are premium Pluggy features served from sibling
 * hosts the SDK does not surface:
 *   - `https://enrichment-api.pluggy.ai/recurring-payments`
 *       Detects subscription-like patterns in an Item's transactions
 *       (Netflix, Spotify, etc.).
 *   - `https://insights-api.pluggy.ai/book?itemIds=...`
 *       Aggregates account-level KPIs across one or more Items.
 *
 * Both go through `pluggyRawFetch` (`../pluggy/rawFetch.ts`), which
 * reuses the SDK's apiKey cache so we don't redo the auth handshake.
 *
 * IMPORTANT: these are PREMIUM endpoints. Pluggy returns 403 for
 * accounts whose plan does not include enrichment / insights. The tool
 * descriptions tell the LLM that a 403 means "feature not enabled" —
 * not a transient failure — so it should not auto-retry.
 *
 * Allowlist scope:
 *   - `getRecurringPayments` takes one `itemId` → pre-fetch check.
 *   - `getInsightsBook` takes `itemIds: string[]` → validates EACH id
 *     against the allowlist. ANY denial returns a single hardcoded
 *     FORBIDDEN envelope; no upstream call is made.
 *
 * The recurring-payments response shape is institution-derived (vendor
 * names, descriptions) → wrap free text in `<untrusted>`. The insights
 * book response is documented as KPI numerics → still wrap any free
 * text we surface.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { pluggyRawFetch } from '../pluggy/rawFetch.js';
import { ErrorCodeEnum, classifyAndReport } from '../util/errors.js';
import { loadSecurityConfig, isItemAllowed } from '../config.js';
import {
  audit,
  checkRateLimit,
  hashArgsSafely,
  wrapUntrusted,
  UNTRUSTED_PREAMBLE,
  LOCAL_RATE_LIMITED_MESSAGE,
  ITEM_NOT_ALLOWED_MESSAGE,
} from '../security/index.js';

const ENRICHMENT_RECURRING_URL =
  'https://enrichment-api.pluggy.ai/recurring-payments';
const INSIGHTS_BOOK_URL = 'https://insights-api.pluggy.ai/book';

// Hardcoded — `getInsightsBook` accepts an array of itemIds and we want
// a single, server-controlled string when ANY of them is denied. Avoids
// naming the offending id in the LLM channel (consistent with
// `ITEM_NOT_ALLOWED_MESSAGE` posture).
const INSIGHTS_ITEM_NOT_ALLOWED_MESSAGE =
  'One or more itemIds not in PLUGGY_ITEM_IDS allowlist.';

// ---------------------------------------------------------------------------
// `getRecurringPayments`
// ---------------------------------------------------------------------------
//
// The enrichment response shape is not documented at type-level by
// Pluggy; we accept `unknown` and surface it as a pass-through `result`
// field validated by `z.unknown()`. Free-text strings inside the payload
// stay wrapped server-side via the response normalizer below.

const GetRecurringPaymentsOutputShape = {
  ok: z.boolean(),
  itemId: z.string().optional(),
  // Pass-through payload; the upstream shape is opaque to this server.
  // We pre-normalize free-text via `normalizeRecurringPayments` before
  // emitting so an institution-composed string can't bypass the
  // <untrusted> wrap.
  result: z.unknown().optional(),
  errorCode: ErrorCodeEnum.optional(),
  requestId: z.string().optional(),
  message: z.string().optional(),
};

/**
 * Walk the recurring-payments response and wrap every string leaf in
 * `<untrusted>`. The upstream shape is documented loosely and may change;
 * a recursive wrap is the safest posture short of pinning a strict
 * schema. We deliberately do NOT mutate the input — JSON.parse(stringify)
 * gives us a deep clone that's safe to mutate.
 *
 * NUMBERS pass through unchanged: KPI values are the point of the tool.
 * BOOLEANS / NULLS pass through. Object keys are NOT wrapped (they are
 * server-controlled by Pluggy, not adversarial).
 */
function normalizeRecurringPayments(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return wrapUntrusted(value);
  if (Array.isArray(value)) {
    return value.map((v) => normalizeRecurringPayments(v));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // `Object.create(null)` so the resulting object has no prototype —
    // serializing through JSON later cannot collide with `Object.prototype`
    // accessors, and explicit skip-listing the three dangerous keys below
    // gives belt-and-braces against an upstream payload trying to inject
    // a `__proto__` / `constructor` / `prototype` field.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(obj)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = normalizeRecurringPayments(v);
    }
    return out;
  }
  // numbers, booleans, bigints — pass through.
  return value;
}

export function registerGetRecurringPaymentsTool(server: McpServer): void {
  const toolName = 'getRecurringPayments';
  server.registerTool(
    toolName,
    {
      description:
        UNTRUSTED_PREAMBLE +
        '\n\n' +
        'Detect recurring (subscription-like) payments across the ' +
        'transactions of a Pluggy Item. Premium Pluggy feature — your ' +
        'account may return 403 if your plan does not include ' +
        'enrichment/insights. All free-text fields in the response are ' +
        'wrapped in <untrusted>. ' +
        'When the server is configured with PLUGGY_ITEM_IDS, only itemIds ' +
        'in the allowlist will be fetched; others return FORBIDDEN.',
      inputSchema: {
        itemId: z
          .string()
          .uuid()
          .describe('The Pluggy Item id (UUID) to analyze.'),
      },
      outputSchema: GetRecurringPaymentsOutputShape,
      annotations: {
        title: 'Get Recurring Payments (premium)',
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ itemId }) => {
      const start = performance.now();
      let outcome: 'success' | 'error' = 'success';
      let errorCode: string | undefined;
      let requestId: string | undefined;
      let rateLimitReason: 'PER_MINUTE' | 'PER_DAY' | undefined;
      // Subscription/vendor data is financial-behavior PII — flip sensitive
      // ONLY when we actually hit the upstream. Gate denials stay false.
      let sensitive = false;
      try {
        const sec = loadSecurityConfig();
        const rl = sec.rateLimit
          ? checkRateLimit(toolName)
          : { allowed: true as const };
        if (!rl.allowed) {
          outcome = 'error';
          errorCode = 'LOCAL_RATE_LIMITED';
          rateLimitReason = rl.reason;
          const errorOutput = {
            ok: false as const,
            errorCode: 'LOCAL_RATE_LIMITED' as const,
            message: LOCAL_RATE_LIMITED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: LOCAL_RATE_LIMITED_MESSAGE }],
          };
        }

        if (!isItemAllowed(itemId)) {
          outcome = 'error';
          errorCode = 'FORBIDDEN';
          const errorOutput = {
            ok: false as const,
            errorCode: 'FORBIDDEN' as const,
            message: ITEM_NOT_ALLOWED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: ITEM_NOT_ALLOWED_MESSAGE }],
          };
        }

        sensitive = true;
        const raw = await pluggyRawFetch(
          ENRICHMENT_RECURRING_URL,
          'POST',
          { itemId },
        );
        const result = normalizeRecurringPayments(raw);

        const output = { ok: true as const, itemId, result };
        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              // Generic — the structured channel carries the itemId and
              // the result payload. Keep the text minimal to avoid
              // leaking vendor names into transcripts.
              text: 'Returned recurring-payments analysis.',
            },
          ],
        };
      } catch (err) {
        outcome = 'error';
        const safe = classifyAndReport(err, {
          tool: toolName,
          operation: 'enrichmentRecurringPayments',
        });
        errorCode = safe.errorCode;
        requestId = safe.requestId;
        const errorOutput = {
          ok: false as const,
          errorCode: safe.errorCode,
          requestId: safe.requestId,
          message: safe.message,
        };
        return {
          isError: true,
          structuredContent: errorOutput,
          content: [{ type: 'text' as const, text: safe.message }],
        };
      } finally {
        audit({
          tool: toolName,
          outcome,
          errorCode,
          durationMs: Math.round(performance.now() - start),
          ...hashArgsSafely({ itemId }, ['itemId']),
          sensitive,
          requestId,
          rateLimitReason,
        });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// `getInsightsBook`
// ---------------------------------------------------------------------------

const GetInsightsBookOutputShape = {
  ok: z.boolean(),
  itemIds: z.array(z.string()).optional(),
  // Pass-through; same posture as `getRecurringPayments.result`.
  result: z.unknown().optional(),
  errorCode: ErrorCodeEnum.optional(),
  requestId: z.string().optional(),
  message: z.string().optional(),
};

/**
 * Recursive `<untrusted>` wrap for the insights book payload, same idea
 * as the recurring-payments normalizer but kept as a separate function
 * so the two surfaces can diverge if Pluggy publishes a tighter schema
 * for one of them.
 */
function normalizeInsightsBook(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return wrapUntrusted(value);
  if (Array.isArray(value)) {
    return value.map((v) => normalizeInsightsBook(v));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Same posture as `normalizeRecurringPayments`: prototype-free output
    // object and explicit skip for `__proto__` / `constructor` / `prototype`.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(obj)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = normalizeInsightsBook(v);
    }
    return out;
  }
  return value;
}

/**
 * Hardcoded ceiling on the number of itemIds accepted per call. The
 * insights endpoint will happily accept large batches, but each id
 * appears in the URL query string and a runaway agent could hit our
 * per-tool rate limit with one giant call. Pluggy's docs don't pin a
 * hard limit; 25 is comfortably above any realistic LLM-driven workflow
 * (one user's portfolio rarely spans more than a handful of institutions)
 * and small enough that the resulting URL stays well under any sensible
 * proxy's URI length cap.
 */
const MAX_INSIGHTS_ITEM_IDS = 25;

export function registerGetInsightsBookTool(server: McpServer): void {
  const toolName = 'getInsightsBook';
  server.registerTool(
    toolName,
    {
      description:
        UNTRUSTED_PREAMBLE +
        '\n\n' +
        'Fetch the insights "book" — aggregated KPIs (cash flow, recurring ' +
        'income / expenses, account-level summaries) across one or more ' +
        'Pluggy Items. Premium Pluggy feature — your account may return ' +
        '403 if your plan does not include enrichment/insights. All ' +
        'free-text fields in the response are wrapped in <untrusted>. ' +
        'When PLUGGY_ITEM_IDS is configured, every supplied itemId is ' +
        'validated against the allowlist; ANY denial returns FORBIDDEN ' +
        'without calling the SDK.',
      inputSchema: {
        itemIds: z
          .array(z.string().uuid())
          .min(1)
          .max(MAX_INSIGHTS_ITEM_IDS)
          .describe(
            `One or more Pluggy Item ids (UUIDs). Max ${MAX_INSIGHTS_ITEM_IDS}.`,
          ),
      },
      outputSchema: GetInsightsBookOutputShape,
      annotations: {
        title: 'Get Insights Book (premium)',
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      const { itemIds } = args;
      const start = performance.now();
      let outcome: 'success' | 'error' = 'success';
      let errorCode: string | undefined;
      let requestId: string | undefined;
      let rateLimitReason: 'PER_MINUTE' | 'PER_DAY' | undefined;
      // Income / cash-flow aggregates are financial-behavior PII — flip
      // sensitive ONLY when we actually hit the upstream.
      let sensitive = false;
      try {
        const sec = loadSecurityConfig();
        const rl = sec.rateLimit
          ? checkRateLimit(toolName)
          : { allowed: true as const };
        if (!rl.allowed) {
          outcome = 'error';
          errorCode = 'LOCAL_RATE_LIMITED';
          rateLimitReason = rl.reason;
          const errorOutput = {
            ok: false as const,
            errorCode: 'LOCAL_RATE_LIMITED' as const,
            message: LOCAL_RATE_LIMITED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: LOCAL_RATE_LIMITED_MESSAGE }],
          };
        }

        // Validate EVERY id against the allowlist. The response envelope
        // carries a uniform FORBIDDEN message regardless of which id was
        // denied, so the LLM cannot infer which id was the bad one from
        // the envelope. (The allowlist is `null` when unset — `every`
        // returns true and we fall through.)
        const allAllowed = itemIds.every((id) => isItemAllowed(id));
        if (!allAllowed) {
          outcome = 'error';
          errorCode = 'FORBIDDEN';
          const errorOutput = {
            ok: false as const,
            errorCode: 'FORBIDDEN' as const,
            message: INSIGHTS_ITEM_NOT_ALLOWED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [
              { type: 'text' as const, text: INSIGHTS_ITEM_NOT_ALLOWED_MESSAGE },
            ],
          };
        }

        // Pluggy's insights book takes itemIds as a repeated `itemIds`
        // query parameter. URLSearchParams handles encoding for us.
        const params = new URLSearchParams();
        for (const id of itemIds) {
          params.append('itemIds', id);
        }
        const url = `${INSIGHTS_BOOK_URL}?${params.toString()}`;

        sensitive = true;
        const raw = await pluggyRawFetch(url, 'POST');
        const result = normalizeInsightsBook(raw);

        const output = { ok: true as const, itemIds, result };
        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              text: `Returned insights book for ${itemIds.length} item(s).`,
            },
          ],
        };
      } catch (err) {
        outcome = 'error';
        const safe = classifyAndReport(err, {
          tool: toolName,
          operation: 'insightsBook',
        });
        errorCode = safe.errorCode;
        requestId = safe.requestId;
        const errorOutput = {
          ok: false as const,
          errorCode: safe.errorCode,
          requestId: safe.requestId,
          message: safe.message,
        };
        return {
          isError: true,
          structuredContent: errorOutput,
          content: [{ type: 'text' as const, text: safe.message }],
        };
      } finally {
        audit({
          tool: toolName,
          outcome,
          errorCode,
          durationMs: Math.round(performance.now() - start),
          // We hash the FULL args object (so `argsHash` correlates calls
          // with the same itemIds list) but explicitly list no per-field
          // hash because `itemIds` is an array — `hashArgsSafely`'s
          // per-field branch only hashes string fields.
          ...hashArgsSafely(args, []),
          sensitive,
          requestId,
          rateLimitReason,
        });
      }
    },
  );
}
