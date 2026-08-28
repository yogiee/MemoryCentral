// Splitting a memory into the units that actually get embedded.
//
// Until 2026-08-28 every memory got exactly one vector, built from its first
// EMBED_MAX_CHARS characters. 61 of 505 memories were longer than that, and the
// worst of them (39 KB) exposed only its leading 15% to find_similar — the rest
// was unreachable by semantic search while the memory looked fully indexed.
// The failure compounded: an edit landing past the cap re-embedded to a
// byte-identical vector, so a memory whose body had entirely changed still
// scored as freshly embedded (cosine 1.0000 against its own new content).
//
// Cuts follow markdown structure — heading, then paragraph break, then any line
// break — rather than a fixed stride, so a boundary rarely lands mid-sentence.
// Consecutive chunks overlap, so a passage straddling a cut survives intact in
// one of them. Every chunk carries the memory title: an isolated middle chunk
// otherwise embeds with no signal of which document it belongs to.

import { createHash } from 'crypto';

// Body chars per chunk. Deliberately well under embed.js's EMBED_MAX_CHARS
// (6000) so the title prefix can never push a chunk back into truncation — the
// exact failure this module exists to remove.
export const CHUNK_CHARS = Number(process.env.EMBED_CHUNK_CHARS) || 4000;

// Trailing chars of each chunk repeated at the head of the next. Clamped to half
// a chunk below: an overlap approaching CHUNK_CHARS would make each step barely
// advance and turn a long memory into hundreds of near-identical vectors.
export const CHUNK_OVERLAP = Number(process.env.EMBED_CHUNK_OVERLAP) || 400;

// Never cut before this fraction of a chunk is filled. Without a floor, a
// heading two lines in would produce a 60-char chunk and the split degenerates
// into one vector per section regardless of size.
const MIN_FILL = 0.5;

// Ordered best-to-worst. `at` maps a match to the offset the NEXT chunk starts
// at, so a heading opens its chunk rather than trailing the previous one.
const BOUNDARIES = [
  { re: /\n(?=#{1,6} )/g, at: m => m.index + 1 },              // markdown heading
  { re: /\n[ \t]*\n/g,    at: m => m.index + m[0].length },    // paragraph break
  { re: /\n/g,            at: m => m.index + 1 },              // any line break
];

// The exact text embed() receives for a chunk. Title first — see above.
const chunkText = (title, body) => (title ? `${title}\n\n${body}` : body);

// Identifies the precise text a stored vector was built from. Covers the title
// as well as the content because the title is part of every chunk's embed text:
// a retitled memory (sync reclassifies titles when the extraction rules change)
// needs new vectors even though its body is untouched.
export function embedHash(title, content) {
  return createHash('sha256').update(chunkText(title, String(content))).digest('hex').slice(0, 32);
}

// Best cut position in [start, hardEnd), preferring the most structural
// boundary available. Falls back to hardEnd for content with no line breaks at
// all (a single pasted blob), which still terminates — it just cuts mid-line.
function cutPoint(content, start, hardEnd) {
  const floor = start + Math.floor(CHUNK_CHARS * MIN_FILL);
  const window = content.slice(start, hardEnd);
  for (const { re, at } of BOUNDARIES) {
    re.lastIndex = 0;
    let best = -1, m;
    while ((m = re.exec(window)) !== null) {
      const abs = start + at(m);
      if (abs > floor && abs < hardEnd) best = abs;
      if (m.index === re.lastIndex) re.lastIndex++; // zero-width match guard
    }
    if (best > 0) return best;
  }
  return hardEnd;
}

// Returns [{ index, start, end, text }] covering the whole content. `start`/`end`
// are char offsets into `content` (not into `text`, which carries the title
// prefix) so callers can quote the passage a chunk actually matched on.
export function chunkMemory(title, content) {
  const body = String(content);
  const overlap = Math.min(CHUNK_OVERLAP, Math.floor(CHUNK_CHARS / 2));
  const chunks = [];
  let start = 0;

  while (start < body.length) {
    const end = body.length - start <= CHUNK_CHARS
      ? body.length
      : cutPoint(body, start, start + CHUNK_CHARS);

    chunks.push({ index: chunks.length, start, end, text: chunkText(title, body.slice(start, end)) });
    if (end >= body.length) break;
    start = Math.max(end - overlap, start + 1); // the max() guarantees progress
  }

  // An empty memory still needs a vector, or it is permanently pending.
  if (!chunks.length) chunks.push({ index: 0, start: 0, end: 0, text: chunkText(title, '') });
  return chunks;
}
