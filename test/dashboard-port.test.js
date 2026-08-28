// Regression tests for dashboard port takeover.
// Run: node --test test/
//
// The bug these guard (observed 2026-08-28): every MCP process calls start(),
// so they race for the port and one wins. Losing used to be terminal — the
// error handler ignored EADDRINUSE and gave up — which tied the dashboard's
// lifetime to whichever process booted FIRST. Killing a 3-hour-old instance
// left two healthy servers running and the dashboard answering nothing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';

process.env.DASHBOARD_RETRY_MS = '150'; // must be read before the module loads
const { start, DASHBOARD_RETRY_MS } = await import('../server/dashboard.js');

const PORT = 45231;
const opened = [];
const realWrite = process.stderr.write;
let stderr = '';
process.stderr.write = chunk => { stderr += chunk; return true; };

afterEach(async () => {
  for (const s of opened.splice(0)) await new Promise(r => s.close(r));
});
process.on('exit', () => { process.stderr.write = realWrite; });

const listenOn = port => new Promise(resolve => {
  const s = createServer((_q, res) => res.end('squatter'));
  opened.push(s);
  s.listen(port, '127.0.0.1', () => resolve(s));
});

const waitFor = async (fn, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
};

const serving = async port => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return (await res.text()) !== 'squatter';
  } catch { return false; }
};

test('claims a free port immediately', async () => {
  const server = start(PORT);
  opened.push(server);
  assert.ok(await waitFor(() => serving(PORT)), 'should be serving');
});

test('takes the port over once the previous holder exits', async () => {
  const squatter = await listenOn(PORT + 1);
  stderr = '';

  const server = start(PORT + 1); // loses the race
  opened.push(server);
  assert.ok(await waitFor(async () => /held by another instance/.test(stderr)), 'contention reported');
  assert.ok(!(await serving(PORT + 1)), 'squatter still owns the port');

  await new Promise(r => squatter.close(r));

  // This is the whole point: the survivor must claim the freed port on its own.
  assert.ok(await waitFor(() => serving(PORT + 1)), 'never took over the freed port');
});

test('reports a contended port once, not on every retry', async () => {
  await listenOn(PORT + 2);
  stderr = '';
  opened.push(start(PORT + 2));
  await new Promise(r => setTimeout(r, DASHBOARD_RETRY_MS * 4));
  const notices = stderr.match(/held by another instance/g) || [];
  assert.equal(notices.length, 1, `expected one notice, got ${notices.length}`);
});

test('waiting for a port does not keep the process alive', async () => {
  await listenOn(PORT + 3);
  const server = start(PORT + 3);
  opened.push(server);
  await new Promise(r => setTimeout(r, DASHBOARD_RETRY_MS * 2));
  // An unref'd retry timer reports itself as such; a ref'd one would pin the
  // MCP process open forever just because another instance holds the port.
  const refd = process.getActiveResourcesInfo().filter(r => r === 'Timeout');
  assert.equal(refd.length, 0, 'retry timer must be unref\'d');
});
