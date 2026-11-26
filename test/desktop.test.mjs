// The desktop app (desktop/: a Tauri shell around the agent the zip package holds; tools/desktop.mjs builds its
// setup): what can be checked without building it - the shell and the launcher agree on the lines that pass between
// them, the shell's own page knows the launcher's words in both languages, the setup's parts are there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import { PLAIN } from '../memory-transport.mjs';
import { capacityLimit, capacityText, localCapacity } from '../capacity.mjs';

test('the local capacity summary uses the measured device and the current licence, including older trials', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-capacity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const folder = path.join(home, 'config', 'brain');
  fs.mkdirSync(folder, { recursive: true });
  const env = { RULITH_BRAIN_APP_HOME: home };
  const local = () => localCapacity('http://127.0.0.1:8091', env);
  assert.deepEqual(local(), { device: null, tier: null });
  fs.writeFileSync(path.join(folder, 'device.json'), '{"device_max":40000000}');
  const file = path.join(home, 'licence.txt');
  fs.writeFileSync(file, 'test');
  const st = fs.statSync(file, { bigint: true });
  const keep = (status) => fs.writeFileSync(path.join(folder, 'licence.json'), JSON.stringify({
    key: [null, null, file, [Number(st.mtimeNs), Number(st.size)]], status: { ok: true, ...status },
  }));
  keep({ kind: 'trial', tier: 'trial' });
  assert.match(capacityText(local(), true), /40M.*试用上限 10M/);
  keep({ kind: 'paid', tier: '50M' });
  assert.match(capacityText(local(), false), /40M.*50M/);
  keep({ kind: 'trial', expires: 1 });
  assert.equal(local().tier, null);
  assert.equal(localCapacity('http://example.test:8091', env), null);
  for (const url of ['http://127.0.0.1:18400', 'http://localhost', 'http://[::1]:3900'])
    assert.deepEqual(localCapacity(url, { RULITH_BRAIN_HOME: home }), local(), url);
  for (const url of ['http://192.0.2.17:8091', 'https://localhost.example', 'http://[2001:db8::1]:5800'])
    assert.equal(localCapacity(url, env), null, url);
  // what the page's context meter measures against: the licence's size, no more than the device's estimate
  assert.equal(capacityLimit({ device: 40e6, tier: 'trial' }), 10e6);
  assert.equal(capacityLimit({ device: 40e6, tier: '50M' }), 40e6);
  assert.equal(capacityLimit({ device: null, tier: '50M' }), 50e6);
  assert.equal(capacityLimit({ device: 6e6, tier: '10M' }), 6e6);
  assert.equal(capacityLimit({ device: 40e6, tier: 'unlimited' }), 40e6);
  assert.equal(capacityLimit({ device: null, tier: 'unlimited' }), null);
  assert.equal(capacityLimit({ device: 40e6, tier: null }), null);   // (no licence known: the caller's own figure)
  assert.equal(capacityLimit(null), null);
});
import { APP, DESKTOP, PRODUCT, setupName, crateNotices, resourceSource, installedNames, installFolder, INSTALLED, MAX_PATH,
  PROFILE_NAME, STAGED_PATH_MAX } from '../tools/desktop.mjs';

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const rust = read(APP, 'rust', 'lib.rs');
const page = read(DESKTOP, 'ui', 'shell.js');
const launcher = read(AGENT, 'start.mjs');

