// Capacity planning for the move to HPE VM Essentials: will the VMs fit on the
// target servers, with room to lose a host, and how many servers (and socket
// licences) does that take?
//
// Supply is the bare-metal hosts Trinetra has scanned (server/hardware/inventory.ts)
// plus servers you are only planning to buy. Demand is the VMs it has scanned
// plus groups typed in by hand (Windows VMs, VMs not in the inventory). Sizing is
// either what each VM is GIVEN in VMware (allocated) or what it actually USES
// (95th percentile from Trinetra's own metrics, plus headroom) — the gap between
// the two is usually the biggest saving a migration offers.
//
// Everything here is pure and covered by server/__tests__/capacity.test.ts; the
// router at the bottom only gathers the inputs from the scan cache and metrics.

import { Router } from 'express';
import { loadVms } from '../vms.js';
import { readSamples } from '../metrics/store.js';
import { cpuPctBetween, type Sample } from '../metrics/model.js';
import { cachedHardware, type HardwareInfo } from './inventory.js';

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PlanHost {
  name: string;
  /** Typed in as a server to buy, not scanned. */
  planned?: boolean;
  model?: string;
  sockets: number;
  threads: number;
  memoryBytes: number;
  diskBytes: number;
  gpus: number;
}

export interface Observed {
  cpuP95Pct: number;
  memP95Bytes: number;
  samples: number;
  hours: number;
}

export interface PlanVm {
  name: string;
  /** Typed in by hand rather than scanned. */
  manual?: boolean;
  vcpus: number;
  memoryBytes: number;
  diskBytes: number;
  usedDiskBytes?: number;
  gpus: number;
  observed?: Observed;
}

export interface PlanOptions {
  /** vCPUs per physical thread. 4:1 is a common general-purpose ceiling on KVM. */
  cpuRatio: number;
  /** Memory overcommit. 1 = none, which is the safe default on KVM. */
  memRatio: number;
  /** Hosts the cluster must be able to lose and still run everything. */
  failures: number;
  /** Threads per host kept for the hypervisor and VME agents. */
  reserveThreads: number;
  /** Memory per host kept for the hypervisor and VME agents. */
  reserveMemGiB: number;
  /** Plan to this utilization of what is left, not 100%. */
  targetPct: number;
  basis: 'allocated' | 'observed';
  /** Added on top of observed p95 when right-sizing. */
  observedHeadroomPct: number;
  /** Thin: storage demand is used space; thick: provisioned size. */
  thin: boolean;
  storageGrowthPct: number;
  /** Size of the shared datastore (SAN/NFS), when VMs will not live on local disks. */
  sharedStorageTiB?: number;
}

export const DEFAULT_OPTIONS: PlanOptions = {
  cpuRatio: 4, memRatio: 1, failures: 1, reserveThreads: 2, reserveMemGiB: 8, targetPct: 80,
  basis: 'allocated', observedHeadroomPct: 25, thin: true, storageGrowthPct: 20,
};

export interface PlannedHostSpec { label: string; count: number; sockets: number; coresPerSocket: number; threadsPerCore: number; memoryGiB: number; diskTiB: number; gpus: number }
export interface ExtraVmSpec { label: string; count: number; vcpus: number; memoryGiB: number; diskGiB: number; gpus: number }

export type ResourceId = 'cpu' | 'memory' | 'storage' | 'gpu';
export interface ResourceFit {
  id: ResourceId;
  label: string;
  unit: 'vCPU' | 'bytes' | 'GPUs';
  demand: number;
  /** Usable after reserves, overcommit, target and the failure allowance. */
  capacity: number;
  /** Usable with every host up — the gap to `capacity` is the failover reserve. */
  capacityAllUp: number;
  utilPct: number | null;
  status: 'ok' | 'tight' | 'short' | 'n/a';
}

export interface Placement {
  host: string;
  planned?: boolean;
  vms: string[];
  vcpu: number;
  vcpuCap: number;
  memoryBytes: number;
  memCap: number;
  gpus: number;
  gpuCap: number;
}

