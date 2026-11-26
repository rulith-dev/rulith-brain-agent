#!/usr/bin/env node
// Packs Rulith Brain Agent for Windows: one zip a user unpacks and starts, nothing to install.
//   node tools/pack.mjs [--out dist] [--node <node.exe>] [--node-license <file>]
//                       [--without-office] [--release] [--preview preview.1] [--allow-draft [--version 0.2.1]]
// The Agent's release version comes from its package.json. --preview preview.1 adds a prerelease suffix;
// only a test build (--allow-draft) takes another --version.
// The zip (its files sit at the zip's root: Explorer's "Extract All" makes the folder, which keeps paths short):
//   start.cmd                 starts the agent against a Brain server, http://127.0.0.1:8091 unless told otherwise
//   README.txt                how to start it, where its files go
//   THIRD-PARTY-NOTICES.txt   DeepSeek Harness's, Node's and every npm package's licence; the licences of the code
//                             inside the packages' native binaries and where its source is (BINARY_LICENCES)
//   LICENSE.txt               the agent's own licence: MIT (the owner, 2026-11-20: the agent is open source; the
//                             Rulith Brain app and its runtime stay under their licence agreement, which no longer
//                             covers the agent)
//   SHA256SUMS.txt            the SHA-256 of every other file in the zip
//   node/node.exe             the Node runtime: a copy of the one running this script (or --node)
//   node/LICENSE              Node's licence text (also in the notices): tools/licenses/node-<version>.LICENSE
//   app/                      the launcher and forwarder (start.mjs, memory-transport.mjs, brain-core.mjs,
//                             research-learn.mjs, brain-panel.html), the dsh profile overlay, the page's brand
//                             (rulith-brain-ui), the search without an account (rulith-brain-web) and the system's
//                             proxy for the agent's web tools (system-proxy.mjs)
//   app/node_modules/         dsh at the version package.json pins and everything it depends on, copied from the
//                             installed tree (type declarations and source maps left out); a few of dsh's page texts
//                             carry the product's name (BRAND_PATCHES)
// Beside the zip: <zip>.sha256. The out folder is dist/ (gitignored).
// Node's LICENSE is not part of a Node installation on Windows, so the text for each Node version the package
// bundles lives beside this script (tools/licenses/node-v24.12.0.LICENSE: nodejs/node's LICENSE at tag v24.12.0,
// fetched once with the owner's OK on 2026-11-16); --node-license <file> names another.
// Some npm packages ship prebuilt binaries without (all) the licence texts of the code inside them: libvips and its
// libraries in sharp, ONNX Runtime in sherpa-onnx, ConPTY in node-pty. Their texts live beside Node's too, for the
// versions BINARY_LICENCES names, fetched with the owner's OK on 2026-11-18: GPL-3.0.txt and LGPL-3.0.txt from
// gnu.org/licenses; onnxruntime-1.28.2.* from the archive the binaries come from (csukuangfj/onnxruntime-libs v1.28.2,
// onnxruntime-win-x64-MT-Release, its onnxruntime.dll byte-identical); conpty-* = microsoft/terminal's LICENSE and
// NOTICE.md (branch release-1.25; the binaries are the NuGet package Microsoft.Windows.Console.ConPTY, byte-identical);
// sharp-libvips-1.3.4.THIRD-PARTY-NOTICES.md from lovell/sharp-libvips at v1.3.4, and sharp-libvips-1.3.4.LICENSES.txt
// = libvips' own LICENSE plus each bundled library's licence file at its version, each with the address it came from.
// Nothing is downloaded: every file comes from this machine. Nothing secret goes in: the agent ships as readable
// JavaScript, and its own files are checked for anything that looks like a key before they are packed (keys stay
// with the server; the agent reads a server's API key from the environment at run time only).
// --without-office leaves out LibreOffice (dsh's optional office-document reader, about 180 MB).
// --release refuses a package that lacks a licence text (Node's, one BINARY_LICENCES names, or one written for another
// version of its package) or whose source offer has no contact yet, instead of warning.
// The agent's own licence (LICENSE beside package.json: MIT) must be whole - its copyright line, no DRAFT mark, no
// bracket placeholder (legalProblems; the same rules as tools/brain_release.py). --allow-draft makes a TEST build, named
// rulith-brain-agent-<version>-draft.zip, whose README.txt says so under its title.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseVersion } from './agent-update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const AGENT = path.resolve(here, '..');
export const DEFAULT_SERVER = 'http://127.0.0.1:8091';
export const DRAFT_SUFFIX = '-draft';

// --- the legal texts are final (tools/brain_release.py: DRAFT_MARK, PLACEHOLDER) ------------------------------------

const DRAFT_MARK = /\bDRAFT\b/;
const PLACEHOLDERS = [/\[[^\]\n]*\b(?:OPEN|OWNER|TODO|TBD|MISSING)\b[^\]\n]*\]/g,
  /\[(?:contact(?: address)?|e-?mail(?: address)?|address|date|effective date|governing law)\]/gi];
/** What makes a legal text not final: its DRAFT mark and its unfilled placeholders. */
export function legalProblems(text, name) {
  const found = DRAFT_MARK.test(text) ? [`${name}: "DRAFT"`] : [];
  for (const re of PLACEHOLDERS) for (const m of text.matchAll(re)) found.push(`${name}: ${m[0]}`);
  return found;
}
// the agent's own files, as they go into app/
export const APP_FILES = ['start.mjs', 'capacity.mjs', 'tools/connection.mjs', 'tools/agent-update.mjs', 'memory-transport.mjs', 'brain-core.mjs', 'research-learn.mjs', 'system-proxy.mjs', 'brain-panel.html', 'memory-agent.cordis.yml',
  'rulith-brain-ui', 'rulith-brain-web'];
