#!/usr/bin/env node
// Rulith Brain Agent launcher: dsh's web app on Rulith Brain's memory server.
//   node start.mjs [<server url> | --server http://127.0.0.1:8091] [--home <folder>] [--learn-research on|off]
//                  [dsh web flags such as --port 3000 --no-open]
// The Connection page can select a Brain on this PC or another computer. While Brain is unreachable or still
// loading its model, the agent waits. The agent's own files go to --home, default ~/.rulith-brain-agent; the memory
// itself stays with the server.
//   --learn-research  "Learn from research" (default on): pages the agent reads while working on a task are learned
//               into the memory (research-learn.mjs). Also RULITH_BRAIN_LEARN_RESEARCH=on|off; the page's switch is
//               kept in <home>/agent-settings.json and is the default of the next start
// For developers (README.md, "Developer flags"): [--brain on|off] [--front kv|text] [--focus-k 1..256]
//   [--focus-every N] [--persona <text file>] [--system both|request|persona] [--forwarder-port N]
//   --brain     brain mode (default on): the memory windows picked for each message and re-chosen as the answer is
//               written, the persona read once a conversation (its opening turn)
//   --front, --focus-k, --focus-every   how a turn recalls; unset, the server's memory folder decides (status.recall:
//               kv, 12 windows, chosen again every 16 steps by default)
//   --persona   a text file read as each conversation's front before dsh's own system prompt (--system picks which go);
//               default brain-front.md, the agent's own; "none": no front of the agent's
// The agent's page, http://127.0.0.1:<forwarder port>/brain, says whether Brain runs, has the switches, and shows what
// the last answer drew on. The page carries the product's brand (rulith-brain-ui, copied into the dsh profile at every
// start); the packaged agent (tools/pack.mjs) starts this file with its own Node through start.cmd.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMemoryProxy, waitForServer } from './memory-transport.mjs';
import { proxyEnv, windowsProxySettings } from './system-proxy.mjs';
import { capacityLimit, capacityText, localCapacity } from './capacity.mjs';
import { agentConnection } from './tools/connection.mjs';
import { portableUpdate } from './tools/agent-update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = 'rulith-memory';

const argv = process.argv.slice(2);
const take = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const fail = (text) => { console.error(text); process.exit(1); };
const oneOf = (flag, value, allowed) => allowed.includes(value) ? value : fail(`${flag}: ${allowed.join(' or ')}`);

