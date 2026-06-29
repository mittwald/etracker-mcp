#!/usr/bin/env node
// Builds the Claude Desktop extension bundle (.mcpb) from mcpb/.
// Syncs the version from package.json and, if ETRACKER_MCP_URL is set,
// bakes it in as the default Server URL. Output: dist-mcpb/etracker-mcp-<version>.mcpb
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'mcpb');
const build = join(root, '.mcpb-build');
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

mkdirSync(outDir, { recursive: true });
const out = join(outDir, `etracker-mcp-${version}.mcpb`);
execFileSync('pnpm', ['dlx', '@anthropic-ai/mcpb@latest', 'pack', build, out], {
  stdio: 'inherit',
});
rmSync(build, { recursive: true, force: true });

console.log(`\nBuilt ${out} (default URL: ${manifest.user_config.url.default})`);
