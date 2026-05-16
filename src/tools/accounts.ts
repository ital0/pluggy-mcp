/**
 * `getAccounts` tool — list the bank / credit-card accounts attached to a
 * given Pluggy Item. Read-only: only calls `GET /accounts?itemId=...`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPluggyClient } from '../pluggy/client.js';
import { toSafeError } from '../util/errors.js';

const BankDataSchema = z.object({
  transferNumber: z.string().nullable(),
  closingBalance: z.number().nullable(),
  automaticallyInvestedBalance: z.number().nullable(),
  overdraftUsedLimit: z.number().nullable(),
  unarrangedOverdraftAmount: z.number().nullable(),
});

const CreditDataSchema = z.object({
  level: z.string().nullable(),
  brand: z.string().nullable(),
  balanceCloseDate: z.union([z.string(), z.date()]).nullable(),
  balanceDueDate: z.union([z.string(), z.date()]).nullable(),
  availableCreditLimit: z.number().nullable(),
  balanceForeignCurrency: z.number().nullable(),
  minimumPayment: z.number().nullable(),
  creditLimit: z.number().nullable(),
  isLimitFlexible: z.boolean().nullable(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'CANCELLED']).nullable(),
  holderType: z.enum(['MAIN', 'ADDITIONAL']).nullable(),
});

const AccountSchema = z.object({
  id: z.string().describe('Account id'),
  itemId: z.string().describe('Parent Pluggy Item id'),
  type: z.enum(['BANK', 'CREDIT']),
  subtype: z.enum(['SAVINGS_ACCOUNT', 'CHECKING_ACCOUNT', 'CREDIT_CARD']),
  number: z.string().describe('Institution-issued account number'),
  balance: z.number().describe('Current balance in account currency'),
  name: z.string().describe('Account name / description'),
  marketingName: z.string().nullable(),
  owner: z.string().nullable(),
  taxNumber: z.string().nullable(),
  currencyCode: z.string().describe('ISO 4217 currency code'),
  bankData: BankDataSchema.nullable(),
  creditData: CreditDataSchema.nullable(),
});

const GetAccountsOutputSchema = z.object({
  itemId: z.string().describe('Echo of the requested itemId'),
  total: z.number(),
  accounts: z.array(AccountSchema),
});

export function registerGetAccountsTool(server: McpServer): void {
  server.registerTool(
    'getAccounts',
    {
      description:
        'Retrieve all accounts (bank, credit card, etc.) belonging to a given ' +
        'Pluggy Item. An Item represents one user-institution connection — call ' +
        '`listConnectors` first to discover institutions and create items via the ' +
        'Pluggy dashboard or your own backend to obtain an `itemId`.',
      inputSchema: {
        itemId: z
          .string()
          .min(1)
          .describe('The Pluggy Item id whose accounts should be fetched.'),
      },
      outputSchema: GetAccountsOutputSchema.shape,
      annotations: {
        title: 'Get Pluggy Accounts',
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ itemId }) => {
      try {
        const client = getPluggyClient();
        const page = await client.fetchAccounts(itemId);

        const accounts = page.results.map((a) => ({
          id: a.id,
          itemId: a.itemId,
          type: a.type,
          subtype: a.subtype,
          number: a.number,
          balance: a.balance,
          name: a.name,
          marketingName: a.marketingName,
          owner: a.owner,
          taxNumber: a.taxNumber,
          currencyCode: a.currencyCode,
          bankData: a.bankData,
          // The SDK returns Date for credit-card balance dates; serialise to
          // ISO strings so the JSON envelope is stable and validates.
          creditData: a.creditData
            ? {
                ...a.creditData,
                balanceCloseDate:
                  a.creditData.balanceCloseDate instanceof Date
                    ? a.creditData.balanceCloseDate.toISOString()
                    : a.creditData.balanceCloseDate,
                balanceDueDate:
                  a.creditData.balanceDueDate instanceof Date
                    ? a.creditData.balanceDueDate.toISOString()
                    : a.creditData.balanceDueDate,
              }
            : null,
        }));

        const output = {
          itemId,
          total: page.total ?? accounts.length,
          accounts,
        };

        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              text: `Found ${output.accounts.length} account(s) for item ${itemId}.`,
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
