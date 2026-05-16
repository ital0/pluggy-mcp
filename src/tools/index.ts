/**
 * Tool registration barrel.
 *
 * Each per-domain module owns its own schemas and handler. Adding a tool
 * is a matter of writing one file and adding a call here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerListConnectorsTool,
  registerGetConnectorTool,
} from './connectors.js';
import {
  registerGetAccountsTool,
  registerGetRawAccountDetailsTool,
  registerGetAccountTool,
  registerGetRealTimeBalanceTool,
} from './accounts.js';
import { registerGetItemTool } from './items.js';
import {
  registerListConsentsTool,
  registerGetConsentTool,
} from './consents.js';
import {
  registerListTransactionsTool,
  registerGetTransactionTool,
} from './transactions.js';
import {
  registerListCategoriesTool,
  registerGetCategoryTool,
} from './categories.js';

export function registerAllTools(server: McpServer): void {
  // Connectors (no-PII reference data).
  registerListConnectorsTool(server);
  registerGetConnectorTool(server);
  // Items (operator-scoped via PLUGGY_ITEM_IDS).
  registerGetItemTool(server);
  registerListConsentsTool(server);
  registerGetConsentTool(server);
  // Accounts (masked-by-default; raw variant audit-logged).
  registerGetAccountsTool(server);
  registerGetAccountTool(server);
  registerGetRawAccountDetailsTool(server);
  registerGetRealTimeBalanceTool(server);
  // Transactions (heaviest PII surface; payer/receiver redacted, free
  // text wrapped in <untrusted>).
  registerListTransactionsTool(server);
  registerGetTransactionTool(server);
  // Categories (global taxonomy; no PII).
  registerListCategoriesTool(server);
  registerGetCategoryTool(server);
}
