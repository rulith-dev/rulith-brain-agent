import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTransport, createMemoryProxy, heldDigest, lastAnswer, memoryDelta, waitForServer } from '../memory-transport.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentConnection } from '../tools/connection.mjs';
import { chatFixture } from './chat-fixture.mjs';

test('saved address and key, command line and environment, then the current local Brain settings', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connection-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: home };
  const options = { home, env };
  const { resolve, save } = agentConnection(options);
  assert.equal(resolve().server, 'http://127.0.0.1:8091');
  const localKey = randomUUID(), envKey = randomUUID(), savedKey = randomUUID();
  const write = (root, port) => {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'settings.json'), JSON.stringify({ network: { port, api_key: localKey } }));
  };
  write(path.join(home, 'Rulith', 'Brain'), 16000);
  assert.equal(resolve().server, 'http://127.0.0.1:16000');
  env.RULITH_BRAIN_HOME = path.join(home, 'other');
  write(env.RULITH_BRAIN_HOME, 16001);
  assert.ok(resolve().server.endsWith(':16001') && resolve().key === localKey);
  write(env.RULITH_BRAIN_HOME, 16002);
  assert.equal(resolve().server, 'http://127.0.0.1:16002');
  write(env.RULITH_BRAIN_HOME, 99999);
  assert.equal(resolve().server, 'http://127.0.0.1:8091');
  env.RULITH_MEMORY_KEY = envKey;
  assert.ok(resolve().key === envKey);
  env.RULITH_MEMORY_SERVER = 'https://brain.example:18000/';
  assert.ok(resolve().server === 'https://brain.example:18000' && resolve().key === envKey);
  save({ server: resolve().server });
  assert.ok(resolve().key === envKey);
  save({ automatic: true });
  const cli = agentConnection({ ...options, server: 'http://cli.example' });
  assert.ok(cli.resolve().server === 'http://cli.example' && cli.resolve().key === envKey);
  delete env.RULITH_MEMORY_KEY;
  assert.ok(cli.resolve().key === '');
  env.RULITH_MEMORY_KEY = envKey;
  save({ server: 'https://saved.example', key: savedKey });
  assert.ok(cli.resolve().server === 'https://saved.example' && cli.resolve().key === savedKey);
  save({ server: 'https://saved.example/' });
  assert.ok(resolve().key === savedKey);
  save({ server: 'https://other.example' });
  assert.ok(resolve().key === '');
  save({ server: 'https://other.example', key: savedKey });
  save({ server: 'https://other.example', key: '' });
  assert.ok(resolve().key === '');
  for (const server of ['file:///path', 'https://user:password@example.org', 'https://example.org/?key=value'])
    assert.throws(() => save({ server }), /Brain address/);
  save({ automatic: true });
  assert.ok(cli.resolve().server === 'http://cli.example' && cli.resolve().key === envKey);
});

test('remote discovery, model forwarding, chat and memory requests authenticate to the selected Brain', async (t) => {
  const fixture = chatFixture();
  const key = randomUUID();
  const headers = { Authorization: 'Bearer ' + key };
  const paths = [];
  const upstream = async (url, init) => {
    assert.equal(new URL(url).origin, fixture.server);
    assert.ok(new Headers(init.headers).get('Authorization') === headers.Authorization);
    const { pathname } = new URL(url);
    paths.push(pathname);
    if (pathname === '/v1/models') return Response.json({ data: [{ id: 'model' }] });
    if (pathname === '/v1/memory/learn') return Response.json({ ids: [] });
    return fixture.fetch(url, init);
  };
  const options = { server: fixture.server, headers, fetch: upstream };
  const { model } = await waitForServer(options);
  assert.equal(model, 'model');
  const { proxy, transport } = createMemoryProxy(options);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  await (await fetch('http://127.0.0.1:' + proxy.address().port + '/v1/models')).json();
  await (await transport.send({ messages: [{ role: 'user', content: 'hello' }] })).response.text();
  await transport.json('/v1/memory/learn', { items: [] });
  assert.deepEqual(paths, ['/v1/memory/status', '/v1/models', '/v1/models', '/v1/memory/status',
    '/v1/brain/chat/completions', '/v1/memory/learn']);
});

test('HTTP 401 from status, the models list or chat reports a key problem without echoing the response', async (t) => {
  const echoed = randomUUID();
  const refused = () => new Response(echoed, { status: 401 });
  const auth = error => error.code === 'auth' && error.status === 401 && !error.message.includes(echoed);
  const server = 'https://brain.example';
  await assert.rejects(waitForServer({ server, fetch: refused }), auth);
  const upstream = url => url.endsWith('/status') ? new Response(null, { status: 403 }) : refused();
  await assert.rejects(waitForServer({ server, fetch: upstream }), auth);
  const { proxy, transport } = createMemoryProxy({ server, fetch: upstream, model: 'previous-model', saveConnection() {} });
  await assert.rejects(transport.send({ messages: [{ role: 'user', content: 'hi' }] }), auth);
  assert.ok(!JSON.stringify(transport.state()).includes(echoed));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const origin = 'http://127.0.0.1:' + proxy.address().port;
  const models = await fetch(origin + '/v1/models');
  assert.equal(models.status, 401);
  assert.ok(!(await models.text()).includes(echoed));
  const state = await (await fetch(origin + '/brain/state?refresh=1')).json();
  assert.equal(state.reach.state, 'auth');
  assert.ok(!JSON.stringify(state).includes(echoed));
});