export interface PlanResult {
  options: PlanOptions;
  supply: { hosts: number; planned: number; sockets: number; threads: number; memoryBytes: number; diskBytes: number; gpus: number; failedHosts: string[] };
  demand: { vms: number; manual: number; vcpu: number; memoryBytes: number; storageBytes: number; gpus: number; observedVms: number; allocatedVcpu: number; allocatedMemoryBytes: number };
  resources: ResourceFit[];
  binding?: ResourceId;
  verdict: 'fits' | 'tight' | 'short' | 'empty';
  summary: string;
  hostsNeeded?: { spec: string; perHost: { vcpu: number; memoryBytes: number; gpus: number; sockets: number }; count: number; failover: number; sockets: number; by: ResourceId };
  placement: Placement[];
  unplaced: Array<{ vm: string; reason: string }>;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const clampNum = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Options from an untrusted request body, every field bounded. */
export function normalizeOptions(o: any = {}): PlanOptions {
  const d = DEFAULT_OPTIONS;
  const shared = Number(o.sharedStorageTiB);
  return {
    cpuRatio: clampNum(o.cpuRatio, 1, 16, d.cpuRatio),
    memRatio: clampNum(o.memRatio, 1, 2, d.memRatio),
    failures: Math.round(clampNum(o.failures, 0, 4, d.failures)),
    reserveThreads: clampNum(o.reserveThreads, 0, 64, d.reserveThreads),
    reserveMemGiB: clampNum(o.reserveMemGiB, 0, 512, d.reserveMemGiB),
    targetPct: clampNum(o.targetPct, 10, 100, d.targetPct),
    basis: o.basis === 'observed' ? 'observed' : 'allocated',
    observedHeadroomPct: clampNum(o.observedHeadroomPct, 0, 200, d.observedHeadroomPct),
    thin: o.thin === undefined ? d.thin : !!o.thin,
    storageGrowthPct: clampNum(o.storageGrowthPct, 0, 300, d.storageGrowthPct),
    sharedStorageTiB: Number.isFinite(shared) && shared > 0 ? Math.min(shared, 100_000) : undefined,
  };
}

export function hostFromHardware(name: string, hw: HardwareInfo): PlanHost {
  return {
    name, model: hw.system.product,
    sockets: hw.cpu.sockets || 1,
    threads: hw.cpu.logical || hw.cpu.cores || 0,
    memoryBytes: hw.memory.totalBytes || 0,
    diskBytes: hw.disks.reduce((s, d) => s + d.sizeBytes, 0),
    gpus: hw.gpus.length,
  };
}

export function vmFromHardware(name: string, hw: HardwareInfo, observed?: Observed): PlanVm {
  return {
    name,
    vcpus: hw.cpu.logical || 1,
    memoryBytes: hw.memory.totalBytes || 0,
    diskBytes: hw.disks.reduce((s, d) => s + d.sizeBytes, 0),
    usedDiskBytes: hw.guest.usedBytes,
    gpus: hw.gpus.length,
    observed,
  };
}

const p95 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};

/**
 * 95th-percentile CPU and memory from stored samples. Undefined when there is
 * too little history to trust (under 20 readings or under an hour) — a plan
 * built on ten minutes of a quiet afternoon would undersize everything.
 */
export function observedUsage(samples: Sample[]): Observed | undefined {
  const s = samples.filter((x) => x.reachable).sort((a, b) => a.at - b.at);
  if (s.length < 20) return undefined;
  const hours = (s[s.length - 1].at - s[0].at) / 3_600_000;
  if (hours < 1) return undefined;
  const cpu: number[] = [];
  for (let i = 1; i < s.length; i++) { const v = cpuPctBetween(s[i - 1], s[i]); if (v !== null) cpu.push(v); }
  const mem = s.map((x) => x.memUsed).filter((v): v is number => typeof v === 'number');
  if (!cpu.length || !mem.length) return undefined;
  return { cpuP95Pct: Math.round(p95(cpu) * 10) / 10, memP95Bytes: p95(mem), samples: s.length, hours: Math.round(hours * 10) / 10 };
}

