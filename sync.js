#!/usr/bin/env node
// Cross-platform entry point for the Stop hook.
// Usage: node sync.js
// Claude Code Stop hook: { "type": "command", "command": "node /path/to/sync.js", "async": true }
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
await import(join(__dirname, 'server', 'sync.js'));
