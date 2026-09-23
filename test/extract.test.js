// Regression tests for extractProjectMeta().
// Run: node --test test/
//
// The pin (granite4.2:3b, 2026-09-23) is only viable with the call settings these
// guard: without num_ctx it pre-allocates 13.3 GB for its native window, and with
// its default thinking it runs 24-85s against a 60s abort. Dropping either field
// doesn't fail anything — it silently brings back the residency the pin removed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OLLAMA_HOST = 'http://127.0.0.1:45999';
const { extractProjectMeta, STACK_TAGS, MAX_STACK_TAGS } = await import('../server/embed.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const replyWith = meta => {
  globalThis.fetch = async () => Response.json({ message: { content: JSON.stringify(meta) } });
};

test('the call bounds the context window and turns thinking off', async () => {
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ message: { content: '{"description":"x","stack":[]}' } });
  };
  await extractProjectMeta('memory');
  assert.equal(sent.think, false, 'thinking must be off, or thinkers blow the abort budget');
  assert.ok(sent.options.num_ctx > 0 && sent.options.num_ctx <= 8192,
    `num_ctx ${sent.options.num_ctx} — unset means the native window (131k+)`);
});

test('the context window fits the prompt it is given', async () => {
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ message: { content: '{"description":"x","stack":[]}' } });
  };
  await extractProjectMeta('x'.repeat(10_000));
  // ~4 chars/token is generous for English; the prompt must fit with room to answer.
  const promptChars = sent.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(promptChars / 4 < sent.options.num_ctx / 2, `prompt ${promptChars} chars vs num_ctx ${sent.options.num_ctx}`);
});

test('a model reciting the whole allowlist yields no tags, not every tag', async () => {
  replyWith({ description: 'd', stack: STACK_TAGS });
  assert.deepEqual((await extractProjectMeta('m')).stack, []);
});

test('an honest multi-tag stack survives the cap', async () => {
  const electron = ['node', 'typescript', 'react', 'electron', 'html', 'css', 'bash'];
  assert.ok(electron.length <= MAX_STACK_TAGS);
  replyWith({ description: 'd', stack: electron });
  assert.deepEqual((await extractProjectMeta('m')).stack, electron);
});

test('off-list tags are still filtered before the cap is applied', async () => {
  replyWith({ description: 'd', stack: ['Node', 'postgres', 'node', 'docker'] });
  assert.deepEqual((await extractProjectMeta('m')).stack, ['node']);
});
