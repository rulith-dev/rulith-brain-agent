import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { compareVersions, ENDPOINTS, findUpdate, portableUpdate, RELEASES } from '../tools/agent-update.mjs';
import { copySetup, setupName } from '../tools/desktop.mjs';
import { APP_FILES } from '../tools/pack.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const publicRelease = 'https://github.com/rulith-dev/rulith-brain-agent/releases';
const latest = publicRelease + '/latest';

test('versions use numeric components and SemVer prerelease precedence', () => {
  const ordered = ['0.2.0', '0.2.9', '0.2.10-preview.2', '0.2.10-preview.10', '0.2.10', '0.10.0', '1.0.0'];
  for (const [i, a] of ordered.entries()) for (const [j, b] of ordered.entries()) {
    assert.equal(compareVersions(a, b), Math.sign(i - j));
  }
  assert.equal(compareVersions('1.0.0+win.2', '1.0.0+win.1'), 0);
  for (const invalid of [null, 12, '1', '1.0.0-01', '01.2.3', '<b>2.0.0</b>']) {
    assert.equal(compareVersions(invalid, '0.2.0'), null);
  }
});

test('portable offers only a newer Agent and links only to its fixed release page', async () => {
  for (const [version, expected] of [['0.2.0', null], ['0.2.9', null], ['0.2.10', { version: '0.2.10', url: latest }]]) {
    const asked = [];
    const notice = await findUpdate('0.2.9', async (url, init) => {
      asked.push(url);
      assert.deepEqual(Object.keys(init), ['signal']);
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json({ version, url: 'https://unused.invalid/installer' });
    });
    assert.deepEqual(asked, [latest + '/download/latest.json']);
    assert.deepEqual(notice, expected);
  }
});

test('portable tries the mirror after failed requests or invalid manifests and stays quiet when both fail', async () => {
  for (const failure of [
    () => { throw new DOMException('timed out', 'TimeoutError'); },
    () => new Response(null, { status: 404 }),
    () => new Response('<html>'),
    () => Response.json({ version: 'bad' }),
  ]) {
    for (const recover of [true, false]) {
      const asked = [];
      const notice = await findUpdate('1.0.0', url => {
        asked.push(url);
        return asked.length === 2 && recover ? Response.json({ version: '2.0.0' }) : failure();
      });
      assert.deepEqual(asked, [latest + '/download/latest.json', 'https://gh-proxy.com/' + latest + '/download/latest.json']);
      assert.deepEqual(notice, recover ? { version: '2.0.0', url: latest } : null);
    }
  }
});

test('the system proxy applies to the release request and its dispatcher is released afterwards', async t => {
  const harness = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'));
  const undici = createRequire(harness.resolve('@deepseek-ai/dsh-http-proxy'))('undici');
  let options, dispatcher, closed = false;
  t.mock.method(undici, 'EnvHttpProxyAgent', function (opts) {
    options = opts;
    dispatcher = { async destroy() { closed = true; } };
    return dispatcher;
  });
  t.mock.method(undici, 'fetch', async (url, init) => {
    assert.equal(url, ENDPOINTS[0]);
    assert.equal(init.dispatcher, dispatcher);
    assert.ok(!init.headers);
    return Response.json({ version: '900.1.0' });
  });
  const proxy = 'http://proxy.invalid:3128';
  const notice = await portableUpdate({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: 'localhost' });
  assert.equal(notice.version, '900.1.0');
  assert.equal(options.httpsProxy, proxy);
  assert.equal(options.noProxy, 'localhost');
  assert.ok(closed);
});

