import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HOST, loadConfig } from './config.js';
import { logger } from './logger.js';
import { tools } from './tools.js';
import { EtrackerApiError, EtrackerClient } from './etracker-client.js';

const VERSION = '0.1.0';
const MAX_BODY_BYTES = 1_000_000;

const config = loadConfig();

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function tokenFromRequest(req: IncomingMessage): string | null {
  const token = header(req, 'x-et-token');
  return token && token.trim() ? token.trim() : null;
}

function buildMcpServer(client: EtrackerClient): Server {
  const server = new Server(
    { name: 'etracker-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.inputSchema, { target: 'draft-7' }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      logger.warn('unknown tool requested', { tool: request.params.name });
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      };
    }
    const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Invalid arguments: ${parsed.error.message}` },
        ],
      };
    }

    const start = Date.now();
    try {
      const result = await tool.handler(client, parsed.data);
      logger.info('tool.call', {
        tool: tool.name,
        durationMs: Date.now() - start,
        ok: true,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const isApi = err instanceof EtrackerApiError;
      logger.warn('tool.call.failed', {
        tool: tool.name,
        durationMs: Date.now() - start,
        kind: isApi ? 'etracker_api' : 'unknown',
        status: isApi ? err.status : undefined,
      });
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      };
    }
  });

  return server;
}

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: Server;
};

const sessions = new Map<string, SessionEntry>();

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: message }));
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const reqStart = Date.now();
  if (!req.url) {
    sendError(res, 400, 'missing URL');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, version: VERSION }));
    return;
  }

  if (url.pathname !== '/mcp') {
    sendError(res, 404, 'not found');
    return;
  }

  let mcpStatus: number | undefined;
  try {
    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    const body = req.method === 'POST' ? await readBody(req) : undefined;

    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (!entry) {
      const token = tokenFromRequest(req);
      if (!token) {
        mcpStatus = 401;
        sendError(
          res,
          401,
          'Missing etracker access token. Send the X-ET-Token request header.',
        );
        return;
      }

      const client = new EtrackerClient({ apiUrl: config.apiUrl, token });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
          logger.info('session.opened', { sessionId: id, target: config.apiUrl });
        },
      });
      const server = buildMcpServer(client);
      await server.connect(transport);
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          logger.info('session.closed', { sessionId: transport.sessionId });
        }
      };
      entry = { transport, server };
    }

    await entry.transport.handleRequest(req, res, body);
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode ?? 500;
    mcpStatus = status;
    logger.error('request.failed', {
      path: url.pathname,
      method: req.method,
      status,
      err: err instanceof Error ? err.message : String(err),
    });
    sendError(res, status, err instanceof Error ? err.message : 'internal error');
  } finally {
    if (url.pathname === '/mcp') {
      logger.debug('request', {
        method: req.method,
        path: url.pathname,
        status: mcpStatus ?? res.statusCode,
        durationMs: Date.now() - reqStart,
      });
    }
  }
});

httpServer.listen(config.port, HOST, () => {
  logger.info('server.listening', {
    host: HOST,
    port: config.port,
    endpoint: `/mcp`,
    version: VERSION,
    apiUrl: config.apiUrl,
  });
});

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown', { signal });
  for (const { transport } of sessions.values()) {
    transport.close().catch(() => undefined);
  }
  sessions.clear();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