export function expandPlannedHosts(specs: any[]): PlanHost[] {
  const out: PlanHost[] = [];
  for (const raw of (Array.isArray(specs) ? specs : []).slice(0, 10)) {
    const label = String(raw?.label || 'Planned server').slice(0, 60);
    const count = Math.round(clampNum(raw?.count, 0, 64, 0));
    const sockets = Math.round(clampNum(raw?.sockets, 1, 8, 2));
    const threads = sockets * Math.round(clampNum(raw?.coresPerSocket, 1, 256, 32)) * Math.round(clampNum(raw?.threadsPerCore, 1, 2, 2));
    for (let i = 1; i <= count; i++) {
      out.push({
        name: count === 1 ? label : `${label} #${i}`, planned: true, model: label, sockets, threads,
        memoryBytes: clampNum(raw?.memoryGiB, 1, 65_536, 512) * GiB,
        diskBytes: clampNum(raw?.diskTiB, 0, 2_000, 0) * TiB,
        gpus: Math.round(clampNum(raw?.gpus, 0, 16, 0)),
      });
    }
  }
  return out;
}

export function expandExtraVms(specs: any[]): PlanVm[] {
  const out: PlanVm[] = [];
  for (const raw of (Array.isArray(specs) ? specs : []).slice(0, 50)) {
    const label = String(raw?.label || 'VM group').slice(0, 60);
    const count = Math.round(clampNum(raw?.count, 0, 5_000, 0));
    for (let i = 1; i <= count && out.length < 10_000; i++) {
      out.push({
        name: count === 1 ? label : `${label} #${i}`, manual: true,
        vcpus: Math.round(clampNum(raw?.vcpus, 1, 512, 2)),
        memoryBytes: clampNum(raw?.memoryGiB, 0.25, 8_192, 4) * GiB,
        diskBytes: clampNum(raw?.diskGiB, 0, 65_536, 50) * GiB,
        gpus: Math.round(clampNum(raw?.gpus, 0, 16, 0)),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** What one VM asks for under the chosen basis. */
export function vmDemand(vm: PlanVm, o: PlanOptions): { vcpu: number; memoryBytes: number; storageBytes: number; observed: boolean } {
  const grow = 1 + o.storageGrowthPct / 100;
  const storageBytes = (o.thin ? (vm.usedDiskBytes ?? vm.diskBytes) : vm.diskBytes) * grow;
  if (o.basis === 'observed' && vm.observed) {
    const head = 1 + o.observedHeadroomPct / 100;
    return {
      vcpu: Math.min(vm.vcpus, Math.max(1, Math.ceil(vm.vcpus * (vm.observed.cpuP95Pct / 100) * head))),
      memoryBytes: Math.min(vm.memoryBytes || Infinity, Math.max(GiB, vm.observed.memP95Bytes * head)),
      storageBytes, observed: true,
    };
  }
  return { vcpu: vm.vcpus, memoryBytes: vm.memoryBytes, storageBytes, observed: false };
}

/** What one host offers after the hypervisor reserve, overcommit and target utilization. */
export function hostCapacity(h: PlanHost, o: PlanOptions): { vcpu: number; memoryBytes: number } {
  const t = o.targetPct / 100;
  return {
    vcpu: Math.floor(Math.max(0, h.threads - o.reserveThreads) * o.cpuRatio * t),
    memoryBytes: Math.max(0, h.memoryBytes - o.reserveMemGiB * GiB) * o.memRatio * t,
  };
}

const statusOf = (demand: number, cap: number): ResourceFit['status'] => {
  if (!demand && !cap) return 'n/a';
  if (demand > cap) return 'short';
  return demand > cap * 0.9 ? 'tight' : 'ok';
};

const fmtGiB = (b: number) => (b >= TiB ? `${(b / TiB).toFixed(1)} TiB` : `${Math.round(b / GiB)} GiB`);

export function planCapacity(hosts: PlanHost[], vms: PlanVm[], opts: Partial<PlanOptions> = {}): PlanResult {
  const o: PlanOptions = { ...DEFAULT_OPTIONS, ...opts };
  const notes: string[] = [];

  // ── Supply, and which hosts the failover allowance takes away ──
  const caps = hosts.map((h) => ({ h, ...hostCapacity(h, o) }));
  // The largest hosts are the ones whose loss hurts most: lose those.
  const byBiggest = [...caps].sort((a, b) => b.memoryBytes - a.memoryBytes || b.vcpu - a.vcpu);
  const failed = byBiggest.slice(0, Math.min(o.failures, Math.max(0, caps.length - 1)));
  if (o.failures > 0 && caps.length <= o.failures) notes.push(`Only ${caps.length} host${caps.length === 1 ? '' : 's'}: cannot keep ${o.failures} in reserve, so there is no failover.`);
  const survivors = caps.filter((c) => !failed.includes(c));
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

  // ── Demand ──
  const dem = vms.map((v) => ({ v, ...vmDemand(v, o) }));
  const demand = {
    vms: vms.length,
    manual: vms.filter((v) => v.manual).length,
    vcpu: sum(dem, (d) => d.vcpu),
    memoryBytes: sum(dem, (d) => d.memoryBytes),
    storageBytes: sum(dem, (d) => d.storageBytes),
    gpus: sum(vms, (v) => v.gpus),
    observedVms: dem.filter((d) => d.observed).length,
    allocatedVcpu: sum(vms, (v) => v.vcpus),
    allocatedMemoryBytes: sum(vms, (v) => v.memoryBytes),
  };
  if (o.basis === 'observed') {
    // Typed-in groups are sized as entered; only scanned VMs can have history.
    const scannedVms = vms.filter((v) => !v.manual);
    const missing = scannedVms.filter((v) => !v.observed).length;
    if (missing) notes.push(`${missing} of ${scannedVms.length} scanned VM${scannedVms.length === 1 ? '' : 's'} have no usable metrics history (needs ≥ 1 h of Observability samples) and are sized as allocated.`);
  }

  const storageCap = o.sharedStorageTiB ? o.sharedStorageTiB * TiB * (o.targetPct / 100) : sum(hosts, (h) => h.diskBytes) * (o.targetPct / 100);
  if (!o.sharedStorageTiB && hosts.length) notes.push('Storage capacity is the target hosts\' local disks (OS disks included). If the VMs will live on a SAN or NFS datastore, enter its size instead.');

  const fits: ResourceFit[] = [
    { id: 'cpu', label: 'CPU', unit: 'vCPU', demand: demand.vcpu, capacity: sum(survivors, (c) => c.vcpu), capacityAllUp: sum(caps, (c) => c.vcpu), utilPct: null, status: 'n/a' },
    { id: 'memory', label: 'Memory', unit: 'bytes', demand: demand.memoryBytes, capacity: sum(survivors, (c) => c.memoryBytes), capacityAllUp: sum(caps, (c) => c.memoryBytes), utilPct: null, status: 'n/a' },
    { id: 'storage', label: 'Storage', unit: 'bytes', demand: demand.storageBytes, capacity: storageCap, capacityAllUp: storageCap, utilPct: null, status: 'n/a' },
  ];
  const gpuSupply = sum(hosts, (h) => h.gpus);
  // GPUs only matter when some VM passes one through.
  if (demand.gpus) {
    fits.push({ id: 'gpu', label: 'GPUs (passthrough)', unit: 'GPUs', demand: demand.gpus, capacity: sum(survivors, (c) => c.h.gpus), capacityAllUp: gpuSupply, utilPct: null, status: 'n/a' });
  }
  for (const f of fits) {
    // No capacity at all leaves utilization undefined; status still says 'short' when there is demand.
    f.utilPct = f.capacity > 0 ? Math.round((f.demand / f.capacity) * 1000) / 10 : null;
    f.status = statusOf(f.demand, f.capacity);
  }
  const ranked = fits.filter((f) => f.status !== 'n/a').sort((a, b) => (b.utilPct ?? Infinity) - (a.utilPct ?? Infinity));
  const binding = ranked[0]?.id;

  // ── Placement: biggest VMs first, each onto the host with the most memory left ──
  const slots = caps.map((c) => ({
    host: c.h.name, planned: c.h.planned, vms: [] as string[], threads: c.h.threads,
    vcpu: 0, vcpuCap: c.vcpu, memoryBytes: 0, memCap: c.memoryBytes, gpus: 0, gpuCap: c.h.gpus,
  }));
  const unplaced: PlanResult['unplaced'] = [];
  const order = [...dem].sort((a, b) => b.v.gpus - a.v.gpus || b.memoryBytes - a.memoryBytes || b.vcpu - a.vcpu);
  for (const d of order) {
    const fitsEmpty = (s: typeof slots[number]) => d.v.vcpus <= s.threads && d.vcpu <= s.vcpuCap && d.memoryBytes <= s.memCap && d.v.gpus <= s.gpuCap;
    const room = slots
      .filter((s) => d.v.vcpus <= s.threads && s.vcpu + d.vcpu <= s.vcpuCap && s.memoryBytes + d.memoryBytes <= s.memCap && s.gpus + d.v.gpus <= s.gpuCap)
      .sort((a, b) => (b.memCap - b.memoryBytes) - (a.memCap - a.memoryBytes));
    const s = room[0];
    if (s) {
      s.vms.push(d.v.name); s.vcpu += d.vcpu; s.memoryBytes += d.memoryBytes; s.gpus += d.v.gpus;
      continue;
    }
    if (!slots.length) { unplaced.push({ vm: d.v.name, reason: 'No target hosts selected.' }); continue; }
    if (!slots.some(fitsEmpty)) {
      const maxThreads = Math.max(...slots.map((x) => x.threads));
      const maxMem = Math.max(...slots.map((x) => x.memCap));
      const maxGpu = Math.max(...slots.map((x) => x.gpuCap));
      const why = [
        d.v.vcpus > maxThreads ? `${d.v.vcpus} vCPUs > ${maxThreads} threads on the largest host` : '',
        d.memoryBytes > maxMem ? `${fmtGiB(d.memoryBytes)} memory > ${fmtGiB(maxMem)} usable on the largest host` : '',
        d.v.gpus > maxGpu ? `${d.v.gpus} GPU${d.v.gpus === 1 ? '' : 's'} > ${maxGpu} on any host` : '',
        d.vcpu > Math.max(...slots.map((x) => x.vcpuCap)) ? `${d.vcpu} vCPU demand > a single host's usable vCPU` : '',
      ].filter(Boolean);
      unplaced.push({ vm: d.v.name, reason: `Larger than any one host: ${why.join('; ') || 'exceeds every host'}.` });
    } else {
      unplaced.push({ vm: d.v.name, reason: 'Fits a host on its own, but no host has room left — the cluster is full.' });
    }
  }

  // ── How many servers of one spec would it take ──
  let hostsNeeded: PlanResult['hostsNeeded'];
  const ref = hosts.find((h) => h.planned) || [...hosts].sort((a, b) => b.memoryBytes - a.memoryBytes)[0];
  if (ref && vms.length) {
    const per = hostCapacity(ref, o);
    // Compare the unrounded need, so a tie after rounding up still names the real limit.
    const need: Array<[ResourceId, number]> = [
      ['cpu', per.vcpu ? demand.vcpu / per.vcpu : Infinity],
      ['memory', per.memoryBytes ? demand.memoryBytes / per.memoryBytes : Infinity],
    ];
    if (demand.gpus) need.push(['gpu', ref.gpus ? demand.gpus / ref.gpus : Infinity]);
    const [by, ratio] = need.sort((a, b) => b[1] - a[1])[0];
    if (Number.isFinite(ratio)) {
      const count = Math.max(1, Math.ceil(ratio - 1e-9)) + o.failures;
      hostsNeeded = {
        spec: `${ref.model || ref.name}: ${ref.sockets} socket${ref.sockets === 1 ? '' : 's'}, ${ref.threads} threads, ${fmtGiB(ref.memoryBytes)}${ref.gpus ? `, ${ref.gpus} GPU${ref.gpus === 1 ? '' : 's'}` : ''}`,
        perHost: { vcpu: per.vcpu, memoryBytes: per.memoryBytes, gpus: ref.gpus, sockets: ref.sockets },
        count, failover: o.failures, sockets: count * ref.sockets, by,
      };
    } else {
      notes.push(`A ${ref.model || ref.name} offers no usable ${by === 'gpu' ? 'GPUs' : by}; the host count cannot be computed from it.`);
    }
  }

  // ── Verdict ──
  let verdict: PlanResult['verdict'];
  let summary: string;
  const pctOf = (f?: ResourceFit) => (f?.utilPct === null || f?.utilPct === undefined ? '—' : `${f.utilPct}%`);
  const tol = o.failures ? ` while tolerating ${o.failures} host failure${o.failures === 1 ? '' : 's'}` : '';
  if (!vms.length || !hosts.length) {
    verdict = 'empty';
    summary = !hosts.length ? 'Select target hosts or add planned servers.' : 'Select VMs to move or add VM groups.';
  } else if (ranked.some((f) => f.status === 'short') || unplaced.length) {
    verdict = 'short';
    const short = ranked.filter((f) => f.status === 'short').map((f) => `${f.label.toLowerCase()} at ${pctOf(f)}`);
    summary = `Does not fit${tol}: ${[...short, unplaced.length ? `${unplaced.length} VM${unplaced.length === 1 ? '' : 's'} cannot be placed` : ''].filter(Boolean).join(', ')}.`;
  } else if (ranked.some((f) => f.status === 'tight')) {
    verdict = 'tight';
    summary = `Fits${tol}, but tight: ${ranked.filter((f) => f.status === 'tight').map((f) => `${f.label.toLowerCase()} at ${pctOf(f)}`).join(', ')} of planned capacity.`;
  } else {
    verdict = 'fits';
    const b = ranked[0];
    summary = `Fits${tol}. ${b ? `${b.label} is the limit at ${pctOf(b)} of planned capacity.` : ''}`.trim();
  }

  return {
    options: o,
    supply: {
      hosts: hosts.length, planned: hosts.filter((h) => h.planned).length,
      sockets: sum(hosts, (h) => h.sockets), threads: sum(hosts, (h) => h.threads),
      memoryBytes: sum(hosts, (h) => h.memoryBytes), diskBytes: sum(hosts, (h) => h.diskBytes), gpus: gpuSupply,
      failedHosts: failed.map((c) => c.h.name),
    },
    demand,
    resources: fits,
    binding,
    verdict,
    summary,
    hostsNeeded,
    placement: slots.map(({ threads: _t, ...s }) => s),
    unplaced,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const capacityRouter = Router();

/** Scan results are kept a day for planning: hardware and VM sizes do not change by the minute. */
const PLAN_CACHE_MS = 24 * 3_600_000;

/**
 * POST /api/hardware/capacity
 *   { targets?: string[], vms?: string[], planned?: PlannedHostSpec[], extra?: ExtraVmSpec[], options?: Partial<PlanOptions> }
 * Reads the Hardware page's scan cache and the metrics store; no SSH.
 */
capacityRouter.post('/api/hardware/capacity', async (req, res) => {
  try {
    const body = req.body || {};
    const options = normalizeOptions(body.options);
    const inventory = await loadVms();
    const scanned: Array<{ name: string; hw: HardwareInfo }> = [];
    const missing: string[] = [];
    for (const v of inventory) {
      const r = cachedHardware(v.name, PLAN_CACHE_MS);
      if (r?.hardware) scanned.push({ name: v.name, hw: r.hardware });
      else missing.push(v.name);
    }

    const physical = scanned.filter((s) => s.hw.physical);
    const guests = scanned.filter((s) => !s.hw.physical);
    // Default targets: servers already set up for KVM; if none are, every server.
    const kvmReady = physical.filter((s) => s.hw.virtHost.kvm);
    const defaultTargets = (kvmReady.length ? kvmReady : physical).map((s) => s.name);
    const defaultVms = guests.map((s) => s.name);
    const pick = (list: unknown, dflt: string[]) => (Array.isArray(list) ? list.map(String) : dflt);
    const targets = new Set(pick(body.targets, defaultTargets));
    const chosenVms = new Set(pick(body.vms, defaultVms));

    const since = Date.now() - 7 * 24 * 3_600_000;
    const vmCandidates = await Promise.all(guests.map(async (s) => {
      const observed = observedUsage(await readSamples(s.name, since).catch(() => []));
      return vmFromHardware(s.name, s.hw, observed);
    }));

    const hosts = [...physical.filter((s) => targets.has(s.name)).map((s) => hostFromHardware(s.name, s.hw)), ...expandPlannedHosts(body.planned)];
    const vms = [...vmCandidates.filter((v) => chosenVms.has(v.name)), ...expandExtraVms(body.extra)];

    res.json({
      plan: planCapacity(hosts, vms, options),
      candidates: {
        hosts: physical.map((s) => ({ ...hostFromHardware(s.name, s.hw), kvm: s.hw.virtHost.kvm })),
        vms: vmCandidates.map((v) => ({ ...v, virt: guests.find((g) => g.name === v.name)?.hw.virt })),
      },
      defaults: { targets: defaultTargets, vms: defaultVms },
      missing,
      at: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});