test('the Connection form shows all three failures in both languages and keeps its password write-only', async () => {
  const html = read(AGENT, 'brain-panel.html');
  const script = new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  for (const [language, auth, loading] of [['en', 'missing or wrong', 'loading'], ['zh', '密钥缺失或不正确', '加载']]) {
    const element = () => ({ value: '', addEventListener(name, handler) { this[name] = handler; },
      setAttribute() {}, append() {}, replaceChildren() {} });
    const fields = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], element()]));
    const document = { documentElement: {}, body: { classList: { toggle() {} } }, createElement: element,
      createTextNode: String, getElementById: id => fields[id] };
    const state = { server: 'https://brain.example', configurable: true, reach: { state: 'down' } };
    const key = randomUUID();
    let submission;
    const notice = { version: '0.2.10', url: 'https://github.com/rulith-dev/rulith-brain-agent/releases/latest' };
    const fetch = async (url, init) => {
      if (url === '/brain/agent-update') return Response.json(notice);
      if (url.startsWith('/brain/state')) return Response.json(state);
      assert.equal(url, '/brain/connection');
      submission = JSON.parse(init.body);
      state.server = submission.server;
      return Response.json({ ok: true });
    };
    let poll;
    script.runInNewContext({ document, navigator: { language }, location: { search: '?setup=1' },
      fetch, URLSearchParams, setInterval(fn) { poll = fn; } });
    await delay(0);
    assert.equal(fields['agent-update'].hidden, false);
    assert.equal(fields['agent-update'].href, notice.url);
    assert.equal(fields['agent-update'].textContent, language === 'zh' ? 'Rulith Brain Agent 0.2.10 已发布' : 'Rulith Brain Agent 0.2.10 is available');
    assert.equal(fields.connection.hidden, false);
    assert.ok(fields['notice-help'].textContent.includes(state.server));
    assert.equal(fields['brain-address'].value, state.server);
    fields['brain-address'].value = 'https://other.example';
    fields['brain-key'].value = key;
    state.reach.state = 'auth';
    poll();
    await delay(0);
    assert.equal(fields['brain-address'].value, 'https://other.example');
    assert.ok(fields['notice-title'].textContent.includes(auth));
    fields['connection-form'].submit({ preventDefault() {} });
    await delay(0);
    assert.ok(submission.server === state.server && submission.key === key);
    assert.ok(fields['brain-key'].value === '' && !fields['key-help'].textContent.includes(key));
    state.reach.state = 'loading';
    fields['connection-form'].submit({ preventDefault() {} });
    await delay(0);
    assert.ok(fields['notice-title'].textContent.includes(loading));
    assert.equal(submission.key, undefined);
  }
});

