import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PORT = 8091;

export function brainHome(env) {
  return env.RULITH_BRAIN_HOME || (env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Rulith', 'Brain'));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function address(value) {
  const url = typeof value === 'string' && URL.canParse(value) && new URL(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Enter an HTTP or HTTPS Brain address without credentials, a query or a fragment.');
  return url.href.replace(/\/+$/, '');
}

// The address selects the source of credentials. A key from this PC's Brain must never follow a remote override.
export function agentConnection({ home, server, env = process.env }) {
  const file = path.join(home, 'connection.json');
  function resolve() {
    const saved = readJson(file);
    if (saved?.server) return { server: address(saved.server), key: saved.key || '' };
    const named = server || env.RULITH_MEMORY_SERVER;
    if (named) return { server: address(named), key: env.RULITH_MEMORY_KEY || '' };
    const root = brainHome(env);
    const network = root && readJson(path.join(root, 'config', 'settings.json'))?.network;
    const port = network?.port;
    return { server: 'http://127.0.0.1:' + (Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT),
      key: env.RULITH_MEMORY_KEY || network?.api_key || '' };
  }

  function save(change) {
    if (change?.automatic === true) {
      fs.rmSync(file, { force: true });
      return;
    }
    const server = address(change?.server);
    // Preserve a known key only for the same destination. Sending an empty string explicitly clears it.
    let key = change.key;
    if (key === undefined) {
      const current = resolve();
      key = current.server === server ? current.key : '';
    }
    if (typeof key !== 'string' || /[^!-~]/.test(key)) throw new Error('Invalid access key.');
    fs.mkdirSync(home, { recursive: true });
    const tmp = file + '.' + randomUUID();
    try {
      fs.writeFileSync(tmp, JSON.stringify({ server, key }) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  return { resolve, save };
}
