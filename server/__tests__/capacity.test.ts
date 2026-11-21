// VME capacity planning: the arithmetic has to be right, the failover allowance
// has to bite, and a VM no host can take has to be named — not silently dropped.

import { describe, it, expect } from 'vitest';
import {
  planCapacity, hostCapacity, vmDemand, observedUsage, expandPlannedHosts, expandExtraVms, normalizeOptions,
  DEFAULT_OPTIONS, type PlanHost, type PlanVm,
} from '../hardware/capacity.js';
import type { Sample } from '../metrics/model.js';

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

const host = (name: string, over: Partial<PlanHost> = {}): PlanHost =>
  ({ name, model: 'ProLiant DL380 Gen11', sockets: 2, threads: 64, memoryBytes: 512 * GiB, diskBytes: 4 * TiB, gpus: 0, ...over });
const vm = (name: string, over: Partial<PlanVm> = {}): PlanVm =>
  ({ name, vcpus: 8, memoryBytes: 32 * GiB, diskBytes: 100 * GiB, usedDiskBytes: 40 * GiB, gpus: 0, ...over });
const vms = (n: number, over: Partial<PlanVm> = {}) => Array.from({ length: n }, (_, i) => vm(`vm-${i + 1}`, over));
const three = [host('a'), host('b'), host('c')];
const res = (p: ReturnType<typeof planCapacity>, id: string) => p.resources.find((r) => r.id === id)!;

describe('per-host and per-VM arithmetic', () => {
  it('hostCapacity applies the reserve, overcommit and target', () => {
    // (64 − 2) × 4 × 0.8 = 198.4 → 198 ; (512 − 8) × 1 × 0.8 = 403.2 GiB
    const c = hostCapacity(host('a'), DEFAULT_OPTIONS);
    expect(c.vcpu).toBe(198);
    expect(c.memoryBytes / GiB).toBeCloseTo(403.2);
  });

  it('vmDemand: allocated vs observed (right-sized), thin vs thick', () => {
    const v = vm('x', { vcpus: 16, memoryBytes: 64 * GiB, observed: { cpuP95Pct: 10, memP95Bytes: 8 * GiB, samples: 100, hours: 24 } });
    expect(vmDemand(v, DEFAULT_OPTIONS)).toMatchObject({ vcpu: 16, memoryBytes: 64 * GiB, observed: false });
    const o = { ...DEFAULT_OPTIONS, basis: 'observed' as const };
    // ceil(16 × 0.10 × 1.25) = 2 ; 8 GiB × 1.25 = 10 GiB
    expect(vmDemand(v, o)).toMatchObject({ vcpu: 2, memoryBytes: 10 * GiB, observed: true });
    // thin: 40 GiB used × 1.2 growth ; thick: 100 GiB provisioned × 1.2
    expect(vmDemand(v, DEFAULT_OPTIONS).storageBytes).toBeCloseTo(48 * GiB);
    expect(vmDemand(v, { ...DEFAULT_OPTIONS, thin: false }).storageBytes).toBeCloseTo(120 * GiB);
  });

  it('observed sizing never goes above what the VM has, nor below 1 vCPU / 1 GiB', () => {
    const busy = vm('b', { vcpus: 4, memoryBytes: 8 * GiB, observed: { cpuP95Pct: 100, memP95Bytes: 8 * GiB, samples: 50, hours: 5 } });
    const idle = vm('i', { observed: { cpuP95Pct: 0, memP95Bytes: 0, samples: 50, hours: 5 } });
    const o = { ...DEFAULT_OPTIONS, basis: 'observed' as const };
    expect(vmDemand(busy, o)).toMatchObject({ vcpu: 4, memoryBytes: 8 * GiB });
    expect(vmDemand(idle, o)).toMatchObject({ vcpu: 1, memoryBytes: GiB });
  });
});

