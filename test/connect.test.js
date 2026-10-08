// "Connect your apps" snippets must paste cleanly on every platform — a Windows
// path with spaces and backslashes is the case that breaks hand-written configs.
// Run: cd server && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectSnippets, shellQuote, tomlString } from '../server/connect.js';

const WIN = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  server: 'C:\\Users\\Dev One\\MemoryCentral\\server\\index.js',
  sync: 'C:\\Users\\Dev One\\MemoryCentral\\sync.js',
  platform: 'win32', home: 'C:\\Users\\Dev One',
};
const MAC = { node: '/opt/homebrew/bin/node', server: "/Users/o'neil/MC/server/index.js", sync: '/Users/o/MC/sync.js', platform: 'darwin', home: '/Users/o' };
const step = (snips, id, lang) => snips.find(s => s.id === id).steps.find(s => s.lang === lang).text;

test('every JSON snippet parses back to the exact paths, Windows included', () => {
  for (const env of [WIN, MAC]) {
    const snips = connectSnippets(env);
    for (const s of snips) for (const st of s.steps.filter(x => x.lang === 'json')) JSON.parse(st.text);
    assert.deepEqual(JSON.parse(step(snips, 'vscode', 'json')).servers.memoryCentral.args, [env.server]);
    assert.deepEqual(JSON.parse(step(snips, 'opencode', 'json')).mcp.memoryCentral.command, [env.node, env.server]);
    assert.equal(JSON.parse(step(snips, 'claude', 'json')).mcpServers.memoryCentral.command, env.node);
  }
});

test('TOML uses literal strings so Windows backslashes survive', () => {
  const toml = step(connectSnippets(WIN), 'codex', 'toml');
  assert.match(toml, /command = 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.equal(tomlString("it's"), '"it\'s"');
});

test('shell commands quote paths with spaces for the platform\'s shell', () => {
  assert.match(step(connectSnippets(WIN), 'claude', 'shell'), /-- "C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\Dev One/);
  assert.equal(shellQuote("/Users/o'neil/x", 'darwin'), `'/Users/o'\\''neil/x'`);
  assert.equal(shellQuote('/opt/homebrew/bin/node', 'darwin'), '/opt/homebrew/bin/node', 'no needless quotes');
});
