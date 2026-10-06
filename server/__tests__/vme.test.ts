// VME integration: normalizing Manager responses, joining VMs to Kubernetes
// nodes, the findings, capacity / N+1, topology, the connection store's
// secret handling, and the HTTP client against a real local server (token,
// password login, paging, allow-list).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { normalize, joinKubernetes, k8sNodesFrom, vmeFindings, capacity, topology, isHost, ipsOf, type VmeSnapshot } from '../vme/model.js';
import { vmeGet, vmeList, fetchAll } from '../vme/client.js';
import { validateConnection, publicConnection, type VmeConnection } from '../vme/store.js';
import { buildView } from '../vme/router.js';
import { demoRaw } from '../vme/demo.js';

const GiB = 1024 ** 3;
const NOW = Date.parse('2026-10-07T12:00:00Z');

const host = (id: number, name: string, memUsed: number, extra: any = {}) => ({
  id, name, powerState: 'on', status: 'provisioned', maxCores: 32, externalIp: `10.0.0.${id}`,
  computeServerType: { code: 'mvmHypervisor', name: 'HPE VM Hypervisor', vmHypervisor: true },
  stats: { maxMemory: 256 * GiB, usedMemory: memUsed * GiB, cpuUsage: 20, maxStorage: 1000 * GiB, usedStorage: 100 * GiB },
  lastAgentUpdate: new Date(NOW - 60_000).toISOString(), ...extra,
});
const vm = (id: number, name: string, hostId: number, ip: string, extra: any = {}) => ({
  id, name, hostname: name, powerState: 'on', status: 'provisioned', parentServer: { id: hostId, name: `h${hostId}` }, maxCores: 8, maxMemory: 32 * GiB,
  computeServerType: { code: 'mvmvm', name: 'HPE VM' }, interfaces: [{ ipAddress: ip }],
  stats: { maxMemory: 32 * GiB, usedMemory: 16 * GiB, cpuUsage: 10 }, ...extra,
});

const RAW = {
  whoami: { user: { username: 'ro' }, appliance: { buildVersion: '8.0.5' } },
  clusters: [
    { id: 1, name: 'hvm', type: { name: 'HPE VM Cluster' }, status: 'ok', servers: [{ id: 10 }, { id: 11 }] },
    { id: 2, name: 'k8s', type: { name: 'Kubernetes Cluster' }, status: 'ok', servers: [{ id: 20 }] },
  ],
  servers: [
    host(10, 'h10', 235), host(11, 'h11', 60),
    vm(20, 'cp-1', 10, '10.1.0.1'), vm(21, 'cp-2', 10, '10.1.0.2'), vm(22, 'worker-1', 11, '10.1.0.3', { powerState: 'off', status: 'stopped' }),
    vm(23, 'App01', 11, '10.1.0.9'),
  ],
  instances: [{ id: 500, name: 'cp-1-inst', servers: [20], connectionInfo: [{ ip: '192.168.5.5' }] }],
  datastores: [
    { id: 1, name: 'ds-full', storageSize: 1000 * GiB, freeSpace: 120 * GiB, active: true, online: true, refType: 'ComputeServerGroup', refId: 1, datastoreType: { name: 'GFS2' } },
    { id: 2, name: 'ds-gone', storageSize: 100 * GiB, freeSpace: 90 * GiB, active: true, online: false },
  ],
  networks: [{ id: 1, name: 'mgmt', type: { name: 'VLAN' }, cidr: '10.0.0.0/24', vlanId: 10 }],
  alarms: [{ id: 1, name: 'disk', severity: 'critical', status: 'open' }, { id: 2, name: 'old', severity: 'warning', acknowledged: true }],
  activity: [{ _id: 'x', success: true, name: 'Reconfigure', message: 'cp-1 resized', objectType: 'Instance', objectId: 500, userName: 'ops', ts: new Date(NOW - 10 * 60_000).toISOString() }],
};

const k8s = k8sNodesFrom({ items: [
  { metadata: { name: 'cp-1', labels: { 'node-role.kubernetes.io/control-plane': '' } }, status: { addresses: [{ address: '10.1.0.1' }], conditions: [{ type: 'Ready', status: 'True' }] } },
  { metadata: { name: 'cp-2.cluster.local', labels: { 'node-role.kubernetes.io/control-plane': '' } }, status: { addresses: [{ address: '172.16.0.2' }], conditions: [{ type: 'Ready', status: 'True' }] } },
  { metadata: { name: 'worker-1', labels: {} }, status: { addresses: [{ address: '10.1.0.3' }], capacity: { 'nvidia.com/gpu': '2' }, conditions: [{ type: 'Ready', status: 'False' }] } },
  { metadata: { name: 'metal-9', labels: {} }, status: { addresses: [{ address: '10.9.9.9' }], conditions: [{ type: 'Ready', status: 'True' }] } },
] }, 'cp-1\ncp-1\nworker-1\n');

