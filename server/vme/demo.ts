// Demo data for the VME page — so it can be seen, tested and demoed without a
// Manager. Shaped exactly like Morpheus API responses (field names from HPE's
// OpenAPI examples) and run through the SAME normalize/join/judge code as a
// real connection; nothing about the UI is special-cased for it. Every
// response built from it carries `demo: true`, and the UI labels it.
//
// The scenario is a PCAI-style estate on two hypervisor clusters, seeded with
// the problems the findings exist to catch: a saturated host under a
// Kubernetes node, two control-plane VMs on one host, a powered-off worker, a
// nearly full datastore, a silent host agent, an open alarm and a migration
// twenty minutes ago.

import type { RawVme } from './model.js';

const GiB = 1024 ** 3;
const ago = (now: number, min: number) => new Date(now - min * 60_000).toISOString();

export function demoRaw(now = Date.now()): { raw: RawVme; k8sNodes: any; podNodes: string } {
  const hosts = [
    { id: 101, name: 'hvm-a-01', ip: '10.10.0.11', cores: 64, mem: 512, memUsed: 0.96, cpu: 71, cluster: 11, agentMin: 1 },
    { id: 102, name: 'hvm-a-02', ip: '10.10.0.12', cores: 64, mem: 512, memUsed: 0.58, cpu: 34, cluster: 11, agentMin: 1 },
    { id: 103, name: 'hvm-a-03', ip: '10.10.0.13', cores: 64, mem: 512, memUsed: 0.41, cpu: 22, cluster: 11, agentMin: 42 },
    { id: 201, name: 'hvm-edge-01', ip: '10.20.0.11', cores: 32, mem: 256, memUsed: 0.62, cpu: 40, cluster: 12, agentMin: 2 },
    { id: 202, name: 'hvm-edge-02', ip: '10.20.0.12', cores: 32, mem: 256, memUsed: 0.55, cpu: 31, cluster: 12, agentMin: 2 },
  ];
  const hostServer = (h: (typeof hosts)[number]) => ({
    id: h.id, name: h.name, hostname: h.name, externalIp: h.ip, internalIp: h.ip, status: 'provisioned', powerState: 'on',
    computeServerType: { id: 300, code: 'mvmHypervisor', name: 'HPE VM Hypervisor', vmHypervisor: true, managed: true },
    zone: { id: 1, name: 'pcai-cloud' }, maxCores: h.cores, maxMemory: h.mem * GiB, maxStorage: 3840 * GiB,
    stats: { ts: ago(now, h.agentMin), maxMemory: h.mem * GiB, usedMemory: Math.round(h.memUsed * h.mem * GiB), maxStorage: 3840 * GiB, usedStorage: 1900 * GiB, cpuUsage: h.cpu },
    serverOs: { name: 'Ubuntu 22.04' }, lastAgentUpdate: ago(now, h.agentMin), agentInstalled: true, agentVersion: '8.0.5', guestAgentStatus: 'ok',
    dateCreated: ago(now, 400 * 24 * 60), owner: { username: 'vme-admin' }, tags: [{ name: 'rack', value: h.cluster === 11 ? 'R12' : 'E02' }],
    interfaces: [
      { name: 'eno1', ipAddress: h.ip, macAddress: `3c:ec:ef:00:${h.id.toString(16).padStart(2, '0')}:01`, primaryInterface: true, network: { name: 'mgmt (VLAN 10)' }, type: { name: 'bond0 member' } },
      { name: 'eno2', macAddress: `3c:ec:ef:00:${h.id.toString(16).padStart(2, '0')}:02`, primaryInterface: false, network: { name: 'pcai-nodes (VLAN 20)' }, type: { name: 'bond0 member' } },
    ],
    volumes: [{ name: 'boot', maxStorage: 480 * GiB, rootVolume: true }, { name: 'local-nvme', maxStorage: 3360 * GiB, rootVolume: false }],
  });

  // [id, name, host, ip, vcpu, memGiB, gpus, power, cpu%, mem%]
  const vmRows: Array<[number, string, number, string, number, number, number, string, number, number]> = [
    [1001, 'pcai-cp-1', 101, '10.10.1.11', 8, 32, 0, 'on', 38, 71],
    [1002, 'pcai-cp-2', 101, '10.10.1.12', 8, 32, 0, 'on', 35, 69],
    [1003, 'pcai-cp-3', 102, '10.10.1.13', 8, 32, 0, 'on', 30, 64],
    [1011, 'pcai-worker-1', 101, '10.10.1.21', 32, 128, 0, 'on', 82, 88],
    [1012, 'pcai-worker-2', 102, '10.10.1.22', 32, 128, 0, 'on', 55, 61],
    [1013, 'pcai-worker-3', 103, '10.10.1.23', 32, 128, 0, 'off', 0, 0],
    [1021, 'pcai-gpu-1', 102, '10.10.1.31', 48, 192, 2, 'on', 64, 77],
    [1022, 'pcai-gpu-2', 103, '10.10.1.32', 48, 192, 2, 'on', 12, 70],
    [1031, 'dsc-jump', 103, '10.10.1.5', 4, 8, 0, 'on', 4, 30],
    [1032, 'ezua-proxy', 102, '10.10.1.6', 4, 16, 0, 'on', 9, 44],
    [2001, 'edge-gw-1', 201, '10.20.1.11', 8, 32, 0, 'on', 41, 52],
    [2002, 'edge-gw-2', 202, '10.20.1.12', 8, 32, 0, 'on', 39, 50],
    [2003, 'edge-cache', 201, '10.20.1.21', 16, 64, 0, 'on', 22, 61],
    [2004, 'build-runner', 202, '10.20.1.31', 16, 64, 0, 'on', 93, 58],
  ];
  const hostName = new Map(hosts.map((h) => [h.id, h.name]));
  const vmServers = vmRows.map(([id, name, host, ip, vcpu, mem, gpus, power, cpu, memPct]) => ({
    id, name, hostname: name, externalIp: ip, internalIp: ip, status: power === 'on' ? 'provisioned' : 'stopped', powerState: power,
    parentServer: { id: host, name: hostName.get(host) },
    computeServerType: { id: 301, code: 'mvmvm', name: 'HPE VM', managed: true, vmHypervisor: false },
    zone: { id: 1, name: 'pcai-cloud' }, plan: { name: `${vcpu} vCPU, ${mem} GB Memory` },
    maxCores: vcpu, maxMemory: mem * GiB, maxStorage: (name.startsWith('pcai') ? 500 : 120) * GiB, maxGpus: gpus || null,
    stats: { maxMemory: mem * GiB, usedMemory: Math.round((memPct / 100) * mem * GiB), maxStorage: 500 * GiB, usedStorage: 210 * GiB, cpuUsage: cpu },
    serverOs: { name: 'Ubuntu 22.04' }, agentInstalled: power === 'on', agentVersion: power === 'on' ? '8.0.5' : null, guestAgentStatus: power === 'on' ? 'ok' : 'unknown',
    dateCreated: ago(now, (id % 97) * 24 * 60 + 600), owner: { username: name.startsWith('pcai') ? 'pcai-ops' : 'platform' },
    tags: [{ name: 'env', value: name.startsWith('edge') || name === 'build-runner' ? 'edge' : 'pcai' }, ...(name.startsWith('pcai') ? [{ name: 'k8s', value: 'true' }] : [])],
    hourlyCost: Math.round(vcpu * 0.012 * 1000) / 1000,
    interfaces: [{ name: 'eth0', ipAddress: ip, macAddress: `52:54:00:${(id >> 8).toString(16).padStart(2, '0')}:${(id & 255).toString(16).padStart(2, '0')}:10`, primaryInterface: true, dhcp: false,
      network: { name: ip.startsWith('10.20') ? 'edge (VLAN 40)' : 'pcai-nodes (VLAN 20)' }, type: { name: 'virtio' } }],
    volumes: [
      { name: 'root', maxStorage: 100 * GiB, rootVolume: true, datastoreId: host < 200 ? 501 : 503 },
      ...(name.startsWith('pcai') ? [{ name: 'data', maxStorage: 400 * GiB, rootVolume: false, datastoreId: name.includes('gpu') ? 502 : 501 }] : []),
    ],
  }));
  const instances = vmRows.map(([id, name]) => ({ id: id + 50000, name, servers: [id], status: 'running', connectionInfo: [] }));

  const raw: RawVme = {
    whoami: { user: { username: 'trinetra-readonly' }, appliance: { buildVersion: '8.0.5', url: 'https://vme-manager.demo' } },
    servers: [...hosts.map(hostServer), ...vmServers],
    instances,
    clusters: [
      { id: 11, name: 'pcai-hvm', status: 'ok', type: { name: 'HPE VM Cluster', code: 'mvm' }, zone: { name: 'pcai-cloud' }, servers: hosts.filter((h) => h.cluster === 11).map((h) => ({ id: h.id, name: h.name })) },
      { id: 12, name: 'edge-hvm', status: 'ok', type: { name: 'HPE VM Cluster', code: 'mvm' }, zone: { name: 'pcai-cloud' }, servers: hosts.filter((h) => h.cluster === 12).map((h) => ({ id: h.id, name: h.name })) },
    ],
    datastores: [
      { id: 501, name: 'pcai-gfs2-01', type: 'gfs2', datastoreType: { name: 'GFS2 Pool' }, storageSize: 20 * 1024 * GiB, freeSpace: 1.8 * 1024 * GiB, active: true, online: true, refType: 'ComputeServerGroup', refId: 11, zone: { name: 'pcai-cloud' } },
      { id: 502, name: 'pcai-nfs-models', type: 'nfs', datastoreType: { name: 'NFS Pool' }, storageSize: 50 * 1024 * GiB, freeSpace: 31 * 1024 * GiB, active: true, online: true, refType: 'ComputeServerGroup', refId: 11 },
      { id: 503, name: 'edge-local', type: 'directory', datastoreType: { name: 'Directory Pool' }, storageSize: 4 * 1024 * GiB, freeSpace: 2.6 * 1024 * GiB, active: true, online: true, refType: 'ComputeServerGroup', refId: 12 },
    ],
    networks: [
      { id: 601, name: 'mgmt', displayName: 'mgmt (VLAN 10)', type: { name: 'VLAN' }, cidr: '10.10.0.0/24', vlanId: 10, gateway: '10.10.0.1', active: true, zone: { name: 'pcai-cloud' } },
      { id: 602, name: 'pcai-nodes', displayName: 'pcai-nodes (VLAN 20)', type: { name: 'VLAN' }, cidr: '10.10.1.0/24', vlanId: 20, gateway: '10.10.1.1', active: true, zone: { name: 'pcai-cloud' } },
      { id: 603, name: 'storage', displayName: 'storage (VLAN 30)', type: { name: 'VLAN' }, cidr: '10.30.0.0/24', vlanId: 30, active: true, zone: { name: 'pcai-cloud' } },
      { id: 604, name: 'edge', displayName: 'edge (VLAN 40)', type: { name: 'VLAN' }, cidr: '10.20.1.0/24', vlanId: 40, gateway: '10.20.1.1', active: true, zone: { name: 'pcai-cloud' } },
    ],
    alarms: [
      { id: 9001, name: 'Datastore pcai-gfs2-01 above 90% capacity', severity: 'warning', status: 'open', acknowledged: false, refType: 'Datastore', refId: 501, refName: 'pcai-gfs2-01', startDate: ago(now, 180) },
      { id: 9002, name: 'Host hvm-a-03 agent heartbeat missed', severity: 'critical', status: 'open', acknowledged: false, refType: 'ComputeServer', refId: 103, refName: 'hvm-a-03', startDate: ago(now, 40) },
      { id: 9003, name: 'Backup job nightly-vms finished with warnings', severity: 'warning', status: 'open', acknowledged: true, startDate: ago(now, 600) },
    ],
    activity: [
      { _id: 'a1', success: true, activityType: 'Provisioning', name: 'Migrate', message: 'pcai-worker-2 live-migrated from hvm-a-01 to hvm-a-02', objectType: 'Instance', objectId: 1012 + 50000, userName: 'ops-admin', ts: ago(now, 20) },
      { _id: 'a2', success: true, activityType: 'Provisioning', name: 'Stop', message: 'pcai-worker-3 stopped', objectType: 'Instance', objectId: 1013 + 50000, userName: 'ops-admin', ts: ago(now, 55) },
      { _id: 'a3', success: false, activityType: 'Provisioning', name: 'Resize', message: 'build-runner resize to 32 vCPU failed: not enough free memory on hvm-edge-02', objectType: 'Instance', objectId: 2004 + 50000, userName: 'ci-bot', ts: ago(now, 95) },
      { _id: 'a4', success: true, activityType: 'Backup', name: 'Backup', message: 'nightly-vms completed with 2 warnings', objectType: 'Backup', objectId: 1, ts: ago(now, 600) },
    ],
  };

  // ── Everything else the Manager exposes ───────────────────────────────────
  raw.health = {
    success: true, buildVersion: '8.0.5', applianceUrl: 'https://vme-manager.demo/',
    cpu: { cpuTotalLoad: 0.31, systemLoad: 1.7, processorCount: 8, status: 'ok' },
    memory: { memoryPercent: 0.48, systemMemoryPercent: 0.91, status: 'warning' },
    database: { usedConnections: 41, maxConnections: 1000, maxUsedConnections: 220, status: 'ok' },
    threads: { totalThreads: 412, status: 'ok' }, elastic: { status: 'ok' }, rabbit: { status: 'ok' },
  };
  raw.license = { productTier: 'HPE VM Essentials', startDate: ago(now, 340 * 24 * 60), endDate: new Date(now + 21 * 86_400_000).toISOString(), maxHosts: 8, maxMvm: 5, maxMvmSockets: 10, maxInstances: 500, hardLimit: true, freeTrial: false, accountName: 'PCAI Demo' };
  raw.logs = [
    { ts: ago(now, 3), level: 'ERROR', hostname: 'vme-manager', sourceType: 'appliance', message: 'Stats sync failed for server hvm-a-03: agent connection timed out' },
    { ts: ago(now, 18), level: 'ERROR', hostname: 'vme-manager', sourceType: 'appliance', message: 'Stats sync failed for server hvm-a-03: agent connection timed out' },
    { ts: ago(now, 33), level: 'ERROR', hostname: 'vme-manager', sourceType: 'appliance', message: 'Stats sync failed for server hvm-a-03: agent connection timed out' },
    { ts: ago(now, 95), level: 'WARN', hostname: 'vme-manager', sourceType: 'appliance', message: 'Resize of build-runner rejected: insufficient memory on hvm-edge-02' },
    { ts: ago(now, 240), level: 'INFO', hostname: 'vme-manager', sourceType: 'appliance', message: 'Nightly backup job nightly-vms started' },
  ];
  raw.zones = [{ id: 1, name: 'pcai-cloud', zoneType: { name: 'HPE VM' }, status: 'ok', enabled: true }];
  raw.groups = [{ id: 1, name: 'PCAI', zones: [{ id: 1 }] }, { id: 2, name: 'Edge', zones: [{ id: 1 }] }];
  raw.subnets = [
    { id: 701, name: 'pcai-nodes-a', cidr: '10.10.1.0/25', gateway: '10.10.1.1', dhcpServer: false, active: true, network: { name: 'pcai-nodes' } },
    { id: 702, name: 'pcai-nodes-b', cidr: '10.10.1.128/25', gateway: '10.10.1.129', dhcpServer: false, active: true, network: { name: 'pcai-nodes' } },
  ];
  raw.ipPools = [
    { id: 801, name: 'pcai-nodes-pool', ipCount: 40, freeCount: 3, poolEnabled: true, ipRanges: [{ startAddress: '10.10.1.10', endAddress: '10.10.1.49' }] },
    { id: 802, name: 'edge-pool', ipCount: 60, freeCount: 44, poolEnabled: true, ipRanges: [{ startAddress: '10.20.1.10', endAddress: '10.20.1.69' }] },
  ];
  raw.securityGroups = [{ id: 901, name: 'pcai-nodes', description: 'Kubernetes node traffic', rules: [{}, {}, {}, {}, {}, {}] }, { id: 902, name: 'mgmt-ssh', description: 'SSH from jump host', rules: [{}] }];
  raw.virtualSwitches = [
    { id: 12, name: 'vs-mgmt', baseType: 'management', bondMode: 'active-backup', mtu: 1500, status: 'available', active: true, clusterId: 11, nicCount: 2, networkCount: 1 },
    { id: 13, name: 'vs-pcai', baseType: 'general', bondMode: '802.3ad (LACP)', mtu: 9000, status: 'available', active: true, clusterId: 11, nicCount: 2, networkCount: 2 },
    { id: 14, name: 'vs-storage', baseType: 'storage', bondMode: 'none', mtu: 9000, status: 'available', active: true, clusterId: 11, nicCount: 1, networkCount: 1 },
    { id: 21, name: 'vs-edge', baseType: 'general', bondMode: 'active-backup', mtu: 1500, status: 'available', active: true, clusterId: 12, nicCount: 2, networkCount: 1 },
  ];
  raw.storageServers = [{ id: 1001, name: 'alletra-mp-01', type: { name: 'HPE Alletra Storage MP' }, status: 'ok', serviceUrl: 'https://10.30.0.10' }];
  raw.storageVolumes = vmServers.flatMap((v: any) => v.volumes.map((d: any, i: number) => ({
    id: v.id * 10 + i, volumeName: `${v.name}-disk-${i}`, maxStorage: d.maxStorage, usedStorage: Math.round(d.maxStorage * (0.2 + ((v.id + i) % 7) / 10)),
    datastore: { name: d.datastoreId === 502 ? 'pcai-nfs-models' : d.datastoreId === 503 ? 'edge-local' : 'pcai-gfs2-01' }, datastoreId: d.datastoreId,
    poolName: d.datastoreId === 502 ? 'nfs-models' : 'gfs2-pool', deviceDisplayName: i ? 'vdb' : 'vda', status: 'provisioned', refType: 'ComputeServer', refId: v.id, rootVolume: !!d.rootVolume,
  })));
  raw.images = [
    { id: 1201, name: 'ubuntu-22.04-pcai-node', imageType: 'qcow2', osType: { name: 'Ubuntu 22.04' }, rawSize: 4.2 * GiB, isCloudInit: true, dateCreated: ago(now, 90 * 24 * 60), visibility: 'private' },
    { id: 1202, name: 'rocky-9-base', imageType: 'qcow2', osType: { name: 'Rocky Linux 9' }, rawSize: 1.9 * GiB, isCloudInit: true, dateCreated: ago(now, 200 * 24 * 60), visibility: 'public' },
    { id: 1203, name: 'win2022-std', imageType: 'qcow2', osType: { name: 'Windows Server 2022' }, rawSize: 14.5 * GiB, isCloudInit: false, dateCreated: ago(now, 150 * 24 * 60), visibility: 'private' },
  ];
  raw.plans = [
    { id: 1301, name: '4 vCPU, 16 GB Memory', maxCores: 4, maxMemory: 16 * GiB, maxStorage: 100 * GiB, active: true, provisionType: { name: 'HPE VM' } },
    { id: 1302, name: '8 vCPU, 32 GB Memory', maxCores: 8, maxMemory: 32 * GiB, maxStorage: 200 * GiB, active: true, provisionType: { name: 'HPE VM' } },
    { id: 1303, name: '32 vCPU, 128 GB Memory', maxCores: 32, maxMemory: 128 * GiB, maxStorage: 500 * GiB, active: true, provisionType: { name: 'HPE VM' } },
    { id: 1304, name: '48 vCPU, 192 GB, 2 GPU', maxCores: 48, maxMemory: 192 * GiB, maxStorage: 500 * GiB, active: true, provisionType: { name: 'HPE VM' } },
  ];
  raw.backups = [
    { id: 1401, name: 'dsc-jump-daily', instance: { id: 1031 + 50000, name: 'dsc-jump' }, enabled: true, cronExpression: '0 2 * * *', nextFire: new Date(now + 6 * 3600_000).toISOString(), lastResult: { status: 'SUCCEEDED', endDate: ago(now, 600) } },
    { id: 1402, name: 'ezua-proxy-daily', instance: { id: 1032 + 50000, name: 'ezua-proxy' }, enabled: true, cronExpression: '0 2 * * *', nextFire: new Date(now + 6 * 3600_000).toISOString(), lastResult: { status: 'FAILED', endDate: ago(now, 590) } },
    { id: 1403, name: 'edge-gw-weekly', instance: { id: 2001 + 50000, name: 'edge-gw-1' }, enabled: true, cronExpression: '0 3 * * 0', nextFire: new Date(now + 3 * 86_400_000).toISOString(), lastResult: { status: 'SUCCEEDED', endDate: ago(now, 4 * 24 * 60) } },
  ];
  raw.backupJobs = [{ id: 1501, name: 'nightly-vms', cronExpression: '0 2 * * *' }];
  raw.backupResults = [
    { id: 1601, backup: { id: 1401, name: 'dsc-jump-daily' }, status: 'SUCCEEDED', startDate: ago(now, 605), endDate: ago(now, 600), durationMillis: 300000, sizeInMb: 2140 },
    { id: 1602, backup: { id: 1402, name: 'ezua-proxy-daily' }, status: 'FAILED', startDate: ago(now, 600), endDate: ago(now, 590), durationMillis: 610000, sizeInMb: 0, errorMessage: 'Snapshot timed out: datastore pcai-gfs2-01 above 90%' },
    { id: 1603, backup: { id: 1403, name: 'edge-gw-weekly' }, status: 'SUCCEEDED', startDate: ago(now, 4 * 24 * 60 + 5), endDate: ago(now, 4 * 24 * 60), durationMillis: 290000, sizeInMb: 3880 },
  ];
  raw.checks = [
    { id: 1701, name: 'pcai-ingress https', checkType: { name: 'Web' }, lastCheckStatus: 'success', availability: 99.98, lastRunDate: ago(now, 1), muted: false },
    { id: 1702, name: 'edge-cache tcp/6379', checkType: { name: 'Socket' }, lastCheckStatus: 'error', availability: 96.4, lastError: 'connection refused', lastRunDate: ago(now, 2), muted: false },
  ];
  raw.incidents = [{ id: 1801, displayName: 'edge-cache tcp/6379 down', severity: 'warning', status: 'open', startDate: ago(now, 34), lastError: 'connection refused' }];
  raw.powerSchedules = [{ id: 1, name: 'edge-nightly-off' }];

  const k8sNode = (name: string, ip: string, roles: string[], gpus = 0, ready = true) => ({
    metadata: { name, labels: Object.fromEntries(roles.map((r) => [`node-role.kubernetes.io/${r}`, ''])) },
    status: { addresses: [{ type: 'InternalIP', address: ip }, { type: 'Hostname', address: name }], capacity: gpus ? { 'nvidia.com/gpu': String(gpus) } : {},
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
  });
  const k8sNodes = { items: [
    k8sNode('pcai-cp-1', '10.10.1.11', ['control-plane']), k8sNode('pcai-cp-2', '10.10.1.12', ['control-plane']), k8sNode('pcai-cp-3', '10.10.1.13', ['control-plane']),
    k8sNode('pcai-worker-1', '10.10.1.21', ['worker']), k8sNode('pcai-worker-2', '10.10.1.22', ['worker']), k8sNode('pcai-worker-3', '10.10.1.23', ['worker'], 0, false),
    k8sNode('pcai-gpu-1', '10.10.1.31', ['worker'], 2), k8sNode('pcai-gpu-2', '10.10.1.32', ['worker'], 2),
    k8sNode('pcai-baremetal-gpu-9', '10.10.9.9', ['worker'], 8),
  ] };
  const podCounts: Record<string, number> = { 'pcai-cp-1': 18, 'pcai-cp-2': 17, 'pcai-cp-3': 17, 'pcai-worker-1': 64, 'pcai-worker-2': 51, 'pcai-gpu-1': 9, 'pcai-gpu-2': 7, 'pcai-baremetal-gpu-9': 12 };
  const podNodes = Object.entries(podCounts).flatMap(([n, c]) => Array(c).fill(n)).join('\n');
  return { raw, k8sNodes, podNodes };
}
