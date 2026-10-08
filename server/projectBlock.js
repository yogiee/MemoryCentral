// Project metadata from the project itself, not from a model.
//
// A project declares its MemoryCentral identity in whichever instructions file
// its harness reads, with a short block:
//
//   ## MemoryCentral
//   Project: MemoryCentral
//   Description: Central memory index and dashboard for all local AI-coding projects.
//   Stack: node, sqlite, mcp, javascript
//   Use: Before a feature, fix or research task, check MemoryCentral for prior work …
//
// The same block that tells MemoryCentral what the project is also tells the
// harness to use MemoryCentral, because harnesses load these files into every
// session. It replaced the LLM extraction step (2026-10-09), which needed Ollama,
// ran on every sync, and guessed.
//
// The pre-block convention — a bare `## Stack` section — is still read, so every
// project that has one keeps its stack.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Instructions files by harness, in lookup order. The first file that carries a
// block wins; `## Stack` is looked up across the same files.
export const INSTRUCTION_FILES = [
  'AGENTS.md',                         // Codex, OpenCode, and a growing set of others
  'CLAUDE.md',                         // Claude Code
  '.github/copilot-instructions.md',   // GitHub Copilot
  'GEMINI.md',                         // Gemini CLI
];

const KEYS = { project: 'project', name: 'project', description: 'description', stack: 'stack', use: 'use' };

// The block body: everything after the heading up to the next heading of the same
// or higher level. Level 2 or deeper only — a file whose H1 title happens to be the
// heading text (this repo's own CLAUDE.md is "# MemoryCentral") is not a block.
function section(src, heading) {
  const re = new RegExp(`^(#{2,6})\\s+${heading}[ \\t]*$`, 'mi');
  const m = src.match(re);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`^#{1,${m[1].length}}\\s`, 'm'));
  return end === -1 ? rest : rest.slice(0, end);
}

// `Key: value` lines; tolerates list bullets and bold keys (`- **Stack:** node`).
export function parseBlock(body) {
  const out = {};
  for (const raw of body.split('\n')) {
    // The colon is required (inside or outside the bold) so a prose line that
    // happens to start with "Use" or "Project" is not read as a key.
    const m = raw.trim().replace(/^[-*]\s+/, '').match(/^\**\s*([A-Za-z]+)\s*(?::\**|\**\s*:)\s*(.*)$/);
    if (!m) continue;
    const key = KEYS[m[1].toLowerCase()];
    const value = m[2].replace(/\*\*$/, '').trim();
    if (key && value && !(key in out)) out[key] = value;
  }
  if (out.stack) out.stack = parseStack(out.stack.split(','));
  return out;
}

// Tags must look like tags; prose yields nothing rather than garbage.
function parseStack(candidates) {
  const tags = [...new Set(
    candidates.map(t => t.replace(/`/g, '').trim().toLowerCase()).filter(t => /^[a-z][a-z0-9.@#+_-]{0,23}$/.test(t))
  )];
  return tags.length ? tags : null;
}

// The legacy `## Stack` section: one comma line (`node, sqlite, mcp`), or a list
// whose items' leading tokens are the tags (`- Python 3.11+` → python).
function legacyStack(src) {
  const body = section(src, 'Stack');
  if (body == null) return null;
  const candidates = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet) candidates.push(bullet[1].replace(/`/g, '').split(/\s+/)[0]);
    else candidates.push(...line.split(','));
  }
  return parseStack(candidates);
}

// The first paragraph of a file that reads like prose — the description of last
// resort for projects without a block. Skips frontmatter, headings, rules, badges,
// HTML, code, tables and lists, and strips inline markdown so the dashboard shows
// text, not `**syntax**`.
export function firstParagraph(file) {
  if (!existsSync(file)) return null;
  let src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  src = src.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
  for (const p of src.split(/\n\s*\n/)) {
    const text = p.trim();
    if (!text || /^(#|!\[|\[!|<|\||[-*+] |\d+\. |>)/.test(text) || /^([-*_])\1{2,}$/.test(text)) continue;
    const plain = text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2')
      .replace(/\s+/g, ' ').trim();
    // A paragraph about the file itself, not the project — `/init` opens every
    // CLAUDE.md with "This file provides guidance to Claude Code…".
    if (plain.length < 20 || /^this (file|document) (provides|is|contains|gives)/i.test(plain)) continue;
    // Framework scaffolding READMEs describe the framework, not the project.
    if (/^(Laravel is a web application framework|This project was bootstrapped with)/.test(plain)) continue;
    return plain.length > 300 ? plain.slice(0, 297).replace(/\s+\S*$/, '') + '…' : plain;
  }
  return null;
}

// A project's description when it declares none: its README's opening paragraph,
// else its instructions file's. README first — instructions files often open with
// directions to the agent rather than a description (measured on 23 real projects,
// 2026-10-09). Only a fallback: the block's Description line is the real answer.
export function fallbackDescription(repoPath) {
  if (!repoPath) return null;
  for (const name of ['README.md', ...INSTRUCTION_FILES]) {
    const d = firstParagraph(join(repoPath, name));
    if (d) return d;
  }
  return null;
}

// Everything a project declares about itself. `file` names where the block was
// found, so the dashboard can say "from AGENTS.md" or "no block yet".
export function readProjectMeta(repoPath) {
  if (!repoPath) return null;
  const meta = { file: null, project: null, description: null, stack: null, use: null };
  for (const name of INSTRUCTION_FILES) {
    const path = join(repoPath, name);
    if (!existsSync(path)) continue;
    let src;
    try { src = readFileSync(path, 'utf8'); } catch { continue; }
    if (!meta.file) {
      const body = section(src, 'MemoryCentral');
      if (body != null) Object.assign(meta, parseBlock(body), { file: name });
    }
    if (!meta.stack) meta.stack = legacyStack(src);
  }
  return meta;
}

// The block MemoryCentral suggests for a project, prefilled from what it knows.
export function suggestBlock({ name, description, stack }) {
  return [
    '## MemoryCentral',
    `Project: ${name}`,
    `Description: ${description || '<one sentence: what this project is>'}`,
    `Stack: ${stack?.length ? stack.join(', ') : '<comma-separated tags, e.g. node, sqlite>'}`,
    `Use: Before a feature, fix or research task, check MemoryCentral for prior work (find_similar with a one-line task; find_by_stack per Stack tag). Save decisions, fixes and gotchas with save_memory (project "${name}").`,
  ].join('\n');
}
