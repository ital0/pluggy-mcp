#!/usr/bin/env node
/**
 * MCP stdio entry point for pluggy-mcp.
 *
 * IMPORTANT: stdio MCP servers MUST keep stdout reserved for JSON-RPC
 * traffic. All logging here goes to stderr (`console.error`).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_INFO, loadPluggyConfig } from './config.js';
import { registerAllTools } from './tools/index.js';

async function main(): Promise<void> {
  const server = new McpServer({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
  });

  registerAllTools(server);

  // Surface a startup hint to the operator without crashing — the server
  // can still serve `tools/list`, and individual tools will return a safe
  // error if they're invoked without credentials.
  if (!loadPluggyConfig()) {
    console.error(
      '[pluggy-mcp] PLUGGY_CLIENT_ID and/or PLUGGY_CLIENT_SECRET are not set. ' +
        'Tools will return errors until both are configured.',
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[pluggy-mcp] ${SERVER_INFO.name} v${SERVER_INFO.version} ready on stdio.`);
}

main().catch((err) => {
  console.error('[pluggy-mcp] fatal startup error:', err);
  process.exit(1);
});
