#!/usr/bin/env node
// Rulith Brain Agent as an installed Windows app: dist/Rulith-Brain-Agent-Setup-<version>.exe
//
//   node tools/desktop.mjs [--version 0.2.1] [--allow-draft] [--preview preview.1] [--without-office]
//                          [--out dist] [--stage <folder>] [--tauri <tauri.js>] [--target-dir <folder>]
//                          [--offline] [--jobs N] [--notes <UTF-8 file>]
//
// The app is a small shell (desktop/src-tauri: a window, Tauri) around the agent the zip package holds: it starts
// the agent without a console window, shows its page in a window of its own and stops it with the window.
//
// 1. the package's files, staged as tools/pack.mjs stages them for the zip (node\, app\, LICENSE.txt,
//    THIRD-PARTY-NOTICES.txt, README.txt, start.cmd) - the same checks and the same version rules; the zip pack
//    writes on the way is not kept
// 2. LICENSES-desktop-shell.txt beside them: the licence texts of the Rust crates inside the shell, each crate's own
//    licence files from the local cargo cache (cargo tree / cargo metadata)
// 3. the shell built with the Tauri CLI, the staged folder as its resources (installed as agent\ beside the exe)
// 4. the setup copied to --out with its SHA-256. TAURI_SIGNING_PRIVATE_KEY enables its .sig and latest.json.
//
// Needs Rust (cargo, the MSVC target) and the Tauri CLI: `npm i -D @tauri-apps/cli` in this folder, or --tauri <the
// path of its tauri.js>. --stage: where the files are staged (default desktop/src-tauri/target/agent: the deepest
// file of the package is ~180 characters below it, the setup's compiler reads paths of 260 at most, and it reads
// each file by the stage's path as written from src-tauri - a stage beside src-tauri costs the "..\..\" on the
// way). --target-dir: cargo's (default desktop/src-tauri/target). --offline: cargo takes every crate from its cache.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { pack, AGENT, DRAFT_SUFFIX } from './pack.mjs';
import { MIRROR, RELEASES } from './agent-update.mjs';

export const DESKTOP = path.join(AGENT, 'desktop');
export const APP = path.join(DESKTOP, 'src-tauri');
export const PRODUCT = 'Rulith Brain Agent';
export const CRATE_TARGET = 'x86_64-pc-windows-msvc';
/** The longest path the setup's compiler (and Explorer) reads. */
export const MAX_PATH = 259;
/** The folder the setup's files are installed in, below the install folder. */
export const INSTALLED = 'agent';
/** The longest name of a user's profile folder the setup still has to install under (Windows: 20 for a local
 *  account; a work account's folder may add its domain). */
export const PROFILE_NAME = 32;
/** Where a per-user setup installs for a profile folder of that name. */
export const installFolder = (profile) => `C:\\Users\\${profile}\\AppData\\Local\\${PRODUCT}`;
/** How long a file's path below the staged folder may be: installed as <install folder>\agent\<path>, it has to
 *  stay within MAX_PATH for a profile folder name of PROFILE_NAME characters (the setup's first draft put the files
 *  50 characters deeper, and a file of the package then had no path Windows would open). */
export const STAGED_PATH_MAX = MAX_PATH - (installFolder('x'.repeat(PROFILE_NAME)).length + 1 + INSTALLED.length + 1);

/** The staged folder as the Tauri CLI is to be given a resource folder: relative to src-tauri, forward slashes, a
 *  slash at its end. Not its absolute path: the CLI (2.8) drops the drive, the folder is then not found as the
 *  start of its own files' paths, and every file is installed under <install folder>\<the whole path on the build
 *  machine> instead of agent\ - the first draft's setup. */
export function resourceSource(stage, app = APP) {
  const rel = path.relative(app, stage);
  if (!rel || path.isAbsolute(rel)) throw new Error(`--stage ${stage}: a folder on the drive of ${app}, not that folder itself`);
  return `${rel.replace(/\\/g, '/')}/`;
}

/** Where the setup's compiler was told to install the resources: the names of the script's `File /a "/oname=..."`
 *  lines (target\release\nsis\x64\installer.nsi, written by the Tauri CLI), and the ones not below agent\. */