describe('normalize', () => {
  const n = normalize(RAW as any, 'm1');

  it('tells hosts from VMs and places VMs on hosts and clusters', () => {
    expect(n.hosts.map((h) => h.name)).toEqual(['h10', 'h11']);
    expect(n.vms.map((v) => v.name)).toEqual(['cp-1', 'cp-2', 'worker-1', 'App01']);
    expect(n.hosts[0]).toMatchObject({ cluster: 'hvm', vmIds: [20, 21], memUsed: 235 * GiB });
    expect(n.vms[0]).toMatchObject({ host: 'h10', cluster: 'hvm', instance: 'cp-1-inst' });
    expect(n.vms[0].ips).toEqual(['10.1.0.1', '192.168.5.5']);
  });

  it('does not treat a Kubernetes cluster record as a hypervisor cluster', () => {
    expect(n.vms.find((v) => v.id === 20)?.cluster).toBe('hvm');
  });

  it('normalizes storage, networks, alarms, activity and the Manager identity', () => {
    expect(n.datastores[0]).toMatchObject({ name: 'ds-full', clusterId: 1, type: 'GFS2', total: 1000 * GiB, free: 120 * GiB });
    expect(n.networks[0]).toMatchObject({ name: 'mgmt', vlan: 10, cidr: '10.0.0.0/24' });
    expect(n.alarms.map((a) => [a.severity, a.acknowledged])).toEqual([['critical', false], ['warning', true]]);
    expect(n.activity[0]).toMatchObject({ user: 'ops', objectId: 500 });
    expect(n.manager).toMatchObject({ user: 'ro', version: '8.0.5' });
  });

  it('isHost and ipsOf cover the fallbacks', () => {
    expect(isHost({ id: 1, computeServerType: { name: 'KVM Host' } }, new Set(), new Set())).toBe(true);
    expect(isHost({ id: 1, parentServer: { id: 2 }, computeServerType: { name: 'KVM Host' } }, new Set(), new Set())).toBe(false);
    expect(isHost({ id: 7 }, new Set([7]), new Set())).toBe(true);
    expect(ipsOf({ externalIp: '1.1.1.1', internalIp: '1.1.1.1', interfaces: [{ ipAddress: '2.2.2.2' }] })).toEqual(['1.1.1.1', '2.2.2.2']);
  });
});

describe('joinKubernetes', () => {
  it('matches by IP first, then by short name; reports the rest', () => {
    const n = normalize(RAW as any, 'm1');
    const unmatched = joinKubernetes(n.vms, k8s);
    expect(n.vms.find((v) => v.name === 'cp-1')?.k8sNode).toBe('cp-1');
    expect(n.vms.find((v) => v.name === 'cp-2')?.k8sNode).toBe('cp-2.cluster.local');
    expect(n.vms.find((v) => v.name === 'worker-1')?.k8sNode).toBe('worker-1');
    expect(unmatched).toEqual(['metal-9']);
    expect(k8s[0]).toMatchObject({ roles: ['control-plane'], pods: 2, ready: true });
    expect(k8s[2]).toMatchObject({ gpus: 2, ready: false });
  });
});

describe('findings, capacity, topology', () => {
  const v = buildView(normalize(RAW as any, 'm1'), {}, { source: 'local', nodes: k8s }, NOW);
  const ids = v.findings.map((f) => f.id);

  it('connects the layers: host saturation under Kubernetes nodes, powered-off node VMs, colocated control planes', () => {
    expect(v.findings.find((f) => f.id === 'host-mem:10')).toMatchObject({ severity: 'warning', title: 'Host h10 memory at 92%' });
    expect(ids).toContain('k8s-hot-host:20');
    expect(v.findings.find((f) => f.id === 'k8s-vm-off:22')).toMatchObject({ severity: 'critical' });
    expect(ids).toContain('k8s-cp-colocated:10');
    expect(ids).not.toContain('k8s-notready:22'); // off, so the off finding says it already
  });

  it('flags storage, open alarms only, recent changes to node VMs, and unmatched nodes', () => {
    expect(v.findings.find((f) => f.id === 'ds-full:1')).toMatchObject({ severity: 'warning', title: 'Datastore ds-full is 88% full' });
    expect(v.findings.find((f) => f.id === 'ds-offline:2')?.severity).toBe('critical');
    expect(ids).toContain('alarm:1');
    expect(ids).not.toContain('alarm:2');
    expect(v.findings.find((f) => f.id === 'change:x')?.title).toMatch(/Reconfigure on cp-1 \(Kubernetes node cp-1\) 10 min ago/);
    expect(ids).toContain('k8s-unmatched:metal-9');
  });

  it('orders critical first', () => {
    expect(v.findings[0].severity).toBe('critical');
  });

  it('computes cluster capacity and N+1', () => {
    expect(v.capacity).toHaveLength(1);
    expect(v.capacity[0]).toMatchObject({ name: 'hvm', hosts: 2, vms: 3, biggestHost: 'h10', survivesHostLoss: false });
    expect(ids).toContain('nplus1:1');
  });

  it('lays out manager → cluster → host → VM → Kubernetes node, plus datastores', () => {
    const kinds = v.topology.nodes.reduce<Record<string, number>>((a, n) => ({ ...a, [n.kind]: (a[n.kind] || 0) + 1 }), {});
    expect(kinds).toEqual({ manager: 1, cluster: 1, host: 2, vm: 4, k8s: 3, datastore: 2 });
    expect(v.topology.edges).toContainEqual({ from: 'vm:20', to: 'k8s:cp-1', kind: 'is' });
    expect(v.topology.nodes.find((n) => n.id === 'vm:22')?.level).toBe('off');
    expect(v.topology.nodes.find((n) => n.id === 'host:10')?.level).toBe('warning');
    expect(v.topology.nodes.find((n) => n.id === 'k8s:worker-1')?.level).toBe('critical');
  });
});

