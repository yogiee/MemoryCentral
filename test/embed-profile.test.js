// The embedding model and its wire format depend on the platform and the model
// family (2026-10-09). These guard the two ways that goes wrong quietly:
//   - an MLX-only default reaching a machine that cannot load it (a Windows
//     user was told to pull an MLX model), and
//   - queries and documents framed by different conventions, which puts them
//     in different vector spaces and degrades search without any error.
// Run: node --test test/
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; delete process.env.EMBED_MODEL; delete process.env.OLLAMA_HOST; });

// embed.js reads its environment at load, so each case gets a fresh instance.
let n = 0;
async function load(env = {}) {
  Object.assign(process.env, env);
  return import(`../server/embed.js?case=${n++}`);
}

// Records what embed() put on the wire.
function capture() {
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ embeddings: [[0.1, 0.2, 0.3]] });
  };
  return sent;
}

test('the MLX-only v2 model is the default only on Apple Silicon with local Ollama', async () => {
  const m = await load();
  if (m.APPLE_SILICON) assert.equal(m.DEFAULT_EMBED_MODEL, 'embeddinggemma-2:270m-bf16-text');
  else assert.equal(m.DEFAULT_EMBED_MODEL, 'embeddinggemma:300m');
});

test('a remote Ollama gets the GGUF model whatever this machine is', async () => {
  const m = await load({ OLLAMA_HOST: 'http://192.168.1.50:11434' });
  assert.equal(m.DEFAULT_EMBED_MODEL, 'embeddinggemma:300m');
});

test('v2: queries and documents carry their task prefixes, and num_ctx is sent', async () => {
  const m = await load({ EMBED_MODEL: 'embeddinggemma-2:270m-bf16-text' });
  const sent = capture();
  const q = await m.embed('cifs mount lessons', { kind: 'query' });
  await m.embed('body text', { kind: 'document', title: 'proxmox-notes' });
  await m.embed('body text', { kind: 'document' });
  assert.equal(sent[0].input, 'task: search result | query: cifs mount lessons');
  assert.equal(sent[1].input, 'title: proxmox-notes | text: body text');
  assert.equal(sent[2].input, 'title: none | text: body text');
  assert.deepEqual(sent[0].options, { num_ctx: 8192 });
  // The stored id names the convention, so changing it later marks old vectors stale.
  assert.equal(q.model, 'embeddinggemma-2:270m-bf16-text#prompts-v1');
  assert.equal(m.activeModel(), q.model);
});

test('v1: plain text exactly as chunk.js frames it, no options, bare model id', async () => {
  const m = await load({ EMBED_MODEL: 'embeddinggemma:300m' });
  const { chunkText } = await import('../server/chunk.js');
  const sent = capture();
  const q = await m.embed('cifs mount lessons', { kind: 'query' });
  await m.embed('body text', { kind: 'document', title: 'proxmox-notes' });
  assert.equal(sent[0].input, 'cifs mount lessons');
  assert.equal(sent[1].input, chunkText('proxmox-notes', 'body text'));
  assert.equal(sent[0].options, undefined);
  // Unchanged id: existing v1 tables stay valid, nothing is re-embedded.
  assert.equal(q.model, 'embeddinggemma:300m');
});

test('other v2 tags share the profile; unknown overrides get plain text', async () => {
  const nv = await load({ EMBED_MODEL: 'embeddinggemma-2:270m' });
  let sent = capture();
  await nv.embed('x', { kind: 'query' });
  assert.match(sent[0].input, /^task: search result \| query: /);

  const other = await load({ EMBED_MODEL: 'nomic-embed-text' });
  sent = capture();
  await other.embed('x', { kind: 'query' });
  assert.equal(sent[0].input, 'x');
  assert.equal(sent[0].options, undefined);
});
