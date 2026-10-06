// Talking to a VME Manager.
//
// Read-only by construction: `vmeGet` refuses any path outside a fixed
// allow-list, and the only non-GET request ever sent is the OAuth password
// grant that turns a username/password into a bearer token (the documented
// login, POST /oauth/token?client_id=morph-api). Tokens are cached in memory
// only. Self-signed Manager certificates are common on a fresh VME install,
// so TLS verification can be switched off per connection — and it is reported
// back so the UI can say so.

import http from 'http';
import https from 'https';
import { URL } from 'url';
import type { VmeConnection } from './store.js';
import type { RawVme } from './model.js';

/** The only API paths Trinetra will ever GET from a Manager. */
export const ALLOWED_PATHS = [
  '/api/whoami', '/api/servers', '/api/instances', '/api/clusters', '/api/datastores',
  '/api/networks', '/api/health', '/api/health/alarms', '/api/health/logs', '/api/activity',
  '/api/license', '/api/zones', '/api/groups', '/api/subnets', '/api/networks/pools', '/api/security-groups',
  '/api/virtual-switches', '/api/storage-servers', '/api/storage-volumes', '/api/virtual-images',
  '/api/service-plans', '/api/backups', '/api/backups/jobs', '/api/backups/results',
  '/api/monitoring/checks', '/api/monitoring/incidents', '/api/power-schedules',
] as const;

/**
 * Keys whose values never leave this server, at any depth. The Manager returns
 * some of these on ordinary objects (servers carry `sshPassword`, `apiKey`;
 * images carry `sshPassword`, `userData`), and the Explorer shows raw objects.
 */
const SECRET_KEY = /password|passwd|passphrase|secret|token|api[-_]?key|private[-_]?key|ssh[-_]?key|hash$|cypher|credential|access[-_]?key|serviceaccess|user[-_]?data|cert(ificate)?[-_]?(key|data)/i;

export function sanitize(v: any, depth = 0): any {
  if (depth > 12) return '[deep]';
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = SECRET_KEY.test(k) && x !== null && x !== undefined && x !== '' && typeof x !== 'boolean' ? '<redacted>' : sanitize(x, depth + 1);
    }
    return out;
  }
  return v;
}
export type AllowedPath = (typeof ALLOWED_PATHS)[number];

const TIMEOUT_MS = 30_000;
const PAGE = 100;
const MAX_ITEMS = 5000;

interface Resp { status: number; body: string }