test('the startup page works before Brain is ready and follows edits from both the user and Brain', { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-start-'));
  const home = path.join(dir, 'agent'), config = path.join(dir, 'brain', 'config');
  fs.mkdirSync(config, { recursive: true });
  const key = randomUUID();
  const writeBrain = port => fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ network: { port, api_key: key } }));
  writeBrain(16001);
  // Run the actual launcher with a stub for every upstream request. No model, harness or installed dependency is needed.
  const stub = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(name, ctx, next) {
      if (name === '@deepseek-ai/dsh-spill-local') return { shortCircuit: true,
        url: 'data:text/javascript,export const privateRoot = () => process.env.RULITH_BRAIN_HOME' };
      return next(name, ctx);
    } });
    globalThis.fetch = async (url, init) => {
      const { hostname, port, pathname } = new URL(url);
      if (hostname === 'github.com' || hostname === 'gh-proxy.com') {
        if (init.headers) throw new Error('Unexpected headers on a public update check');
        return Response.json({ version: '900.1.0' });
      }
      const authenticated = init.headers.Authorization === 'Bearer ' + process.env.TEST_FIXTURE_KEY;
      process.send({ port, authenticated });
      if (port === '16001') throw new Error('unreachable');
      if (hostname === 'remote.invalid' && pathname.endsWith('/status')) return new Response(null, { status: 403 });
      if (hostname === 'remote.invalid' && !authenticated) return new Response('denied', { status: 401 });
      return new Response('loading', { status: 503 });
    };
  `;
  const child = fork(path.join(AGENT, 'start.mjs'), ['--home', home], {
    silent: true, execArgv: ['--import', 'data:text/javascript,' + encodeURIComponent(stub)],
    env: { ...process.env, RULITH_BRAIN_HOME: path.dirname(config), RULITH_MEMORY_KEY: '', RULITH_MEMORY_SERVER: '',
      RULITH_AGENT_DESKTOP: '', NODE_USE_ENV_PROXY: '0', TEST_FIXTURE_KEY: key },
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let output = '';
  const collect = data => { output += data.toString(); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const probes = [];
  child.on('message', msg => probes.push(msg));
  async function until(check) {
    for (let i = 0; i < 220; i++) {
      const result = await check();
      if (result) return result;
      if (child.exitCode !== null) break;
      await delay(25);
    }
    assert.fail('Launcher did not reach the expected state');
  }
  const origin = await until(() => /Brain connection page: (http:\/\/127\.0\.0\.1:\d+)\/brain/.exec(output)?.[1]);
  const page = await (await fetch(origin + '/brain?setup=1')).text();
  assert.match(page, /id="brain-key" type="password"/);
  assert.deepEqual(await (await fetch(origin + '/brain/agent-update')).json(), {
    version: '900.1.0', url: 'https://github.com/rulith-dev/rulith-brain-agent/releases/latest',
  });
  async function stateIs(reach, server) {
    return until(async () => {
      const r = await fetch(origin + '/brain/state');
      if (!r.ok) return false;
      const s = await r.json();
      assert.ok(!JSON.stringify(s).includes(key));
      return s.server === server && s.reach.state === reach && s.configurable;
    });
  }
  const save = (change, originHeader = origin) => fetch(origin + '/brain/connection', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: originHeader }, body: JSON.stringify(change) });
  await stateIs('down', 'http://127.0.0.1:16001');
  writeBrain(16002);
  // No page requests during this wait. The launcher's next retry itself must reread Brain's port.
  await until(() => probes.some(p => p.port === '16002' && p.authenticated));
  await stateIs('loading', 'http://127.0.0.1:16002');
  const server = 'https://remote.invalid';
  assert.equal((await save({ server }, 'https://foreign.invalid')).status, 403);
  assert.equal((await save({ server })).status, 200);
  await stateIs('auth', server);
  const response = await save({ server, key });
  assert.ok(response.ok && !(await response.text()).includes(key));
  await stateIs('loading', server);
  assert.equal((await save({ automatic: true })).status, 200);
  await stateIs('loading', 'http://127.0.0.1:16002');
  assert.ok(!output.includes(key));
});

test('the setup: a per-user install with its hooks, icons and the shell\'s own page', () => {
  const conf = JSON.parse(read(APP, 'tauri.conf.json'));
  assert.deepEqual([conf.productName, conf.identifier, conf.mainBinaryName], [PRODUCT, 'ai.rulith.brain.agent', 'rulith-brain-agent']);
  assert.deepEqual([conf.bundle.targets, conf.bundle.windows.nsis.installMode], [['nsis'], 'currentUser']);
  assert.ok(fs.existsSync(path.join(APP, conf.bundle.windows.nsis.installerHooks)));
  for (const icon of [...conf.bundle.icon, conf.bundle.windows.nsis.installerIcon]) assert.ok(fs.existsSync(path.join(APP, icon)), icon);
  const ui = path.resolve(APP, conf.build.frontendDist);
  for (const f of ['index.html', 'shell.js', 'icon.svg']) assert.ok(fs.existsSync(path.join(ui, f)), f);
  // the page runs its script from a file (the app's content policy lets no inline script run)
  assert.equal(conf.app.security.csp['script-src'], "'self'");
  assert.doesNotMatch(read(ui, 'index.html'), /<script(?![^>]*\bsrc=)/);
  // MIT, as the agent is
  assert.match(read(APP, 'Cargo.toml'), /^license = "MIT"$/m);
  assert.equal(setupName('0.2.0'), 'Rulith-Brain-Agent-Setup-0.2.0.exe');
  assert.equal(setupName('0.2.9', true), 'Rulith-Brain-Agent-Setup-0.2.9-draft.exe');
  // the hooks stop only Node under the install folder
  const hooks = read(APP, conf.bundle.windows.nsis.installerHooks);
  assert.match(hooks, /\$\$_\.Name -eq 'node\.exe' -and \$\$_\.ExecutablePath -like '\$INSTDIR\\\*'/);
});

test('the shell and the launcher agree: how the agent is started, the line that names its page', () => {
  // the line dsh prints with the page's address, as the launcher renames it
  const says = /const SAYS_PAGE: &str = "([^"]+)";/.exec(rust)[1];
  assert.equal(says, 'Rulith Brain Agent: ');
  assert.ok(launcher.includes(`line.replace(/^dsh web: /, '${says}')`));
  // the page's port: one of the shell's own when it is free (the page's storage goes by its address), else any
  assert.match(rust, /const PAGE_PORT: u16 = \d{4,5};/);
  assert.match(rust, /free\(PAGE_PORT\)\.or_else\(\|_\| free\(0\)\)/);
  // the flags the shell passes are dsh's own, which the launcher hands on
  assert.match(rust, /\.args\(\["--port", &port\.to_string\(\), "--no-open"\]\)/);
  // the agent as the setup lays it down: what the package's start.cmd runs
  assert.match(rust, /root\.join\("node"\)\.join\("node\.exe"\), root\.join\("app"\)\.join\("start\.mjs"\)/);
  // stopped with everything it started
  assert.match(rust, /"\/PID", &pid\.to_string\(\), "\/T", "\/F"/);
});

test('the agent\'s page is given no way into the shell; other sites open in the browser', () => {
  const cap = JSON.parse(read(APP, 'capabilities', 'default.json'));
  assert.deepEqual([cap.windows, cap.permissions, 'remote' in cap], [['main'], ['core:default'], false]);
  const commands = /generate_handler!\[([^\]]+)\]/.exec(rust)[1].split(',').map((x) => x.trim()).sort();
  assert.deepEqual(commands, ['agent_start', 'agent_state']);
  assert.deepEqual([...page.matchAll(/invoke\('(\w+)'\)/g)].map((m) => m[1]).sort().filter((x, i, a) => a.indexOf(x) === i), commands);
  // Tauri lets any page the window shows call an app's commands (tried on the first build: the agent's page read
  // agent_state): each command asks whose page it is, first thing
  for (const c of commands) assert.ok(rust.split(`fn ${c}(app: AppHandle, window: tauri::WebviewWindow) -> Result<`)[1]?.split('\n')[1]?.trim() === 'asked_by_shell(&window)?;', c);
  assert.match(rust, /url\.scheme\(\) == "tauri" \|\| url\.host_str\(\) == Some\("tauri\.localhost"\) => Ok\(\(\)\)/);
  assert.match(rust, /\.on_navigation\(/);
  assert.match(rust, /\.on_new_window\(/);
  assert.match(rust, /Some\("tauri\.localhost" \| "127\.0\.0\.1" \| "localhost"\)/);
});

test('the shell\'s page knows the launcher\'s words, and says the same in both languages', () => {
  // the lines it reads the start from are the launcher's
  for (const [words, source] of [['Rulith Brain is not reachable at', PLAIN.down], ['The Brain access key is missing or wrong', PLAIN.auth], ['Rulith Brain is loading the model', PLAIN.loading],
    ['Rulith Brain is ready', read(AGENT, 'memory-transport.mjs')], ['Connected to Rulith Brain', launcher]]) {
    assert.ok(page.includes(`line.startsWith('${words}')`), words);
    assert.ok(source.includes(words), `the launcher no longer says "${words}"`);
  }
  // English and Chinese: the same keys, none empty but the one that is meant to be
  const [, zh, en] = /const T = zh \? \{([\s\S]*?)\n  \} : \{([\s\S]*?)\n  \};/.exec(page);
  const keys = (block) => [...block.matchAll(/(?:^|[\s,{])(\w+): (?:'|\()/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys(zh), keys(en));
  assert.ok(keys(en).length >= 14);
  for (const k of ['starting', 'down', 'auth', 'loading', 'opening', 'ended']) assert.ok(keys(en).includes(k) && keys(en).includes(`${k}Help`), k);
  // what the agent is: the same words as on the agent's Brain page
  const panel = read(AGENT, 'brain-panel.html');
  assert.match(panel, /id="brain-key" type="password"/);
  assert.ok(rust.includes('line.strip_prefix("Brain connection page: ")') && launcher.includes('Brain connection page: '));
  for (const lang of [zh, en]) {
    for (const key of ['aboutTitle', 'aboutText']) {
      const line = lang.split('\n').find((s) => s.trimStart().startsWith(key + ':'));
      assert.ok(line?.trim() && panel.includes(line.trim()), key);
    }
  }
});

test('the licence texts of the shell\'s crates: crates with the same text together, a crate without one named', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-crates-'));
  const crate = (name, licence, files) => {
    const at = path.join(dir, name);
    fs.mkdirSync(at);
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(at, f), text);
    return { name, version: '1.0.0', license: licence, authors: ['A. Person'], manifest_path: path.join(at, 'Cargo.toml') };
  };
  try {
    const text = crateNotices([crate('aaa', 'MIT', { 'LICENSE-MIT': 'MIT text\r\n', 'lib.rs': 'code' }), crate('bbb', 'MIT', { LICENSE: 'MIT text\n' }),
      crate('ccc', 'Apache-2.0', { 'LICENSE-APACHE': 'Apache text' }), crate('ddd', 'Zlib', { 'README.md': 'no licence file' })], '0.2.0');
    assert.match(text, /^Rust crates in rulith-brain-agent\.exe \(Rulith Brain Agent 0\.2\.0\)/);
    assert.match(text, /aaa 1\.0\.0 \(MIT\)\nbbb 1\.0\.0 \(MIT\)\n\nMIT text\n/);
    assert.match(text, /ccc 1\.0\.0 \(Apache-2\.0\)\n\nApache text\n/);
    assert.match(text, /Crates that ship no licence file[^\n]*:\n\nddd 1\.0\.0 \(Zlib\) - A\. Person\n/);
    assert.equal(text.split('MIT text').length, 2, 'one copy of a text');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the setup installs the package below agent\\, where the shell looks for it, on paths Windows opens', () => {
  // the shell starts <its folder>\agent\node\node.exe with agent\app\start.mjs
  assert.equal(INSTALLED, 'agent');
  assert.match(rust, /join\("agent"\)/);
  // the staged folder goes to the Tauri CLI by its path from src-tauri (by its absolute path the CLI installed every
  // file under the build machine's own folders: the first draft)
  assert.equal(resourceSource(path.join(AGENT, 'dist', 'ds', 'agent')), '../../dist/ds/agent/');
  assert.throws(() => resourceSource(APP), /--stage/);
  if (process.platform === 'win32') assert.throws(() => resourceSource(`${APP[0] === 'Q' ? 'R' : 'Q'}:\\stage\\agent`), /--stage/);
  // what the setup's compiler is told: every resource below agent\, or the build stops
  const good = '  File /a "/oname=agent\\LICENSE.txt" "X:\\b\\LICENSE.txt"\n    File /a "/oname=agent\\app\\start.mjs" "X:\\b\\app\\start.mjs"\n  File "${MAINBINARYSRCPATH}"\n';
  assert.deepEqual(installedNames(good), { names: ['agent\\LICENSE.txt', 'agent\\app\\start.mjs'], outside: [] });
  // the first draft's script: the build machine's folders in the installed name
  const first = '    File /a "/oname=/checkout\\project\\agent\\dist\\ds\\agent\\LICENSE.txt" "X:/checkout\\project\\agent\\dist\\ds\\agent\\LICENSE.txt"\n';
  assert.equal(installedNames(first).outside.length, 1);
  assert.equal(installedNames('  File /a "/oname=agent\\..\\x.txt" "X:\\b\\x.txt"\n').outside.length, 1);
  // a file as deep as the build allows still has a path of MAX_PATH for the longest profile folder name
  const deepest = `${installFolder('n'.repeat(PROFILE_NAME))}\\${INSTALLED}\\${'p'.repeat(STAGED_PATH_MAX)}`;
  assert.equal(deepest.length, MAX_PATH);
  assert.ok(STAGED_PATH_MAX >= 178, 'the package\'s deepest file today (the inspector\'s page descriptions) is 178 characters');
});
