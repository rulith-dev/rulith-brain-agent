// The loopback forwarder: an OpenAI client's requests (dsh's, or any other's), sent to Rulith Brain's memory server -
// on a server of the Rulith Memory Protocol 1.0 as requests without context to its public POST /v1/brain/chat/completions
// (only what is new; nothing else of the server is used: no status, no learning, no sources - those are the Rulith
// Brain app's own), on a server from before it as one turn at a time of draft 2. The turn logic - what is cut, the conversation each transcript goes
// on in, when a turn is taken back (and what happens when the server cannot take it back any more), waiting while
// another conversation is answered, brain mode - is brain-core.mjs, shared with Rulith Brain's own page
// (integrations/brain-ui) and the Rulith Inference app's chat.
//
//   POST /v1/chat/completions   one chat request -> one request to the brain (1.0: <server>/v1/brain/chat/completions; draft 2:
//                               one memory turn, <server>/v1/memory/input), streamed or not. The
//                               answer carries the server's X-Memory-Turn, X-Memory-Focus, X-Brain-Append and
//                               X-Memory-Recall (draft 2), and X-Brain-Session: new | continued | resumed | retaken
//                               (draft 2) | again (1.0: a request repeated, heard again).
//                               The transcript's name, when the client has one: the header X-Brain-Conversation.
//                               A turn that meets another conversation's answer in the app waits for it (busyWaitMs,
//                               15 minutes: a tool result must not be lost to a long answer there)
//   GET  /v1/models             passes through
//   GET  /brain/state           what a page shows: the server as last seen, the settings, the conversations, the last
//                               turns (each with the excerpts of its sources, read when its answer ended), and "reach": whether the server answered when it was last asked - up, loading (it
//                               answers 503 while it loads its model), down (?refresh=1 asks the server again)
//   POST /brain/windows         {"windows": [w, ...]} -> the label and source text of memory windows (what a turn
//                               recalled), from the server's /v1/memory/windows (draft 2; on 1.0 an empty list)
//   POST /brain/sources         {"ids": [...]} -> the passages an answer drew on, from the server's /v1/memory/sources
//                               (draft 2; on 1.0 an empty list)
//   POST /brain/session/new     the next request opens a new conversation (the agent's earlier ones end)
//   POST /brain/settings        {"learn_research": true | false}: the switch "Learn from research"
//   GET  /brain                 a small page of the above
//
// Learning from research (research-learn.mjs): once a turn has been answered, the web pages among its new tool results
// (what the agent opened with web_fetch) go to the memory's learn queue, each once; nothing waits for that. Draft 2
// only: on a 1.0 server the pages reach the brain as the tool results they are, and its learn queue is the app's.
import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryTransport, MemoryError, errorFrom, takeExcerpts } from './brain-core.mjs';
import { ResearchLearner } from './research-learn.mjs';
import { localCapacity, capacityText } from './capacity.mjs';

export * from './brain-core.mjs';
export * from './research-learn.mjs';

// how long a turn waits while the app's own chat (another conversation) is being answered
export const AGENT_BUSY_WAIT_MS = 15 * 60 * 1000;

const HTTP_OF = { server_down: 502, loading: 503, turn_in_flight: 503, busy: 503, memory_off: 409, one_slot: 409, brain_unavailable: 409, brain_invalid: 409, memory_load: 500, answer_lost: 409 };
// what the agent's page and its user are told when Rulith Brain does not answer (the server's own words go to the log)
export const PLAIN = {
  down: 'Rulith Brain is not reachable at',
  auth: 'The Brain access key is missing or wrong.',
  loading: 'Rulith Brain is loading the model. This takes a few minutes; the agent goes on when it is ready.',
  answer_lost: 'The memory took your message, but its reply did not arrive. Ask again if you still need the answer.',
};
const reachOf = (error) => ({ loading: 'loading', server_down: 'down', auth: 'auth' })[error?.code];
const reachMessage = (state, server) => state === 'down' ? PLAIN.down + ' ' + server : PLAIN[state];

