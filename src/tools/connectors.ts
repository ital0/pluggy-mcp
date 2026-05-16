/**
 * `listConnectors` tool — surfaces all financial institutions Pluggy can
 * connect to. This is strictly read-only: it only calls `GET /connectors`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPluggyClient } from '../pluggy/client.js';
import { toSafeError } from '../util/errors.js';

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

const ListConnectorsOutputSchema = z.object({
  total: z.number().describe('Total connectors returned'),
  connectors: z.array(ConnectorSchema),
});

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
      outputSchema: ListConnectorsOutputSchema.shape,
      annotations: {
        title: 'List Pluggy Connectors',
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
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

        const output = {
          total: page.total ?? connectors.length,
          connectors,
        };

        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              text: `Found ${output.connectors.length} Pluggy connector(s).`,
            },
          ],
        };
      } catch (err) {
        const safe = toSafeError(err, { tool: 'listConnectors', operation: 'fetchConnectors' });
        return {
          isError: true,
          content: [{ type: 'text' as const, text: safe.message }],
        };
      }
    },
  );
}
