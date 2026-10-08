#!/usr/bin/env node
// Standalone dashboard runner (setup.js does the same and opens the browser).
// The dashboard also starts inside every connected AI tool's MemoryCentral
// server (server/index.js).
// Usage: node dashboard.js
import { start } from './server/dashboard.js';

start(9980, true);
