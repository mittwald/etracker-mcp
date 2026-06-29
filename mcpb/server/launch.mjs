#!/usr/bin/env node
// Launcher for the etracker MCP Desktop Extension (.mcpb).
// Bridges Claude Desktop (stdio) to the remote Streamable-HTTP MCP server,
// injecting the user's etracker token as the X-ET-Token header.
//
// The bridge runs in-process on Claude Desktop's built-in Node: it forwards
// JSON-RPC messages between a stdio server transport and a Streamable-HTTP
// client transport. No child process, no npx, and no local OAuth callback
// socket — the only I/O is stdin/stdout and the outbound HTTPS request — so it
// works identically on macOS (incl. the sandboxed app), Windows and Linux.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.ETRACKER_MCP_URL?.trim();
const token = process.env.ETRACKER_TOKEN?.trim();

if (!url) {
  console.error('etracker-mcp: missing server URL (set the "Server URL" field).');
  process.exit(1);
}
if (!token) {
  console.error('etracker-mcp: missing access token (set the "etracker Access Token" field).');
  process.exit(1);
}

const remote = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { 'X-ET-Token': token } },
});
const local = new StdioServerTransport();

let closing = false;
function shutdown(err) {
  if (err) console.error(`etracker-mcp: ${err instanceof Error ? err.message : err}`);
  if (closing) return;
  closing = true;
  Promise.allSettled([remote.close(), local.close()]).finally(() =>
    process.exit(err ? 1 : 0),
  );
}

// Transparently forward every JSON-RPC message in both directions.
local.onmessage = (msg) => remote.send(msg).catch(shutdown);
remote.onmessage = (msg) => local.send(msg).catch(shutdown);
local.onclose = () => shutdown();
remote.onclose = () => shutdown();
local.onerror = (err) => console.error(`etracker-mcp (stdio): ${err.message}`);
remote.onerror = (err) => console.error(`etracker-mcp (remote): ${err.message}`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown());

await remote.start();
await local.start();
console.error(`etracker-mcp: proxy ready → ${new URL(url).host}`);
