// The "## Project" block (named "## MemoryCentral" until 2026-10-10) and the description fallback.
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
  const b = parseBlock('Name: Billing\n- **Stack:** Node, SQLite\n**Description**: Invoices.\nName this repo carefully.\nUse: check MC');
  assert.deepEqual(b, { project: 'Billing', stack: ['node', 'sqlite'], description: 'Invoices.' });
  assert.equal(parseBlock('Project: Billing').project, 'Billing', 'the older Project: key still names it');
});

test('## Project is the block; the older ## MemoryCentral is still read, and loses to ## Project', () => {
  const dir = repo({ 'CLAUDE.md': '# p\n\n## Project\nName: New\nStack: go\n\n## Notes\nx\n' });
  const old = repo({ 'CLAUDE.md': '## MemoryCentral\nProject: Old\nDescription: Before the rename.\nUse: check MemoryCentral\n' });
  const both = repo({ 'CLAUDE.md': '## MemoryCentral\nProject: Old\n\n## Project\nName: New\n' });
  try {
    assert.deepEqual(readProjectMeta(dir), { file: 'CLAUDE.md', project: 'New', description: null, stack: ['go'] });
    assert.deepEqual(readProjectMeta(old), { file: 'CLAUDE.md', project: 'Old', description: 'Before the rename.', stack: null });
    assert.equal(readProjectMeta(both).project, 'New');
  } finally { for (const d of [dir, old, both]) rmSync(d, { recursive: true }); }
});

test('a prose "## Project" section is not a block; the next file\'s block is used', () => {
  const dir = repo({
    'AGENTS.md': '## Project\nThis project tracks invoices. See docs.\n',
    'CLAUDE.md': '## Project\nName: Billing\n',
  });
  try {
    const m = readProjectMeta(dir);
    assert.equal(m.file, 'CLAUDE.md');
    assert.equal(m.project, 'Billing');
  } finally { rmSync(dir, { recursive: true }); }
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

test('the suggested block round-trips through the parser and names no tool', () => {
  const text = suggestBlock({ name: 'p', description: 'Does things.', stack: ['go'] });
  const dir = repo({ 'AGENTS.md': text });
  try { assert.deepEqual(readProjectMeta(dir), { file: 'AGENTS.md', project: 'p', description: 'Does things.', stack: ['go'] }); }
  finally { rmSync(dir, { recursive: true }); }
  assert.doesNotMatch(text, /MemoryCentral|find_similar|save_memory/, 'the block must mean something to agents without MemoryCentral');
});