const sys = { role: 'system', content: 'You are an agent.' };
const u1 = { role: 'user', content: 'hello' };
const a1 = { role: 'assistant', content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] };
const t1 = { role: 'tool', tool_call_id: 'c1', content: 'file text' };
const a2 = { role: 'assistant', content: 'done' };
const u2 = { role: 'user', content: 'next question' };

test('the first turn keeps the system prompt', () => {
  assert.deepEqual(memoryDelta([sys, u1], true), [sys, u1]);
});

test('later turns send only what follows the last answer', () => {
  assert.deepEqual(memoryDelta([sys, u1, a1, t1], false), [t1]);
  assert.deepEqual(memoryDelta([sys, u1, a1, t1, a2, u2], false), [u2]);
});

test('a new conversation on an existing memory drops its system prompt', () => {
  assert.deepEqual(memoryDelta([sys, u2], false), [u2]);
});

test('a system update after the start becomes a user note', () => {
  const dev = { role: 'developer', content: 'The date is now 2026-11-07.' };
  assert.deepEqual(memoryDelta([sys, u1, a2, dev, u2], false), [{ role: 'user', content: '(system note) The date is now 2026-11-07.' }, u2]);
  assert.deepEqual(memoryDelta([sys, u1, a1, t1, dev], false), [t1, { role: 'user', content: '(system note) The date is now 2026-11-07.' }]);
});

test('lastAnswer and heldDigest', () => {
  assert.equal(lastAnswer([sys, u1]), -1);
  assert.equal(lastAnswer([sys, u1, a1, t1]), 2);
  assert.equal(heldDigest([sys, u1, a1, t1]), heldDigest([sys, u1, a1, u2]));
  assert.notEqual(heldDigest([sys, u1, a1, t1]), heldDigest([sys, u1, a1, t1, a2, u2]));
});

// a fake memory server for the turn logic: status and undo
function fakeServer(turn = 0) {
  const calls = [];
  const undone = [];
  const state = { turn };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    let body = {};
    if (path === '/v1/memory/status') body = { memory_mode: true, turn: state.turn };
    else if (path === '/v1/memory/undo') { undone.push(JSON.parse(init.body)); body = { turn: --state.turn }; }
    else return { ok: false, status: 404, text: async () => 'no' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls, state, undone };
}

const send = async (tr, srv, params, key) => { const out = await tr.rewrite(params, key); srv.state.turn += 1; tr.accepted(out, srv.state.turn); return out.body; };

const front = (...parts) => ({ role: 'system', content: parts.map((m) => m.content ?? m).join('\n\n') });

test("dsh's repeated context goes to the memory only when it changes; on an opening turn it is read with the front", async () => {
  const srv = fakeServer();
  const tr = new MemoryTransport({ server: 'http://x', fetch: srv.fetch });
  const rt = (n) => ({ role: 'user', content: `Current runtime context. Snapshot ${n}.` });
  const sk = { role: 'user', content: '<system-reminder>\nA skill is a reusable set of task-specific instructions. Skills: a, b.' };
  const time = { role: 'user', content: 'Time sampled while preparing turn 1, step 1: 2026-11-06T09:12:49' };
  const p1 = await send(tr, srv, { messages: [sys, u1, rt(1), sk, time] });
  assert.deepEqual(p1.messages, [front(sys, rt(1), sk), u1, time]);
  assert.equal(p1.conversation_open, true);
  const p2 = await send(tr, srv, { messages: [sys, u1, rt(1), sk, time, a2, rt(1), sk, time, u2] });
  assert.deepEqual(p2.messages, [time, u2]);
  assert.equal(p2.conversation, p1.conversation);
  assert.equal(p2.conversation_open, undefined);
  // another transcript: a conversation of its own, its notes in its own front
  const p3 = await send(tr, srv, { messages: [sys, u1, a2, rt(2), sk, u2, a2, rt(2), sk, u1] });
  assert.deepEqual(p3.messages, [front(sys, rt(2), sk), u1]);
  assert.notEqual(p3.conversation, p1.conversation);
  // taken back: its opening turn, so it opens again under its id, with the context again
  const p4 = await send(tr, srv, { messages: [sys, u1, a2, rt(2), sk, u2, a2, rt(2), sk, u1] });
  assert.deepEqual(p4.messages, p3.messages);
  assert.equal(p4.conversation, p3.conversation);
  assert.equal(p4.conversation_open, true);
  assert.equal(p4.previous_turn, 2);
});

