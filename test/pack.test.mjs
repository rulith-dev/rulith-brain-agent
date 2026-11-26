// The Windows package (tools/pack.mjs) and the page's brand (rulith-brain-ui): the parts that can be checked without
// building the whole package (that is `npm run package`, then start.cmd from the unpacked zip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AGENT, APP_FILES, BINARY_LICENCES, BRAND_ICONS, BRAND_PATCHES, DEFAULT_SERVER, binaryLicencePath, binaryLicences,
  SOURCE_OFFER_CONTACT, brandPlugin, dependencyClosure, legalProblems, licenceTexts,
  nodeLicencePath, notices, pack, readZip, readme, resolveFrom, secretsIn, startCmd, topFolders, writeZip,
} from '../tools/pack.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rba-pack-'));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const pkg = (dir, body) => put(path.join(dir, 'package.json'), JSON.stringify(body));

test('the closure follows Node\'s lookup: nested versions first, installed optional deps and peers, missing ones named', () => {
  const root = scratch();
  const nm = path.join(root, 'node_modules');
  pkg(path.join(nm, 'a'), { name: 'a', version: '1.0.0', dependencies: { b: '1', e: '2' }, optionalDependencies: { zz: '1', o: '1' }, peerDependencies: { p: '1' } });
  pkg(path.join(nm, 'b'), { name: 'b', version: '1.0.0' });
  pkg(path.join(nm, 'e'), { name: 'e', version: '1.0.0' });                      // not this one: a has its own
  pkg(path.join(nm, 'a', 'node_modules', 'e'), { name: 'e', version: '2.0.0', dependencies: { b: '1', y: '1' } });
  pkg(path.join(nm, '@s', 'o'), { name: '@s/o', version: '1.0.0' });
  pkg(path.join(nm, 'o'), { name: 'o', version: '1.0.0' });
  pkg(path.join(nm, 'p'), { name: 'p', version: '1.0.0' });
  pkg(path.join(nm, 'unused'), { name: 'unused', version: '1.0.0' });
  assert.equal(resolveFrom(root, path.join(nm, 'a'), 'e'), path.join(nm, 'a', 'node_modules', 'e'));
  const { packages, missing } = dependencyClosure(root, 'a');
  const versions = [...packages.values()].map((p) => `${p.name}@${p.version}`).sort();
  assert.deepEqual(versions, ['a@1.0.0', 'b@1.0.0', 'e@2.0.0', 'o@1.0.0', 'p@1.0.0']);
  assert.deepEqual(missing, ['e -> y']);                                      // zz is optional: not missing
  assert.deepEqual(topFolders(root, packages), ['a', 'b', 'o', 'p']);         // e@2 comes with a
  fs.rmSync(root, { recursive: true, force: true });
});