const DSH = '@deepseek-ai/dsh';
// not needed to run: type declarations and source maps
const LEFT_OUT = /\.(d\.[cm]?ts|map)$/i;
const OFFICE = /^@deepseek-ai\/libreoffice-kit-(win32|darwin|linux|wasm)/;
// the longest path inside the zip: with Explorer's folder (C:\Users\<name>\Downloads\<zip name>\) in front it must
// stay under Windows' 260 characters
export const MAX_PATH_IN_ZIP = 200;
// Node's licence text for the version bundled (see the head)
export const nodeLicencePath = (version) => path.join(here, 'licenses', `node-${version}.LICENSE`);
const NODE_LICENCE_HEAD = 'Node.js is licensed for use as follows:';

// --- the dependency closure: what Node would load, starting from one package ---------------------------------------

/** Node's lookup of `name` from a package folder: its own node_modules, then each parent's, up to `root`. */
export function resolveFrom(root, dir, name) {
  for (let d = dir; ; d = path.dirname(d)) {
    const at = path.join(d, 'node_modules', name);
    if (fs.existsSync(path.join(at, 'package.json'))) return at;
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) return null;
  }
}

/** Every package folder `entry` needs (dependencies, installed optional ones and peers), with what is missing. */
export function dependencyClosure(root, entry) {
  const start = resolveFrom(root, root, entry);
  if (!start) throw new Error(`${entry} is not installed under ${root}`);
  const found = new Map();   // folder -> package.json
  const missing = [];
  for (const queue = [start]; queue.length;) {
    const dir = queue.shift();
    if (found.has(dir)) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    found.set(dir, pkg);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      const at = resolveFrom(root, dir, name);
      if (at) queue.push(at);
      else if (!(name in (pkg.optionalDependencies ?? {})) && !pkg.peerDependenciesMeta?.[name]?.optional) missing.push(`${pkg.name} -> ${name}`);
    }
  }
  return { packages: found, missing };
}

/** The folders directly under root/node_modules that hold the closure (a nested package comes with its parent). */
export function topFolders(root, packages) {
  const nm = path.join(root, 'node_modules');
  return [...new Set([...packages.keys()].map((dir) => path.relative(nm, dir).split(path.sep).join('/').split('/node_modules/')[0]))].sort();
}

// --- the page's brand in dsh's own files (the copy in the package only) --------------------------------------------

// each is found exactly once, or the package is not made: a newer dsh must be looked at again
export const BRAND_PATCHES = [
  // the tab before the page's plugins load, and the name an installed page app gets
  { file: '@deepseek-ai/dsh-web-frontend/dist/index.html', from: '<title>DeepSeek Harness</title>', to: '<title>Rulith Brain Agent</title>' },
  { file: '@deepseek-ai/dsh-web-frontend/dist/manifest.webmanifest', from: '"name": "DeepSeek Harness"', to: '"name": "Rulith Brain Agent"' },
  { file: '@deepseek-ai/dsh-web-frontend/dist/manifest.webmanifest', from: '"short_name": "DSH"', to: '"short_name": "Rulith Brain"' },
  // the card shown while the page loads its plugins
  { file: '@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js', from: '.wordmark,"HARNESS")', to: '.wordmark,"RULITH BRAIN")' },
  // the tab's title as dsh writes it (rulith-brain-ui rewrites it as well, for a run from the source tree)
  { file: '@deepseek-ai/dsh-client-ui-layout/lib/client.js', from: 'const productTitle = "DeepSeek Harness";', to: 'const productTitle = "Rulith Brain Agent";' },
  // The first task screen explains why the agent uses Brain, including after the welcome panel is dismissed.
  { file: '@deepseek-ai/dsh-client-ui-conversation/lib/client.js', from: '"hero.headline": "探索未至之境"', to: '"hero.headline": "用项目记忆完成任务"' },
  { file: '@deepseek-ai/dsh-client-ui-conversation/lib/client.js', from: '"hero.headline": "Into the Unknown"', to: '"hero.headline": "Work with your project’s memory"' },
  { file: '@deepseek-ai/dsh-client-ui-conversation/lib/client.js', from: '"placeholder.hero": "描述你想要构建的内容, / 调用指令, @ 文件或对话"',
    to: '"placeholder.hero": "例如：按上次定下的要求，对比这两款产品，整理成表格。输入 @ 引用文件，/ 查看指令。"' },
  { file: '@deepseek-ai/dsh-client-ui-conversation/lib/client.js', from: '"placeholder.hero": "Describe what you want to build, / commands, @ files or sessions"',
    to: '"placeholder.hero": "Try: Compare these two products against our earlier requirements. Use @ for files or / for commands."' },
  // the Chinese page's "working" line puns on DeepSeek's Chinese name (深度求索); the English one says "Deep diving"
  { file: '@deepseek-ai/dsh-client-ui-chat/lib/client.js', from: '"chat.deepDiving": "深度求索中"', to: '"chat.deepDiving": "深度探索中"' },
  { file: '@deepseek-ai/dsh-client-ui-chat/lib/client.js', from: '"chat.deepDivingFor": "深度求索中，', to: '"chat.deepDivingFor": "深度探索中，' },
  // the folder the first workspace is made in, under Documents (dsh's own name there would be another product's folder)
  { file: '@deepseek-ai/dsh-api-workspace-controller/lib/index.js', from: 'paths.join(directory, "deepseek-harness", DEFAULT_WORKSPACE_DIRECTORY)',
    to: 'paths.join(directory, "rulith-brain-agent", DEFAULT_WORKSPACE_DIRECTORY)' },
  // the answer to the page opened without its key
  { file: '@deepseek-ai/dsh-client-connection/lib/index.js', from: '"dsh web authentication required; reopen the URL printed by dsh web.',
    to: '"Rulith Brain Agent: open the address the agent printed when it started (it carries the page\'s key).' },
];
// the tab's icon, in both colour schemes
export const BRAND_ICONS = ['@deepseek-ai/dsh-web-frontend/dist/favicon.svg', '@deepseek-ai/dsh-web-frontend/dist/favicon-dark.svg'];