describe('demo estate', () => {
  it('runs through the same pipeline and trips every seeded problem', () => {
    const { raw, k8sNodes, podNodes } = demoRaw(NOW);
    const v = buildView(normalize(raw, 'demo'), {}, { source: 'demo', nodes: k8sNodesFrom(k8sNodes, podNodes) }, NOW);
    const areas = new Set(v.findings.map((f) => f.area));
    for (const a of ['host', 'kubernetes', 'storage', 'alarm', 'capacity', 'change']) expect(areas).toContain(a);
    expect(v.snapshot.k8s?.unmatched).toEqual(['pcai-baremetal-gpu-9']);
  });
});

describe('connection store', () => {
  it('validates, keeps secrets on edit, switches login method cleanly, and never exposes secrets', () => {
    expect(validateConnection({ name: 'bad name', url: 'https://x' })).toMatch(/Name/);
    expect(validateConnection({ name: 'a', url: 'ftp://x', token: 't' })).toMatch(/https/);
    expect(validateConnection({ name: 'a', url: 'https://x' })).toMatch(/token/);
    const c = validateConnection({ name: 'a', url: 'https://vme.example.com/', token: 'T' }) as VmeConnection;
    expect(c.url).toBe('https://vme.example.com');
    const kept = validateConnection({ name: 'a', url: 'https://vme.example.com', token: '' }, c) as VmeConnection;
    expect(kept.token).toBe('T');
    const switched = validateConnection({ name: 'a', url: 'https://vme.example.com', auth: 'password', username: 'u', password: 'p' }, c) as VmeConnection;
    expect(switched.token).toBeUndefined();
    const pub = publicConnection(c) as any;
    expect(pub.token).toBeUndefined();
    expect(pub.hasToken).toBe(true);
  });
});