test('the zip reads back byte for byte: deflated text, stored noise, UTF-8 names, an empty file', () => {
  const dir = scratch();
  const zip = path.join(dir, 't.zip');
  const noise = crypto.randomBytes(4096);
  const entries = [
    { name: 'start.cmd', data: Buffer.from(startCmd()) },
    { name: 'app/node_modules/x/README.md', data: Buffer.from('# x\n'.repeat(500)) },
    { name: 'app/记忆/noise.bin', data: noise },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const bytes = writeZip(zip, entries, new Date(2026, 10, 16, 21, 30, 4));
  assert.equal(bytes, fs.statSync(zip).size);
  const back = readZip(zip);
  assert.deepEqual([...back.keys()], entries.map((e) => e.name));
  for (const e of entries) assert.ok(back.get(e.name).equals(e.data), e.name);
  assert.ok(bytes < entries.reduce((n, e) => n + e.data.length, 0));
  // an independent reader: Windows' own tar (bsdtar reads zip)
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (process.platform === 'win32' && fs.existsSync(tar)) {
    const out = path.join(dir, 'x');
    fs.mkdirSync(out);
    const r = spawnSync(tar, ['-xf', zip, '-C', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const e of entries) assert.ok(fs.readFileSync(path.join(out, e.name)).equals(e.data), `tar: ${e.name}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start.cmd: Windows line ends, the default server, its own Node and the launcher', () => {
  const cmd = startCmd();
  assert.equal(DEFAULT_SERVER, 'http://127.0.0.1:8091');
  assert.ok(cmd.includes('\r\n') && !/[^\r]\n/.test(cmd));
  assert.doesNotMatch(cmd, /set "RULITH_MEMORY_SERVER=/i);
  assert.ok(APP_FILES.includes('tools/connection.mjs'));
  assert.match(cmd, /"%HERE%node\\node\.exe" "%HERE%app\\start\.mjs" %\*/);
  assert.match(startCmd('http://10.0.0.2:8080'), /RULITH_MEMORY_SERVER=http:\/\/10\.0\.0\.2:8080"/);
  // the user's options only; Rulith Brain, not another product, is what is started first
  assert.match(cmd, /--learn-research on\/off/);
  assert.doesNotMatch(cmd, /--front|--focus-k|--brain |--persona|Inference/);
  assert.match(cmd, /Open Rulith Brain first and press\r\nrem "Load the model and start"/);
});

test('README.txt: Rulith Brain\'s app and its address, the user\'s options, no developer flags', () => {
  const text = readme({ version: '0.2.0', dshVersion: '0.2.1-alpha.1', nodeVersion: 'v24.12.0', nodeLicence: true, office: true });
  // open source: its own licence is in the package, and the source has an address
  assert.match(text, /are open source under the MIT licence: LICENSE\.txt/);
  assert.match(text, /LICENSE\.txt\s+the agent's own licence \(MIT\)/);
  assert.match(text, /Source: https:\/\/github\.com\/rulith-dev\/rulith-brain-agent\s/);
  assert.doesNotMatch(text, /EULA/);
  assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text));
  assert.match(text, /Open Rulith Brain and press "Load the model and start"\. Keep the app open/);
  assert.match(text, /default http:\/\/127\.0\.0\.1:8091/);
  assert.match(text, /--learn-research on\|off/);
  assert.match(text, /lets old, unused material go by itself\. The agent has\s+no tool to remove anything/);
  assert.doesNotMatch(text, /forget|delet|eras/i);
  for (const dev of ['--front', '--focus-k', '--focus-every', '--brain', '--persona', '--system', '--forwarder-port', 'Inference', ':8080', 'llama-server', '--memory-mode'])
    assert.ok(!text.includes(dev), dev);
  // nor the memory's mechanics ("its window" is the console's)
  assert.doesNotMatch(text, /\b(kv|turns?|sessions?|recall\w*|focus)\b|memory windows?/i);
});

test('Node\'s licence text is kept for the Node the package bundles (v24.12.0): whole, with its components', () => {
  const file = nodeLicencePath('v24.12.0');
  assert.ok(fs.existsSync(file), file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('Node.js is licensed for use as follows:'));
  for (const part of ['- OpenSSL, located at', '- ICU, located at', '- V8, located at', '- libuv, located at', '- npm, located at'])
    assert.ok(text.includes(part), part);
  assert.equal(fs.statSync(file).size, 143310);   // as fetched from nodejs/node at tag v24.12.0
  assert.equal(fs.existsSync(nodeLicencePath('v1.0.0')), false);
});

test('the licence texts of the code inside the binaries are kept, whole, for every package BINARY_LICENCES names', () => {
  const files = BINARY_LICENCES.flatMap((e) => e.files);
  for (const f of files) assert.ok(fs.existsSync(binaryLicencePath(f)), f);
  const head = (f) => fs.readFileSync(binaryLicencePath(f), 'utf8').slice(0, 200);
  assert.match(head('GPL-3.0.txt'), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(head('LGPL-3.0.txt'), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(head('onnxruntime-1.28.2.ThirdPartyNotices.txt'), /^THIRD PARTY SOFTWARE NOTICES AND INFORMATION/);
  const libs = fs.readFileSync(binaryLicencePath('sharp-libvips-1.3.4.LICENSES.txt'), 'utf8');
  for (const lib of ['libvips 8.18.7', 'aom 3.15.1', 'cairo 1.18.6 - COPYING-MPL-1.1', 'freetype 2.14.3', 'libpng 1.6.58', 'mozjpeg', 'zlib-ng 2.3.3'])
    assert.ok(libs.includes(lib), lib);
  for (const e of BINARY_LICENCES) assert.ok(e.source.length && e.title && e.licence, e.pkg);
});

test('the binaries section: texts and sources of the packages present, the written offer, and what a release refuses', () => {
  const nm = scratch();
  const [sharp, ort, , office] = BINARY_LICENCES;
  pkg(path.join(nm, sharp.pkg), { name: sharp.pkg, version: sharp.version });
  pkg(path.join(nm, ort.pkg), { name: ort.pkg, version: '9.9.9' });
  pkg(path.join(nm, office.pkg), { name: office.pkg, version: office.version });
  pkg(path.join(nm, '@deepseek-ai', 'dsh'), { name: '@deepseek-ai/dsh', version: '0', license: 'MIT' });
  put(path.join(nm, '@deepseek-ai', 'dsh', 'LICENSE'), 'dsh MIT');
  const warned = [];
  const found = binaryLicences(nm, (w) => warned.push(w), [sharp.pkg, ort.pkg]);   // (office left out, as --without-office)
  assert.deepEqual(found.map((e) => e.pkg), [sharp.pkg, ort.pkg]);
  assert.ok(warned.some((w) => w.includes('9.9.9') && w.includes(ort.version)), 'another version is reported');
  assert.ok(!warned.some((w) => w.includes('SOURCE_OFFER_CONTACT')), 'the source offer has its contact');
  assert.throws(() => binaryLicences(nm, (w) => { throw new Error(w); }), /9\.9\.9/);
  const text = notices({ version: '0.0.0', nm, dsh: { version: '0', license: 'MIT' }, node: { version: 'v0' }, nodeLicence: 'n', binary: found });
  assert.ok(text.includes('6. Code inside the packages\' native binaries'));
  assert.ok(text.includes('https://github.com/libvips/libvips/releases/tag/v8.18.7'));
  assert.ok(text.includes('GNU LESSER GENERAL PUBLIC LICENSE'));
  assert.match(text, /Written offer for the source code[\s\S]*libvips 8\.18\.7[\s\S]*three years/);
  assert.match(text, /Write to: contact@rulith\.ai/);
  assert.ok(!text.includes('libreoffice-26.8.0.3.tar.xz'));
  fs.rmSync(nm, { recursive: true, force: true });
});

test('the installed packages are the versions whose licence texts are kept (else look at them again)', { skip: !fs.existsSync(path.join(AGENT, 'node_modules', '@deepseek-ai', 'dsh')) }, () => {
  for (const e of BINARY_LICENCES) {
    const file = path.join(AGENT, 'node_modules', e.pkg, 'package.json');
    if (fs.existsSync(file)) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, e.version, e.pkg);
  }
});

test('nothing that looks like a key in the agent\'s own files, and the check finds one', () => {
  const fake = ['sk-', 'a1B2'.repeat(6)].join('');
  assert.equal(secretsIn(`const key = "${fake}";\nok`).length, 1);
  assert.equal(secretsIn(['-----BEGIN ', 'PRIVATE KEY-----'].join('')).length, 1);
  assert.equal(secretsIn('headers.Authorization = `Bearer ${key}`').length, 0);
  const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => walk(path.join(p, f))) : [p];
  for (const f of APP_FILES) for (const file of walk(path.join(AGENT, f))) assert.deepEqual(secretsIn(fs.readFileSync(file, 'utf8')), [], file);
});

test('the way to Rulith Brain: an entry at the sidebar\'s foot opens the agent\'s Brain page; a newcomer is shown it once', () => {
  // the launcher writes this start's address into the profile's copy of the plugin (start.mjs)
  const dir = scratch();
  const file = path.join(dir, 'client.js');
  const shipped = fs.readFileSync(path.join(AGENT, 'rulith-brain-ui', 'lib', 'client.js'), 'utf8');
  assert.equal(shipped.split('"__RULITH_BRAIN_PANEL__"').length, 2, 'the placeholder stands once');
  fs.writeFileSync(file, shipped.replace('"__RULITH_BRAIN_PANEL__"', JSON.stringify('http://127.0.0.1:8098/brain')));
  assert.ok(fs.readFileSync(path.join(AGENT, 'start.mjs'), 'utf8').includes(`.replace('"__RULITH_BRAIN_PANEL__"', JSON.stringify(\`\${origin}/brain\`))`));
  // a page to open it over: just enough of a document
  const made = [];
  const node = (tag) => {
    const n = { tag, style: {}, attrs: {}, kids: [], listeners: {}, removed: false,
      setAttribute(k, v) { this.attrs[k] = v; }, append(...x) { this.kids.push(...x); }, remove() { this.removed = true; document.body.kids = document.body.kids.filter((k) => k !== this); },
      addEventListener(type, fn) { this.listeners[type] = fn; }, focus() { document.focused = this; } };
    made.push(n);
    return n;
  };
  const keys = [];
  const document = { body: node('body'), createElement: node, focused: null,
    getElementById: (id) => document.body.kids.find((k) => k.id === id) ?? null,
    addEventListener: (type, fn) => keys.push(fn), removeEventListener: (type, fn) => keys.splice(keys.indexOf(fn), 1) };
  const ui = brandPlugin(file, { document, navigator: { language: 'en-US' } });
  assert.equal(ui.PANEL, 'http://127.0.0.1:8098/brain');
  const slots = new Map();
  ui.apply({ slots: { inject: (name, fn) => { const r = fn(); if (r && typeof r.next === 'function') [...r]; }, register: (spec, component) => { slots.set(spec.name, component); return () => {}; } },
    effect: () => {} });
  const text = (n) => (n == null || typeof n !== 'object' ? String(n ?? '') : n.children.map(text).join(''));
  const foot = slots.get('sidebar.footer.action')({ wide: true });
  assert.equal(text(foot), 'Rulith BrainBased on DeepSeek Harness (MIT)');
  const entry = foot.children[0];
  assert.equal(entry.type, 'button');
  assert.match(entry.props['aria-label'], /^Rulith Brain\. The memory this agent works with/);
  // the narrow sidebar: the entry's glyph alone, no credit
  const narrow = slots.get('sidebar.footer.action')({ wide: false });
  assert.deepEqual([narrow.children[0].type, text(narrow), narrow.children[1]], ['button', '', null]);
  // opened: the page in a frame over dsh's page, once; Escape or its button closes it
  assert.equal(ui.openPanel(document), true);
  const panel = document.getElementById('rulith-brain-panel');
  const frame = made.find((n) => n.tag === 'iframe');
  assert.deepEqual([panel.attrs.role, frame.src, document.focused.attrs['aria-label']], ['dialog', 'http://127.0.0.1:8098/brain?embed=1', 'Close']);
  assert.equal(ui.openPanel(document), false, 'not twice');
  keys[0]({ key: 'a' });
  assert.equal(panel.removed, false);
  keys[0]({ key: 'Escape' });
  assert.deepEqual([panel.removed, keys.length, document.getElementById('rulith-brain-panel')], [true, 0, null]);
  // a newcomer is shown it once: the visit is kept before the page opens
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(ui.introduce(document, storage), true);
  document.getElementById('rulith-brain-panel').kids[0].kids[0].kids[1].listeners.click();   // its Close button
  assert.equal(document.getElementById('rulith-brain-panel'), null);
  assert.equal(ui.introduce(document, storage), false);
  assert.equal(ui.introduce(document, { getItem() { throw new Error('no storage'); }, setItem() {} }), false);
  // the page itself begins with what the agent is, in both languages
  const page = fs.readFileSync(path.join(AGENT, 'brain-panel.html'), 'utf8');
  assert.match(page, /aboutText: '[^']*compare them in a table[^']*Brain memory/);
  assert.match(page, /aboutText: '[^']*整理成表格[^']*Brain 当前打开的记忆/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('licence texts: at the root, bundled deeper, a licences folder; code and nested packages left alone', () => {
  const dir = scratch();
  put(path.join(dir, 'LICENSE'), 'MIT root\r\n');
  put(path.join(dir, 'license.js'), 'module.exports = 1;');
  put(path.join(dir, 'lib', 'third_party', 'acorn', 'LICENSE.md'), 'acorn MIT');
  put(path.join(dir, 'licenses', 'MPL-2.0.txt'), 'MPL text');
  put(path.join(dir, 'licenses', 'third-party.html'), '<p>many</p>');
  put(path.join(dir, 'node_modules', 'n', 'LICENSE'), 'nested package: its own');
  const { texts, others } = licenceTexts(dir);
  assert.deepEqual(texts.map((t) => [t.file, t.text]), [['LICENSE', 'MIT root'], ['lib/third_party/acorn/LICENSE.md', 'acorn MIT'], ['licenses/MPL-2.0.txt', 'MPL text']]);
  assert.deepEqual(others, ['licenses/third-party.html']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the brand: mark, name, credit and title in the slots dsh declares; the tab keeps the conversation name', () => {
  const head = { title: 'What chapter 3 says — DeepSeek Harness' };
  const links = [{ href: './favicon.svg', getAttribute() { return this.href; }, setAttribute(_, v) { this.href = v; } }];
  let observed = null;
  const document = {
    head,
    get title() { return head.title; }, set title(v) { head.title = v; },
    querySelectorAll: (q) => (q === 'link[rel~="icon"]' ? links : []),
  };
  class MutationObserver { constructor(fn) { this.fn = fn; } observe(node) { observed = this; this.node = node; } disconnect() { observed = null; } }
  const ui = brandPlugin(undefined, { document, MutationObserver });
  assert.equal(ui.NAME, 'Rulith Brain Agent');
  assert.equal(ui.CREDIT, 'Based on DeepSeek Harness (MIT)');
  // the mark: the app's icon - a blue brain on a white tile, no letter (the owner, 11-20: the brain alone)
  assert.match(ui.markSvg('g'), /^<svg [^>]*viewBox="0 0 64 64".*#3B82F6.*#1E3A8A.*fill="#fff".*fill="url\(#g\)"><ellipse /);
  assert.equal((ui.markSvg('g').match(/<circle /g) || []).length, 8);
  assert.doesNotMatch(ui.markSvg('g'), /M30 22H56/);
  const slots = new Map(), effects = [];
  const ctx = {
    slots: {
      inject: (name, fn) => { const r = fn(); if (r && typeof r.next === 'function') [...r]; },
      register: (spec, component) => { slots.set(spec.name, { spec, component }); return () => {}; },
    },
    effect: (fn) => effects.push(fn()),
  };
  ui.apply(ctx);
  assert.deepEqual([...slots.keys()].sort(), ['conversation.hero.brand.mark', 'sidebar.brand.mark', 'sidebar.brand.name', 'sidebar.footer.action']);
  assert.equal(slots.get('sidebar.footer.action').spec.id, 'rulith-brain-foot');
  const text = (node) => (node == null || typeof node !== 'object' ? String(node ?? '') : node.children.map(text).join(''));
  assert.equal(text(slots.get('sidebar.brand.name').component({})), 'Rulith Brain Agent');
  // as the file ships there is no address of the agent's Brain page: the foot is the credit alone
  assert.equal(ui.PANEL, '__RULITH_BRAIN_PANEL__');
  assert.equal(text(slots.get('sidebar.footer.action').component({ wide: true })), 'Based on DeepSeek Harness (MIT)');
  assert.equal(slots.get('sidebar.footer.action').component({ wide: false }), null);
  assert.equal(ui.openPanel(document), false);
  assert.equal(ui.introduce(document, { getItem: () => null, setItem() {} }), false);
  assert.equal(slots.get('sidebar.brand.mark').component({ size: 24 }).props.width, 24);
  // the tab
  assert.equal(document.title, 'What chapter 3 says — Rulith Brain Agent');
  assert.match(links[0].href, /^data:image\/svg\+xml,/);
  head.title = 'Another — DeepSeek Harness';                      // dsh writes again: fixed once more
  observed.fn();
  assert.equal(document.title, 'Another — Rulith Brain Agent');
  effects[0]();                                                     // the effect's disposer stops watching
  assert.equal(observed, null);
  effects[1]();                                                     // (and the introduction's timer is dropped)
});

test('the installed dsh still has every text the package renames (else a newer dsh needs a look)', { skip: !fs.existsSync(path.join(AGENT, 'node_modules', '@deepseek-ai', 'dsh')) }, () => {
  const nm = path.join(AGENT, 'node_modules');
  for (const p of BRAND_PATCHES) {
    const dir = path.join(nm, path.dirname(p.file));
    const pattern = new RegExp(`^${path.basename(p.file).replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
    const count = fs.readdirSync(dir).filter((f) => pattern.test(f))
      .reduce((n, f) => n + fs.readFileSync(path.join(dir, f), 'utf8').split(p.from).length - 1, 0);
    assert.equal(count, 1, `${p.file}: ${p.from}`);
  }
  for (const icon of BRAND_ICONS) assert.ok(fs.existsSync(path.join(nm, icon)), icon);
  const pin = JSON.parse(fs.readFileSync(path.join(AGENT, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'];
  assert.match(pin, /^\d+\.\d+\.\d+/, 'dsh is pinned to one version');
  assert.equal(JSON.parse(fs.readFileSync(path.join(nm, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version, pin);
});

test('the Agent release follows its own package.json; a version override requires a test build', () => {
  const v = JSON.parse(fs.readFileSync(path.join(AGENT, 'package.json'), 'utf8')).version;
  const dir = scratch();
  put(path.join(dir, 'W'), '9.9.9\n');
  assert.throws(() => pack({ versionFile: path.join(dir, 'W'), out: dir, log: () => {} }), /package\.json says/);
  assert.throws(() => pack({ version: '0.0.1', out: dir, log: () => {} }), e =>
    e.message.includes(`the release is ${v}`) && e.message.includes('only for a test build'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a legal text must be final: a DRAFT mark or a bracket placeholder is found; the agent\'s own licence is MIT', () => {
  assert.deepEqual(legalProblems('Licensor: A. Person. Write to contact@rulith.ai. See [the notices](N.md).', 'E'), []);
  const found = legalProblems('> **DRAFT** - not in force\nEffective: [date]. Transfers [up to N - OPEN] via [contact address]. [OWNER: confirm]', 'E');
  assert.deepEqual(found, ['E: "DRAFT"', 'E: [up to N - OPEN]', 'E: [OWNER: confirm]', 'E: [date]', 'E: [contact address]']);
  // the third-party texts' own brackets are not ours
  assert.deepEqual(legalProblems('Copyright [yyyy] [name of copyright owner]; a draft of the standard', 'E'), []);
  assert.equal(SOURCE_OFFER_CONTACT, 'contact@rulith.ai');
  // the agent is open source: the MIT text with its copyright line, and package.json says the same
  const own = fs.readFileSync(path.join(AGENT, 'LICENSE'), 'utf8').replaceAll('\r\n', '\n');
  assert.match(own, /^MIT License\n\nCopyright \(c\) \d{4} [^\n[\]]+\n\nPermission is hereby granted, free of charge/);
  assert.deepEqual(legalProblems(own, 'LICENSE'), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(AGENT, 'package.json'), 'utf8')).license, 'MIT');
  // a pre-release takes the release's version with its name; anything else is refused before any work
  const dir = scratch();
  assert.throws(() => pack({ version: '9.9.9', out: dir, log: () => {} }), /another version only for a test build \(--allow-draft\) or a pre-release \(--preview\)/);
  assert.throws(() => pack({ preview: 'not a name!', out: dir, log: () => {} }), /--preview not a name!: a name such as preview\.1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('README.txt of a test build says so under its title', () => {
  const opts = { version: '0.2.0', dshVersion: '0.2.1-alpha.1', nodeVersion: 'v24.12.0', nodeLicence: true, office: true };
  assert.ok(readme(opts).startsWith('Rulith Brain Agent 0.2.0\r\n'));
  assert.doesNotMatch(readme(opts), /TEST BUILD/);
  assert.match(readme({ ...opts, draft: true }), /^Rulith Brain Agent 0\.2\.0\r\n=+\r\n\r\nTEST BUILD - not a release/);
});