export function installedNames(nsi) {
  const names = [...nsi.matchAll(/^\s*File \/a "\/oname=([^"]*)"/gm)].map((m) => m[1]);
  const outside = names.filter((n) => !n.replace(/\//g, '\\').startsWith(`${INSTALLED}\\`) || /(^|\\)\.\.(\\|$)/.test(n.replace(/\//g, '\\')));
  return { names, outside };
}
const LICENCE_FILE = /^(licen[cs]e|unlicense|copying|copyright|notice)([-._][\w.-]*)?$/i;

/** The setup's file name. */
export const setupName = (version, draft = false) => `Rulith-Brain-Agent-Setup-${version}${draft ? DRAFT_SUFFIX : ''}.exe`;

/** Copy the exact bytes signed by Tauri. Write the manifest last, once both named assets are in place. */
export function copySetup(made, setup, { signed, version, notes }) {
  const manifest = path.join(path.dirname(setup), 'latest.json');
  const signature = signed ? fs.readFileSync(made + '.sig', 'utf8').trim() : '';
  if (signed && !signature) throw new Error('Tauri produced an empty updater signature');
  fs.rmSync(manifest, { force: true });
  fs.rmSync(setup + '.sig', { force: true });
  fs.copyFileSync(made, setup);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(setup)).digest('hex');
  fs.writeFileSync(setup + '.sha256', `${sum} *${path.basename(setup)}\n`);
  if (signed) {
    fs.copyFileSync(made + '.sig', setup + '.sig');
    const entry = { signature, url: `${MIRROR}${RELEASES}/download/v${version}/${path.basename(setup)}` };
    fs.writeFileSync(manifest, JSON.stringify({ version, notes, pub_date: new Date().toISOString(),
      platforms: { 'windows-x86_64-nsis': entry, 'windows-x86_64': entry } }, null, 2) + '\n');
  }
  return sum;
}

function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${command}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} ended with ${r.status}${r.stderr ? `: ${String(r.stderr).trim().split('\n').slice(-6).join(' | ')}` : ''}`);
  return r.stdout;
}

/** The crates cargo links into the shell on Windows (normal dependencies: proc-macros and build scripts only run at
 *  build time), as cargo metadata describes them. */
export function linkedCrates({ offline = false, env = process.env } = {}) {
  const more = offline ? ['--offline'] : [];
  const tree = run('cargo', ['tree', '--target', CRATE_TARGET, '-e', 'normal,no-proc-macro', '--prefix', 'none', '-f', '{p}', ...more], { cwd: APP, env });
  const linked = new Set(tree.split('\n').map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')).filter(Boolean));   // "name v1.2.3"
  const meta = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--filter-platform', CRATE_TARGET, ...more], { cwd: APP, env }));
  return meta.packages.filter((p) => p.source !== null && linked.has(`${p.name} v${p.version}`));
}

/** The licence texts of those crates, crates with the same text together. */
export function crateNotices(crates, version) {
  const groups = new Map();
  const bare = [];
  for (const p of crates) {
    const crate = `${p.name} ${p.version} (${p.license || 'see its licence file'})`;
    const folder = path.dirname(p.manifest_path);
    const texts = fs.readdirSync(folder).filter((f) => LICENCE_FILE.test(f) && fs.statSync(path.join(folder, f)).isFile()).sort()
      .map((f) => fs.readFileSync(path.join(folder, f), 'utf8').replace(/\r\n/g, '\n').trim());
    for (const text of texts) groups.set(text, [...(groups.get(text) ?? []), crate]);
    if (!texts.length) bare.push(crate + (p.authors?.length ? ` - ${p.authors.join(', ')}` : ''));
  }
  const rule = '-'.repeat(100);
  const parts = [`Rust crates in rulith-brain-agent.exe (${PRODUCT} ${version}), grouped by licence text.\n`
    + `Generated by tools/desktop.mjs: the crates of \`cargo tree --target ${CRATE_TARGET} -e normal,no-proc-macro\`,\n`
    + 'each with the licence files it ships (the local cargo cache).\n'];
  for (const [text, list] of [...groups].sort((a, b) => [...a[1]].sort()[0].localeCompare([...b[1]].sort()[0])))
    parts.push(`${rule}\n${[...list].sort().join('\n')}\n\n${text}\n`);
  if (bare.length) parts.push(`${rule}\nCrates that ship no licence file (under the licence named, whose text is above):\n\n${bare.sort().join('\n')}\n`);
  return parts.join('\n');
}

const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]));

