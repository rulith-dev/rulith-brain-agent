// Rulith Brain Agent's web search: dsh's web_search tool asks the search provider the profile selects, and the one dsh
// ships needs a paid API key of the user's. This one asks the search service the user chose - the same the Rulith
// Brain app's chat offers (tools/manager.py brain_web_search):
//   wikipedia  Wikipedia's own search interface: free, no account, no key (the default)
//   searxng    a SearXNG instance of the user's own, by its address (its JSON format switched on)
// Which one: RULITH_BRAIN_SEARCH; unset, the one set in the Rulith Brain app on this PC (its Settings); else Wikipedia.
// The address likewise: RULITH_BRAIN_SEARXNG_URL, else the app's. The search engines' result pages are not read:
// they answer a program off topic or with a verification page (measured 2026-11-19), and they are not theirs to give.
//
// Reading a page (web_fetch) is dsh's own and needs nothing. Both go through the system's proxy when the launcher
// found one (system-proxy.mjs).
import fs from 'node:fs';
import path from 'node:path';

export const name = 'rulith-brain-web';
/** dsh's web seam, where a search provider registers. */
export const inject = ['web'];
/** The id this provider registers under (the profile's web entry selects it: searchProvider). */
export const PROVIDER_ID = 'rulith-search';
export const SERVICES = Object.freeze(['wikipedia', 'searxng']);

const USER_AGENT = 'Mozilla/5.0 (compatible; RulithBrain/1.0; +https://rulith.ai/brain.html)';
const MAX_RESULTS = 8;
const CJK = /[㐀-䶿一-鿿]/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const plain = (markup) => String(markup ?? '').replace(/<[^>]*>/g, ' ')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  }).replace(/\s+/g, ' ').trim();

const failure = (message) => Object.assign(new Error(message), { code: 'WEB_PROVIDER_ERROR' });
const words = (query) => {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!q) throw failure('a search needs words to search for');
  return q;
};
const count = (limit) => Math.max(1, Math.min(MAX_RESULTS, Math.round(Number(limit)) || MAX_RESULTS));
const reached = (error) => error?.cause?.code ?? error?.message ?? String(error);
/** One result as dsh takes it; null for one without a title or a web address. */
const source = (title, url, snippet) => {
  const t = plain(title).slice(0, 200), s = plain(snippet).slice(0, 320);
  return t && /^https?:\/\//i.test(String(url ?? '')) ? { url: String(url), title: t, ...(s ? { snippet: s } : {}) } : null;
};

/**
 * What Wikipedia lists for the words: { sources: [{ url, title, snippet? }], truncated: false, content }.
 * A query in Chinese asks the Chinese edition first, then the English one; any other the English one.
 * @param fetch - the fetch to ask with (tests give their own).
 * @param limit - how many results at most (1..8).
 * @throws an Error with code WEB_PROVIDER_ERROR when no edition answered.
 */
export async function wikipediaSearch(query, { fetch: f = globalThis.fetch, signal, limit = MAX_RESULTS, editions } = {}) {
  const q = words(query);
  const n = count(limit);
  let last = null;
  for (const edition of editions ?? (CJK.test(q) ? ['zh', 'en'] : ['en'])) {
    const url = `https://${edition}.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', list: 'search', srsearch: q, srlimit: String(n), srprop: 'snippet', format: 'json' })}`;
    try {
      const r = await f(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal });
      if (!r.ok) { last = failure(`Wikipedia (${edition}) answered HTTP ${r.status}`); continue; }
      const found = (await r.json())?.query?.search;
      if (!Array.isArray(found)) { last = failure(`Wikipedia (${edition}) gave an answer that could not be read`); continue; }
      const sources = found.filter((x) => x?.title).map((x) => {
        const snippet = plain(x.snippet);
        return { url: `https://${edition}.wikipedia.org/wiki/${encodeURIComponent(String(x.title).replace(/ /g, '_'))}`, title: String(x.title), ...(snippet ? { snippet } : {}) };
      });
      if (sources.length) {
        return { sources, truncated: false,
          content: `These are Wikipedia articles (${edition}.wikipedia.org). Read one with web_fetch before relying on it; another site is read by its address.` };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      last = failure(`Wikipedia (${edition}) could not be reached: ${reached(error)}`);
    }
  }
  if (last) throw last;
  return { sources: [], truncated: false, content: 'Wikipedia has no article for these words. Try other words, or read a page by its address with web_fetch.' };
}

