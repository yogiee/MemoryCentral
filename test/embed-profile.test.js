// Which embedder runs, and how text reaches it (2026-10-09).
//
// Guards the quiet failures:
//   - an MLX-only model reaching a machine that cannot load it (a Windows user was
//     told to pull one);
//   - queries and documents framed by different conventions, or chunked past a
//     model's window — both degrade search without any error;
//   - a settings change not reaching a running process (a stale process once
//     nearly re-embedded the table back to the old model).
// Run: cd server && npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const realFetch = globalThis.fetch;
const ENV = ['EMBED_MODEL', 'EMBED_PROVIDER', 'EMBED_LOCAL_MODEL', 'OLLAMA_HOST'];
let tmp, db, E, M;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mc-embed-'));
  process.env.MEMORYCENTRAL_HOME = tmp;
  for (const k of ENV) delete process.env[k];
  E = await import('../server/embed.js');
  M = await import('../server/models.js');
  const { openDb } = await import('../server/db.js');
  db = openDb();
  E.useSettingsDb(db);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  E.useSettingsDb(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV) delete process.env[k];
});

const { setSetting } = await import('../server/settings.js');
const set = (k, v) => { setSetting(db, k, v); E.invalidateConfig(); };

function capture() {
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ embeddings: [[0.1, 0.2, 0.3]] });
  };
  return sent;
}

test('the MLX-only model is recommended only on Apple Silicon with a local Ollama', () => {
  const expectMlx = M.APPLE_SILICON;
  assert.equal(M.recommendedOllamaModel('http://localhost:11434'), expectMlx ? 'embeddinggemma-2:270m-bf16-text' : 'embeddinggemma:300m');
  assert.equal(M.recommendedOllamaModel('http://192.168.1.50:11434'), 'embeddinggemma:300m', 'a remote Ollama may not be a Mac');
  assert.equal(M.canRunOllamaModel('embeddinggemma-2:270m-bf16-text', 'http://192.168.1.50:11434'), false);
  assert.equal(M.canRunOllamaModel('embeddinggemma:300m', 'http://192.168.1.50:11434'), true);
});

test('an MLX model configured where it cannot run fails loudly, naming the fix', async () => {
  set('ollama.host', 'http://192.168.1.50:11434');
  set('embed.ollama.model', 'embeddinggemma-2:270m-bf16-text');
  capture();
  const r = await E.embed('x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'model_unsupported');
  assert.match(r.message, /embeddinggemma:300m/);
});

test('settings drive the embedder; env overrides them; a change is picked up without a restart', () => {
  set('embed.ollama.model', 'embeddinggemma:300m');
  assert.equal(E.activeConfig().model, 'embeddinggemma:300m');
  set('embed.ollama.model', 'embeddinggemma-2:270m');
  assert.equal(E.activeConfig().model, 'embeddinggemma-2:270m');
  process.env.EMBED_MODEL = 'nomic-embed-text';
  E.invalidateConfig();
  assert.equal(E.activeConfig().model, 'nomic-embed-text');
});

test('v2: queries and documents carry their task prefixes, and num_ctx is sent', async () => {
  set('embed.ollama.model', 'embeddinggemma-2:270m-bf16-text');
  const sent = capture();
  const q = await E.embed('cifs mount lessons', { kind: 'query' });
  await E.embed('body text', { kind: 'document', title: 'proxmox-notes' });
  await E.embed('body text', { kind: 'document' });
  assert.equal(sent[0].input, 'task: search result | query: cifs mount lessons');
  assert.equal(sent[1].input, 'title: proxmox-notes | text: body text');
  assert.equal(sent[2].input, 'title: none | text: body text');
  assert.deepEqual(sent[0].options, { num_ctx: 8192 });
  if (E.activeConfig().runnable) assert.equal(q.model, 'embeddinggemma-2:270m-bf16-text#prompts-v1#c1500');
});

test('v1: plain text exactly as chunk.js frames it, no options, the same vector-space id as before', async () => {
  set('embed.ollama.model', 'embeddinggemma:300m');
  const { chunkText } = await import('../server/chunk.js');
  const sent = capture();
  const q = await E.embed('cifs mount lessons', { kind: 'query' });
  await E.embed('body text', { kind: 'document', title: 'proxmox-notes' });
  assert.equal(sent[0].input, 'cifs mount lessons');
  assert.equal(sent[1].input, chunkText('proxmox-notes', 'body text'));
  assert.equal(sent[0].options, undefined);
  assert.equal(q.model, 'embeddinggemma:300m#c1500', 'the chunk size is part of the space, so a change re-embeds');
});

test('other v2 tags share the profile; unknown models get plain text', async () => {
  set('embed.ollama.model', 'embeddinggemma-2:270m');
  let sent = capture();
  await E.embed('x', { kind: 'query' });
  assert.match(sent[0].input, /^task: search result \| query: /);
  set('embed.ollama.model', 'nomic-embed-text');
  sent = capture();
  await E.embed('x', { kind: 'query' });
  assert.equal(sent[0].input, 'x');
  assert.equal(sent[0].options, undefined);
});

test('a built-in model is chunked to its own window, and its vector space says so', () => {
  set('embed.provider', 'local');
  set('embed.local.model', 'all-MiniLM-L6-v2');
  const cfg = E.activeConfig();
  assert.equal(cfg.provider, 'local');
  assert.ok(cfg.chunkChars < 1000, 'MiniLM reads 256 tokens; 4,000-char chunks would lose most of each one');
  assert.equal(cfg.space, `all-MiniLM-L6-v2#q8#c${cfg.chunkChars}`, 'differs from the old truncating space, so old vectors re-embed');
});

test('a server on older code than the shared DB stops embedding instead of reverting it', async () => {
  const { MODELS_REVISION } = M;
  capture();
  assert.ok((await E.embed('x')).ok);
  assert.equal(E.activeConfig().stale, false);
  set('embed.revision', MODELS_REVISION + 1); // a newer MemoryCentral has run against this DB
  const r = await E.embed('x');
  assert.equal(r.reason, 'stale_code');
  set('embed.revision', MODELS_REVISION - 1); // older record: this code claims it
  assert.ok((await E.embed('x')).ok);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='embed.revision'").get().value), MODELS_REVISION);
});
