// An answer's sources are read once, when the answer ends, and kept small with it (brain-core takeExcerpts): a source
// id names a place in the memory as it is now, and after a compaction the same id reads another passage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeExcerpts, EXCERPT_LIMITS } from '../memory-transport.mjs';

// a memory whose text can change under the same ids (a compaction)
function fakeTransport({ fail = false } = {}) {
  const tr = { version: 1, calls: 0 };
  const text = (w) => `v${tr.version} passage ${w} ` + 'x'.repeat(600);
  tr.windows = async (ids) => { tr.calls++; if (fail) throw new Error('server_down');
    return ids.map((w) => ({ window: w, label: `Book ${tr.version} / part ${w}`, text: text(w), token_start: 256 * w, token_end: 256 * w + 512 })); };
  tr.sources = async (ids) => { tr.calls++; if (fail) throw new Error('server_down');
    return ids.map((id) => ({ text: text(id), range: [256 * id, 256 * id + 512] })); };   // (passages: text and place, no names)
  return tr;
}

test('excerpts keep what the sources said when the answer ended, within the limits', async () => {
  const tr = fakeTransport();
  const record = { done: true, sources: [3, 5, 3, 9] };
  const x = await takeExcerpts(tr, record);
  assert.equal(x.kind, 'sources');
  assert.deepEqual(x.list.map((s) => s.id), [3, 5, 9]);
  assert.equal(x.more, 0);
  assert.equal(x.list[0].label, undefined);
  assert.deepEqual(x.list[0].range, [768, 1280]);
  assert.ok(x.list[0].text.startsWith('v1 passage 3 '));
  assert.ok(x.list[0].text.length <= EXCERPT_LIMITS.textChars + 1);
  assert.ok(x.list[0].text.endsWith('…'));
  // the memory is compacted afterwards: what was kept does not change, and nothing is read again
  tr.version = 2;
  const kept = JSON.stringify(x);
  assert.equal(tr.calls, 1);
  assert.equal(JSON.stringify(x), kept);
  assert.match(kept, /v1 passage 3/);
});

test('excerpts of many windows: labels for the first 32, text for the first 8, the rest counted', async () => {
  const tr = fakeTransport();
  const ids = Array.from({ length: 40 }, (_, i) => i + 100);
  const x = await takeExcerpts(tr, { done: true, windows: { front: ids } });
  assert.equal(x.kind, 'windows');
  assert.equal(x.list.length, EXCERPT_LIMITS.items);
  assert.equal(x.more, 8);
  assert.equal(x.list.filter((s) => typeof s.text === 'string').length, EXCERPT_LIMITS.textItems);
  assert.deepEqual(x.list[0].tokens, [25600, 26112]);
  // the stored size of one answer's sources stays small
  assert.ok(JSON.stringify(x).length < 6000, `${JSON.stringify(x).length} characters`);
});

test('a failed read keeps the ids, marked unverified; no sources, an empty list', async () => {
  const x = await takeExcerpts(fakeTransport({ fail: true }), { done: true, sources: [4, 7] });
  assert.deepEqual(x, { kind: 'sources', unverified: true, ids: [4, 7] });
  assert.deepEqual(await takeExcerpts(fakeTransport(), { done: true, windows: { front: [] } }), { kind: 'windows', list: [], more: 0 });
});

test('a cut text never ends inside a character', async () => {
  const tr = { sources: async (ids) => ids.map((id) => ({ id, label: 'L', text: '�' + 'a'.repeat(EXCERPT_LIMITS.textChars - 1) + '😀' + 'b'.repeat(50) })) };
  const x = await takeExcerpts(tr, { sources: [1] });
  const s = x.list[0].text;
  assert.ok(!s.startsWith('�'));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(s), 'no lone high surrogate before the ellipsis');
});
