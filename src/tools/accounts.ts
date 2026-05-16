/**
 * `getAccounts` tool — list the bank / credit-card accounts attached to a
 * given Pluggy Item. Read-only: only calls `GET /accounts?itemId=...`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPluggyClient } from '../pluggy/client.js';
import { toSafeError } from '../util/errors.js';

export function registerGetAccountsTool(server: McpServer): void {
  server.registerTool(
    'getAccounts',
    {
      description:
        'Retrieve all accounts (bank, credit card, etc.) belonging to a given ' +
        'Pluggy Item. An Item represents one user-institution connection.',
      inputSchema: {
        itemId: z
          .string()
          .min(1)
          .describe('The Pluggy Item id whose accounts should be fetched.'),
      },
    },
    async ({ itemId }) => {
      try {
        const client = getPluggyClient();
        const page = await client.fetchAccounts(itemId);

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${page.results.length} account(s) for item ${itemId}:\n${JSON.stringify(
                page.results,
                null,
                2,
              )}`,
            },
          ],
        };
      } catch (err) {
        const safe = toSafeError(err, { tool: 'getAccounts', operation: 'fetchAccounts' });
        return {
          isError: true,
          content: [{ type: 'text' as const, text: safe.message }],
        };
      }
    },
  );
}