/**
 * What the user's SearXNG instance lists for the words.
 * @param base - the instance's address ("http://127.0.0.1:8080").
 * @throws an Error with code WEB_PROVIDER_ERROR: no address, an instance that does not answer in JSON, or no answer.
 */
export async function searxngSearch(query, { base, fetch: f = globalThis.fetch, signal, limit = MAX_RESULTS } = {}) {
  const q = words(query);
  const at = String(base ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#]+/i.test(at)) throw failure('the search needs the address of your SearXNG instance: enter it in Rulith Brain (Settings, Web search) or set RULITH_BRAIN_SEARXNG_URL');
  let r, j = null;
  try {
    r = await f(`${at}/search?${new URLSearchParams({ q, format: 'json', language: CJK.test(q) ? 'zh-CN' : 'en' })}`,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal });
    try { j = await r.json(); } catch { j = null; }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failure(`the search address could not be reached: ${reached(error)}`);
  }
  if (!Array.isArray(j?.results)) throw failure(`the search address answered HTTP ${r.status} without results${[403, 404].includes(r.status) ? ' (it must allow the JSON format)' : ''}`);
  const sources = j.results.map((x) => source(x?.title, x?.url, x?.content)).filter(Boolean).slice(0, count(limit));
  return { sources, truncated: false, content: sources.length
    ? 'These are web search results. Read one with web_fetch before relying on it.'
    : 'The search found nothing for these words. Try other words, or read a page by its address with web_fetch.' };
}

/** The search service set in the Rulith Brain app on this PC (its settings file), or {} - the agent only reads it. */
export function appSearchSettings(env = process.env) {
  const home = env.RULITH_BRAIN_APP_HOME || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Rulith', 'Brain') : '');
  if (!home) return {};
  try {
    const web = JSON.parse(fs.readFileSync(path.join(home, 'config', 'settings.json'), 'utf8'))?.brain_web;
    return web && typeof web === 'object' ? web : {};
  } catch { return {}; }
}

/**
 * Which search to ask: { service, searxngUrl }. The environment goes first (RULITH_BRAIN_SEARCH,
 * RULITH_BRAIN_SEARXNG_URL), then what is set in the Rulith Brain app, then Wikipedia. A service that is not one of
 * SERVICES is not followed.
 */
export function searchConfig(env = process.env, app = appSearchSettings(env)) {
  const named = [String(env.RULITH_BRAIN_SEARCH ?? '').trim().toLowerCase(), String(app.provider ?? '')].find((x) => SERVICES.includes(x));
  return { service: named ?? 'wikipedia', searxngUrl: String(env.RULITH_BRAIN_SEARXNG_URL || app.searxng_url || '').trim() };
}

/** dsh's search provider: { id, available(), search({ query, maxResults }, signal) }. Asked anew at every search,
 *  so a change made in the app is followed without a restart. */
export class SearchProvider {
  id = PROVIDER_ID;

  constructor({ fetch: f, config = searchConfig } = {}) { this.fetch = f; this.config = config; }

  available() { return true; }

  search(request, signal) {
    const c = this.config();
    const opts = { fetch: this.fetch, signal, limit: request?.maxResults };
    if (c.service === 'searxng') return searxngSearch(request?.query, { ...opts, base: c.searxngUrl });
    return wikipediaSearch(request?.query, opts);
  }
}

/** Registers the provider with dsh's web service. */
export function apply(ctx) {
  ctx.web.registerSearchProvider(new SearchProvider());
}