describe('planCapacity', () => {
  it('fits 20 VMs on three servers with N+1, memory binding', () => {
    const p = planCapacity(three, vms(20));
    expect(p.supply.failedHosts).toHaveLength(1);
    expect(res(p, 'cpu')).toMatchObject({ demand: 160, capacity: 396, capacityAllUp: 594, status: 'ok' });
    expect(res(p, 'memory').capacity).toBeCloseTo(806.4 * GiB);
    expect(res(p, 'memory').utilPct).toBe(79.4); // 640 / 806.4
    expect(res(p, 'storage').utilPct).toBe(9.8); // 960 GiB / 9.6 TiB
    expect(p.binding).toBe('memory');
    expect(p.verdict).toBe('fits');
    expect(p.summary).toBe('Fits while tolerating 1 host failure. Memory is the limit at 79.4% of planned capacity.');
    expect(p.unplaced).toEqual([]);
    expect(p.placement.flatMap((x) => x.vms)).toHaveLength(20);
    for (const s of p.placement) { expect(s.vcpu).toBeLessThanOrEqual(s.vcpuCap); expect(s.memoryBytes).toBeLessThanOrEqual(s.memCap); }
    // ceil(640 / 403.2) = 2 hosts for memory, + 1 for failover = 3 → 6 socket licences
    expect(p.hostsNeeded).toMatchObject({ count: 3, failover: 1, sockets: 6, by: 'memory' });
    expect(res(p, 'gpu')).toBeUndefined();
  });

  it('is tight at 95%, and short once the failover host is counted', () => {
    expect(planCapacity(three, vms(24)).verdict).toBe('tight'); // 768 / 806.4 = 95.2%
    const short = planCapacity(three, vms(26)); // 832 > 806.4
    expect(short.verdict).toBe('short');
    expect(res(short, 'memory').status).toBe('short');
    expect(short.summary).toMatch(/^Does not fit while tolerating 1 host failure: memory at 103.2%/);
    // The same load fits when no failover is required.
    expect(planCapacity(three, vms(26), { failures: 0 }).verdict).toBe('fits');
  });

  it('names a VM that is bigger than any host instead of dropping it', () => {
    const p = planCapacity(three, [...vms(2), vm('monster', { vcpus: 96, memoryBytes: 600 * GiB })]);
    expect(p.verdict).toBe('short');
    expect(p.unplaced).toHaveLength(1);
    expect(p.unplaced[0].vm).toBe('monster');
    expect(p.unplaced[0].reason).toMatch(/96 vCPUs > 64 threads/);
    expect(p.unplaced[0].reason).toMatch(/600 GiB memory > 403 GiB usable/);
  });

  it('says when the cluster is simply full', () => {
    const p = planCapacity([host('a')], vms(14), { failures: 0 }); // 14 × 32 = 448 > 403.2
    expect(p.unplaced.length).toBeGreaterThan(0);
    expect(p.unplaced[0].reason).toMatch(/no host has room left/);
  });

  it('cannot reserve a failover host out of a single host', () => {
    const p = planCapacity([host('a')], vms(2));
    expect(p.supply.failedHosts).toEqual([]);
    expect(p.notes.join(' ')).toMatch(/cannot keep 1 in reserve/);
  });

  it('accounts GPUs as passthrough devices', () => {
    const p = planCapacity(three, [...vms(2), vm('train', { gpus: 1 })]);
    expect(res(p, 'gpu')).toMatchObject({ demand: 1, capacity: 0, status: 'short' });
    expect(p.unplaced[0].reason).toMatch(/1 GPU > 0 on any host/);
    const withGpus = planCapacity([host('a', { gpus: 2 }), host('b', { gpus: 2 })], [vm('train', { gpus: 1 })]);
    expect(res(withGpus, 'gpu')).toMatchObject({ demand: 1, capacity: 2, status: 'ok' });
    expect(withGpus.placement.find((x) => x.vms.includes('train'))!.gpus).toBe(1);
  });

  it('uses a shared datastore when given, and notes local-disk sizing otherwise', () => {
    expect(planCapacity(three, vms(2)).notes.join(' ')).toMatch(/local disks/);
    const p = planCapacity(three, vms(2), { sharedStorageTiB: 1 });
    expect(res(p, 'storage').capacity).toBeCloseTo(0.8 * TiB);
    expect(p.notes.join(' ')).not.toMatch(/local disks/);
  });

  it('sizes the cluster in planned servers when some are planned', () => {
    const planned = expandPlannedHosts([{ label: 'DL380 Gen11 1 TB', count: 2, sockets: 2, coresPerSocket: 32, threadsPerCore: 2, memoryGiB: 1024, diskTiB: 8 }]);
    const p = planCapacity(planned, vms(40));
    // (128 − 2) × 4 × .8 = 403 vCPU ; (1024 − 8) × .8 = 812.8 GiB per host ; 40 × 32 = 1280 GiB → 2 + 1
    expect(p.hostsNeeded).toMatchObject({ count: 3, sockets: 6, by: 'memory' });
    expect(p.hostsNeeded!.spec).toBe('DL380 Gen11 1 TB: 2 sockets, 128 threads, 1.0 TiB');
    expect(p.supply).toMatchObject({ hosts: 2, planned: 2 });
    expect(p.verdict).toBe('short'); // two planned hosts are not enough with N+1
  });

  it('names the real limit when CPU and memory both round up to one server', () => {
    // 100 vCPU of 198 (0.51 host) vs 300 GiB of 403.2 (0.74 host): both ceil to 1, memory is the limit.
    const p = planCapacity(three, vms(10, { vcpus: 10, memoryBytes: 30 * GiB }));
    expect(p.hostsNeeded).toMatchObject({ count: 2, by: 'memory' });
  });

  it('leaves typed-in VM groups out of the "no history" note, and GPUs out when nobody needs one', () => {
    const p = planCapacity([host('a', { gpus: 2 }), host('b')], [vm('scanned'), ...expandExtraVms([{ label: 'win', count: 5 }])], { basis: 'observed' });
    expect(p.notes.join(' ')).toMatch(/1 of 1 scanned VM have no usable metrics history/);
    expect(res(p, 'gpu')).toBeUndefined();
  });

  it('reports an empty plan plainly', () => {
    expect(planCapacity([], vms(1)).verdict).toBe('empty');
    expect(planCapacity(three, []).summary).toBe('Select VMs to move or add VM groups.');
  });

  it('notes VMs sized as allocated for lack of history', () => {
    const p = planCapacity(three, [vm('a', { observed: { cpuP95Pct: 5, memP95Bytes: 2 * GiB, samples: 99, hours: 9 } }), vm('b')], { basis: 'observed' });
    expect(p.demand.observedVms).toBe(1);
    expect(p.notes.join(' ')).toMatch(/1 of 2 scanned VMs have no usable metrics history/);
    expect(p.demand.vcpu).toBe(1 + 8);
    expect(p.demand.allocatedVcpu).toBe(16);
  });
});

