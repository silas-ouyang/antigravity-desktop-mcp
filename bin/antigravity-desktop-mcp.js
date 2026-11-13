#!/usr/bin/env node
/**
 * Executable CLI entry point for antigravity-desktop-mcp stdio MCP server.
 */
import { createDesktopMcpServer } from '../src/server.js';

const args = new Set(process.argv.slice(2));
const server = createDesktopMcpServer({
  autoBootOverlay: true,
  allowIpcResume: args.has('--allow-ipc-resume'),
});

const handleSignal = () => {
  void server.shutdown().finally(() => process.exit(0));
};

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
process.on('uncaughtException', (err) => {
  process.stderr.write(`[antigravity-desktop-mcp] uncaughtException: ${err?.stack ?? err}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[antigravity-desktop-mcp] unhandledRejection: ${reason?.stack ?? reason}\n`);
});

server.start();
