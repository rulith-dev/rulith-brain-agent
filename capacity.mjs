import fs from 'node:fs';
import path from 'node:path';
import { brainHome } from './tools/connection.mjs';

// Capacity belongs to the machine running Brain.
export function localCapacity(server, env = process.env) {
  const url = new URL(server);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
  const home = env.RULITH_BRAIN_HOME || env.RULITH_BRAIN_APP_HOME || brainHome(env);
  if (!home) return null;
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(path.join(home, 'config', 'brain', file), 'utf8')); }
    catch { return null; }
  };
  const raw = read('device.json')?.device_max;
  const device = Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  const cache = read('licence.json');
  const lic = cache?.status;
  let valid = false;
  try {
    const file = fs.statSync(path.join(home, 'licence.txt'), { bigint: true });
    const stamp = cache.key[3];
    valid = lic?.ok === true && Number(file.mtimeNs) === stamp[0] && Number(file.size) === stamp[1]
      && (!lic.expires || lic.expires > Date.now() / 1000);
  } catch { /* licence has not been checked, or changed since the check */ }
  const tier = valid && lic.kind === 'trial' ? 'trial' : valid && lic.kind === 'paid'
    && ['10M', '50M', '200M', 'unlimited'].includes(lic.tier) ? lic.tier : null;
  return { device, tier };
}

export function capacityText(info, zh) {
  const device = info?.device;
  const amount = device >= 1e6 ? `${Number((device / 1e6).toFixed(2))}M` : String(device);
  const estimate = device ? (zh ? `本机记忆容量约 ${amount} token` : `Device estimate: ${amount} tokens`)
    : zh ? '设备容量尚无估算' : 'Device estimate unavailable';
  const tier = info?.tier;
  const plan = tier === 'trial' ? (zh ? '试用上限 10M token' : 'Trial limit: 10M tokens')
    : tier === 'unlimited' ? (zh ? '许可无容量上限' : 'No licence limit')
    : tier ? (zh ? `许可上限 ${tier} token` : `Licence limit: ${tier} tokens`) : '';
  return [estimate, plan].filter(Boolean).join(' · ');
}

// What a memory may hold on this computer, for the page's context meter: the licence's size (a trial: 10M), no more
// than the device's estimate. null when the licence is not known here (a Brain elsewhere, none checked yet) or has no
// limit and the device has no estimate: the caller keeps its own large figure then.
const PLAN_TOKENS = { trial: 10e6, '10M': 10e6, '50M': 50e6, '200M': 200e6 };
export function capacityLimit(info) {
  const plan = PLAN_TOKENS[info?.tier] ?? null;
  if (plan === null && info?.tier !== 'unlimited') return null;
  const bounds = [plan, info?.device].filter((v) => Number.isFinite(v) && v > 0);
  return bounds.length ? Math.min(...bounds) : null;
}
