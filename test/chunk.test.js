// Regression tests for memory chunking.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMemory, embedHash, CHUNK_CHARS, CHUNK_OVERLAP } from '../server/chunk.js';
import { EMBED_MAX_CHARS } from '../server/embed.js';

const para = (n, char = 'x') => (char.repeat(70) + '\n\n').repeat(n);

// --- The blind spot chunking exists to remove ---------------------------------
// One vector per memory meant everything past EMBED_MAX_CHARS was unreachable by
// semantic search, silently: 61 of 505 memories were over the cap and the worst
// exposed only its leading 15%.
test('covers the entire content, with no gap between chunks', () => {
  const body = para(600); // ~42 KB, far past the old cap
  const chunks = chunkMemory('big-memory', body);

  assert.ok(chunks.length > 1, 'long content must split');
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, body.length);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].start < chunks[i - 1].end, `chunk ${i} must overlap, not skip`);
  }
});

test('every chunk fits under the embed truncation cap, title included', () => {
  const title = 'a-fairly-long-memory-title-of-the-kind-extractTitle-produces';
  for (const chunk of chunkMemory(title, para(600))) {
    assert.ok(chunk.text.length <= EMBED_MAX_CHARS, `chunk of ${chunk.text.length} would be truncated`);
  }
});

test('short content stays a single chunk spanning the whole body', () => {
  const body = '# Note\n\nshort enough to fit in one vector.';
  const chunks = chunkMemory('note', body);
  assert.equal(chunks.length, 1);
  assert.deepEqual([chunks[0].start, chunks[0].end], [0, body.length]);
});

test('offsets index the content, not the title-prefixed embed text', () => {
  const body = para(600);
  for (const chunk of chunkMemory('some-title', body)) {
    // find_similar slices content by these offsets to quote the matched passage.
    assert.ok(chunk.text.endsWith(body.slice(chunk.start, chunk.end)));
  }
});

test('cuts on markdown headings rather than mid-section', () => {
  const section = h => `## ${h}\n\n${para(30)}`;
  const body = ['a', 'b', 'c', 'd', 'e', 'f'].map(section).join('');
  const chunks = chunkMemory('doc', body);
  assert.ok(chunks.length > 1, 'expected more than one chunk');
  // Every cut but the last lands where the next heading begins. Chunk *starts*
  // sit earlier than that by CHUNK_OVERLAP — the overlap is what carries a
  // passage spanning a cut, so it deliberately reaches back into the prior
  // section rather than snapping to the boundary.
  for (const chunk of chunks.slice(0, -1)) {
    assert.equal(body.slice(chunk.end, chunk.end + 2), '##', 'cut should land on a heading');
  }
  for (const chunk of chunks.slice(1)) {
    assert.ok(body.slice(chunk.start, chunk.end).length > CHUNK_OVERLAP);
  }
});

// --- Termination guards -------------------------------------------------------
test('terminates on content with no line breaks at all', () => {
  const body = 'y'.repeat(CHUNK_CHARS * 5); // one unbroken blob, no boundary to find
  const chunks = chunkMemory('blob', body);
  assert.ok(chunks.length >= 5);
  assert.equal(chunks.at(-1).end, body.length);
});

test('empty content still yields one chunk, so it cannot stay pending forever', () => {
  const chunks = chunkMemory('empty', '');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'empty\n\n');
});

// --- The hash that keeps vectors honest ---------------------------------------
// Vectors are matched to content by this hash; anything that changes the embedded
// text must change it, or a stale vector reads as current (the 2026-08-28 bug).
test('hash changes with the content', () => {
  assert.notEqual(embedHash('t', 'one'), embedHash('t', 'two'));
});

test('hash changes with the title alone', () => {
  assert.notEqual(embedHash('old-title', 'body'), embedHash('new-title', 'body'));
});

test('hash is stable for identical input', () => {
  assert.equal(embedHash('t', 'body'), embedHash('t', 'body'));
});

test('overlap is clamped below the chunk size so long memories cannot explode', () => {
  assert.ok(CHUNK_OVERLAP < CHUNK_CHARS);
});