describe('inputs', () => {
  it('observedUsage needs enough history and computes p95', () => {
    // Counters are cumulative: every step adds 100 jiffies, 90 idle (10% busy) — or 50 idle
    // (50% busy) one step in ten. Memory sits at 10 GiB and spikes to 30 GiB one sample in ten.
    const mk = (n: number, stepMs: number): Sample[] => {
      let total = 0, idle = 0;
      return Array.from({ length: n }, (_, i) => {
        total += 100; idle += i % 10 === 9 ? 50 : 90;
        return { at: i * stepMs, source: 'x', reachable: true, cpuTotal: total, cpuIdle: idle, memUsed: (i % 10 === 9 ? 30 : 10) * GiB, memTotal: 64 * GiB };
      });
    };
    expect(observedUsage(mk(10, 600_000))).toBeUndefined(); // too few
    expect(observedUsage(mk(40, 60_000))).toBeUndefined(); // under an hour
    const o = observedUsage(mk(40, 300_000))!;
    expect(o.samples).toBe(40);
    expect(o.hours).toBe(3.3);
    expect(o.memP95Bytes).toBe(30 * GiB);
    expect(o.cpuP95Pct).toBe(50); // 10% of steps at 50% → the 95th percentile is a spike
    // Spikes in only 5% of samples do not reach the 95th percentile.
    const rare = mk(40, 300_000).map((x, i) => ({ ...x, memUsed: (i === 39 || i === 19 ? 30 : 10) * GiB }));
    expect(observedUsage(rare)!.memP95Bytes).toBe(10 * GiB);
  });

  it('expandExtraVms and expandPlannedHosts bound what a request can ask for', () => {
    expect(expandExtraVms([{ label: 'Windows app servers', count: 3, vcpus: 4, memoryGiB: 16, diskGiB: 120 }]).map((v) => v.name))
      .toEqual(['Windows app servers #1', 'Windows app servers #2', 'Windows app servers #3']);
    expect(expandExtraVms([{ label: 'x', count: 1e9 }])).toHaveLength(5000);
    expect(expandPlannedHosts([{ count: 500 }])).toHaveLength(64);
    expect(expandPlannedHosts('nope' as any)).toEqual([]);
  });

  it('normalizeOptions clamps every field', () => {
    const o = normalizeOptions({ cpuRatio: 100, memRatio: 0, failures: 2.6, basis: 'nonsense', targetPct: 5, sharedStorageTiB: -1, thin: 0 });
    expect(o).toMatchObject({ cpuRatio: 16, memRatio: 1, failures: 3, basis: 'allocated', targetPct: 10, thin: false });
    expect(o.sharedStorageTiB).toBeUndefined();
    expect(normalizeOptions(undefined)).toEqual(DEFAULT_OPTIONS);
  });
});
