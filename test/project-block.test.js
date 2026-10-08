// The "## MemoryCentral" project block and the description fallback (2026-10-09).
// These read files people write by hand, in every style.
// Run: cd server && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseBlock, readProjectMeta, fallbackDescription, suggestBlock } from '../server/projectBlock.js';

const repo = files => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-block-'));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
  return dir;
};

test('keys in any common markdown style; prose is not mistaken for a key', () => {
  const b = parseBlock('Project: Billing\n- **Stack:** Node, SQLite\n**Description**: Invoices.\nUse this repo carefully.\nUse: check MC');
  assert.deepEqual(b, { project: 'Billing', stack: ['node', 'sqlite'], description: 'Invoices.', use: 'check MC' });
});

test('the block is found in whichever instructions file has it; a file\'s H1 is not a block', () => {
  const dir = repo({
    'CLAUDE.md': '# MemoryCentral\n\nTitle only.\n',
    '.github/copilot-instructions.md': '## MemoryCentral\nProject: X\nDescription: From Copilot file.\n',
  });
  try {
    const m = readProjectMeta(dir);
    assert.equal(m.file, '.github/copilot-instructions.md');
    assert.equal(m.description, 'From Copilot file.');
  } finally { rmSync(dir, { recursive: true }); }
});

test('the legacy "## Stack" block still supplies the stack', () => {
  const dir = repo({ 'CLAUDE.md': '# p\n\n## Stack\nswift, uikit\n\n## Other\n' });
  try { assert.deepEqual(readProjectMeta(dir).stack, ['swift', 'uikit']); } finally { rmSync(dir, { recursive: true }); }
});

test('fallback description: README prose, skipping frontmatter, rules, badges, boilerplate; markdown stripped', () => {
  const dir = repo({
    'README.md': '---\ntitle: x\n---\n# App\n\n[![ci](b.svg)](x)\n\n---\n\nA **fast** tool for [tracking](http://x) things across devices.\n',
    'CLAUDE.md': 'This file provides guidance to Claude Code (claude.ai/code) when working here.\n\nIgnored.\n',
  });
  try { assert.equal(fallbackDescription(dir), 'A fast tool for tracking things across devices.'); } finally { rmSync(dir, { recursive: true }); }
});

test('the suggested block round-trips through the parser', () => {
  const text = suggestBlock({ name: 'p', description: 'Does things.', stack: ['go'] });
  const parsed = parseBlock(text.split('\n').slice(1).join('\n'));
  assert.equal(parsed.project, 'p');
  assert.deepEqual(parsed.stack, ['go']);
  assert.match(parsed.use, /save_memory \(project "p"\)/);
});