test('the chat sidebar renders the cached notice and stays empty for no update or a failed read', async () => {
  const src = fs.readFileSync(path.join(testDir, '../rulith-brain-ui/lib/client.js'), 'utf8')
    .replace('"__RULITH_BRAIN_PANEL__"', '"http://127.0.0.1:12345/brain"');
  for (const reply of [{ version: '1.2.3', url: latest }, null, new Error('unavailable')]) {
    let plugin, foot, state = null, effect;
    const react = { createElement: (type, props, ...children) => ({ type, props, children }),
      useState: () => [state, value => { state = value; }], useEffect: fn => { effect = fn; } };
    const window = { __ModuleLoader__: { load: spec => { plugin = spec.factory(() => react); } } };
    vm.runInNewContext(src, { window, navigator: { language: 'en' }, fetch: async url => {
      assert.equal(url, 'http://127.0.0.1:12345/brain/agent-update');
      if (reply instanceof Error) throw reply;
      return Response.json(reply);
    } });
    plugin.apply({ slots: { inject(name, fn) { if (name === 'sidebar.footer.action') fn(); },
      register(spec, component) { if (spec.name === 'sidebar.footer.action') foot = component; } }, effect() {} });
    const component = foot({ wide: true }).children.find(child => typeof child?.type === 'function');
    assert.equal(component.type(component.props), null);
    const unmount = effect();
    await new Promise(resolve => setImmediate(resolve));
    const link = component.type(component.props);
    if (reply?.version) {
      assert.equal(link.type, 'a');
      assert.equal(link.props.href, latest);
      assert.equal(link.children[0], 'Rulith Brain Agent 1.2.3 is available');
    } else assert.equal(link, null);
    unmount();
  }
});

test('signed setup, signature and manifest agree; an unsigned rebuild clears prior updater files', t => {
  const dir = fs.mkdtempSync(path.join(testDir, 'setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const version = '0.2.10', notes = 'A new release\n更新说明\n';
  const made = path.join(dir, 'bundled.exe'), setup = path.join(dir, setupName(version));
  const manifest = path.join(dir, 'latest.json');
  fs.writeFileSync(made, 'fixture setup');
  fs.writeFileSync(made + '.sig', 'fixture-signature\n');
  copySetup(made, setup, { signed: true, version, notes });
  assert.deepEqual(fs.readFileSync(setup), fs.readFileSync(made));
  assert.deepEqual(fs.readFileSync(setup + '.sig'), fs.readFileSync(made + '.sig'));
  const json = JSON.parse(fs.readFileSync(manifest));
  const entry = { signature: 'fixture-signature',
    url: 'https://gh-proxy.com/' + publicRelease + '/download/v0.2.10/Rulith-Brain-Agent-Setup-0.2.10.exe' };
  assert.match(json.pub_date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
  assert.deepEqual(json, { version, notes, pub_date: json.pub_date,
    platforms: { 'windows-x86_64-nsis': entry, 'windows-x86_64': entry } });
  fs.rmSync(made + '.sig');
  assert.throws(() => copySetup(made, setup, { signed: true, version, notes }), { code: 'ENOENT' });
  copySetup(made, setup, { signed: false, version, notes });
  assert.ok(fs.existsSync(setup + '.sha256'));
  assert.ok(!fs.existsSync(setup + '.sig') && !fs.existsSync(manifest));
});

test('both editions check the Agent feed; only a native user confirmation can invoke the signed desktop install', () => {
  const shell = path.join(testDir, '../desktop/src-tauri');
  const conf = JSON.parse(fs.readFileSync(path.join(shell, 'tauri.conf.json')));
  assert.equal(RELEASES, publicRelease);
  assert.deepEqual(conf.plugins.updater.endpoints, ENDPOINTS);
  assert.equal(conf.plugins.updater.windows.installMode, 'passive');
  assert.ok(conf.plugins.updater.pubkey);
  assert.equal(conf.bundle.createUpdaterArtifacts, false);
  assert.ok(APP_FILES.includes('tools/agent-update.mjs'));
  const rust = fs.readFileSync(path.join(shell, 'rust/updates.rs'), 'utf8');
  assert.match(rust, /interval\(Duration::from_secs\(24 \* 60 \* 60\)\)/);
  assert.match(rust, /\.set_parent\(&window\)/);
  assert.match(rust, /update\.body/);
  assert.match(rust, /Update and restart/);
  assert.match(rust, /更新并重启/);
  assert.match(rust, /if choice != MessageDialogResult::Custom\(install.into\(\)\)[\s\S]*?return;[\s\S]*?update\.download_and_install/);
});