// the server's address may also come first, alone (start.cmd http://host:port)
if (/^https?:\/\//i.test(argv[0] ?? '')) argv.splice(0, 1, '--server', argv[0]);
const serverFlag = take('--server');
const home = path.resolve(take('--home', process.env.RULITH_BRAIN_AGENT_HOME || process.env.RULITH_MEMORY_AGENT_HOME
  || path.join(os.homedir(), '.rulith-brain-agent')));
const brainOn = oneOf('--brain', take('--brain', process.env.RULITH_BRAIN || 'on'), ['on', 'off']) === 'on';
// the settings the agent's page changes, kept for the next start (a flag or the environment goes before them)
const settingsFile = path.join(home, 'agent-settings.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* none yet */ }
if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
let learnResearch = oneOf('--learn-research', take('--learn-research', process.env.RULITH_BRAIN_LEARN_RESEARCH
  || (saved.learnResearch === false ? 'off' : 'on')), ['on', 'off']) === 'on';
const saveSettings = (change) => {
  saved = { ...saved, ...change };
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify(saved, null, 2)}\n`);
  } catch (error) {
    console.log(`Rulith Brain Agent: the setting was not kept for the next start (${error.message})`);
  }
};
// (developer flags) unset: the server's memory folder decides how a turn recalls (brain-core.mjs request())
const frontFlag = take('--front');
const front = frontFlag === undefined ? undefined : oneOf('--front', frontFlag, ['kv', 'text']);
const focusK = Number(take('--focus-k', 0));
if (!Number.isInteger(focusK) || focusK < 0 || focusK > 256) fail('--focus-k: 1 to 256');
const focusEvery = Number(take('--focus-every', 0));
if (!Number.isInteger(focusEvery) || focusEvery < 0 || focusEvery > 65536) fail('--focus-every: 1 to 65536');
const systemFrom = oneOf('--system', take('--system', 'both'), ['both', 'request', 'persona']);
const personaFile = take('--persona');
const forwarderPort = Number(take('--forwarder-port', 0));
// The conversation's front: unless --persona names another file (or "none"), the agent's own (brain-front.md) tells
// the model what it works on - a memory that keeps what it reads and forgets what is used least, with no context limit
// - so it reads long material through to the end instead of refusing for context size.
let persona = '';
if (personaFile !== 'none') {
  const file = personaFile ? path.resolve(personaFile) : path.join(here, 'brain-front.md');
  try { persona = fs.readFileSync(file, 'utf8').trim(); } catch (error) { fail(`--persona: ${error.message}`); }
}
function findHarness() {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
  } catch {
    fail(`dsh is not installed here: run "npm install" in ${here} first.`);
  }
}

// the forwarder dsh's model route points at: each request goes to the memory as one turn (its conversation ids start
// with "agent"; a turn that meets the app's own chat being answered waits for it, up to 15 minutes)
const { privateRoot } = await import('@deepseek-ai/dsh-spill-local');
const spillRoot = fs.realpathSync(privateRoot());
const connection = agentConnection({ home, server: serverFlag });
const panel = fs.readFileSync(path.join(here, 'brain-panel.html'), 'utf8');
const update = process.env.RULITH_AGENT_DESKTOP === '1' ? Promise.resolve(null) : portableUpdate(proxyEnv(windowsProxySettings()));
let current;
const proxy = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/brain/agent-update') {
    // The chat UI lives on a second loopback port. Only this public release notice is readable there.
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin ?? ''))
      headers['Access-Control-Allow-Origin'] = req.headers.origin;
    update.then(notice => { res.writeHead(200, headers); res.end(JSON.stringify(notice)); });
    return;
  }
  if (current?.stillSelected()) return current.handle(req, res);
  res.writeHead(503, { 'Retry-After': '1' });
  res.end();
});
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(forwarderPort, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${proxy.address().port}`;
const base = `${origin}/v1`;

// Keep the settings page on the same local port while replacing everything tied to the previous Brain.
for (;;) {
  const { server, key } = connection.resolve();
  const controller = new AbortController();
  const { signal } = controller;
  const stillSelected = () => {
    const next = connection.resolve();
    if (next.server !== server || next.key !== key) controller.abort();
    return !signal.aborted;
  };
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const brainFetch = (url, init) => {
    stillSelected();
    signal.throwIfAborted();
    return fetch(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
  };
  const session = createMemoryProxy({ server, headers, spillRoot, panel, fetch: brainFetch, log: console.log,
    brain: { enabled: brainOn, front, focusK, focusEvery, persona, systemFrom },
    learn: { research: learnResearch, onChange: ({ research }) => { learnResearch = research; saveSettings({ learnResearch }); } },
    saveConnection: (change) => { connection.save(change); stillSelected(); } });
  current = { stillSelected, handle: session.handle };
  console.log(`Brain connection page: ${origin}/brain?setup=1`);
  try {
    const { status, model } = await waitForServer({ server, headers, fetch: brainFetch, log: console.log, signal,
      onState: session.noteConnection, editable: true });
    if (!stillSelected()) continue;
    const local = localCapacity(server);
    console.log('Brain capacity ' + JSON.stringify([capacityText(local, false), capacityText(local, true)]));
    console.log(`Connected to Rulith Brain at ${server}.`);
    const code = await runHarness(server, model, local, status, signal);
    if (!signal.aborted) process.exit(code ?? 0);
  } catch (error) {
    if (!signal.aborted) fail(error.message);
  }
}

async function runHarness(server, model, local, status, signal) {
  const dshBin = findHarness();
  console.log(`The agent's page: ${origin}/brain`);
  console.log('Learn from research: ' + (learnResearch ? 'on' : 'off')
    + (status?.mode === 'read_only' ? ' (this memory is read-only)' : ''));
  const overlay = path.join(here, 'memory-agent.cordis.yml');
  // the web: through the system's proxy when Windows is set to use one (as a browser follows it)
  const viaProxy = proxyEnv(windowsProxySettings());
  const proxyOf = (e) => e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy || '';
  if (viaProxy.HTTPS_PROXY) console.log(`The web is reached through the system's proxy (${viaProxy.HTTPS_PROXY}).`);
  else if (viaProxy.NODE_USE_ENV_PROXY && proxyOf(process.env)) console.log(`The web is reached through the proxy your environment names (${proxyOf(process.env).replace(/\/\/[^@/]*@/, '//')}).`);
  const env = {
    ...process.env,
    ...viaProxy,
    DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1',
    RULITH_BRAIN_SPILL_ROOT: spillRoot,
    RULITH_MEMORY_SERVER: server, RULITH_MEMORY_BASE: base, RULITH_MEMORY_MODEL: model,
    // (11-24, the owner: the page said 100M under a 10M trial) what the page's context meter measures against
    RULITH_MEMORY_CONTEXT: String(capacityLimit(local) ?? 100000000),
    // The harness calls only our loopback forwarder. The Brain credential stays in the launcher.
    RULITH_MEMORY_KEY: 'local',
  };
  fs.mkdirSync(home, { recursive: true });

  // the profile is made once from dsh's shipped web template
  if (!fs.existsSync(path.join(home, 'profiles', PROFILE, 'package.json'))) {
    const made = spawnSync(process.execPath, [dshBin, '--profile', PROFILE, '--from-default-profile', 'web', '--patch', overlay, '--dump-config'],
      { cwd: here, env, stdio: ['ignore', 'ignore', 'inherit'] });
    if (made.status !== 0) process.exit(made.status ?? 1);
    console.log(`Profile "${PROFILE}" created in ${home}.`);
  }
  // the agent's own plugins - the page's brand, the search without an account: a fresh copy at every start (no link),
  // so a newer agent never runs with an older one
  for (const own of ['rulith-brain-ui', 'rulith-brain-web']) {
    const to = path.join(home, 'profiles', PROFILE, 'node_modules', own);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(here, own), to, { recursive: true });
  }
  // the brand's sidebar entry opens the agent's own Brain page: its address is this start's (the forwarder's port)
  {
    const client = path.join(home, 'profiles', PROFILE, 'node_modules', 'rulith-brain-ui', 'lib', 'client.js');
    fs.writeFileSync(client, fs.readFileSync(client, 'utf8').replace('"__RULITH_BRAIN_PANEL__"', JSON.stringify(`${origin}/brain`)));
  }

  const child = spawn(process.execPath, [dshBin, '--profile', PROFILE, '--patch', overlay, ...argv],
    { cwd: process.cwd(), env, stdio: ['inherit', 'pipe', 'inherit'] });
  // dsh's own lines name it ("dsh web: <address>"); the console says whose address it is
  const named = (line) => line.replace(/^dsh web: /, 'Rulith Brain Agent: ');
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    const lines = (pending + text).split('\n');
    pending = lines.pop();
    for (const line of lines) process.stdout.write(`${named(line)}\n`);
  });
  child.stdout.on('end', () => { if (pending) process.stdout.write(named(pending)); });
  const stop = () => child.kill();
  signal.addEventListener('abort', stop, { once: true });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally {
    signal.removeEventListener('abort', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