/** The brand plugin's exports (its mark, name, credit), read from its browser script as the page would load it. */
export function brandPlugin(file = path.join(AGENT, 'rulith-brain-ui', 'lib', 'client.js'), page = {}) {
  let loaded;
  const window = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window, encodeURIComponent, setTimeout, clearTimeout, MutationObserver: class {}, document: {}, ...page }, { filename: file });
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (init) => [typeof init === 'function' ? init() : init] };
  return loaded.factory((name) => { if (name === 'react') return react; throw new Error(`no ${name} here`); });
}

function brand(nm) {
  for (const p of BRAND_PATCHES) {
    const dir = path.join(nm, path.dirname(p.file));
    const pattern = new RegExp(`^${path.basename(p.file).replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
    const files = fs.readdirSync(dir).filter((f) => pattern.test(f));
    const hits = files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]).filter(([, text]) => text.includes(p.from));
    const count = hits.reduce((n, [, text]) => n + text.split(p.from).length - 1, 0);
    if (count !== 1) throw new Error(`brand: "${p.from}" found ${count} times in ${p.file} (dsh changed? look at BRAND_PATCHES)`);
    const [f, text] = hits[0];
    fs.writeFileSync(path.join(dir, f), text.replace(p.from, p.to));
  }
  const svg = brandPlugin().markSvg('m');
  for (const icon of BRAND_ICONS) {
    if (!fs.existsSync(path.join(nm, icon))) throw new Error(`brand: ${icon} is gone (dsh changed?)`);
    fs.writeFileSync(path.join(nm, icon), `${svg}\n`);
  }
}

// --- nothing secret in the agent's own files ------------------------------------------------------------------------

const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bhf_[A-Za-z0-9]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /Bearer [A-Za-z0-9._~+/-]{20,}/, /\bxox[abp]-[A-Za-z0-9-]{10,}/,
];
/** The lines of `text` that look like a key or a token. */
export const secretsIn = (text) => text.split(/\r?\n/).filter((line) => SECRET_SHAPES.some((shape) => shape.test(line)));

// --- what the user starts ---------------------------------------------------------------------------------------------

const crlf = (text) => text.replace(/\r?\n/g, '\r\n');
export function startCmd(server) {
  return crlf(`@echo off
rem Rulith Brain Agent: starts the agent and opens its page in the browser. Open Rulith Brain first and press
rem "Load the model and start"; keep the app open. While Brain is still loading, the agent waits for it.
rem   start.cmd [address] [options]      With no override the agent follows this PC's Brain settings.
rem Options: --learn-research on/off, --home folder, --port N, --no-open
rem Choose the address and access key on the Connection page, or use RULITH_MEMORY_SERVER and RULITH_MEMORY_KEY.
setlocal
set "HERE=%~dp0"
${server ? `if not defined RULITH_MEMORY_SERVER set "RULITH_MEMORY_SERVER=${server}"\n` : ''}rem started from its own folder (a double click): the agent works in your user folder, not among its own files
if /i "%CD%\\"=="%HERE%" cd /d "%USERPROFILE%"
"%HERE%node\\node.exe" "%HERE%app\\start.mjs" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" pause
exit /b %CODE%
`);
}

/** The package's README.txt: for the user (the developer flags are in the agent's README.md only). */
export function readme({ version, server = DEFAULT_SERVER, dshVersion, nodeVersion, nodeLicence, office, draft = false }) {
  return crlf(`Rulith Brain Agent ${version}
${'='.repeat(19 + version.length)}
${draft ? '\nTEST BUILD - not a release.\n' : ''}
A companion agent for Rulith Brain: one agent with one long memory that stays with it across days and restarts. It
works with Rulith Brain on this PC or another computer and shows its own page in your browser. It is open source: an open-source
agent harness's web app (dsh ${dshVersion}, MIT: THIRD-PARTY-NOTICES.txt names it) with Rulith's forwarder, which sends
each message to the memory instead of the whole conversation. Source: https://github.com/rulith-dev/rulith-brain-agent

Start
-----
1. Open Rulith Brain and press "Load the model and start". Keep the app open while you use the agent.
2. Double-click start.cmd. The page opens in your browser. If Brain is not running yet or is still loading the
   model, the agent says so and waits for it.
   Stop the agent with Ctrl+C in its window, or close the window.

Open the Connection page printed in the console to save a Brain address and access key. Without a saved address,
use start.cmd http://<address>:<port> or set RULITH_MEMORY_SERVER and, if needed, RULITH_MEMORY_KEY.
With no override the agent reads this PC's Brain port and key (default ${server}).

Options (after the address):
  --learn-research on|off   "Learn from research", on by default: pages the agent reads while working on a task are
                            learned into the memory. The same switch is on the agent's own page.
  --home <folder>           where the agent keeps its own files (see below)
  --port N, --no-open       the page's port, and not opening the browser

Conversations are remembered. When the memory is full, it lets old, unused material go by itself. The agent has
no tool to remove anything from the memory; the Rulith Brain app's Memory page has one.

Web search
----------
The agent searches Wikipedia: free, with no account and no key. Any web page is read by its address.
To search with a SearXNG address of your own, choose it in the Rulith Brain app under Settings, Web search: the
agent follows what is set there. Without the app's setting: set RULITH_BRAIN_SEARCH to wikipedia or searxng, and
RULITH_BRAIN_SEARXNG_URL with it.

What it keeps where
-------------------
- The memory is the server's: the agent keeps no copy of it.
- The agent's own files (its dsh profile, the page's transcripts): %USERPROFILE%\\.rulith-brain-agent, or --home.
- The folder it works in until you pick another on its page: Documents\\rulith-brain-agent\\default-workspace.
- The address it prints at start carries the page's key: open the page with it. The page and the forwarder listen on
  this computer only (127.0.0.1).
- No licence key, password or API key is stored in these files; a server's API key is read from RULITH_MEMORY_KEY
  when the agent starts.
- Whether Brain is running, the switches and what the last answer drew on: the agent's own page, printed at start
  (http://127.0.0.1:<port>/brain).

Inside
------
start.cmd                  starts the agent
app\\                       the agent (readable JavaScript) and the open-source packages it runs on
node\\node.exe              Node.js ${nodeVersion}, the runtime the agent uses (nothing else on this computer is needed)
${nodeLicence ? 'node\\LICENSE               Node.js\'s licence and those of the components it includes\n' : ''}THIRD-PARTY-NOTICES.txt    the licences of the harness (dsh), Node.js and every package in app\\node_modules, and where
                           the source of the open-source libraries inside them is
LICENSE.txt                the agent's own licence (MIT)
SHA256SUMS.txt             the SHA-256 of every file here (the release lists the zip's own)
${office ? '' : '\nThis package leaves out LibreOffice (dsh\'s reader for Office documents): such files are not previewed or read.\n'}
Licence
-------
Rulith Brain Agent's own files (app\\*.mjs, app\\brain-panel.html, app\\memory-agent.cordis.yml, app\\rulith-brain-ui,
app\\rulith-brain-web) are open source under the MIT licence: LICENSE.txt. The harness (dsh), Node.js and the other
third-party packages keep their own licences: THIRD-PARTY-NOTICES.txt. Rulith Brain itself (the app and its runtime)
is a separate product under its own licence agreement.
`);
}

// --- licence texts ----------------------------------------------------------------------------------------------------

const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright|third[-_]party[-_]notices)([-._][a-z0-9-]+)*$/i;
const CODE = /\.(c?m?js|ts|json|html?|css|ya?ml|map)$/i;
const norm = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
const licenceName = (pkg) => typeof pkg.license === 'string' ? pkg.license
  : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : 'not stated');

/** The licence texts a package ships, at any depth (code it bundles carries its own): LICENSE / NOTICE / COPYING
 * files and the text files of a licences folder; other files there (HTML) by name. Nested packages are their own. */
export function licenceTexts(dir) {
  const texts = [], others = [];
  const read = (rel) => {
    const data = fs.readFileSync(path.join(dir, rel));
    if (data.includes(0)) others.push(rel);   // (not text)
    else texts.push({ file: rel, text: norm(data.toString('utf8')) });
  };
  const visit = (rel) => {
    // (a folder's own files before its subfolders: a package's licence comes first)
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.isDirectory() - b.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && e.name !== 'node_modules') {
        if (/^licen[cs]es$/i.test(e.name))
          for (const f of fs.readdirSync(path.join(dir, r)).sort()) (CODE.test(f) ? others.push(`${r}/${f}`) : read(`${r}/${f}`));
        else visit(r);
      } else if (e.isFile() && LICENCE_FILE.test(e.name) && !CODE.test(e.name)) read(r);
    }
  };
  visit('');
  return { texts: texts.filter((t) => t.text), others };
}

/** Every package folder in a node_modules tree (nested ones too). */
export function packageFolders(nm) {
  const out = [];
  const visit = (base) => {
    if (!fs.existsSync(base)) return;
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const names = e.name.startsWith('@') ? fs.readdirSync(path.join(base, e.name), { withFileTypes: true }).filter((s) => s.isDirectory()).map((s) => `${e.name}/${s.name}`) : [e.name];
      for (const n of names) {
        const dir = path.join(base, n);
        if (fs.existsSync(path.join(dir, 'package.json'))) out.push(dir);
        visit(path.join(dir, 'node_modules'));
      }
    }
  };
  visit(nm);
  return out;
}

// --- the code inside the packages' native binaries ----------------------------------------------------------------------

// Who sends the source of the LGPL / MPL parts on request (the written offer in THIRD-PARTY-NOTICES.txt): Rulith's
// contact address. A release is not made while this is a placeholder.
export const SOURCE_OFFER_CONTACT = 'contact@rulith.ai';
// For each npm package (at the version written here) whose binaries hold code whose licence texts the package does not
// ship: what is inside, the texts (tools/licenses, see the head) and where the exact source is. A package left out
// (--without-office) is left out here too; another version of one is refused with --release: look at it again.
export const BINARY_LICENCES = [
  { pkg: '@img/sharp-win32-x64', version: '0.35.5', copyleft: true,
    title: 'libvips 8.18.7 and the libraries built into it (sharp-libvips 1.3.4): lib/libvips-42.dll, lib/libvips-cpp-8.18.7.dll',
    licence: 'libvips, glib, pango, fribidi, libheif, librsvg, libexif and proxy-libintl: GNU LGPL, used under version 3 '
      + '(their "or any later version" clause); cairo: Mozilla Public License 1.1; the others: the licences in the texts below',
    files: ['sharp-libvips-1.3.4.THIRD-PARTY-NOTICES.md', 'sharp-libvips-1.3.4.LICENSES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt'],
    source: ['libvips 8.18.7: https://github.com/libvips/libvips/releases/tag/v8.18.7',
      'the Windows build packed here and its build scripts: https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.7 '
        + '(vips-dev-x64-web-8.18.7-static.zip)',
      'the version of every library in it and how sharp packs it: https://github.com/lovell/sharp-libvips/tree/v1.3.4 '
        + '(versions.properties; also app/node_modules/@img/sharp-win32-x64/versions.json); sharp 0.35.5: '
        + 'https://github.com/lovell/sharp/tree/v0.35.5'] },
  { pkg: 'sherpa-onnx-win-x64', version: '1.13.8',
    title: 'ONNX Runtime 1.28.2: onnxruntime.dll, onnxruntime_providers_shared.dll',
    licence: 'MIT, Copyright (c) Microsoft Corporation, with the third-party notices that follow it',
    files: ['onnxruntime-1.28.2.LICENSE', 'onnxruntime-1.28.2.ThirdPartyNotices.txt'],
    source: ['ONNX Runtime 1.28.2, commit 33ca9628233dc8f002435e868d4c2e9f82766ca1; these binaries are sherpa-onnx\'s build of it, '
      + 'https://github.com/csukuangfj/onnxruntime-libs/releases/tag/v1.28.2 (onnxruntime-win-x64-MT-Release-1.28.2.tar.bz2, '
      + 'which also holds the two texts)'] },
  { pkg: 'node-pty', version: '1.2.0-beta.15',
    title: 'ConPTY 1.25.260303002-preview (Windows Terminal): conpty.dll, OpenConsole.exe',
    licence: 'MIT, Copyright (c) Microsoft Corporation, with Windows Terminal\'s third-party notices',
    files: ['conpty-1.25.260303002.LICENSE', 'conpty-1.25.260303002.NOTICE.md'],
    source: ['the NuGet package Microsoft.Windows.Console.ConPTY 1.25.260303002-preview, '
      + 'https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY/1.25.260303002-preview, built from '
      + 'https://github.com/microsoft/terminal'] },
  { pkg: '@deepseek-ai/libreoffice-kit-win32-x64', version: '0.1.5', copyleft: true,
    title: 'LibreOffice 26.8.0.3: bin/libreoffice-kit.exe and program/',
    licence: 'Mozilla Public License 2.0, with the third-party licences (LGPL and others) in its program/license.txt and '
      + 'licenses/ - their texts are in section 3 and 4 above, with the package',
    files: [],
    source: ['LibreOffice 26.8.0.3 (tag libreoffice-26.8.0.3, commit bce0998afefdbc355585ca324285661a2170ba77): '
      + 'https://download.documentfoundation.org/libreoffice/src/26.8.0/libreoffice-26.8.0.3.tar.xz, with the external '
      + 'libraries its build fetches from https://dev-www.libreoffice.org/src/',
      'the changes and build settings of this build: app/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/sources '
        + '(core-changes.patch, core.json) and https://github.com/deepseek-ai/dsh-libreoffice-kit'] },
];
export const binaryLicencePath = (file) => path.join(here, 'licenses', file);

/** The BINARY_LICENCES entries whose package is in `nm` (and among the folders `among`, when given), with their texts;
 * another version of a package, a missing text and a source offer without a contact go to `warn` (a release refuses). */
export function binaryLicences(nm, warn, among = null) {
  const found = [];
  for (const entry of BINARY_LICENCES) {
    const pkgFile = path.join(nm, entry.pkg, 'package.json');
    if (!fs.existsSync(pkgFile) || (among && !among.includes(entry.pkg))) continue;
    const { version } = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    if (version !== entry.version) warn(`${entry.pkg} ${version} is installed; the licence texts for ${entry.title} are for ${entry.version} (look at it again: BINARY_LICENCES)`);
    const texts = entry.files.map((file) => ({ file, text: fs.existsSync(binaryLicencePath(file)) ? norm(fs.readFileSync(binaryLicencePath(file), 'utf8')) : null }));
    for (const t of texts.filter((t) => !t.text)) warn(`no ${binaryLicencePath(t.file)} (${entry.title}); THIRD-PARTY-NOTICES.txt marks it missing`);
    found.push({ ...entry, texts });
  }
  if (found.some((e) => e.copyleft) && SOURCE_OFFER_CONTACT.startsWith('[')) warn(`the source offer has no contact yet (SOURCE_OFFER_CONTACT in tools/pack.mjs)`);
  return found;
}

function binarySection(binary, rule) {
  const parts = [`${rule}
6. Code inside the packages' native binaries, and where its source is

These packages in app/node_modules ship prebuilt libraries and programs whose own licence files they do not carry (or not
all of them). Their texts follow, each with where the exact source of that version is.
`];
  binary.forEach((e, i) => parts.push(`${rule}
6.${i + 1}  ${e.title}
      in app/node_modules/${e.pkg} (${e.pkg} ${e.version})
      Licence: ${e.licence}
      Source: ${e.source.join('\n              ')}
${e.texts.map((t) => `\n${'.'.repeat(40)} ${t.file}\n\n${t.text ?? `[MISSING: ${t.file} (tools/licenses in the agent's source); a release must carry it.]`}\n`).join('')}`));
  const copyleft = binary.filter((e) => e.copyleft);
  if (copyleft.length) parts.push(`${rule}
6.${binary.length + 1}  Written offer for the source code

The components above under the GNU LGPL or the Mozilla Public License:
${copyleft.map((e) => `  - ${e.title.split(':')[0]}`).join('\n')}
Their source code is available from the upstream addresses given with each, which hold the exact versions in this
package. On request, the publisher of this package (Rulith) also provides the complete corresponding source code
of these components, for this version of the package, for at least three years from its release, at no more than the
cost of providing it. Write to: ${SOURCE_OFFER_CONTACT}
`);
  return parts;
}

export function notices({ version, nm, dsh, node, nodeLicence, binary = [] }) {
  const rel = (dir) => path.relative(path.dirname(path.dirname(nm)), dir).split(path.sep).join('/');
  const dshText = norm(fs.readFileSync(path.join(nm, DSH, 'LICENSE'), 'utf8'));
  const groups = new Map();   // licence text -> package lines
  const silent = [], pointers = [];
  for (const dir of packageFolders(nm)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!pkg.name) continue;   // (a folder's own package.json that only sets "type")
    const id = `${pkg.name}@${pkg.version} (${licenceName(pkg)})`;
    const { texts, others } = licenceTexts(dir);
    for (const o of others) pointers.push(`${id}: ${rel(dir)}/${o}`);
    if (!texts.length) {
      const by = [typeof pkg.author === 'string' ? pkg.author : pkg.author?.name, pkg.homepage ?? pkg.repository?.url ?? pkg.repository].filter(Boolean).join(', ');
      silent.push(`${id}${by ? ` - ${by}` : ''}`);
    }
    for (const t of texts) {
      if (!groups.has(t.text)) groups.set(t.text, new Set());
      // (a text from deeper in the package belongs to code the package bundles: its folder says which)
      const where = path.posix.dirname(t.file).replace(/^(\.|licen[cs]es)$/i, '');
      groups.get(t.text).add(where ? `${id}, bundled: ${where}/` : id);
    }
  }
  const rule = '-'.repeat(100);
  const parts = [`THIRD-PARTY NOTICES - Rulith Brain Agent ${version}

Rulith Brain Agent is DeepSeek Harness's web app with Rulith's forwarder, run by Node.js. This file holds the licence
of every third-party part of this package: DeepSeek Harness, Node.js, and each npm package in app/node_modules (as it
shipped there), and in section 6 the code inside those packages' native binaries, with where its source is and a written
offer for the source of its LGPL and MPL parts. Rulith's own files are not covered here (see README.txt).

Changes made to DeepSeek Harness in this package: the page carries the product's name and mark (the tab title, the
loading card, the page-app name and icon, the sign-in notice); see tools/pack.mjs BRAND_PATCHES in the agent's source.
`,
  `${rule}
1. DeepSeek Harness (dsh) ${dsh.version} - ${licenceName(dsh)}
   ${String(dsh.repository?.url ?? dsh.repository ?? '').replace(/^git\+/, '')}
   (this text also covers the ${[...groups.get(dshText) ?? []].length - 1} other @deepseek-ai packages listed with it below)

${dshText}
`,
  `${rule}
2. Node.js ${node.version} - MIT, with the licences of the components it includes (node/node.exe)

${nodeLicence ?? `[MISSING: the text of Node.js ${node.version}'s LICENSE file. It is not part of the Node installation this
package was made from; a release must carry it (tools/pack.mjs --node-license <file>).]`}
`,
  `${rule}
3. npm packages in app/node_modules: ${packageFolders(nm).length} packages, grouped by their licence text
`];
  let n = 0;
  for (const [text, ids] of [...groups].sort((a, b) => [...a[1]][0].localeCompare([...b[1]][0]))) {
    n++;
    parts.push(`${rule}
3.${n}  ${[...ids].sort().join('\n      ')}

${text}
`);
  }
  if (pointers.length) parts.push(`${rule}
4. Further licence files shipped inside packages (not text: not repeated here)

${pointers.join('\n')}
`);
  if (silent.length) parts.push(`${rule}
5. Packages that ship no licence text (the licence their package.json names)

${silent.sort().join('\n')}
`);
  if (binary.length) parts.push(...binarySection(binary, rule));
  return crlf(parts.join('\n'));
}

// --- the zip ----------------------------------------------------------------------------------------------------------

const dosTime = (d) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });

/** Writes `entries` ({ name, file } or { name, data }) to a zip at `out`: deflated (stored when that is not smaller),
 * UTF-8 names, one time for all. Not ZIP64: fails past 65535 entries or 4 GB. */
export function writeZip(out, entries, when = new Date()) {
  const { time, date } = dosTime(when);
  const fd = fs.openSync(out, 'w');
  const central = [];
  let offset = 0;
  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const entry of entries) {
      const data = entry.data ?? fs.readFileSync(entry.file);
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      const name = Buffer.from(entry.name, 'utf8');
      const crc = zlib.crc32(data);
      if (offset > 0xfffffffe || data.length > 0xfffffffe) throw new Error('the zip would need ZIP64');
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
      head.writeUInt16LE(stored ? 0 : 8, 8); head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12);
      head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22);
      head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
      const at = offset;
      write(head); write(name); write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(stored ? 0 : 8, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
      central.push(c, name);
    }
    if (entries.length > 0xffff) throw new Error('the zip would need ZIP64 (entries)');
    const start = offset;
    for (const b of central) write(b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    write(end);
  } finally { fs.closeSync(fd); }
  return offset;
}

/** Reads a zip written by writeZip (or any plain zip): name -> contents. */
export function readZip(file) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const body = buf.subarray(at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28) + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

// --- the package --------------------------------------------------------------------------------------------------------

const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
});
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

