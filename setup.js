#!/usr/bin/env node
// One-time setup script. Cross-platform (macOS, Windows, Linux).
// Usage: node setup.js
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const serverDir  = join(__dirname, 'server');
const serverEntry = resolve(join(serverDir, 'index.js'));
const syncEntry   = resolve(join(__dirname, 'sync.js'));
const isWin       = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
}

// ── 1. Node version check (22+ required for node:sqlite) ────────────────────
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  console.error(`ERROR: Node.js 22+ required (found v${process.versions.node})`);
  console.error('Download: https://nodejs.org');
  process.exit(1);
}
console.log(`✓  Node.js v${process.versions.node}`);

// ── 2. Install dependencies ─────────────────────────────────────────────────
console.log('\nInstalling dependencies...');
const install = run('npm', ['install', '--prefix', serverDir, '--silent']);
if (install.status !== 0) { console.error('npm install failed'); process.exit(1); }
console.log('✓  Dependencies installed');

// ── 3. Register MCP server with Claude Code ─────────────────────────────────
console.log('\nRegistering MCP server...');
const mcp = run('claude', ['mcp', 'add', '--scope', 'user', 'memoryCentral', process.execPath, serverEntry]);
if (mcp.status !== 0) {
  console.error('\n⚠  Auto-registration failed. Run this manually:');
  console.error(`   claude mcp add --scope user memoryCentral ${process.execPath} "${serverEntry}"`);
} else {
  console.log('✓  MCP server registered (memoryCentral)');
}

// ── 4. Print Stop hook snippet ──────────────────────────────────────────────
const hookCmd = isWin ? `node "${syncEntry.replace(/\\/g, '\\\\')}"` : `node "${syncEntry}"`;
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Add this to ~/.claude/settings.json to enable auto-sync
  (merges with any existing content in that file)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: hookCmd, async: true }] }] } }, null, 2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

// ── 5. First sync ────────────────────────────────────────────────────────────
console.log('Running first sync...\n');
await import(join(__dirname, 'server', 'sync.js'));

console.log('\n✓  Setup complete.');
console.log('   Start a new Claude Code session — memoryCentral tools will be available.');
