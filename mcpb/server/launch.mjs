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
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

const local = new StdioServerTransport();

// JSON-RPC id for our own re-initialize handshake. A string can never collide
// with the numeric ids Claude Desktop issues.
const REINIT_ID = '__etracker_reinit__';
const REINIT_TIMEOUT_MS = 30_000;

/** The client's `initialize` request, replayed when a remote session is gone. */
let initMessage;
let pendingReinit;
let remote = createRemote();

function createRemote() {
  const t = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'X-ET-Token': token } },
  });
  t.onmessage = (msg) => {
    if (pendingReinit && msg.id === REINIT_ID) {
      const resolve = pendingReinit;
      pendingReinit = undefined;
      resolve(msg);
      return;
    }
    local.send(msg).catch(shutdown);
  };
  // Only the transport we currently forward through may end the process; a
  // transport replaced by reconnect() closes as part of normal operation.
  t.onclose = () => {
    if (t === remote) shutdown();
  };
  t.onerror = (err) => console.error(`etracker-mcp (remote): ${err.message}`);
  return t;
}

let closing = false;
function shutdown(err) {
  if (err) console.error(`etracker-mcp: ${err instanceof Error ? err.message : err}`);
  if (closing) return;
  closing = true;
  Promise.allSettled([remote.close(), local.close()]).finally(() =>
    process.exit(err ? 1 : 0),
  );
}

/** The server forgot our session (restart or expiry); it wants a new one. */
function isSessionGone(err) {
  return err instanceof StreamableHTTPError && (err.code === 404 || err.code === 400);
}

/** Opens a fresh remote session by replaying the client's initialize handshake. */
async function reconnect() {
  if (!initMessage) throw new Error('cannot reconnect before initialize');
  const next = createRemote();
  await next.start();

  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReinit = undefined;
      reject(new Error('re-initialize timed out'));
    }, REINIT_TIMEOUT_MS);
    pendingReinit = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    next.send({ ...initMessage, id: REINIT_ID }).catch((err) => {
      clearTimeout(timer);
      pendingReinit = undefined;
      reject(err);
    });
  }).catch(async (err) => {
    await next.close().catch(() => undefined);
    throw err;
  });

  if (response.error) {
    await next.close().catch(() => undefined);
    throw new Error(`re-initialize rejected: ${response.error.message}`);
  }

  await next.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const previous = remote;
  remote = next;
  await previous.close().catch(() => undefined);
  console.error('etracker-mcp: remote session lost, re-initialized');
}

/** Reports a failed request back to the client instead of killing the bridge. */
function replyError(msg, err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`etracker-mcp (remote): ${message}`);
  if (msg.id === undefined || msg.id === null) return;
  local
    .send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } })
    .catch(shutdown);
}

// Transparently forward every JSON-RPC message in both directions.
local.onmessage = async (msg) => {
  if (msg.method === 'initialize') initMessage = msg;
  try {
    await remote.send(msg);
  } catch (err) {
    if (!isSessionGone(err) || msg.method === 'initialize') return replyError(msg, err);
    try {
      await reconnect();
      await remote.send(msg);
    } catch (retryErr) {
      replyError(msg, retryErr);
    }
  }
};
local.onclose = () => shutdown();
local.onerror = (err) => console.error(`etracker-mcp (stdio): ${err.message}`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown());

await remote.start();
await local.start();
console.error(`etracker-mcp: proxy ready → ${new URL(url).host}`);
