#!/usr/bin/env node
// Standalone dashboard runner. The dashboard also starts automatically
// inside every Claude session via server/index.js.
// Usage: node dashboard.js
import { start } from './server/dashboard.js';

start(9980);
