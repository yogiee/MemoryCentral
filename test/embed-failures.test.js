// Regression tests for embed() failure reporting.
// Run: node --test test/
//
// The bug these guard: embed() was `catch { return null }`, so a missing model,
// a stopped service, a timeout and a garbage response were indistinguishable.
// Callers printed `provider "ollama" unavailable` for all of them — and printed
// it while Ollama was healthy, which is how 14 memories' vectors went stale
// unnoticed on 2026-08-28.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Nothing listens here, so the un-stubbed path exercises a real connection
// failure. Must be set before embed.js reads it at module load.
process.env.OLLAMA_HOST = 'http://127.0.0.1:45999';
const { embed, EMBED_TIMEOUT_MS } = await import('../server/embed.js');

const realFetch = globalThis.fetch;
const realWrite = process.stderr.write;
let stderr = '';

beforeEach(() => {
  stderr = '';
  process.stderr.write = chunk => { stderr += chunk; return true; };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.stderr.write = realWrite;
});

const respondWith = (status, body) => {
  globalThis.fetch = async () => new Response(body, { status });
};

test('a stopped service reports provider_down, naming endpoint and cause', async () => {
  const r = await embed('hello'); // no stub: a real refused connection
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'provider_down');
  assert.match(r.message, /127\.0\.0\.1:45999/);
  // "fetch failed" is what err.message says for every network problem; the
  // actionable part is only ever on err.cause.
  assert.match(r.message, /ECONNREFUSED/);
});

test('a missing model reports model_missing with the pull command', async () => {
  respondWith(404, 'model not found');
  const r = await embed('hello');
  assert.equal(r.reason, 'model_missing');
  assert.match(r.message, /ollama pull /);
});

test('other HTTP errors report the status and the response body', async () => {
  respondWith(500, 'out of memory');
  const r = await embed('hello');
  assert.equal(r.reason, 'http_error');
  assert.match(r.message, /500/);
  assert.match(r.message, /out of memory/);
});

test('a 200 carrying no vector is not mistaken for success', async () => {
  globalThis.fetch = async () => Response.json({ embeddings: [] });
  const r = await embed('hello');
  assert.equal(r.reason, 'bad_response');
});

test('a slow provider reports timeout, not a dead one', async () => {
  globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); };
  const r = await embed('hello');
  assert.equal(r.reason, 'timeout');
  assert.match(r.message, new RegExp(String(EMBED_TIMEOUT_MS)));
});

test('a network-layer throw is a down provider, not a mystery', async () => {
  // fetch rejects with TypeError for connection-level failures.
  globalThis.fetch = async () => { throw new TypeError('network boom'); };
  assert.equal((await embed('hello')).reason, 'provider_down');
});

test('an unanticipated throw is still classified, never swallowed', async () => {
  // A response shape nothing here expects — the point is that the catch-all
  // reports it rather than returning a bare failure with no cause.
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const r = await embed('hello');
  assert.equal(r.reason, 'unexpected');
  assert.ok(r.message);
});

test('every failure is written to stderr — silence is the defect', async () => {
  respondWith(404, '');
  await embed('hello');
  assert.match(stderr, /embed \[model_missing\]/);
});

test('success reports ok with a vector and the model that produced it', async () => {
  globalThis.fetch = async () => Response.json({ embeddings: [[0.1, 0.2, 0.3]] });
  const r = await embed('hello');
  assert.equal(r.ok, true);
  assert.deepEqual(r.vector, [0.1, 0.2, 0.3]);
  assert.ok(r.model);
});

test('a failure never looks like a success, and always carries both fields', async () => {
  for (const stub of [
    () => respondWith(404, ''),
    () => respondWith(503, 'busy'),
    () => { globalThis.fetch = async () => Response.json({}); },
  ]) {
    stub();
    const r = await embed('hello');
    assert.notEqual(r.ok, true);
    assert.ok(r.reason && r.message, 'reason and message must both be set');
  }
});
