/**
 * `listConnectors` tool — surfaces all financial institutions Pluggy can
 * connect to. This is strictly read-only: it only calls `GET /connectors`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { getPluggyClient } from '../pluggy/client.js';
import { ErrorCodeEnum, classifyAndReport } from '../util/errors.js';
import { audit, checkRateLimit, hashForAudit } from '../security/index.js';

// Hardcoded — same posture as `src/util/errors.ts`; never let runtime
// state leak into the model-facing string.
const RATE_LIMITED_MESSAGE =
  'Rate limit exceeded for this MCP tool. Wait a moment before retrying.';

// Subset of the SDK's Connector shape — we expose only stable fields that
// are useful for an LLM picking a connector. The SDK adds new optional
// fields over time, so we keep this loose with `.passthrough()`-style
// helpers where appropriate.
const ConnectorSchema = z.object({
  id: z.number().describe('Pluggy connector id'),
  name: z.string().describe('Institution name'),
  institutionUrl: z.string().describe('Institution website URL'),
  imageUrl: z.string().describe('Institution logo URL'),
  primaryColor: z.string().describe('Brand color (hex)'),
  type: z
    .enum([
      'PERSONAL_BANK',
      'BUSINESS_BANK',
      'INVOICE',
      'INVESTMENT',
      'TELECOMMUNICATION',
      'DIGITAL_ECONOMY',
      'PAYMENT_ACCOUNT',
      'OTHER',
    ])
    .describe('Connector category'),
  country: z.string().describe('ISO country code, e.g. BR'),
  hasMFA: z.boolean(),
  oauth: z.boolean().optional(),
  isOpenFinance: z.boolean(),
  isSandbox: z.boolean(),
  supportsPaymentInitiation: z.boolean(),
  supportsScheduledPayments: z.boolean(),
  supportsSmartTransfers: z.boolean(),
  products: z.array(z.string()).describe('Products available on this connector'),
  health: z
    .object({
      status: z.enum(['ONLINE', 'OFFLINE', 'UNSTABLE']),
      stage: z.enum(['BETA']).nullable(),
    })
    .describe('Real-time connector availability'),
});

// `outputSchema` is wrapped by the SDK in `z.object(...)`, so we can't pass
// a `z.discriminatedUnion`. Instead we declare a flat shape that contains
// fields from both the success and error variants, with `ok` as the
// discriminator. Variant-specific fields are optional at the SDK level;
// the tool callback always emits one consistent shape per branch so
// downstream consumers can switch on `ok` reliably.
const ListConnectorsOutputShape = {
  ok: z.boolean().describe('true on success, false when an error envelope is returned'),
  // Success-only fields.
  total: z.number().optional().describe('Total connectors reported by Pluggy'),
  truncated: z
    .boolean()
    .optional()
    .describe('True when more results exist than were returned (page 1 only).'),
  connectors: z.array(ConnectorSchema).optional(),
  // Error-only fields.
  errorCode: ErrorCodeEnum.optional(),
  requestId: z.string().optional().describe('Correlation id present in stderr logs'),
  message: z.string().optional().describe('Model-actionable error message'),
};

export function registerListConnectorsTool(server: McpServer): void {
  server.registerTool(
    'listConnectors',
    {
      description:
        'List all financial institutions (connectors) available through Pluggy. ' +
        'Use this to discover which banks, brokers, and other institutions a user ' +
        'can link, and to obtain the `connectorId` needed to create an item.',
      inputSchema: {
        // Intentionally empty — `GET /connectors` returns the full list and
        // server-side filters live on a follow-up tool (added in PR2+).
      },
      outputSchema: ListConnectorsOutputShape,
      annotations: {
        title: 'List Pluggy Connectors',
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
      try {
        const rl = checkRateLimit('listConnectors');
        if (!rl.allowed) {
          outcome = 'error';
          errorCode = 'RATE_LIMITED';
          const errorOutput = {
            ok: false as const,
            errorCode: 'RATE_LIMITED' as const,
            message: RATE_LIMITED_MESSAGE,
          };
          return {
            isError: true,
            structuredContent: errorOutput,
            content: [{ type: 'text' as const, text: RATE_LIMITED_MESSAGE }],
          };
        }

        const client = getPluggyClient();
        const page = await client.fetchConnectors();

        // Re-shape into our outputSchema — the SDK may add fields we don't
        // currently advertise; only forward what we documented.
        const connectors = page.results.map((c) => ({
          id: c.id,
          name: c.name,
          institutionUrl: c.institutionUrl,
          imageUrl: c.imageUrl,
          primaryColor: c.primaryColor,
          type: c.type,
          country: c.country,
          hasMFA: c.hasMFA,
          oauth: c.oauth,
          isOpenFinance: c.isOpenFinance,
          isSandbox: c.isSandbox,
          supportsPaymentInitiation: c.supportsPaymentInitiation,
          supportsScheduledPayments: c.supportsScheduledPayments,
          supportsSmartTransfers: c.supportsSmartTransfers,
          products: c.products,
          health: {
            status: c.health.status,
            stage: c.health.stage,
          },
        }));

        const total = page.total ?? connectors.length;
        const truncated = total > connectors.length;

        if (truncated) {
          // Signal to operators that pagination is missing — the LLM also
          // sees `truncated: true` in structuredContent (full pagination
          // ships in PR3+).
          console.error(
            JSON.stringify({
              ts: new Date().toISOString(),
              tool: 'listConnectors',
              event: 'truncated',
              total,
              returned: connectors.length,
            }),
          );
        }

        const output = {
          ok: true as const,
          total,
          truncated,
          connectors,
        };

        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              text: truncated
                ? `Found ${connectors.length} of ${total} Pluggy connector(s) (truncated; pagination ships in a later PR).`
                : `Found ${connectors.length} Pluggy connector(s).`,
            },
          ],
        };
      } catch (err) {
        outcome = 'error';
        const safe = classifyAndReport(err, {
          tool: 'listConnectors',
          operation: 'fetchConnectors',
        });
        errorCode = safe.errorCode;
        requestId = safe.requestId;
        // Must include `structuredContent` even on errors when an
        // `outputSchema` is declared — the SDK throws McpError otherwise.
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
          tool: 'listConnectors',
          outcome,
          errorCode,
          durationMs: Math.round(performance.now() - start),
          // No inputs to hash — listConnectors takes no args. The
          // `argsHash` field is omitted entirely so the audit line stays
          // honest about there being nothing to fingerprint.
          argsHash: hashForAudit({}),
          requestId,
        });
      }
    },
  );
}
