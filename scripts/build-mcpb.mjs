#!/usr/bin/env node
// Builds the Claude Desktop extension bundle (.mcpb) from mcpb/.
// Syncs the version from package.json and, if ETRACKER_MCP_URL is set,
// bakes it in as the default Server URL. Output: dist-mcpb/etracker-mcp-<version>.mcpb
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'mcpb');
// Build outside the repo so pnpm doesn't walk up into the project workspace
// and install the project's dependencies instead of the bundle's.
const build = mkdtempSync(join(tmpdir(), 'etracker-mcpb-'));
const outDir = join(root, 'dist-mcpb');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(build, { recursive: true, force: true });
cpSync(src, build, { recursive: true });

const manifestPath = join(build, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = version;
const url = process.env.ETRACKER_MCP_URL?.trim();
if (url) manifest.user_config.url.default = url;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// Bundle mcp-remote (and its deps) so the extension runs without npx/network.
// Hoisted linker keeps node_modules symlink-free so it packs into the .mcpb.
execFileSync(
  'pnpm',
  [
    'install',
    '--prod',
    '--ignore-workspace',
    '--ignore-scripts',
    '--config.node-linker=hoisted',
  ],
  { stdio: 'inherit', cwd: build },
);

mkdirSync(outDir, { recursive: true });
const out = join(outDir, `etracker-mcp-${version}.mcpb`);
execFileSync('pnpm', ['dlx', '@anthropic-ai/mcpb@latest', 'pack', build, out], {
  stdio: 'inherit',
});
rmSync(build, { recursive: true, force: true });

console.log(`\nBuilt ${out} (default URL: ${manifest.user_config.url.default})`);
