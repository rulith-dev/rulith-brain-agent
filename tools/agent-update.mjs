import { createRequire } from 'node:module';
import pkg from '../package.json' with { type: 'json' };

export const RELEASES = 'https://github.com/rulith-dev/rulith-brain-agent/releases';
export const MIRROR = 'https://gh-proxy.com/';
const manifest = RELEASES + '/latest/download/latest.json';
export const ENDPOINTS = [manifest, MIRROR + manifest];
const TIMEOUT = 3500;

export function parseVersion(version) {
  if (typeof version !== 'string' || version.length > 256) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(id => /^0\d+$/.test(id))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

/** SemVer precedence, including numeric prerelease identifiers. Invalid versions are never offered. */
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    return (xn ? BigInt(x) > BigInt(y) : x > y) ? 1 : -1;
  }
  return Math.sign(a.pre.length - b.pre.length);
}

export async function findUpdate(installed, request = fetch) {
  for (const url of ENDPOINTS) {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!response.ok) { await response.body?.cancel(); continue; }
      const { version } = await response.json();
      const order = compareVersions(version, installed);
      if (order !== null) return order > 0 ? { version, url: RELEASES + '/latest' } : null;
    } catch { /* Try the mirror when the first request fails or its manifest is unreadable. */ }
  }
  return null;
}

/** Use the HTTP client shipped with dsh's proxy plugin, scoped to the public feed. This also works on Node 22.19. */
export async function portableUpdate(proxyEnvironment) {
  if (proxyEnvironment.NODE_USE_ENV_PROXY !== '1') return findUpdate(pkg.version);
  let dispatcher;
  try {
    const harness = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'));
    const proxyPlugin = createRequire(harness.resolve('@deepseek-ai/dsh-http-proxy'));
    const { EnvHttpProxyAgent, fetch: request } = proxyPlugin('undici');
    const env = { ...process.env, ...proxyEnvironment };
    const fallback = env.all_proxy || env.ALL_PROXY;
    const httpProxy = env.http_proxy || env.HTTP_PROXY || fallback;
    dispatcher = new EnvHttpProxyAgent({ httpProxy, httpsProxy: env.https_proxy || env.HTTPS_PROXY || httpProxy,
      noProxy: proxyEnvironment.NO_PROXY || env.no_proxy || env.NO_PROXY });
    return await findUpdate(pkg.version, (url, init) => request(url, { ...init, dispatcher }));
  } catch {
    return null;
  } finally {
    await dispatcher?.destroy().catch(() => {});
  }
}
