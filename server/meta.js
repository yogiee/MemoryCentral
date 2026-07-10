// Memory-file metadata extraction — shared by sync.js and the MCP server
// (previously duplicated in both).

const VALID_TYPES = ['feedback', 'project', 'user', 'reference', 'general'];

// Type resolves from frontmatter first (metadata.type per the memory-file
// convention), filename prefix second. The prefix rule is a Claude-ism —
// frontmatter lets non-Claude writers and unconventionally-named files
// classify correctly instead of falling into "general".
export function memoryType(filename, content = '') {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^\s*type:\s*([a-z]+)\s*$/m);
    if (m && VALID_TYPES.includes(m[1])) return m[1];
  }
  for (const t of ['feedback', 'project', 'user', 'reference']) {
    if (filename.startsWith(t)) return t;
  }
  return 'general';
}

export function extractTitle(content, filename) {
  const fm = content.match(/^---[\s\S]*?\nname:\s*(.+)/m);
  if (fm) return fm[1].trim();
  const h1 = content.match(/^#\s+(.+)/m);
  if (h1) return h1[1].trim();
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}
