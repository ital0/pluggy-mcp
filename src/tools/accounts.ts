/**
 * `getAccounts` tool — list the bank / credit-card accounts attached to a
 * given Pluggy Item. Read-only: only calls `GET /accounts?itemId=...`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPluggyClient } from '../pluggy/client.js';
import { ErrorCodeEnum, classifyAndReport } from '../util/errors.js';

// NOTE: PII fields (taxNumber/CPF, owner full name, full account number, email, phone, address)
// are intentionally omitted from PR1's output. They will be added back in PR2 with proper masking
// (e.g. taxNumber -> ***.***.***-NN, number -> ****-NNNN, owner -> first name + initial).
// Per pluggy-sdk types, the only PII fields actually exposed by the Account/BankData/CreditData
// shapes are `number`, `owner`, and `taxNumber`. Email/phone/address aren't on the SDK type at
// all, but the omit list above documents intent for PR2.

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
  balance: z.number().describe('Current balance in account currency'),
  name: z.string().describe('Account name / description'),
  marketingName: z.string().nullable(),
  currencyCode: z.string().describe('ISO 4217 currency code'),
  bankData: BankDataSchema.nullable(),
  creditData: CreditDataSchema.nullable(),
});

// Flat output shape — `z.discriminatedUnion` can't be passed to
// `registerTool`'s `outputSchema` because the SDK wraps the argument in
// `z.object(...)`. Both branches still share a single discriminator
// (`ok`) and the tool callback emits a consistent shape per branch.
const GetAccountsOutputShape = {
  ok: z.boolean().describe('true on success, false when an error envelope is returned'),
  // Success-only fields.
  itemId: z.string().optional().describe('Echo of the requested itemId'),
  total: z.number().optional(),
  truncated: z
    .boolean()
    .optional()
    .describe('True when more results exist than were returned (page 1 only).'),
  accounts: z.array(AccountSchema).optional(),
  // Error-only fields.
  errorCode: ErrorCodeEnum.optional(),
  requestId: z.string().optional().describe('Correlation id present in stderr logs'),
  message: z.string().optional().describe('Model-actionable error message'),
};

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
      outputSchema: GetAccountsOutputShape,
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

        // Explicit field-by-field mapping: PII fields (number, owner, taxNumber)
        // are intentionally NOT forwarded — they'll come back in PR2 with masking.
        const accounts = page.results.map((a) => ({
          id: a.id,
          itemId: a.itemId,
          type: a.type,
          subtype: a.subtype,
          balance: a.balance,
          name: a.name,
          marketingName: a.marketingName,
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

        const total = page.total ?? accounts.length;
        const truncated = total > accounts.length;

        if (truncated) {
          console.error(
            JSON.stringify({
              ts: new Date().toISOString(),
              tool: 'getAccounts',
              event: 'truncated',
              itemId,
              total,
              returned: accounts.length,
            }),
          );
        }

        const output = {
          ok: true as const,
          itemId,
          total,
          truncated,
          accounts,
        };

        return {
          structuredContent: output,
          content: [
            {
              type: 'text' as const,
              text: truncated
                ? `Found ${output.accounts.length} of ${total} account(s) for item ${itemId} (truncated; pagination ships in a later PR).`
                : `Found ${output.accounts.length} account(s) for item ${itemId}.`,
            },
          ],
        };
      } catch (err) {
        const safe = classifyAndReport(err, {
          tool: 'getAccounts',
          operation: 'fetchAccounts',
        });
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
      }
    },
  );
}
