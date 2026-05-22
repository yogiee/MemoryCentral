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
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let res;
  try {
    res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'llama3.1:latest',
        messages: [
          {
            role: 'system',
            content: 'You analyze software project memory files and output JSON metadata. Always respond with only valid JSON, no extra text.',
          },
          {
            role: 'user',
            content: `Read these project memory files and extract metadata. Respond with ONLY this JSON (fill in real values, do not copy the labels):
{"description": "<one sentence about what this project actually does>", "stack": ["<real tech tags>"]}

Valid tech tags: swift, swiftui, node, typescript, python, react, electron, bash, homeassistant, go, rust, wordpress, html, css

Project memory files:
${content.slice(0, 3000)}`,
          },
        ],
        stream: false,
        options: { temperature: 0 },
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);

  const data = await res.json();
  const text = data?.message?.content || '';
  const match = text.match(/\{[\s\S]*?\}/);
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
