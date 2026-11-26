import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryError, parseBrain, parseFocus, parseWindows, recalledWindows, transcriptOf, errorCode } from '../memory-transport.mjs';

const sys = { role: 'system', content: 'You are Mira, a study assistant.' };
const u1 = { role: 'user', content: 'What does chapter 3 say about osmosis?' };
const u2 = { role: 'user', content: 'And about diffusion?' };
const a = (text) => ({ role: 'assistant', content: text });

test('the headers of a brain turn', () => {
  assert.deepEqual(parseFocus('8 windows (12,40,77,90,91,300,301,5000); continuous, a scan every 128 steps'),
    { windows: 8, ids: [12, 40, 77, 90, 91, 300, 301, 5000], detail: 'continuous, a scan every 128 steps' });
  assert.deepEqual(parseFocus('2 windows (7,9)'), { windows: 2, ids: [7, 9], detail: '' });
  assert.deepEqual(parseFocus('0 pieces (best cover 0.12)'), { windows: 0, ids: [], detail: '0 pieces (best cover 0.12)' });
  assert.equal(parseFocus(null), null);
  assert.deepEqual(parseBrain('lookups=1; input_tokens=1951; proposals=0; front_frozen=1; trials=0; restored=0; accepted=0'),
    { lookups: 1, input_tokens: 1951, proposals: 0, front_frozen: 1, trials: 0, restored: 0, accepted: 0 });
  assert.equal(parseBrain(''), null);
  // the answer's last part: the windows as the turn ended
  assert.deepEqual(parseWindows('front=12,40; text=; appended=77; kv_added=90,91'), { front: [12, 40], text: [], appended: [77], kv_added: [90, 91] });
  assert.equal(parseWindows(undefined), null);
  assert.deepEqual(recalledWindows({ windows: { front: [12, 40], text: [12], appended: [77], kv_added: [90] }, focus: { ids: [1] } }), [12, 40, 77, 90]);
  assert.deepEqual(recalledWindows({ windows: null, focus: { ids: [7, 9] } }), [7, 9]);
  assert.deepEqual(recalledWindows({}), []);
  assert.equal(errorCode('brain append: one slot only (start the server with --parallel 1)', 501), 'one_slot');
  assert.equal(errorCode('memory mode is off (start the server with --memory-mode)', 501), 'memory_off');
  assert.equal(errorCode('brain append requires LLAMA_QSA_SEAL_FOCUS>=512 and focus_k>0', 400), 'brain_unavailable');
  assert.equal(errorCode('something else', 500), 'server_error');
});

test('the conversation so far, for a session started again', () => {
  const text = transcriptOf([sys, u1, a('Osmosis is ...'), { role: 'tool', tool_call_id: 'c', content: 'x'.repeat(2000) }, u2]);
  assert.match(text, /^\[Earlier in this conversation, oldest first\]\nUser: What does chapter 3/);
  assert.match(text, /Assistant: Osmosis is \.\.\./);
  assert.match(text, /Tool result: x{600} \[\.\.\.\]/);
  assert.ok(!text.includes('Mira'));                       // the persona is not a turn
  assert.equal(transcriptOf([sys]), '');
  const long = transcriptOf([u1, a('first answer'), u2, a('second answer')], 60);
  assert.match(long, /its beginning is left out/);
  assert.ok(long.includes('second answer') && !long.includes('first answer'));
});

test('request_done is a reason of its own; answer_lost carries its turn and conversation', () => {
  assert.equal(errorCode('request x was taken already', 409, 'request_done'), 'request_done');
  const e = new MemoryError('lost', { code: 'answer_lost', turn: 7, conversation: 'app-1' });
  assert.deepEqual([e.code, e.turn, e.conversation], ['answer_lost', 7, 'app-1']);
});
