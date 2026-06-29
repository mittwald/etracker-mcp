# etracker MCP Server

Streamable-HTTP [MCP](https://modelcontextprotocol.io) server for the
[etracker Analytics Report API](https://help.etracker.com/en/article/rest-report-api/).
Read-only, 4 tools, runs in a container.

> The REST Report API is available in the etracker analytics **Enterprise
> Edition**. Create an access token with scope *Reporting API* under
> **Settings → Account → Integration**.

## Table of contents

- [Run in Docker](#run-in-docker)
- [Authentication](#authentication)
- [Connect from your client](#connect-from-your-client)
  - [Claude Code](#claude-code)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [n8n](#n8n)
  - [VS Code (Copilot Chat)](#vs-code-copilot-chat)
  - [MCP Inspector (debug)](#mcp-inspector-debug)
- [Tools](#tools)
- [Example prompts](#example-prompts)
- [Configuration](#configuration)
- [Operations](#operations)
- [Development](#development)

## Run in Docker

Published image: **`ghcr.io/mittwald/etracker-mcp:latest`** (tags: `latest`, `0.1.0`).

```bash
docker run -d --name etracker-mcp -p 3334:3334 \
  --restart unless-stopped \
  ghcr.io/mittwald/etracker-mcp:latest
```

The server is credential-free at startup — every client provides its own
etracker access token via a header (see [Authentication](#authentication)).

Endpoint: `http://127.0.0.1:3334/mcp` · Healthcheck: `GET /health`.

> Build locally instead: `docker build -t etracker-mcp .` and use
> `etracker-mcp` as the image name.

### docker compose

```yaml
services:
  etracker-mcp:
    image: ghcr.io/mittwald/etracker-mcp:latest
    ports: ["3334:3334"]
    restart: unless-stopped
```

## Authentication

Each client provides its own etracker access token via a request header:

- `X-ET-Token` — access token with scope *Reporting API*.

The server keeps no global credentials, holds nothing in env, and stores
nothing on disk. The token lives only in the per-session `EtrackerClient`
inside the running process. One server can serve many etracker accounts.
Requests without the header are rejected with `401`.

The upstream API base URL defaults to the public endpoint
`https://ws.etracker.com/api/v7` and can be overridden server-side with
`ETRACKER_API_URL`.

## Connect from your client

All client examples below include the required `X-ET-Token` header. Replace
the token with your own.

### Claude Code

```bash
claude mcp add etracker http://127.0.0.1:3334/mcp --transport http \
  --header "X-ET-Token: your-access-token"
```

### Claude Desktop

**Recommended: one-click install via the `.mcpb` extension.** No config
files, no Docker. Download the latest `etracker-mcp-<version>.mcpb` from the
[Releases](https://github.com/mittwald/etracker-mcp/releases) page and
double-click it (or in Claude Desktop: **Settings → Extensions → Advanced
settings → Install Extension…**). You'll be prompted for two values in a form:

- **Server URL** — pre-filled with the hosted instance; leave as is unless you
  run your own.
- **etracker Access Token** — your token with scope *Reporting API* (stored in
  the OS keychain, marked sensitive).

Works on macOS, Windows and Linux with no extra setup — the extension bundles
a small stdio↔HTTP bridge that runs in-process on Claude Desktop's own Node
runtime (no system Node, no `npx`, no local listening socket; the only network
I/O is the outbound HTTPS call to the server). To build the bundle yourself:
`pnpm pack:mcpb` → `dist-mcpb/etracker-mcp-<version>.mcpb`.

<details>
<summary><b>Manual alternative: edit the config with <code>mcp-remote</code></b></summary>

> Claude Desktop's stable config only accepts **stdio** MCP servers. To
> use this HTTP-based server, bridge it via the `mcp-remote` shim
> (auto-installed by `npx`). This also lets you pass the required
> `X-ET-Token` header, which the Connectors UI doesn't support.

**Step-by-step:**

1. Quit Claude Desktop (`⌘Q` on macOS · right-click tray → Quit on Win/Linux).
2. Open the config file:

   | OS | Path |
   | --- | --- |
   | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
   | Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
   | Linux | `~/.config/Claude/claude_desktop_config.json` |

3. Add (or merge into) `mcpServers`:

   ```json
   {
     "mcpServers": {
       "etracker": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote",
           "http://127.0.0.1:3334/mcp",
           "--header",
           "X-ET-Token: your-access-token"
         ]
       }
     }
   }
   ```

4. Save the file and reopen Claude Desktop. The first launch downloads
   `mcp-remote` (one-time, ~5 s).
5. Open a new chat → type `/mcp` and press Enter. `etracker` should appear with
   status **connected** and 4 tools listed.

If it shows **failed**: check that the MCP server is running
(`curl http://127.0.0.1:3334/health` → `{"ok": true}`) and that Node.js is
installed system-wide (`npx` must be on your PATH).

</details>

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "etracker": {
      "url": "http://127.0.0.1:3334/mcp",
      "headers": {
        "X-ET-Token": "your-access-token"
      }
    }
  }
}
```

### n8n

In an **AI Agent** workflow add the **MCP Client Tool** node:

- **Endpoint**: `http://127.0.0.1:3334/mcp` (or the container hostname if
  n8n runs in Docker, e.g. `http://etracker-mcp:3334/mcp` on the same network).
- **Server Transport**: `HTTP Streamable`.
- **Headers**: add `X-ET-Token`.

Connect the node to the `tools` input of the AI Agent. n8n introspects
`tools/list` automatically, so the etracker tools become available to the
agent without further config.

### VS Code (Copilot Chat)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "etracker": {
      "type": "http",
      "url": "http://127.0.0.1:3334/mcp",
      "headers": {
        "X-ET-Token": "your-access-token"
      }
    }
  }
}
```

### MCP Inspector (debug)

```bash
npx @modelcontextprotocol/inspector
# Streamable HTTP → http://127.0.0.1:3334/mcp
# Add the X-ET-Token header in the Inspector "Authentication" panel.
```

## Tools

The etracker Report API is report-centric: pick a report (e.g. `EAPage`,
`EAGeo`, `EADeviceType`), then query its rows. Each report exposes
*attributes* (dimensions) and *keyfigures* (metrics).

| Tool | Purpose |
| --- | --- |
| `list_reports` | Map of report ID → display name. Call first. |
| `get_report_info` | Metadata for a report: create date, segments, attributes. |
| `get_report_metadata` | Column metadata: ids, labels, types, sortable/filterable flags. |
| `get_report_data` | Report rows with date range, paging, sorting, column selection and filters. |
| `compare_report_data` | Two periods compared per row: current/previous/delta/pctChange per figure, sorted by largest change. |

A typical flow: `list_reports` → `get_report_metadata` (to learn valid
attribute/figure IDs) → `get_report_data` (or `compare_report_data` for
period-over-period analysis). `compare_report_data` defaults the comparison
period to the equally long span immediately before the current range.

## Example prompts

Marketing-oriented questions for the connected assistant:

- "Which reports are available in my etracker account?"
- "Show me the top 10 pages by unique visits in **May 2024** (`EAPage`)."
- "Break down visits by device type for the last 7 days."
- "Which countries drove the most traffic last month? Sort descending."
- "List pages whose name matches \"Checkout\" with more than 100 unique visits."
- "Compare page impressions for `/en/` vs `/de/` URLs over the last 30 days."

## Data notes

- **Composite row IDs**: `get_report_data` rows carry an `id` that can be a
  comma-joined composite of the report's dimensions (e.g. `pageNameId,urlId`
  for `EAPage`). `compare_report_data` joins on this full `id`, i.e. at the
  granularity of the attributes you request.
- **Invisible characters in attribute values**: etracker may track the same
  URL under two `page_name` values — a normal one and a second one prefixed
  with an invisible separator (`U+2063`), e.g. from a JS-set `et_pagename`
  vs. an auto-derived name. Grouping by `page_name` then shows the page
  twice. For per-URL truth, request `attributes=url` (drop `page_name`) so
  etracker aggregates by URL; or strip zero-width/invisible characters before
  deduping names.

## Configuration

| Env | Required | Default | |
| --- | --- | --- | --- |
| `MCP_PORT` | no | `3334` | TCP port. |
| `LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |
| `ETRACKER_API_URL` | no | `https://ws.etracker.com/api/v7` | Base URL of the etracker Report API. |

The etracker access token is not configured via env — it is passed by each
client via the `X-ET-Token` request header. See
[Authentication](#authentication).

## Operations

- **Logging**: structured JSON to stdout/stderr (`info`/`debug` → stdout,
  `warn`/`error` → stderr). One line per event, no header values logged.
  Tail with `docker logs -f etracker-mcp`.
- **Healthcheck**: `GET /health` returns `{"ok": true, "version": "..."}`.
  Wired into the Dockerfile `HEALTHCHECK`.
- **Limits**: request bodies > 1 MB → `413`; outbound calls to etracker
  timeout after 30 s. The etracker API itself limits to 50 calls per 5
  minutes, 10 parallel requests, and 100,000 rows per response.
- **Security model**: server holds no credentials. Run multiple replicas
  behind a load balancer if needed — sessions are sticky via the
  `Mcp-Session-Id` header, so terminate sessions on the same backend
  (or accept that a reconnect re-initializes a session).
- **Image**: pin a digest in production
  (`ghcr.io/mittwald/etracker-mcp@sha256:…`) rather than `:latest`.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` close all open MCP sessions and
  drain in-flight requests before exit (10 s hard cap).

## Development

```bash
pnpm install
pnpm dev           # tsx watch
pnpm test          # unit tests
pnpm test:live     # live smoke test (client → API), needs ETRACKER_TOKEN env
pnpm build         # tsc → dist/

# Holistic end-to-end test: drives the running server over the real MCP
# transport against the live API, exercising every tool.
pnpm build && node dist/index.js &      # start the server
ETRACKER_TOKEN=... pnpm test:e2e        # MCP_URL overridable (default :3334)
```

All tools are read-only. Add a tool: extend `src/tools.ts`, add a unit test
in `tests/tools.test.ts`, add a live test in `tests/live/live.test.ts` that
asserts the actual response shape.
