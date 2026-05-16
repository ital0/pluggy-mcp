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
  // Process-level safety net. A stdio MCP server lives or dies with its
  // pipes — exiting on a stray promise rejection would orphan the host
  // mid-conversation. We log and stay up so the host can surface the
  // error and the operator can grep stderr for `event=...`.
  process.on('unhandledRejection', (reason) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'unhandledRejection',
        reason: String(reason),
      }),
    );
  });
  process.on('uncaughtException', (err) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'uncaughtException',
        name: err?.name ?? null,
        message: err?.message ?? null,
      }),
    );
    // Deliberately do NOT exit — keep the stdio pipe alive so the host
    // can surface the error and the operator can decide what to do.
  });

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

  // Graceful shutdown: respect MCP host lifecycle signals so any in-flight
  // requests get a chance to finish and the stdio pipe is closed cleanly.
  // A once-only guard prevents a double-signal (e.g. Ctrl-C twice) from
  // racing through `server.close()` twice.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown', signal }),
    );
    try {
      await server.close();
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'shutdown_error',
          message: (err as Error)?.message ?? null,
        }),
      );
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[pluggy-mcp] fatal startup error:', err);
  process.exit(1);
});