/** Where the Tauri CLI is: named, or installed beside this package. */
export function tauriCli(named) {
  if (named) {
    if (!fs.existsSync(named)) throw new Error(`--tauri ${named}: no such file`);
    return path.resolve(named);
  }
  try { return createRequire(path.join(AGENT, 'package.json')).resolve('@tauri-apps/cli/tauri.js'); }
  catch { throw new Error('the Tauri CLI is not installed here: npm i -D @tauri-apps/cli, or --tauri <the path of its tauri.js>'); }
}

export function desktop(opts = {}) {
  const say = opts.log ?? ((line) => console.log(line));
  if (process.platform !== 'win32') throw new Error('the setup is built on Windows');
  const cli = tauriCli(opts.tauri);
  const outDir = path.resolve(opts.out ?? path.join(AGENT, 'dist'));
  const stage = path.resolve(opts.stage ?? path.join(APP, 'target', 'agent'));
  if (path.basename(stage) !== 'agent') throw new Error(`--stage ${stage}: a folder named agent (it is emptied)`);
  const parent = path.dirname(stage);
  const signed = !!process.env.TAURI_SIGNING_PRIVATE_KEY;
  const releaseNotes = signed && opts.notes ? fs.readFileSync(opts.notes, 'utf8') : undefined;
  if (!signed) say('TAURI_SIGNING_PRIVATE_KEY is unset. Building without an updater signature or latest.json.');

  // 1. the package's files (pack names the stage by the version; it is moved to the short name)
  fs.rmSync(stage, { recursive: true, force: true });
  const packed = pack({ version: opts.version, allowDraft: opts.allowDraft, preview: opts.preview, withoutOffice: opts.withoutOffice,
    node: opts.node, nodeLicense: opts.nodeLicense, out: parent, keepStage: true, log: say });
  fs.rmSync(packed.zip, { force: true });
  fs.rmSync(`${packed.zip}.sha256`, { force: true });
  fs.renameSync(packed.stage, stage);
  const draft = !!opts.allowDraft;
  const version = packed.version;
  const files = walk(stage);
  const longest = files.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (path.join(stage, longest).length > MAX_PATH)
    throw new Error(`a staged path is ${path.join(stage, longest).length} characters (${path.join(stage, longest)}): name a shorter --stage`);
  if (longest.length > STAGED_PATH_MAX)
    throw new Error(`${longest} is ${longest.length} characters: installed below ${installFolder('<a name of ' + PROFILE_NAME + ' characters>')}\\${INSTALLED} it would be longer than ${MAX_PATH} (at most ${STAGED_PATH_MAX} here)`);
  const source = resourceSource(stage);
  // (the compiler opens each file as <src-tauri>\<the stage as named to the CLI>\<file>, the ".." in it too)
  const compiled = path.win32.join(APP, 'x').slice(0, -1) + source.split('/').join(path.win32.sep) + longest;
  if (compiled.length > MAX_PATH)
    throw new Error(`the setup's compiler would read ${compiled} (${compiled.length} characters, ${MAX_PATH} at most): name a --stage with a shorter path from ${APP}`);

  // 2. the shell's own third-party code
  const env = { ...process.env };
  if (opts.targetDir) env.CARGO_TARGET_DIR = path.resolve(opts.targetDir);
  if (opts.offline) env.CARGO_NET_OFFLINE = 'true';
  env.CARGO_BUILD_JOBS = String(opts.jobs ?? env.CARGO_BUILD_JOBS ?? 4);
  const crates = linkedCrates({ offline: opts.offline, env });
  fs.writeFileSync(path.join(stage, 'LICENSES-desktop-shell.txt'), crateNotices(crates, version));
  say(`${crates.length} Rust crates in the shell: their licence texts in LICENSES-desktop-shell.txt`);

  // 3. the shell, the staged folder as its resources; the setup's licence page shows the agent's own licence (MIT)
  const conf = JSON.parse(fs.readFileSync(path.join(APP, 'tauri.conf.json'), 'utf8'));
  const overrides = { version, bundle: { createUpdaterArtifacts: signed,
    resources: { [source]: `${INSTALLED}/` }, licenseFile: path.join(stage, 'LICENSE.txt') } };
  if (signed) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
  // Authenticode, when a signing identity is set (RULITH_SIGN_SHA1; the signer is the publisher's own script,
  // RULITH_SIGN_TOOL or tools/sign_files.py of the tree this folder lives in): the staged package's unsigned
  // executables and native modules here, the shell, the setup and its uninstaller by the bundler
  if (env.RULITH_SIGN_SHA1 || env.RULITH_SIGN_PFX) {
    const signer = env.RULITH_SIGN_TOOL ?? path.resolve(AGENT, '..', '..', 'tools', 'sign_files.py');
    if (!fs.existsSync(signer)) throw new Error(`a signing identity is set and ${signer} is not there (RULITH_SIGN_TOOL)`);
    const python = env.RULITH_SIGN_PYTHON ?? 'python';
    const signedStage = spawnSync(python, [signer, stage, '--quiet'], { env, stdio: 'inherit' });
    if (signedStage.status !== 0) throw new Error('the staged package was not signed');
    overrides.bundle.windows = { signCommand: { cmd: python, args: [signer, '%1'] } };
    say('a signing identity is set: the package, the shell, the setup and its uninstaller are signed');
  } else {
    say('UNSIGNED: no signing identity (RULITH_SIGN_SHA1) - Smart App Control will block this setup');
  }
  const target = env.CARGO_TARGET_DIR ?? path.join(APP, 'target');
  const script = path.join(target, 'release', 'nsis', 'x64', 'installer.nsi');
  const made = path.join(target, 'release', 'bundle', 'nsis', `${conf.productName}_${version}_x64-setup.exe`);
  fs.rmSync(script, { force: true });
  fs.rmSync(made + '.sig', { force: true });
  const built = spawnSync(process.execPath, [cli, 'build', '--ci', '--config', JSON.stringify(overrides)], { cwd: APP, env, stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`the Tauri build ended with ${built.status}`);
  if (!fs.existsSync(made)) throw new Error(`no setup at ${made}`);
  // what the setup really installs where: read from the script its compiler was given (a setup is not run here)
  if (!fs.existsSync(script)) throw new Error(`no ${script}: what the setup installs cannot be checked`);
  const { names, outside } = installedNames(fs.readFileSync(script, 'utf8'));
  if (outside.length) throw new Error(`the setup would install ${outside.length} of ${names.length} files outside ${INSTALLED}\\ (the first: ${outside[0]})`);
  const staged = walk(stage).length;
  if (names.length !== staged) throw new Error(`the setup installs ${names.length} files below ${INSTALLED}\\, the staged folder has ${staged}`);
  for (const must of ['node\\node.exe', 'app\\start.mjs', 'LICENSE.txt'])
    if (!names.some((n) => n.replace(/\//g, '\\') === `${INSTALLED}\\${must}`)) throw new Error(`the setup does not install ${INSTALLED}\\${must}`);

  // 4. the setup, its checksum beside it
  fs.mkdirSync(outDir, { recursive: true });
  const setup = path.join(outDir, setupName(version, draft));
  const notes = (draft ? 'DRAFT TEST BUILD - ' : '') + (releaseNotes ?? `${PRODUCT} ${version}`);
  const sum = copySetup(made, setup, { signed, version, notes });
  if (signed) say(`Updater files: ${path.basename(setup)}.sig and latest.json`);
  say(`${path.basename(setup)}: ${(fs.statSync(setup).size / 2 ** 20).toFixed(1)} MiB (${names.length} files, all below ${INSTALLED}\\ by the setup's own script; installed, the longest path is ${longest.length + INSTALLED.length + 1} characters below the install folder: ${installFolder('<name>').length - '<name>'.length + 1 + INSTALLED.length + 1 + longest.length} + the profile folder's name, of ${MAX_PATH} at most)`);
  say(`SHA-256 ${sum}`);
  return { setup, sha256: sum, stage, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opts = {};
  const value = (i) => { if (argv[i + 1] === undefined) { console.error(`${argv[i]}: needs a value`); process.exit(2); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') opts.version = value(i++);
    else if (a === '--notes') opts.notes = value(i++);
    else if (a === '--out') opts.out = value(i++);
    else if (a === '--stage') opts.stage = value(i++);
    else if (a === '--tauri') opts.tauri = value(i++);
    else if (a === '--target-dir') opts.targetDir = value(i++);
    else if (a === '--jobs') opts.jobs = Number(value(i++));
    else if (a === '--node') opts.node = value(i++);
    else if (a === '--node-license') opts.nodeLicense = value(i++);
    else if (a === '--preview') opts.preview = value(i++);
    else if (a === '--without-office') opts.withoutOffice = true;
    else if (a === '--allow-draft') opts.allowDraft = true;
    else if (a === '--offline') opts.offline = true;
    else { console.error(`unknown option ${a} (see the head of tools/desktop.mjs)`); process.exit(2); }
  }
  try { desktop(opts); } catch (error) { console.error(`desktop: ${error.message}`); process.exit(1); }
}
