/**
 * `listConnectors` tool — surfaces all financial institutions Pluggy can
 * connect to. This is strictly read-only: it only calls `GET /connectors`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getPluggyClient } from '../pluggy/client.js';
import { toSafeError } from '../util/errors.js';

export function registerListConnectorsTool(server: McpServer): void {
  server.registerTool(
    'listConnectors',
    {
      description:
        'List all financial institutions (connectors) available through Pluggy. ' +
        'Use this to discover which banks, brokers, and other institutions a user ' +
        'can link, and to obtain the `connectorId` needed to create an item.',
      inputSchema: {
        // Intentionally empty — `GET /connectors` returns the full list.
      },
    },
    async () => {
      try {
        const client = getPluggyClient();
        const page = await client.fetchConnectors();

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${page.results.length} Pluggy connector(s):\n${JSON.stringify(
                page.results,
                null,
                2,
              )}`,
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
