#!/usr/bin/env node
// Holistic end-to-end test: drives the running MCP server over the real
// Streamable-HTTP transport (the same path Claude Desktop uses) against the
// live etracker API, exercising every tool in sequence.
//
// Usage:
//   ETRACKER_TOKEN=... [MCP_URL=http://127.0.0.1:3334/mcp] node scripts/e2e.mjs
//
// Exits 0 on success, 1 on the first failure. Never prints the token.

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:3334/mcp';
const TOKEN = process.env.ETRACKER_TOKEN;
const HEALTH_URL = MCP_URL.replace(/\/mcp$/, '/health');

if (!TOKEN) {
  console.error('ETRACKER_TOKEN is required');
  process.exit(1);
}

const baseHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'X-ET-Token': TOKEN,
};

let sessionId;
let rpcId = 0;

function parseSse(text) {
  // Streamable HTTP returns one SSE "message" event per JSON-RPC response.
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
  }
  return undefined;
}

async function rpc(method, params) {
  const id = ++rpcId;
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { ...baseHeaders, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}: ${await res.text()}`);
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const msg = parseSse(await res.text());
  if (msg?.error) throw new Error(`${method} → RPC error ${msg.error.code}: ${msg.error.message}`);
  return msg?.result;
}

async function notify(method, params) {
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { ...baseHeaders, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  });
}

// Unwraps a tool result into the parsed JSON payload the tool returned.
async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args ?? {} });
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).join('\n') ?? 'unknown error';
    throw new Error(`tool ${name} returned isError: ${text}`);
  }
  const text = result?.content?.[0]?.text;
  return typeof text === 'string' ? JSON.parse(text) : text;
}

let step = 0;
function ok(msg) {
  step += 1;
  console.log(`  ✓ [${step}] ${msg}`);
}

async function main() {
  console.log(`E2E against ${MCP_URL}`);

  // 0. health
  const health = await (await fetch(HEALTH_URL)).json();
  if (!health.ok) throw new Error('health check failed');
  ok(`health ok (v${health.version})`);

  // 1. MCP handshake
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  });
  if (!sessionId) throw new Error('no mcp-session-id returned by initialize');
  await notify('notifications/initialized');
  ok(`initialized (server: ${init.serverInfo?.name})`);

  // 2. tools/list
  const { tools } = await rpc('tools/list');
  const names = tools.map((t) => t.name);
  const expected = ['list_reports', 'get_report_info', 'get_report_metadata', 'get_report_data', 'compare_report_data'];
  for (const e of expected) if (!names.includes(e)) throw new Error(`tool missing: ${e}`);
  ok(`tools/list returned ${names.length} tools: ${names.join(', ')}`);

  // 3. list_reports → pick the first report
  const reports = await callTool('list_reports');
  const reportIds = Object.keys(reports ?? {});
  if (reportIds.length === 0) throw new Error('list_reports returned no reports');
  // Prefer the Pages report for a data-rich run, otherwise the first available.
  const reportId = reportIds.includes('EAPage') ? 'EAPage' : reportIds[0];
  ok(`list_reports: ${reportIds.length} reports; using "${reportId}" (${reports[reportId]})`);

  // 4. get_report_info
  const info = await callTool('get_report_info', { reportId });
  ok(`get_report_info: ${Array.isArray(info) ? 'array' : typeof info} response`);

  // 5. get_report_metadata → discover a keyfigure id
  const meta = await callTool('get_report_metadata', { reportId });
  const cols = Array.isArray(meta) ? meta : [];
  // etracker keyfigures use numeric column types; attributes use "attribute".
  const FIGURE_TYPES = new Set(['integer', 'float', 'percent', 'staytime']);
  const figureCol = cols.find((c) => FIGURE_TYPES.has(String(c.type).toLowerCase()));
  const figureId = figureCol?.id;
  ok(`get_report_metadata: ${cols.length} columns; keyfigure = ${figureId ?? '(none found)'}`);

  // 6. get_report_data
  const data = await callTool('get_report_data', { reportId, rangeDays: 7, limit: 5 });
  if (!Array.isArray(data)) throw new Error(`get_report_data did not return a JSON array (got ${typeof data})`);
  const hasId = data.length === 0 || 'id' in data[0];
  ok(`get_report_data: ${data.length} rows, has "id" field = ${hasId}`);

  // 7. compare_report_data (needs a figure)
  if (figureId) {
    const cmp = await callTool('compare_report_data', { reportId, rangeDays: 7, figures: figureId, limit: 5 });
    if (!Array.isArray(cmp.rows)) throw new Error('compare_report_data.rows is not an array');
    const sample = cmp.rows[0];
    const figOk = !sample || (sample.figures && figureId in sample.figures && 'delta' in sample.figures[figureId]);
    if (!figOk) throw new Error('compare_report_data rows missing figure delta');
    ok(`compare_report_data: cur ${cmp.current.startDate}..${cmp.current.endDate} vs prev ${cmp.previous.startDate}..${cmp.previous.endDate}; ${cmp.rows.length} rows; delta present = ${figOk}`);
  } else {
    console.log('  • [skip] compare_report_data — no keyfigure column found in metadata');
  }

  console.log('\nE2E PASSED');
}

main().catch((err) => {
  console.error(`\nE2E FAILED: ${err.message}`);
  process.exit(1);
});