test('turns go out with previous_turn, a conversation and a request id; tools on the opening turn only', async () => {
  const srv = fakeServer();
  const tr = new MemoryTransport({ server: 'http://x', fetch: srv.fetch, idPrefix: 'agent' });
  const tools = [{ type: 'function', function: { name: 'read' } }];
  const p1 = await send(tr, srv, { model: 'm', messages: [sys, u1], tools, stream: true });
  assert.equal(p1.previous_turn, 0);
  assert.deepEqual(p1.messages, [sys, u1]);
  assert.deepEqual(p1.tools, tools);
  assert.equal(p1.conversation_open, true);
  assert.match(p1.conversation, /^agent-[a-z0-9]{12}$/);
  assert.match(p1.request_id, /^agent-[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(p1.end_conversations, undefined);
  assert.equal(p1.forget_conversations, undefined);
  for (const old of ['session_open', 'session_keep', 'session_system', 'forget_conversation']) assert.equal(p1[old], undefined);
  const p2 = await send(tr, srv, { model: 'm', messages: [sys, u1, a1, t1], tools, stream: true });
  assert.equal(p2.previous_turn, 1);
  assert.deepEqual(p2.messages, [t1]);
  assert.equal(p2.tools, undefined);
  assert.equal(p2.conversation, p1.conversation);
  assert.notEqual(p2.request_id, p1.request_id);
  assert.ok(!srv.calls.includes('/v1/memory/undo'));
});

test('a request that repeats the last one takes its turn back first', async () => {
  const srv = fakeServer();
  const tr = new MemoryTransport({ server: 'http://x', fetch: srv.fetch });
  await send(tr, srv, { messages: [sys, u1] });
  await send(tr, srv, { messages: [sys, u1, a2, u2] });
  // the answer to u2 was not kept (regenerate, retry, stopped): same held part as the previous request
  const p = await send(tr, srv, { messages: [sys, u1, a2, u2] });
  assert.deepEqual(srv.calls.filter((c) => c === '/v1/memory/undo'), ['/v1/memory/undo']);
  assert.deepEqual(srv.undone, [{ turn: 2 }]);
  assert.equal(p.previous_turn, 1);
  assert.deepEqual(p.messages, [u2]);
  assert.equal(p.conversation_open, undefined);
  // an answer stopped before dsh kept it, then a new message: both user messages go again
  const u3 = { role: 'user', content: 'third' };
  const q = await send(tr, srv, { messages: [sys, u1, a2, u2, u3] });
  assert.equal(q.previous_turn, 1);
  assert.deepEqual(q.messages, [u2, u3]);
});

test('a regenerated first answer resends the system prompt', async () => {
  const srv = fakeServer();
  const tr = new MemoryTransport({ server: 'http://x', fetch: srv.fetch });
  await send(tr, srv, { messages: [sys, u1] });
  const p = await send(tr, srv, { messages: [sys, u1] });
  assert.equal(p.previous_turn, 0);
  assert.deepEqual(p.messages, [sys, u1]);
  assert.equal(p.conversation_open, true);
});

test('another conversation continues the same memory without undo', async () => {
  const srv = fakeServer();
  const tr = new MemoryTransport({ server: 'http://x', fetch: srv.fetch });
  await send(tr, srv, { messages: [sys, u1, a2, u2] });
  const other = { role: 'user', content: 'from another conversation' };
  const p = await send(tr, srv, { messages: [{ role: 'system', content: 'other prompt' }, other] });
  assert.equal(p.previous_turn, 1);
  assert.deepEqual(p.messages, [{ role: 'system', content: 'other prompt' }, other]);
  assert.equal(p.conversation_open, true);
  assert.ok(!srv.calls.includes('/v1/memory/undo'));
});

test('a request with nothing new is refused', async () => {
  const srv = fakeServer(3);
  const tr = new MemoryTransport({ server: 'http://x', fetch: srv.fetch });
  await assert.rejects(tr.rewrite({ messages: [sys, u1, a2] }), /nothing new/);
});

test('two new conversations in a row are not a repeat', async () => {
  const srv = fakeServer();
  const tr = new MemoryTransport({ server: 'http://x', fetch: srv.fetch });
  await send(tr, srv, { messages: [sys, u1] });
  // the same system prompt, another first message: another conversation, the first one's turn stays
  const p = await send(tr, srv, { messages: [sys, u2] });
  assert.equal(p.previous_turn, 1);
  assert.ok(!srv.calls.includes('/v1/memory/undo'));
  // named conversations: the same first message in another conversation is not a repeat either
  const q = await send(tr, srv, { messages: [sys, u2] }, 'thread-b');
  assert.equal(q.previous_turn, 2);
  await send(tr, srv, { messages: [sys, u2] }, 'thread-c');
  assert.ok(!srv.calls.includes('/v1/memory/undo'));
  // and the same conversation's same first message is one
  const r = await send(tr, srv, { messages: [sys, u2] }, 'thread-c');
  assert.equal(r.previous_turn, 3);
  assert.deepEqual(srv.calls.filter((c) => c === '/v1/memory/undo'), ['/v1/memory/undo']);
});
