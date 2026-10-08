#!/usr/bin/env node
// Start here: `node setup.js`
//
// Checks Node, installs dependencies if needed, then serves the MemoryCentral
// dashboard and opens it in your browser. Everything else — choosing a search
// engine, downloading a model, importing existing memories, and connecting your
// AI tools — happens on that page. Works the same on macOS, Windows and Linux.
//
// The dashboard keeps running until you stop it (Ctrl+C). It is also how you
// browse and search memories without any AI tool open. AI tools start their own
// MemoryCentral server in the background once connected; that one never opens a
// browser.
//
//   node setup.js             open the dashboard (port 9980, or MC_DASHBOARD_PORT)
//   node setup.js --no-open   start it without opening a browser
import { spawnSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = join(__dirname, 'server');
const isWin = process.platform === 'win32';
const port = Number(process.env.MC_DASHBOARD_PORT) || 9980;
const url = `http://localhost:${port}`;

// 1. Node 22+ (node:sqlite).
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  console.error(`MemoryCentral needs Node.js 22 or newer (found ${process.versions.node}). Download: https://nodejs.org`);
  process.exit(1);
}

// 2. Dependencies, once.
if (!existsSync(join(serverDir, 'node_modules'))) {
  console.log('Installing dependencies (first run only)…');
  const r = spawnSync('npm', ['install', '--prefix', serverDir, '--no-fund', '--no-audit'], { stdio: 'inherit', shell: isWin });
  if (r.status !== 0) { console.error('npm install failed — see the output above.'); process.exit(1); }
}

function openBrowser() {
  if (process.argv.includes('--no-open')) return;
  const [cmd, args] = isWin ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch {}
}

// 3. A dashboard already running (another setup, or a connected AI tool's server)
//    serves the same page — open that rather than starting a second one.
try {
  const r = await fetch(`${url}/api/setup/status`, { signal: AbortSignal.timeout(1500) });
  if (r.ok) {
    console.log(`MemoryCentral is already running → ${url}`);
    openBrowser();
    process.exit(0);
  }
} catch {}

const { start } = await import('./server/dashboard.js');
const server = start(port, true);
server.once('listening', () => {
  console.log(`\nMemoryCentral → ${url}\nFinish setup in your browser. Press Ctrl+C to stop the dashboard.\n`);
  openBrowser();
});
