/**
 * Tool registration barrel.
 *
 * Each per-domain module owns its own schemas and handler. Adding a tool
 * is a matter of writing one file and adding a call here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListConnectorsTool } from './connectors.js';
import { registerGetAccountsTool } from './accounts.js';

export function registerAllTools(server: McpServer): void {
  registerListConnectorsTool(server);
  registerGetAccountsTool(server);
}