describe('client against a local Manager', () => {
  let server: http.Server;
  let url: string;
  const seen: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/oauth/token') {
        let body = '';
        req.on('data', (d) => (body += d)).on('end', () => {
          const f = new URLSearchParams(body);
          if (f.get('username') === 'ro' && f.get('password') === 'pw') { res.end(JSON.stringify({ access_token: 'FROM-LOGIN', expires_in: 3600 })); return; }
          res.statusCode = 400; res.end('{"error":"invalid_grant"}');
        });
        return;
      }
      const auth = req.headers.authorization;
      if (auth !== 'Bearer TOKEN' && auth !== 'Bearer FROM-LOGIN') { res.statusCode = 401; res.end('{}'); return; }
      if (u.pathname === '/api/whoami') { res.end(JSON.stringify({ user: { username: 'ro' } })); return; }
      if (u.pathname === '/api/servers') {
        const offset = Number(u.searchParams.get('offset')), max = Number(u.searchParams.get('max'));
        const all = Array.from({ length: 230 }, (_, i) => ({ id: i }));
        res.end(JSON.stringify({ servers: all.slice(offset, offset + max), meta: { total: all.length } }));
        return;
      }
      if (u.pathname === '/api/datastores') { res.statusCode = 404; res.end('{}'); return; }
      res.end(JSON.stringify({ instances: [], clusters: [], networks: [], alarms: [], activity: [], meta: { total: 0 } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('uses the token, pages through lists, and refuses paths off the allow-list', async () => {
    const conn = { name: 't', url, token: 'TOKEN' };
    expect((await vmeGet(conn, '/api/whoami')).user.username).toBe('ro');
    expect(await vmeList(conn, '/api/servers', 'servers')).toHaveLength(230);
    await expect(vmeGet(conn, '/api/servers/1/stop' as any)).rejects.toThrow(/allow-list/);
    expect(seen.filter((s) => s.startsWith('GET /api/servers')).length).toBe(3);
  });

  it('logs in with a password, and reports a bad one clearly', async () => {
    expect((await vmeGet({ name: 'p', url, username: 'ro', password: 'pw' }, '/api/whoami')).user.username).toBe('ro');
    await expect(vmeGet({ name: 'q', url, username: 'ro', password: 'nope' }, '/api/whoami')).rejects.toThrow(/Login rejected/);
  });

  it('degrades per endpoint: a missing API does not blank the rest', async () => {
    const { sources } = await fetchAll({ name: 't2', url, token: 'TOKEN' });
    expect(sources.servers).toMatchObject({ ok: true, count: 230 });
    expect(sources.datastores).toMatchObject({ ok: false, error: expect.stringMatching(/404/) });
    // Read-only: nothing but GETs (and no login when a token is given).
    expect(seen.every((s) => s.startsWith('GET ') || s.startsWith('POST /oauth/token'))).toBe(true);
  });

  it('says why a bad token fails', async () => {
    const { sources } = await fetchAll({ name: 't3', url, token: 'WRONG' });
    expect(sources.whoami.error).toMatch(/rejected the API token/);
  });
});

// Type-level guard: the snapshot shape stays what the page expects.
const _typecheck: Partial<VmeSnapshot> = { connection: 'x' };
void _typecheck;

describe('everything else the Manager exposes', () => {
  it('sanitize blanks secrets at any depth but keeps look-alike fields', async () => {
    const { sanitize } = await import('../vme/client.js');
    const out = sanitize({ name: 'vm', sshPassword: 'pw', apiKey: 'k', config: { cloudInit: { userData: '#cloud-config', sshKey: 'ssh-rsa' } }, gpuPassthrough: true, passwordHash: null, tokens: [{ token: 'x' }] });
    expect(out).toEqual({ name: 'vm', sshPassword: '<redacted>', apiKey: '<redacted>', config: { cloudInit: { userData: '<redacted>', sshKey: '<redacted>' } }, gpuPassthrough: true, passwordHash: null, tokens: '<redacted>' });
  });

  it('normalizes health, license, logs, networking, storage, catalog, backups and monitoring', () => {
    const { raw } = demoRaw(NOW);
    const n = normalize(raw, 'demo');
    expect(n.health).toMatchObject({ overall: 'warning', version: '8.0.5', memory: { status: 'warning' } });
    expect(n.health?.memory?.systemPct).toBeCloseTo(91);
    expect(n.license).toMatchObject({ tier: 'HPE VM Essentials', maxMvm: 5, hardLimit: true });
    expect(n.logs[0].level).toBe('ERROR');
    expect(n.switches.find((w) => w.name === 'vs-storage')).toMatchObject({ nics: 1, mtu: 9000, clusterId: 11 });
    expect(n.ipPools[0]).toMatchObject({ total: 40, free: 3, ranges: ['10.10.1.10–10.10.1.49'] });
    expect(n.volumes.length).toBeGreaterThan(14);
    expect(n.backupResults[0]).toMatchObject({ status: 'FAILED' });
    expect(n.incidents[0]).toMatchObject({ severity: 'warning', status: 'open' });
    const vm = n.vms.find((v) => v.name === 'pcai-gpu-1')!;
    expect(vm.disks.map((d) => d.datastore)).toEqual(['pcai-gfs2-01', 'pcai-nfs-models']);
    expect(vm.nics[0]).toMatchObject({ ip: '10.10.1.31', network: 'pcai-nodes (VLAN 20)', primary: true });
    expect(vm.agent.installed).toBe(true);
    expect(vm.tags).toContain('env=pcai');
  });

  it('judges the Manager, license, IP pools, switches, backups and monitoring', () => {
    const { raw, k8sNodes, podNodes } = demoRaw(NOW);
    const v = buildView(normalize(raw, 'demo'), {}, { source: 'demo', nodes: k8sNodesFrom(k8sNodes, podNodes) }, NOW, raw);
    const ids = v.findings.map((f) => f.id);
    for (const id of ['mgr-health', 'mgr-mem', 'license-expiry', 'license-hosts', 'mgr-logs', 'pool:801', 'switch-nic:14', 'backup-fail', 'backup-none', 'incident:1801', 'checks']) expect(ids).toContain(id);
    expect(ids).not.toContain('backup:1402'); // already reported as a recent failed run
    expect(v.topology.nodes.filter((n) => n.kind === 'switch')).toHaveLength(4);
    // Raw objects ride along for the Explorer, secrets removed.
    expect(JSON.stringify(v.snapshot.raw)).not.toMatch(/"sshPassword":"[^<]/);
    expect(v.snapshot.raw?.servers).toHaveLength(19);
  });
});