function nodeOf(exe) {
  if (path.resolve(exe) === path.resolve(process.execPath)) return { exe, version: process.version, platform: process.platform, arch: process.arch };
  const r = spawnSync(exe, ['-p', 'JSON.stringify([process.version, process.platform, process.arch])'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`--node ${exe}: does not run (${r.error?.message ?? r.stderr})`);
  const [version, platform, arch] = JSON.parse(r.stdout);
  return { exe, version, platform, arch };
}

export function pack(opts = {}) {
  const say = opts.log ?? console.log;
  const warn = (text) => { if (opts.release) throw new Error(text); say(`WARNING ${text}`); };
  const agentPkg = JSON.parse(fs.readFileSync(path.join(AGENT, 'package.json'), 'utf8'));
  const release = agentPkg.version;
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(release)) throw new Error('package.json needs a release version x.y.z');
  if (opts.versionFile && fs.readFileSync(opts.versionFile, 'utf8').trim() !== release)
    throw new Error(`package.json says ${release}, which differs from ${opts.versionFile}`);
  if (opts.preview !== undefined && !/^[0-9A-Za-z]+(\.[0-9A-Za-z]+)*$/.test(opts.preview)) throw new Error(`--preview ${opts.preview}: a name such as preview.1`);
  const version = opts.version ?? (opts.preview ? `${release}-${opts.preview}` : release);
  if (version !== release && !opts.allowDraft && !(opts.preview && version === `${release}-${opts.preview}`))
    throw new Error(`--version ${version}: the release is ${release}; another version only for a test build (--allow-draft) or a pre-release (--preview)`);
  if (!parseVersion(version)) throw new Error(`--version ${version}: not a version`);
  const draft = !!opts.allowDraft;
  const name = `rulith-brain-agent-${version}${draft ? DRAFT_SUFFIX : ''}`;
  const outDir = path.resolve(opts.out ?? path.join(AGENT, 'dist'));
  const stage = path.join(outDir, name);
  const zipFile = path.join(outDir, `${name}.zip`);

  // dsh: the version package.json pins, and the one installed
  const pin = agentPkg.dependencies?.[DSH];
  if (!/^\d+\.\d+\.\d+/.test(pin ?? '')) throw new Error(`package.json must pin ${DSH} to one version (it says ${pin})`);
  const { packages, missing } = dependencyClosure(AGENT, DSH);
  const dsh = [...packages.values()][0];
  if (dsh.version !== pin) throw new Error(`${DSH} ${dsh.version} is installed, package.json pins ${pin}: run npm install`);
  if (missing.length) throw new Error(`dsh's dependencies are not all installed: ${missing.join(', ')}`);

  // Node: the runtime that will run the agent
  const node = nodeOf(opts.node ?? process.execPath);
  const [major, minor] = node.version.slice(1).split('.').map(Number);
  if (node.platform !== 'win32' || node.arch !== 'x64') throw new Error(`Node ${node.version} is ${node.platform}-${node.arch}; the package is for win32-x64`);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error(`Node ${node.version}: the agent needs 22.19 or newer`);
  // (named, else the one kept for this version, else one beside node.exe)
  const nodeLicenceFile = opts.nodeLicense ?? [nodeLicencePath(node.version), path.join(path.dirname(node.exe), 'LICENSE')].find((f) => fs.existsSync(f));
  const nodeLicence = nodeLicenceFile && fs.existsSync(nodeLicenceFile) ? norm(fs.readFileSync(nodeLicenceFile, 'utf8')) : null;
  if (nodeLicence && !nodeLicence.startsWith(NODE_LICENCE_HEAD)) throw new Error(`${nodeLicenceFile}: not Node's LICENSE (it begins "${nodeLicence.slice(0, 40)}")`);
  if (!nodeLicence) warn(`no LICENSE for Node ${node.version} (no ${nodeLicencePath(node.version)}); THIRD-PARTY-NOTICES.txt marks it missing (--node-license <file>)`);
  // the agent's own licence: MIT, whole and without a placeholder
  const ownLicenceFile = path.join(AGENT, 'LICENSE');
  if (!fs.existsSync(ownLicenceFile)) throw new Error('no LICENSE beside package.json: the agent\'s own licence (MIT)');
  const ownLicence = norm(fs.readFileSync(ownLicenceFile, 'utf8'));
  if (!ownLicence.startsWith('MIT License\n\nCopyright (c) ') || !ownLicence.includes('THE SOFTWARE IS PROVIDED "AS IS"'))
    throw new Error('LICENSE: not the MIT licence text with its copyright line');
  if (agentPkg.license !== 'MIT') throw new Error(`package.json says licence ${agentPkg.license}: MIT`);
  const legal = legalProblems(ownLicence, 'LICENSE');
  if (legal.length) throw new Error(`LICENSE is not final: ${legal.join(', ')}`);

  // nothing that looks like a key in the agent's own files
  for (const f of APP_FILES) {
    const at = path.join(AGENT, f);
    for (const file of fs.statSync(at).isDirectory() ? walk(at).map((r) => path.join(at, r)) : [at]) {
      const found = secretsIn(fs.readFileSync(file, 'utf8'));
      if (found.length) throw new Error(`${path.relative(AGENT, file)} holds something that looks like a key: ${found[0].slice(0, 80)}`);
    }
  }

  // a fresh stage
  if (path.dirname(stage) !== outDir || !path.basename(stage).startsWith('rulith-brain-agent-')) throw new Error(`stage ${stage}?`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'app'), { recursive: true });
  for (const f of APP_FILES) fs.cpSync(path.join(AGENT, f), path.join(stage, 'app', f), { recursive: true });
  fs.writeFileSync(path.join(stage, 'app', 'package.json'), `${JSON.stringify({
    name: 'rulith-brain-agent', version, private: true, description: agentPkg.description,
    license: agentPkg.license, type: 'module', engines: agentPkg.engines, dependencies: { [DSH]: pin },
  }, null, 2)}\n`);

  // dsh and what it needs
  const nmFrom = fs.realpathSync(path.join(AGENT, 'node_modules'));
  const nm = path.join(stage, 'app', 'node_modules');
  let tops = topFolders(AGENT, packages);
  const office = !opts.withoutOffice;
  if (!office) tops = tops.filter((t) => !OFFICE.test(t));
  // the licences of the code inside the binaries it ships (before node_modules is copied: a release stops here)
  const binary = binaryLicences(nmFrom, warn, tops);
  for (const t of tops)
    fs.cpSync(path.join(nmFrom, t), path.join(nm, t), { recursive: true, filter: (src) => !LEFT_OUT.test(src) });
  brand(nm);

  // Node
  fs.mkdirSync(path.join(stage, 'node'));
  fs.copyFileSync(node.exe, path.join(stage, 'node', 'node.exe'));
  if (nodeLicence) fs.writeFileSync(path.join(stage, 'node', 'LICENSE'), `${nodeLicence}\n`);

  // the user's files
  fs.writeFileSync(path.join(stage, 'start.cmd'), startCmd(opts.server));
  fs.writeFileSync(path.join(stage, 'README.txt'), readme({ version, server: opts.server ?? DEFAULT_SERVER, dshVersion: dsh.version, nodeVersion: node.version, nodeLicence: !!nodeLicence, office, draft }));
  fs.writeFileSync(path.join(stage, 'LICENSE.txt'), crlf(`${ownLicence}\n`));
  fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices({ version, nm, dsh, node, nodeLicence, binary }));
  const files = walk(stage).sort();
  const sums = files.map((f) => `${sha256(fs.readFileSync(path.join(stage, f)))} *${f}`);
  fs.writeFileSync(path.join(stage, 'SHA256SUMS.txt'), crlf(`${sums.join('\n')}\n`));
  files.push('SHA256SUMS.txt');

  // paths short enough for Explorer
  const longest = files.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (longest.length > MAX_PATH_IN_ZIP) throw new Error(`a path in the zip is ${longest.length} characters (${longest}); the most is ${MAX_PATH_IN_ZIP}`);

  // the zip, its checksum beside it
  fs.rmSync(zipFile, { force: true });
  const bytes = writeZip(zipFile, files.sort().map((f) => ({ name: f, file: path.join(stage, f) })));
  const zipSum = sha256(fs.readFileSync(zipFile));
  fs.writeFileSync(`${zipFile}.sha256`, `${zipSum} *${path.basename(zipFile)}\n`);
  const unpacked = files.reduce((n, f) => n + fs.statSync(path.join(stage, f)).size, 0);
  if (!opts.keepStage) fs.rmSync(stage, { recursive: true, force: true });

  say(`${path.basename(zipFile)}: ${mb(bytes)} (${files.length} files, ${mb(unpacked)} unpacked; dsh ${dsh.version}, `
    + `${packages.size} packages${office ? '' : ', without LibreOffice'}; Node ${node.version})`);
  say(`SHA-256 ${zipSum}`);
  say(`longest path in the zip: ${longest.length} characters`);
  return { zip: zipFile, version, sha256: zipSum, bytes, files: files.length, stage: opts.keepStage ? stage : null, longest: longest.length };
}

