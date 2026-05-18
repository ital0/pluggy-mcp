/**
 * `listCategories` / `getCategory` tools.
 *
 * Categories are the canonical taxonomy Pluggy assigns to transactions
 * (`categoryId` on a Transaction maps to one of these). They are global
 * (not per-item), entirely public, contain no PII, and the descriptions
 * are short Pluggy-controlled enum-like strings — so no `<untrusted>`
 * wrapping and no redaction.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { getPluggyClient } from '../pluggy/client.js';
import { ErrorCodeEnum, classifyAndReport } from '../util/errors.js';
import { ensureOutputShape } from '../util/outputShape.js';
import { loadSecurityConfig } from '../config.js';
import { logEvent } from '../util/log.js';
import {
  audit,
  checkRateLimit,
  hashArgsSafely,
  LOCAL_RATE_LIMITED_MESSAGE,
} from '../security/index.js';

const CategorySchema = z.object({
  id: z.string().describe('Pluggy category id'),
  description: z.string().describe('Human-readable category name'),
  parentId: z.string().optional().describe('Parent category id, when nested'),
  parentDescription: z
    .string()
    .optional()
    .describe('Parent category description, when nested'),
});

// Single source of truth — see `transactions.ts` for rationale.
const ListCategoriesOutputSchema = z.object({
  ok: z.boolean(),
  total: z.number().optional(),
  truncated: z.boolean().optional(),
  categories: z.array(CategorySchema).optional(),
  errorCode: ErrorCodeEnum.optional(),
  requestId: z.string().optional(),
  message: z.string().optional(),
});

const GetCategoryOutputSchema = z.object({
  ok: z.boolean(),
  category: CategorySchema.optional(),
  errorCode: ErrorCodeEnum.optional(),
  requestId: z.string().optional(),
  message: z.string().optional(),
});

export function registerListCategoriesTool(server: McpServer): void {
  const toolName = 'listCategories';
  server.registerTool(
    toolName,
    {
      description:
        "List Pluggy's transaction category taxonomy. Use this to translate a " +
        '`categoryId` on a Transaction into a human-readable label, or to ' +
        'discover the full set of categories before driving downstream ' +
        'analytics. Categories are global and contain no PII.',
      inputSchema: {
        // No-arg; Pluggy returns the full taxonomy in a single page.
      },
      outputSchema: ListCategoriesOutputSchema.shape,
      annotations: {
        title: 'List Pluggy Categories',
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      const start = performance.now();
      let outcome: 'success' | 'error' = 'success';
      let errorCode: string | undefined;
      let requestId: string | undefined;
      let rateLimitReason: 'PER_MINUTE' | 'PER_DAY' | undefined;
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

        const client = getPluggyClient();
        const page = await client.fetchCategories();

        const categories = page.results.map((c) => ({
          id: c.id,
          description: c.description,
          parentId: c.parentId,
          parentDescription: c.parentDescription,
        }));

        const total = page.total ?? categories.length;
        const truncated = total > categories.length;

        if (truncated) {
          logEvent('truncated', {
            tool: toolName,
            total,
            returned: categories.length,
          });
        }

        const output = {
          ok: true as const,
          total,
          truncated,
          categories,
        };
        ensureOutputShape(ListCategoriesOutputSchema, output, { tool: toolName });
        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              text: truncated
                ? `Returned ${categories.length} of ${total} categories (truncated; pagination ships in a later PR).`
                : `Returned ${categories.length} categories.`,
            },
          ],
        };
      } catch (err) {
        outcome = 'error';
        const safe = classifyAndReport(err, {
          tool: toolName,
          operation: 'fetchCategories',
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
          ...hashArgsSafely({}, []),
          requestId,
          rateLimitReason,
        });
      }
    },
  );
}

export function registerGetCategoryTool(server: McpServer): void {
  const toolName = 'getCategory';
  server.registerTool(
    toolName,
    {
      description:
        'Fetch a single Pluggy category by id. Useful when resolving a ' +
        'single `categoryId` from a Transaction without pulling the whole ' +
        'taxonomy.',
      inputSchema: {
        // Pluggy category ids are stable short strings (e.g. "01000000")
        // — NOT UUIDs. We accept any non-empty string here.
        categoryId: z.string().min(1).describe('The Pluggy category id.'),
      },
      outputSchema: GetCategoryOutputSchema.shape,
      annotations: {
        title: 'Get Pluggy Category',
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ categoryId }) => {
      const start = performance.now();
      let outcome: 'success' | 'error' = 'success';
      let errorCode: string | undefined;
      let requestId: string | undefined;
      let rateLimitReason: 'PER_MINUTE' | 'PER_DAY' | undefined;
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

        const client = getPluggyClient();
        const c = await client.fetchCategory(categoryId);
        const category = {
          id: c.id,
          description: c.description,
          parentId: c.parentId,
          parentDescription: c.parentDescription,
        };

        const output = { ok: true as const, category };
        ensureOutputShape(GetCategoryOutputSchema, output, { tool: toolName });
        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              text: `Category ${c.id}: ${c.description}.`,
            },
          ],
        };
      } catch (err) {
        outcome = 'error';
        const safe = classifyAndReport(err, {
          tool: toolName,
          operation: 'fetchCategory',
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
          ...hashArgsSafely({ categoryId }, ['categoryId']),
          requestId,
          rateLimitReason,
        });
      }
    },
  );
}
