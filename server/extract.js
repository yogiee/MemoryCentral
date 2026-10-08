// Optional: describe projects automatically with a local Ollama model.
//
// Off by default; the user turns it on in Settings (it downloads a model). It only
// fills gaps: a project's own MemoryCentral block, or a description an AI tool set
// with set_project_info, always wins (see ingest.js refreshProjectMeta). It suits
// memory that isn't organised around repositories — an app with free-form chats,
// say — where no instructions file exists to carry a block.
//
// Removed 2026-10-09 as an always-on step and brought back the same day as this
// opt-in. Everything learned running it on every sync is kept below.

import { getSetting } from './settings.js';
import { activeConfig } from './embed.js';

// The suggested model. GGUF, so it runs wherever Ollama does (not MLX-only).
// Pinned 2026-09-23 for residency: 2.6 GB loaded vs gemma4:e4b-mlx's 9.4 GB — but
// ONLY with EXTRACT_NUM_CTX and think:false below; without them it pre-allocates
// 13.3 GB and thinks for 24-85 s. Measured on all 27 projects' real payloads:
// 0 failures, 0.9-3.2 s (median 1.6 s). Earlier pins died silently when uninstalled
// (llama3.1, gemma4:latest), which is why a 404 now names the model.
export const SUGGESTED_EXTRACT_MODEL = { model: 'granite4.2:3b', label: 'Granite 4.2 (3B)', sizeMB: 2200 };

// Abort budget for one project. 60 s keeps a busy GPU from reading as a dead pin;
// a model that needs more is the wrong model for a background step.
export const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS ?? 60_000);

// Without num_ctx Ollama allocates the model's full native window (131k-262k), which
// pre-sizes a GGUF model's KV cache to 13-32 GB for a ~1k-token prompt.
export const EXTRACT_NUM_CTX = Number(process.env.EXTRACT_NUM_CTX ?? 4096);

// Closed vocabulary for model-extracted stack tags. No model reliably respects an
// in-prompt allowlist, so it is enforced after the fact too. Declared stacks (project
// blocks) are open vocabulary and never pass through here.
export const STACK_TAGS = [
  'swift', 'swiftui', 'node', 'typescript', 'python', 'react', 'electron',
  'bash', 'homeassistant', 'go', 'rust', 'wordpress', 'html', 'css',
];

// A longer stack is the model reciting the allowlist (granite returned all 14 once);
// no tags beats wrong ones.
export const MAX_STACK_TAGS = 9;

// Active only when the user turned it on AND the search engine is Ollama — the
// setting is offered only then, and a later switch to the built-in engine pauses it.
export function extractConfig(db) {
  const cfg = activeConfig();
  const enabled = !!getSetting(db, 'extract.enabled') && cfg.provider === 'ollama';
  return { enabled, host: cfg.host, model: process.env.EXTRACT_MODEL || getSetting(db, 'extract.model') || SUGGESTED_EXTRACT_MODEL.model };
}

// What the model reads: an overview of the whole project, not raw note text. Fed the
// first 3,000 characters of the memories themselves, the model described whichever
// note happened to come first ("A feedback note about browsermcp…", measured on 27
// real projects, 2026-10-09). The project's name, its README opening and one line per
// memory — title and frontmatter description, project notes first — fit far more of
// the project into the same budget.
const TYPE_ORDER = { project: 0, reference: 1, user: 2, feedback: 3, general: 4 };

export function projectDigest(name, memories, readme = null) {
  const lines = [`Project name: ${name}`];
  if (readme) lines.push(`README: ${readme}`);
  lines.push(`Memory notes (${memories.length}):`);
  const sorted = [...memories].sort((a, b) => (TYPE_ORDER[a.memory_type] ?? 9) - (TYPE_ORDER[b.memory_type] ?? 9));
  for (const m of sorted) {
    const fm = String(m.content).match(/^---\n[\s\S]*?\n---/)?.[0] || '';
    const desc = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]
      || String(m.content).replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    lines.push(`- [${m.memory_type}] ${m.title}: ${desc}`);
  }
  return lines.join('\n').slice(0, 3000);
}

// Returns { description, stack } or null (failure is reported on stderr, never thrown).
export async function extractProjectMeta(content, { host, model }) {
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You analyze project memory notes and output JSON metadata. Always respond with only valid JSON, no extra text.' },
          { role: 'user', content: `Below is an overview of one project: its name, possibly its README, and a one-line summary of each memory note kept about it. Describe the PROJECT AS A WHOLE — what it is or does — not any single note. Respond with ONLY this JSON:
{"description": "<one sentence: what this project is or does>", "stack": ["<real tech tags>"]}

Valid tech tags: ${STACK_TAGS.join(', ')}

${content.slice(0, 3000)}` },
        ],
        stream: false,
        think: false, // thinking models otherwise reason for 9-85 s before a ~50-token answer
        options: { temperature: 0, num_ctx: EXTRACT_NUM_CTX },
      }),
    });
    if (!res.ok) {
      process.stderr.write(`extract: ${model} returned HTTP ${res.status}${res.status === 404 ? ` — not installed (ollama pull ${model}, or turn auto-description off in Settings)` : ''}\n`);
      return null;
    }
    const text = (await res.json())?.message?.content || '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const meta = JSON.parse(match[0]);
    const allow = new Set(STACK_TAGS);
    meta.stack = Array.isArray(meta.stack)
      ? [...new Set(meta.stack.map(t => String(t).toLowerCase().trim()))].filter(t => allow.has(t))
      : [];
    if (meta.stack.length > MAX_STACK_TAGS) meta.stack = [];
    meta.description = String(meta.description || '').trim();
    return meta.description ? meta : null;
  } catch (err) {
    process.stderr.write(`extract: ${model} failed — ${err?.name === 'TimeoutError' ? `no answer in ${EXTRACT_TIMEOUT_MS / 1000}s` : err?.cause?.code || err?.message}\n`);
    return null;
  }
}