/**
 * Waits until Rulith Brain's memory server answers with its model loaded: while nothing listens at `server`, or it
 * answers 503 (the model is loading), it says so once in plain words (`log`) and asks again every `every` ms. A server
 * that cannot serve the agent ends the wait with a MemoryError. With editable settings the page stays available
 * so its user can fix the address or key while the launcher retries. A 1.0
 * server shows its status only to the Rulith Brain app (403): its models list (GET /v1/models) is all the agent asks.
 * @returns { status, model } - the server's status (null from a 1.0 server that keeps it) and the id of its model.
 */
export async function waitForServer({ server, headers = {}, fetch: f = globalThis.fetch, log = () => {}, every = 3000, signal,
  onState = () => {}, editable = false } = {}) {
  const base = String(server).replace(/\/+$/, '');
  let said = null;
  const get = async (path) => {
    let r;
    let text;
    const timeout = AbortSignal.timeout(5000);
    try {
      r = await f(base + path, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      text = await r.text();
    } catch (error) {
      throw new MemoryError(`memory server ${path}: ${error?.message ?? error}`, { code: 'server_down' });
    }
    if (!r.ok) {
      const error = errorFrom(`memory server ${path}`, r.status, text);
      // (a 1.0 server's status is the Rulith Brain app's: 403 there is not a key it refuses)
      if (r.status === 403 && path === '/v1/memory/status') error.code = 'app_only';
      else if (r.status === 403) error.code = 'auth';
      else if (r.status === 503) error.code = 'loading';
      else if (r.status === 404) error.code = 'memory_off';
      throw error;
    }
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  for (;;) {
    if (signal?.aborted) throw new MemoryError('stopped while waiting for the memory server', { code: 'server_down' });
    let state;
    try {
      let status = null;
      try {
        status = await get('/v1/memory/status');
      } catch (error) {
        if (error?.code !== 'app_only') throw error;
      }
      if (status?.memory_mode === false) throw new MemoryError('memory mode is off', { code: 'memory_off' });
      const model = (await get('/v1/models'))?.data?.[0]?.id;
      if (model) {
        onState('up', model);
        if (said) log('Rulith Brain is ready.');
        return { status, model };
      }
      state = 'loading';   // (it answers, and lists no model yet)
    } catch (error) {
      if (signal?.aborted) throw error;
      state = reachOf(error);
      if (editable && !state && error instanceof MemoryError) state = 'down';
      if (!state || (state === 'auth' && !editable)) throw error;
    }
    onState(state);
    if (state !== said) log(reachMessage(state, base));
    said = state;
    await delay(every, undefined, { signal });
  }
}
const PASS = ['x-memory-turn', 'x-memory-focus', 'x-brain-append', 'x-memory-recall'];
const NAME = { 'x-memory-turn': 'X-Memory-Turn', 'x-memory-focus': 'X-Memory-Focus', 'x-brain-append': 'X-Brain-Append', 'x-memory-recall': 'X-Memory-Recall' };

// The marker is untrusted page text. Check the path before touching it (including network paths),
// then check its real location and both visible ends against the file dsh saved.
async function readSpill(root, { file, head, tail, omitted }) {
  // dsh-spill-local writes one file per result in session-<hash>, with a random prefix and an encoded tool name.
  const spillFile = /^session-[0-9a-f]{12}[\\/][0-9a-f]{12}-[A-Za-z0-9._~-]+\.txt$/;
  if (!path.isAbsolute(file) || !spillFile.test(path.relative(root, file))) return null;
  try {
    const target = await realpath(file);
    if (!spillFile.test(path.relative(root, target))) return null;
    const full = await readFile(target, 'utf8');
    if (Buffer.byteLength(full) !== Buffer.byteLength(head) + omitted + Buffer.byteLength(tail)) return null;
    if (full.startsWith(head) && full.endsWith(tail)) return full;
    // The original text can itself contain a paragraph saying "[...]". Find a gap with both ends intact.
    const gap = '\n\n[...]\n\n';
    const visible = head + gap + tail;
    let suffix = visible.length;
    while (suffix && visible[suffix - 1] === full[full.length - visible.length + suffix - 1]) suffix--;
    const at = visible.indexOf(gap, Math.max(0, suffix - gap.length));
    return at >= 0 && full.startsWith(visible.slice(0, at)) ? full : null;
  } catch { return null; }   // a spill may have expired
}

/**
 * @param server - the memory server.
 * @param brain - brain mode's settings (brain-core.mjs); { enabled: true } turns it on.
 * @param headers - sent to the server with every request (its API key).
 * @param panel - the HTML of GET /brain, when there is one.
 * @param spillRoot - the canonical private directory given to dsh-spill-local at this start.
 * @param learn - learning from research: { research: the switch (default on), onChange({ research }) when the page
 *   changes it, limits (research-learn.mjs RESEARCH_DEFAULTS) }.
 * @param busyWaitMs - how long a turn waits for another conversation's answer, or for the model to load.
 * @returns { proxy, transport, learner }.
 */
export function createMemoryProxy({ server, model = null, log = () => {}, fetch: f = globalThis.fetch, brain = {}, headers = {}, panel, learn = {}, spillRoot, saveConnection,
  busyWaitMs = AGENT_BUSY_WAIT_MS }) {
  // (a turn's sources are read once its answer has ended, and kept with the turn as excerpts: the page shows those,
  // never the same ids read again later against a memory that may have changed since - brain-core takeExcerpts)
  // (1.0: the server's sources and learn queue are the Rulith Brain app's own - the agent uses neither)
  const transport = new MemoryTransport({ server, log, fetch: f, brain, headers, idPrefix: 'agent', busyWaitMs,
    onTurn: (entry) => { if (entry.ok && !transport.seen?.v1) void takeExcerpts(transport, entry).then((x) => { entry.excerpts = x; }); } });
  const learner = new ResearchLearner({ transport, log, research: learn.research !== false, onChange: learn.onChange, limits: learn.limits,
    readSpill: (preview) => spillRoot ? readSpill(spillRoot, preview) : null,
    offered: () => transport.seen?.v1 !== true });
  // whether the server answered when it was last asked: { state: 'up' | 'loading' | 'down' | null, at }
  let reach = { state: null, at: null };
  const saw = (state, modelId) => {
    if (modelId) model = modelId;
    if (state) reach = { state, at: new Date().toISOString() };
  };
  const json = (res, code, body) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, error) => {
    const code = error instanceof MemoryError ? error.code : 'forwarder_error';
    const status = HTTP_OF[code] ?? (error?.status >= 400 ? error.status : 400);
    // (Rulith Brain not running, or loading its model: said in plain words to the agent's user; the log has the rest)
    // (and a message the memory took whose reply was lost: it is not sent again by itself)
    const plain = reachMessage(reachOf(error), server) ?? (code === 'answer_lost' ? PLAIN.answer_lost : undefined);
    json(res, status, { error: { message: plain ?? String(error?.message ?? error), type: 'memory_agent', code } });
  };
  const handle = (req, res) => {
    // Only the local Agent page may administer a saved destination. Reject rebound Host names too.
    if (saveConnection && !['127.0.0.1', 'localhost', '[::1]'].some(h => req.headers.host === h + ':' + req.socket.localPort))
      return json(res, 403, { error: 'Unexpected host' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace(/\/+$/, '');
      let answered = null;   // the chat request whose turn the server took: its pages are learned after the answer
      try {
        if (req.method === 'GET' && path.endsWith('/models')) {
          let r;
          try { r = await f(transport.server + '/v1/models', { headers }); }
          catch { throw new MemoryError(reachMessage('down', server), { code: 'server_down' }); }
          if (r.status === 401) {
            await r.body?.cancel();
            throw errorFrom('models', 401);
          }
          if (r.status === 503) saw('loading');
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(await r.text());
          return;
        }
        if (req.method === 'GET' && path === '/brain/capacity') {
          const zh = url.searchParams.get('lang') === 'zh';
          const summary = capacityText(localCapacity(server), zh);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          // Only fixed translations and validated numbers/plan names enter the compact sidebar view.
          res.end(`<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta http-equiv="refresh" content="60"><style>:root{color-scheme:light dark}body{margin:0;font:600 13px/1.45 system-ui;color:CanvasText}</style><body>${summary}</body></html>`);
          return;
        }
        if (req.method === 'GET' && path === '/brain/state') {
          if (url.searchParams.get('refresh') === '1' && (!saveConnection || model))
            await transport.serial(async () => {
              await transport.status(true);
              if (saveConnection) {
                const id = (await transport.json('/v1/models'))?.data?.[0]?.id;
                return saw(id ? 'up' : 'loading', id);
              }
              saw('up');
            }).catch(e => { transport.failed(e); saw(e.status === 503 ? 'loading' : reachOf(e)); });
          const capacity = localCapacity(server);
          return json(res, 200, { ...transport.state(), model, reach, configurable: !!saveConnection, learn: learner.state(), capacityText: { en: capacityText(capacity, false), zh: capacityText(capacity, true) } });
        }
        if (req.method === 'POST' && path === '/brain/connection' && saveConnection) {
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)
            return json(res, 403, { error: 'Unexpected origin' });
          if (!/^application\/json\b/i.test(req.headers['content-type'] ?? ''))
            return json(res, 415, { error: 'Expected JSON' });
          try { saveConnection(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { return json(res, 400, { error: 'Could not save connection' }); }
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && path === '/brain/settings') {
          // (JSON only: a page of another site cannot send that without asking first, and nothing here answers it)
          if (!/^application\/json\b/i.test(req.headers['content-type'] ?? ''))
            return json(res, 415, { error: { message: 'a JSON body is expected', type: 'memory_agent', code: 'bad_request' } });
          const asked = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (typeof asked?.learn_research !== 'boolean')
            return json(res, 400, { error: { message: '"learn_research": true or false', type: 'memory_agent', code: 'bad_request' } });
          learner.configure({ research: asked.learn_research });
          return json(res, 200, { learn: learner.state() });
        }
        if (req.method === 'POST' && path === '/brain/windows') {
          const asked = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').windows;
          if (!Array.isArray(asked)) return json(res, 400, { error: { message: '"windows": an array of window numbers', type: 'memory_agent', code: 'bad_request' } });
          if (transport.seen?.v1) return json(res, 200, { windows: [], offered: false });
          return json(res, 200, { windows: await transport.windows(asked.slice(0, 256)) });
        }
        if (req.method === 'POST' && path === '/brain/sources') {
          const asked = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').ids;
          if (!Array.isArray(asked)) return json(res, 400, { error: { message: '"ids": an array of source ids', type: 'memory_agent', code: 'bad_request' } });
          if (transport.seen?.v1) return json(res, 200, { sources: [], offered: false });
          return json(res, 200, { sources: await transport.sources(asked.slice(0, 256)) });
        }
        if (req.method === 'POST' && path === '/brain/session/new') { transport.newSession(); return json(res, 200, { ok: true }); }
        if (req.method === 'GET' && path === '/brain' && panel) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(panel);
          return;
        }
        if (req.method !== 'POST' || !path.endsWith('/chat/completions'))
          return json(res, 404, { error: { message: `memory agent: no route ${path}`, type: 'memory_agent', code: 'no_route' } });
        if (saveConnection && !model) {
          const state = reach.state || 'loading';
          return json(res, { auth: 401, down: 502 }[state] || 503, { error: { message: reachMessage(state, server) } });
        }
        const params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });
        const key = req.headers['x-brain-conversation'] || undefined;
        // the turn goes out (and gets its number) before the next request may read the memory's turn
        const { response: r, record } = await transport.send(params, { key, signal: ac.signal, accept: req.headers.accept });
        answered = params;
        saw('up');
        const out = { 'Content-Type': r.headers.get('content-type') ?? 'application/json', 'X-Brain-Session': record.session };
        for (const h of PASS) { const v = r.headers.get(h); if (v !== null) out[NAME[h]] = v; }
        res.writeHead(r.status, out);
        if (!r.body) { res.end(); return; }
        for await (const part of r.body) res.write(part);
        res.end();
      } catch (error) {
        if (error?.name === 'AbortError') { res.end(); return; }
        log(`memory agent: ${error.message}`);
        saw(reachOf(error));
        fail(res, error);
      } finally {
        // (the answer has gone out, or was cut off: the pages the turn carried were read all the same)
        if (answered) learner.observe(answered);
      }
    });
  };
  return { proxy: http.createServer(handle), handle, transport, learner, noteConnection: saw };
}