/** What the package's app/node_modules would hold, counted by the licence each package.json names (the numbers
 * THIRD-PARTY-NOTICES.md of the public repository quotes): `node tools/pack.mjs --licence-counts [--without-office]`. */
export function licenceCounts({ withoutOffice = false } = {}) {
  const { packages } = dependencyClosure(AGENT, DSH);
  const nm = fs.realpathSync(path.join(AGENT, 'node_modules'));
  let tops = topFolders(AGENT, packages);
  if (withoutOffice) tops = tops.filter((t) => !OFFICE.test(t));
  const dirs = tops.flatMap((t) => [path.join(nm, t), ...packageFolders(path.join(nm, t, 'node_modules'))]);
  const dshText = norm(fs.readFileSync(path.join(nm, DSH, 'LICENSE'), 'utf8'));
  const counts = new Map();
  let sameAsDsh = 0;
  for (const dir of dirs) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!pkg.name) continue;
    const name = licenceName(pkg);
    counts.set(name, [...(counts.get(name) ?? []), pkg.name]);
    if (pkg.name !== DSH && licenceTexts(dir).texts.some((t) => t.text === dshText)) sameAsDsh++;
  }
  const total = [...counts.values()].reduce((n, v) => n + v.length, 0);
  return { total, sameAsDsh, byLicence: [...counts].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])) };
}

