// The MCP server end to end, over stdio, as any harness would drive it — Claude
// Code, Codex, VS Code and OpenCode all speak this same protocol. Runs against a
// throwaway data root; embedding points at a dead port, so vectors stay pending
// and only keyword paths are exercised here (embed.js has its own tests).
// Run: cd server && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js');
// The SDK is installed under server/, which a test file outside it can't resolve.
const fromServer = createRequire(SERVER);
const sdk = async p => import(pathToFileURL(fromServer.resolve(`@modelcontextprotocol/sdk/${p}`)).href);
const { Client } = await sdk('client/index.js');
const { StdioClientTransport } = await sdk('client/stdio.js');
let tmp, client;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map(c => c.text).join('\n'), isError: !!r.isError };
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mc-e2e-'));
  const repo = join(tmp, 'repos', 'webapp');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'CLAUDE.md'), '# webapp\n\n## MemoryCentral\nProject: webapp\nDescription: A web app.\nStack: node, react\n');
  const mem = join(tmp, 'claude', repo.replace(/[/\\]/g, '-'), 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'feedback_caching.md'), '---\nname: caching rule\ntype: feedback\n---\nAlways set Cache-Control on API responses.');

  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MEMORYCENTRAL_HOME: join(tmp, 'home'),
      MC_CLAUDE_PROJECTS: join(tmp, 'claude'),
      MC_CLAUDE_HOME: tmp,
      MC_RC_PATH: join(tmp, 'no-rc.json'),
      MC_DASHBOARD_PORT: '45987',
      MC_MANIFEST: '0',
      OLLAMA_HOST: 'http://127.0.0.1:45998',
      EMBED_PROVIDER: 'ollama',
    },
    stderr: 'ignore',
  }));
});

after(async () => {
  await client?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('the server tells every client when to use it', () => {
  const text = client.getInstructions();
  assert.match(text, /find_similar/);
  assert.ok(text.length <= 2048, 'Claude Code truncates instructions past 2,048 chars');
});

test('sync ingests the harness folder; the project block supplies the metadata', async () => {
  const r = await call('sync');
  assert.match(r.text, /\+1 added/);
  const list = await call('list_projects');
  assert.match(list.text, /## webapp\nA web app\./);
  assert.match((await call('find_by_stack', { stack: 'react' })).text, /webapp/);
  assert.match((await call('search_memories', { query: 'Cache-Control' })).text, /caching rule/);
});

test('save_memory from a tool with no memory folder of its own creates the project', async () => {
  const r = await call('save_memory', {
    project: 'copilot-service', filename: 'project_queue_choice.md',
    content: '---\nname: queue choice\ntype: project\n---\nChose SQS over Redis streams for durability.',
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Created/);
  assert.match((await call('search_memories', { query: 'SQS' })).text, /queue choice/);
  assert.match((await call('get_project_summary', { project: 'copilot-service' })).text, /queue choice/);
});

test('save_memory rejects a path escape', async () => {
  const r = await call('save_memory', { project: 'x', filename: '../../evil.md', content: 'x' });
  assert.equal(r.isError, true);
});

test('delete_memory removes the memory and its file', async () => {
  const r = await call('delete_memory', { project: 'copilot-service', filename: 'project_queue_choice.md' });
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch((await call('search_memories', { query: 'SQS' })).text, /queue choice/);
  assert.ok(!existsSync(join(tmp, 'home', 'projects', 'copilot-service', 'memory', 'project_queue_choice.md')));
});

test('find_similar degrades to in-context matching when the embedder is down, saying why', async () => {
  const r = await call('find_similar', { description: 'cache headers' });
  assert.match(r.text, /degraded/i);
  assert.match(r.text, /provider_down/);
});
