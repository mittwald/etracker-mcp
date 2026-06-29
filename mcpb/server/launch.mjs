#!/usr/bin/env node
// Launcher for the etracker MCP Desktop Extension (.mcpb).
// Bridges Claude Desktop (stdio) to the remote Streamable-HTTP MCP server via
// mcp-remote, injecting the user's etracker token as the X-ET-Token header.
// URL and token come from env, populated from user_config by the manifest.
//
// mcp-remote is bundled inside the extension and started with the current Node
// binary (no npx, no shell) so the same code path works on macOS, Windows and
// Linux and the token is never passed through a shell.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

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

const require = createRequire(import.meta.url);
const proxy = require.resolve('mcp-remote/dist/proxy.js');

const child = spawn(
  process.execPath,
  [proxy, url, '--header', `X-ET-Token: ${token}`],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error(`etracker-mcp: failed to start mcp-remote: ${err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