function request(conn: Pick<VmeConnection, 'url' | 'insecureTls'>, method: 'GET' | 'POST', pathAndQuery: string, headers: Record<string, string>, body?: string): Promise<Resp> {
  const u = new URL(pathAndQuery, conn.url.replace(/\/+$/, '') + '/');
  const lib = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method,
      headers: { Accept: 'application/json', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}) },
      timeout: TIMEOUT_MS,
      ...(u.protocol === 'https:' ? { rejectUnauthorized: !conn.insecureTls } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 64 * 1024 * 1024) { req.destroy(new Error('Response larger than 64 MB')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`No answer from the Manager within ${TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A sentence a person can act on, from a Node network/TLS error. */
export function friendlyError(e: any): string {
  const m = String(e?.message || e);
  if (/self[- ]signed|unable to verify|UNABLE_TO_GET_ISSUER|CERT_|certificate/i.test(m)) return `TLS: ${m}. The Manager uses a certificate this machine does not trust — tick "Skip TLS verification" for this connection, or add its CA.`;
  if (/ECONNREFUSED/.test(m)) return 'Connection refused — nothing is listening at that URL/port.';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Host name not found — check the Manager URL.';
  if (/ETIMEDOUT|No answer/.test(m)) return 'Timed out — the Manager is unreachable from here (firewall, or only reachable via a jump host).';
  return m;
}

// Bearer tokens obtained from a password login, per connection.
const tokenCache = new Map<string, { token: string; until: number }>();

async function tokenFor(conn: VmeConnection): Promise<string> {
  if (conn.token) return conn.token;
  const cached = tokenCache.get(conn.name);
  if (cached && cached.until > Date.now()) return cached.token;
  if (!conn.username || !conn.password) throw new Error('No API token and no username/password for this connection.');
  const body = new URLSearchParams({ username: conn.username, password: conn.password }).toString();
  const r = await request(conn, 'POST', '/oauth/token?client_id=morph-api&grant_type=password&scope=write',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  let j: any;
  try { j = JSON.parse(r.body); } catch { /* not JSON */ }
  if (r.status !== 200 || !j?.access_token) {
    throw new Error(r.status === 400 || r.status === 401 ? 'Login rejected — check the username and password.' : `Login failed (HTTP ${r.status}).`);
  }
  // Refresh a minute early; Morpheus tokens are long-lived, so this rarely matters.
  tokenCache.set(conn.name, { token: j.access_token, until: Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 60) * 1000 });
  return j.access_token;
}

export function forgetToken(name: string): void { tokenCache.delete(name); }

/** One GET on an allow-listed path. Throws with a readable message. */
export async function vmeGet(conn: VmeConnection, path: AllowedPath, query: Record<string, string | number> = {}): Promise<any> {
  if (!(ALLOWED_PATHS as readonly string[]).includes(path)) throw new Error(`Path ${path} is not on the read-only allow-list.`);
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString();
  const go = async () => request(conn, 'GET', `${path}${qs ? `?${qs}` : ''}`, { Authorization: `Bearer ${await tokenFor(conn)}` });
  let r = await go();
  if (r.status === 401 && !conn.token) { forgetToken(conn.name); r = await go(); } // stale cached token
  if (r.status === 401) throw new Error('The Manager rejected the API token (401).');
  if (r.status === 403) throw new Error('This user is not allowed to read this (403) — give it a role with read access.');
  if (r.status === 404) throw new Error('Not available on this Manager version (404).');
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
  try { return JSON.parse(r.body); } catch { throw new Error('The Manager answered with something that is not JSON — is the URL the Manager itself?'); }
}

/** Page through a list endpoint (`max` / `offset` / `meta.total`). */
export async function vmeList(conn: VmeConnection, path: AllowedPath, key: string, query: Record<string, string | number> = {}): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < MAX_ITEMS; offset += PAGE) {
    const j = await vmeGet(conn, path, { ...query, max: PAGE, offset });
    const items: any[] = Array.isArray(j?.[key]) ? j[key] : [];
    out.push(...items);
    const total = Number(j?.meta?.total);
    if (!items.length || items.length < PAGE || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}

/** What one fetch covers: name in RawVme, how to get it. */
type Job = [keyof RawVme, () => Promise<any>];

/**
 * Everything the page needs, each endpoint independently: a Manager version
 * without /api/datastores (or a user without rights to backups) still gives
 * hosts and VMs. Six requests at a time — enough to be quick, few enough not
 * to load the Manager. Returns per-source status.
 */
export async function fetchAll(conn: VmeConnection): Promise<{ raw: RawVme; sources: Record<string, { ok: boolean; count?: number; error?: string }> }> {
  const sources: Record<string, { ok: boolean; count?: number; error?: string }> = {};
  const raw: RawVme = {};
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const one = (path: AllowedPath, key: string, q: Record<string, string | number> = {}) => async () => (await vmeGet(conn, path, { max: 200, ...q }))?.[key] ?? [];
  const jobs: Job[] = [
    ['whoami', () => vmeGet(conn, '/api/whoami')],
    ['servers', () => vmeList(conn, '/api/servers', 'servers')],
    ['instances', () => vmeList(conn, '/api/instances', 'instances')],
    ['clusters', () => vmeList(conn, '/api/clusters', 'clusters')],
    ['datastores', () => vmeList(conn, '/api/datastores', 'datastores')],
    ['networks', () => vmeList(conn, '/api/networks', 'networks')],
    ['alarms', one('/api/health/alarms', 'alarms')],
    ['activity', one('/api/activity', 'activity', { startDate: since })],
    ['health', async () => (await vmeGet(conn, '/api/health'))?.health ?? null],
    ['logs', one('/api/health/logs', 'logs', { startDate: since })],
    ['license', async () => (await vmeGet(conn, '/api/license'))?.license ?? null],
    ['zones', () => vmeList(conn, '/api/zones', 'zones')],
    ['groups', () => vmeList(conn, '/api/groups', 'groups')],
    ['subnets', () => vmeList(conn, '/api/subnets', 'subnets')],
    ['ipPools', () => vmeList(conn, '/api/networks/pools', 'networkPools')],
    ['securityGroups', () => vmeList(conn, '/api/security-groups', 'securityGroups')],
    ['storageServers', () => vmeList(conn, '/api/storage-servers', 'storageServers')],
    ['storageVolumes', () => vmeList(conn, '/api/storage-volumes', 'storageVolumes')],
    ['images', () => vmeList(conn, '/api/virtual-images', 'virtualImages')],
    ['plans', () => vmeList(conn, '/api/service-plans', 'servicePlans')],
    ['backups', () => vmeList(conn, '/api/backups', 'backups')],
    ['backupJobs', () => vmeList(conn, '/api/backups/jobs', 'jobs')],
    ['backupResults', one('/api/backups/results', 'results')],
    ['checks', () => vmeList(conn, '/api/monitoring/checks', 'checks')],
    ['incidents', one('/api/monitoring/incidents', 'incidents', { status: 'open' })],
    ['powerSchedules', () => vmeList(conn, '/api/power-schedules', 'schedules')],
  ];
  // Login once before fanning out, so a bad password is one clear error, not twenty.
  try { await tokenFor(conn); } catch (e: any) {
    const error = friendlyError(e);
    for (const [k] of jobs) sources[k] = { ok: false, error };
    return { raw, sources };
  }
  const run = async ([k, fn]: Job) => {
    try {
      const v = await fn();
      (raw as any)[k] = v;
      sources[k] = { ok: true, count: Array.isArray(v) ? v.length : undefined };
    } catch (e: any) {
      sources[k] = { ok: false, error: friendlyError(e) };
    }
  };
  await pool(jobs, 6, run);

  // Virtual switches are listed per hypervisor cluster (clusterId is required).
  const hvClusters = (raw.clusters || []).filter((c: any) => !/kubernetes|docker/i.test(`${c?.type?.name || ''} ${c?.type?.code || ''}`));
  if (hvClusters.length) {
    const all: any[] = [];
    const errors: string[] = [];
    await pool(hvClusters, 6, async (c: any) => {
      try {
        const j = await vmeGet(conn, '/api/virtual-switches', { clusterId: c.id });
        for (const sw of j?.virtualSwitches || []) all.push({ ...sw, clusterId: sw.clusterId ?? c.id });
      } catch (e: any) { errors.push(friendlyError(e)); }
    });
    raw.virtualSwitches = all;
    sources.virtualSwitches = errors.length === hvClusters.length ? { ok: false, error: errors[0] } : { ok: true, count: all.length };
  }
  return { raw, sources };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}
