// The system's proxy, for the agent: Node asks no one how to reach the web, so behind a proxy that Windows is set to
// use (Settings > Network > Proxy; what a browser follows) the agent's web tools reached nothing - a page read timed
// out where the browser beside it opened the page (measured 2026-11-19: Wikipedia from this PC, 11 s to a timeout
// direct, 1.3 s through the proxy). The launcher gives the agent's process the proxy as the usual variables, and
// Node 24 follows them for fetch (NODE_USE_ENV_PROXY). This PC's own addresses never go through it: the agent talks
// to its forwarder and to Rulith Brain on the loopback interface.
//
// Only a proxy set by hand is read (ProxyEnable + ProxyServer); a setup script (PAC) is not. Proxy variables the
// user set themself win - and are then followed too: Node reads them only when told to (the agent's web tools went
// direct with HTTPS_PROXY set, measured the same day), and this PC's own addresses are added to their NO_PROXY.
import { spawnSync } from 'node:child_process';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const OWN = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const LOCAL = ['localhost', '127.0.0.1', '::1'];

/**
 * Windows' ProxyServer value as a proxy address: "host:port" (one proxy for everything), or
 * "http=host:port;https=host:port;..." (the https one, else the http one). A SOCKS-only setting gives null: fetch
 * speaks to HTTP proxies only.
 */
export function parseProxyServer(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let pick = text;
  if (text.includes('=')) {
    const by = new Map(text.split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]));
    pick = by.get('https') ?? by.get('http') ?? '';
  }
  pick = pick.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return /^[A-Za-z0-9.\-[\]:]+:\d{1,5}$/.test(pick) ? `http://${pick}` : null;
}

/** Windows' ProxyOverride ("a;b;<local>") as NO_PROXY names: plain hosts and "*.domain" suffixes; this PC always. */
export function noProxy(override) {
  const out = [...LOCAL];
  for (const raw of String(override ?? '').split(';')) {
    const name = raw.trim().toLowerCase();
    if (!name || name === '<local>') continue;
    const host = name.replace(/^\*\./, '.');
    if (/^[a-z0-9.\-:]+$/.test(host) && !out.includes(host)) out.push(host);
  }
  return out.join(',');
}

/**
 * The variables to add to the agent's environment. The user's own proxy variables: only the word that makes Node
 * follow them, and this PC's own addresses in NO_PROXY. Else the system's proxy; nothing when it uses none, when its
 * setting is not an HTTP proxy, or when the user said no (NODE_USE_ENV_PROXY=0).
 * @param settings - { enable, server, override } as Windows keeps them.
 */
export function proxyEnv(settings, env = process.env) {
  if (env.NODE_USE_ENV_PROXY === '0') return {};
  if (OWN.some((k) => env[k])) {
    const no = env.NO_PROXY || env.no_proxy || '';
    const named = no.split(',').map((x) => x.trim().toLowerCase());
    const missing = LOCAL.filter((h) => !named.includes(h));
    return { NODE_USE_ENV_PROXY: '1', ...(missing.length ? { NO_PROXY: [no, ...missing].filter(Boolean).join(',') } : {}) };
  }
  if (!settings) return {};
  const proxy = Number(settings.enable) ? parseProxyServer(settings.server) : null;
  if (!proxy) return {};
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: env.NO_PROXY || env.no_proxy || noProxy(settings.override), NODE_USE_ENV_PROXY: '1' };
}

/** Windows' proxy setting ({ enable, server, override }), or null elsewhere or when it cannot be read. */
export function windowsProxySettings() {
  if (process.platform !== 'win32') return null;
  const read = (name) => {
    const r = spawnSync('reg', ['query', KEY, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = r.status === 0 ? new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`).exec(r.stdout ?? '') : null;
    return m ? m[1].trim() : '';
  };
  try {
    return { enable: Number.parseInt(read('ProxyEnable'), 16) || 0, server: read('ProxyServer'), override: read('ProxyOverride') };
  } catch {
    return null;
  }
}
