/**
 * `getItem` tool — fetch a single Pluggy Item by id. Read-only; only
 * calls `GET /items/{id}` via the SDK.
 *
 * An Item represents one user-institution connection. The response carries
 * connection state (`status`, `executionStatus`), the underlying connector,
 * and a couple of operator-supplied identifiers (`webhookUrl`,
 * `clientUserId`) that are surfaced cautiously — `clientUserId` is the
 * customer's identifier on the operator's side and is treated as PII.
 *
 * Items allowlist: when `PLUGGY_ITEM_IDS` is set, this tool refuses to
 * call the SDK for any itemId not in the configured list. Refusal goes
 * out as a `FORBIDDEN` envelope with a hardcoded message — no upstream
 * round-trip occurs.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { getPluggyClient } from '../pluggy/client.js';
import { ErrorCodeEnum, classifyAndReport } from '../util/errors.js';
import { loadSecurityConfig, isItemAllowed } from '../config.js';
import {
  audit,
  checkRateLimit,
  hashArgsSafely,
  wrapUntrusted,
  redactOwnerName,
  UNTRUSTED_PREAMBLE,
  LOCAL_RATE_LIMITED_MESSAGE,
} from '../security/index.js';

/**
 * Hardcoded user-facing message for allowlist denials. Lives at module
 * scope so every tool that needs it speaks with one voice — same posture
 * as `LOCAL_RATE_LIMITED_MESSAGE` in `src/security/rateLimit.ts`. Never
 * interpolates the offending id (that would leak the operator's allow/deny
 * decision into the LLM context).
 */
export const ITEM_NOT_ALLOWED_MESSAGE =
  'This itemId is not in PLUGGY_ITEM_IDS allowlist.';

const ItemProductStepWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  providerMessage: z.string().optional(),
});

const ItemProductStateSchema = z.object({
  isUpdated: z.boolean(),
  lastUpdatedAt: z.union([z.string(), z.date()]).nullable(),
  warnings: z.array(ItemProductStepWarningSchema).optional(),
});

const ItemSchema = z.object({
  id: z.string().describe('Pluggy Item id'),
  connectorId: z.number().describe('Underlying connector id'),
  connectorName: z.string().describe('Underlying connector name (institution)'),
  status: z.string().describe('Current item status (e.g. UPDATED, LOGIN_ERROR)'),
  executionStatus: z.string().describe('Current execution status'),
  statusDetail: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUpdatedAt: z.string().nullable(),
  // PII — see redaction note above. clientUserId is the operator's own
  // identifier for the end-user; not guaranteed to be a UUID.
  clientUserId: z.string().nullable(),
  webhookUrl: z.string().nullable(),
  consecutiveFailedLoginAttempts: z.number(),
  nextAutoSyncAt: z.string().nullable(),
  // We deliberately omit `userAction` and `parameter` from the surfaced
  // shape — they are MFA/credential-handshake payloads that don't belong
  // in an LLM context.
});

const GetItemOutputShape = {
  ok: z.boolean().describe('true on success, false when an error envelope is returned'),
  item: ItemSchema.optional(),
  errorCode: ErrorCodeEnum.optional(),
  requestId: z.string().optional().describe('Correlation id present in stderr logs'),
  message: z.string().optional().describe('Model-actionable error message'),
};

function dateToIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function registerGetItemTool(server: McpServer): void {
  const toolName = 'getItem';
  server.registerTool(
    toolName,
    {
      description:
        UNTRUSTED_PREAMBLE +
        '\n\n' +
        'Fetch a single Pluggy Item by id. An Item represents one ' +
        'user-institution connection — its `status` and `executionStatus` ' +
        'tell you whether new data is available, whether the connection ' +
        'requires user action, or whether the credentials are stale. ' +
        'When the server is configured with PLUGGY_ITEM_IDS, only ids in ' +
        'the allowlist will be fetched; others return a FORBIDDEN envelope.',
      inputSchema: {
        itemId: z
          .string()
          .uuid()
          .describe('The Pluggy Item id (UUID) to fetch.'),
      },
      outputSchema: GetItemOutputShape,
      annotations: {
        title: 'Get Pluggy Item',
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
      try {
        const sec = loadSecurityConfig();
        const rl = sec.rateLimit
          ? checkRateLimit(toolName)
          : { allowed: true as const, retryAfterMs: undefined, reason: undefined };
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

        // Allowlist check BEFORE building the client — keeps the SDK call
        // count and Pluggy's billable usage to zero for denied ids.
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

        const client = getPluggyClient();
        const it = await client.fetchItem(itemId);

        // `clientUserId` is the operator's PII bridge — treat it like a
        // person name (mask via `redactOwnerName`) when redaction is on
        // so a UUID stays as-is but a human-shaped value gets initials.
        const { redact } = sec;
        const item = {
          id: it.id,
          connectorId: it.connector.id,
          connectorName: wrapUntrusted(it.connector.name) ?? it.connector.name,
          status: it.status,
          executionStatus: it.executionStatus,
          statusDetail: (it.statusDetail as Record<string, unknown> | null) ?? null,
          createdAt: dateToIso(it.createdAt) ?? '',
          updatedAt: dateToIso(it.updatedAt) ?? '',
          lastUpdatedAt: dateToIso(it.lastUpdatedAt),
          clientUserId: redact ? redactOwnerName(it.clientUserId) : it.clientUserId,
          // webhookUrl is operator-controlled — pass through; not free
          // text from a bank.
          webhookUrl: it.webhookUrl,
          consecutiveFailedLoginAttempts: it.consecutiveFailedLoginAttempts,
          nextAutoSyncAt: dateToIso(it.nextAutoSyncAt),
        };

        const output = { ok: true as const, item };
        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              // Generic — the structured channel carries the id; keep the
              // free-text line out of transcripts.
              text: `Item ${it.id} status=${it.status}.`,
            },
          ],
        };
      } catch (err) {
        outcome = 'error';
        const safe = classifyAndReport(err, {
          tool: toolName,
          operation: 'fetchItem',
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
          requestId,
          rateLimitReason,
        });
      }
    },
  );
}