// --- the command --------------------------------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opts = {};
  const value = (i) => { if (argv[i + 1] === undefined) { console.error(`${argv[i]}: needs a value`); process.exit(2); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') opts.version = value(i++);
    else if (a === '--out') opts.out = value(i++);
    else if (a === '--node') opts.node = value(i++);
    else if (a === '--node-license') opts.nodeLicense = value(i++);
    else if (a === '--preview') opts.preview = value(i++);
    else if (a === '--server') opts.server = value(i++);
    else if (a === '--without-office') opts.withoutOffice = true;
    else if (a === '--keep-stage') opts.keepStage = true;
    else if (a === '--release') opts.release = true;
    else if (a === '--allow-draft') opts.allowDraft = true;
    else if (a === '--licence-counts') opts.licenceCounts = true;
    else { console.error(`unknown option ${a} (see the head of tools/pack.mjs)`); process.exit(2); }
  }
  try {
    if (opts.licenceCounts) {
      const c = licenceCounts(opts);
      console.log(`${c.total} npm packages in app/node_modules${opts.withoutOffice ? ' (without LibreOffice)' : ''}; `
        + `${c.sameAsDsh} besides dsh under dsh's own licence text`);
      for (const [licence, names] of c.byLicence) console.log(`  ${String(names.length).padStart(4)}  ${licence}${names.length <= 3 ? `  (${names.join(', ')})` : ''}`);
    } else pack(opts);
  } catch (error) { console.error(`pack: ${error.message}`); process.exit(1); }
}
