const BASE = 'http://localhost:11434';

export async function embed(text) {
  const res = await fetch(`${BASE}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
  const { embedding } = await res.json();
  return embedding;
}

export async function extractProjectMeta(content) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let res;
  try {
    res = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'qwen3.5:2b-q4_K_M',
        // /no_think disables extended reasoning for qwen3.5 thinking models
        prompt: `/no_think Analyze these project memory files. Reply with ONLY valid JSON, no explanation:
{"description": "one sentence describing the project", "stack": ["lowercase", "tech", "tags"]}

Tech tag examples: swift, swiftui, node, typescript, python, react, electron, bash, homeassistant, go, rust

Memory content:
${content.slice(0, 3000)}`,
        stream: true,
        options: { temperature: 0 },
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new Error(`Ollama generate failed: ${res.status}`);

  // Collect streamed tokens, strip <think>…</think> blocks
  let full = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split('\n')) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        if (chunk.response) full += chunk.response;
      } catch { /* ignore partial lines */ }
    }
  }

  // Strip thinking tags if present
  full = full.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const match = full.match(/\{[\s\S]*?\}/);
  if (!match) return { description: '', stack: [] };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { description: '', stack: [] };
  }
}

export function cosineSimilarity(a, b) {
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA  += a[i] * a[i];
    mB  += b[i] * b[i];
  }
  return dot / (Math.sqrt(mA) * Math.sqrt(mB));
}
