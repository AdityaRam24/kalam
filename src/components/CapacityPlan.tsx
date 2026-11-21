// VME capacity plan — will the VMs fit on the target servers, with room to
// lose a host, and how many servers / socket licences does that take?
//
// The arithmetic lives on the server (server/hardware/capacity.ts, tested);
// this page gathers the choices — which servers, which VMs, servers you plan
// to buy, VM groups Trinetra cannot SSH into, and the planning rules — and
// shows the answer. Choices are remembered in this browser only.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, Info, Plus, Trash2, Server, Boxes, Calculator, Download, HelpCircle } from 'lucide-react';
import { downloadText, stamp, toCsv } from '../lib/health';

type ResourceId = 'cpu' | 'memory' | 'storage' | 'gpu';
interface Options {
  cpuRatio: number; memRatio: number; failures: number; reserveThreads: number; reserveMemGiB: number; targetPct: number;
  basis: 'allocated' | 'observed'; observedHeadroomPct: number; thin: boolean; storageGrowthPct: number; sharedStorageTiB?: number;
}
interface PlannedSpec { label: string; count: number; sockets: number; coresPerSocket: number; threadsPerCore: number; memoryGiB: number; diskTiB: number; gpus: number }
interface ExtraSpec { label: string; count: number; vcpus: number; memoryGiB: number; diskGiB: number; gpus: number }
interface Fit { id: ResourceId; label: string; unit: 'vCPU' | 'bytes' | 'GPUs'; demand: number; capacity: number; capacityAllUp: number; utilPct: number | null; status: 'ok' | 'tight' | 'short' | 'n/a' }
interface Placement { host: string; planned?: boolean; vms: string[]; vcpu: number; vcpuCap: number; memoryBytes: number; memCap: number; gpus: number; gpuCap: number }
interface Plan {
  options: Options;
  supply: { hosts: number; planned: number; sockets: number; threads: number; memoryBytes: number; diskBytes: number; gpus: number; failedHosts: string[] };
  demand: { vms: number; manual: number; vcpu: number; memoryBytes: number; storageBytes: number; gpus: number; observedVms: number; allocatedVcpu: number; allocatedMemoryBytes: number };
  resources: Fit[]; binding?: ResourceId; verdict: 'fits' | 'tight' | 'short' | 'empty'; summary: string;
  hostsNeeded?: { spec: string; perHost: { vcpu: number; memoryBytes: number; gpus: number; sockets: number }; count: number; failover: number; sockets: number; by: ResourceId };
  placement: Placement[]; unplaced: Array<{ vm: string; reason: string }>; notes: string[];
}
interface HostCand { name: string; model?: string; sockets: number; threads: number; memoryBytes: number; diskBytes: number; gpus: number; kvm: boolean }
interface VmCand { name: string; vcpus: number; memoryBytes: number; diskBytes: number; usedDiskBytes?: number; gpus: number; virt?: string; observed?: { cpuP95Pct: number; memP95Bytes: number; samples: number; hours: number } }
interface Saved { targets: string[] | null; vms: string[] | null; planned: PlannedSpec[]; extra: ExtraSpec[]; options: Options }

const STORE_KEY = 'trinetra_capacity_plan';
const DEFAULT_OPTIONS: Options = {
  cpuRatio: 4, memRatio: 1, failures: 1, reserveThreads: 2, reserveMemGiB: 8, targetPct: 80,
  basis: 'allocated', observedHeadroomPct: 25, thin: true, storageGrowthPct: 20,
};
const NEW_PLANNED: PlannedSpec = { label: 'ProLiant DL380 Gen11', count: 3, sockets: 2, coresPerSocket: 32, threadsPerCore: 2, memoryGiB: 1024, diskTiB: 8, gpus: 0 };
const NEW_EXTRA: ExtraSpec = { label: 'Windows VMs', count: 10, vcpus: 4, memoryGiB: 16, diskGiB: 120, gpus: 0 };

const load = (): Saved => {
  const blank: Saved = { targets: null, vms: null, planned: [], extra: [], options: DEFAULT_OPTIONS };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return s ? { ...blank, ...s, options: { ...DEFAULT_OPTIONS, ...(s.options || {}) } } : blank;
  } catch { return blank; }
};

const GiB = 1024 ** 3;
const bytes = (b?: number) => {
  if (!b) return '0';
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(1)} TiB`;
  return `${Math.round(b / GiB)} GiB`;
};
const amount = (f: Fit, v: number) => (f.unit === 'bytes' ? bytes(v) : `${Math.round(v)} ${f.unit}`);

const STATUS: Record<Fit['status'] | Plan['verdict'], { color: string; label: string; icon: React.ComponentType<any> }> = {
  ok: { color: 'var(--status-success)', label: 'OK', icon: CheckCircle2 },
  fits: { color: 'var(--status-success)', label: 'Fits', icon: CheckCircle2 },
  tight: { color: 'var(--status-warning)', label: 'Tight', icon: AlertTriangle },
  short: { color: 'var(--status-error)', label: 'Short', icon: XCircle },
  'n/a': { color: 'var(--text-muted)', label: 'n/a', icon: HelpCircle },
  empty: { color: 'var(--text-muted)', label: 'Nothing to plan', icon: Info },
};

const numInput: React.CSSProperties = {
  width: 72, padding: '4px 6px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border-color)',
  background: 'var(--bg-secondary)', color: 'var(--text-primary)',
};
const textInput: React.CSSProperties = { ...numInput, width: 170 };
const cell: React.CSSProperties = { padding: '4px 6px' };

/**
 * One resource as a meter: the track is the capacity with every host up, the
 * fill is the demand, and the tick is where usable capacity ends once the
 * failover host(s) are set aside. Fill color carries status; the track is a
 * lighter step of the same color; status is also spelled out beside it.
 */
const Meter: React.FC<{ f: Fit; failures: number; binding: boolean }> = ({ f, failures, binding }) => {
  const s = STATUS[f.status];
  const Icon = s.icon;
  const scale = Math.max(f.capacityAllUp, f.demand, 1);
  const fillPct = Math.min(100, (f.demand / scale) * 100);
  const tickPct = (f.capacity / scale) * 100;
  const tip = `${f.label}: ${amount(f, f.demand)} needed of ${amount(f, f.capacity)} usable` +
    `${failures && f.capacity !== f.capacityAllUp ? ` with ${failures} host${failures === 1 ? '' : 's'} down (${amount(f, f.capacityAllUp)} with all up)` : ''}` +
    `${f.utilPct !== null ? ` — ${f.utilPct}%` : ''}`;
  return (
    <div title={tip} role="img" aria-label={tip} style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
        <span style={{ color: 'var(--text-heading)', fontWeight: 600 }}>
          {f.label}{binding && <span className="badge neutral" style={{ textTransform: 'none', fontSize: 10, marginLeft: 6 }}>the limit</span>}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)' }}>
          <Icon size={13} color={s.color} /> {s.label}{f.utilPct !== null ? ` · ${f.utilPct}%` : ''}
        </span>
      </div>
      <div style={{ position: 'relative', height: 8, borderRadius: 4, marginTop: 6, background: `color-mix(in srgb, ${s.color} 18%, transparent)` }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fillPct}%`, borderRadius: 4, background: s.color }} />
        {failures > 0 && f.capacity < f.capacityAllUp && (
          <div style={{ position: 'absolute', left: `calc(${tickPct}% - 1px)`, top: -3, bottom: -3, width: 2, borderRadius: 1, background: 'var(--text-heading)' }} />
        )}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
        {amount(f, f.demand)} needed · {amount(f, f.capacity)} usable{failures && f.capacity !== f.capacityAllUp ? ` after failover (${amount(f, f.capacityAllUp)} all up)` : ''}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label title={hint} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11.5, color: 'var(--text-secondary)' }}>
    {label}
    {children}
  </label>
);

export const CapacityPlan: React.FC<{ scanAt?: string }> = ({ scanAt }) => {
  const [saved, setSaved] = useState<Saved>(load);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [hosts, setHosts] = useState<HostCand[]>([]);
  const [vms, setVms] = useState<VmCand[]>([]);
  const [defaults, setDefaults] = useState<{ targets: string[]; vms: string[] }>({ targets: [], vms: [] });
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);

  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* private mode */ } }, [saved]);

  // Recompute on every change, debounced; a slower older answer never overwrites a newer one.
  useEffect(() => {
    const my = ++ticket.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const d = await fetch('/api/hardware/capacity', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ targets: saved.targets ?? undefined, vms: saved.vms ?? undefined, planned: saved.planned, extra: saved.extra, options: saved.options }),
        }).then((r) => r.json());
        if (my !== ticket.current) return;
        if (d.error) { setError(d.error); return; }
        setError('');
        setPlan(d.plan); setHosts(d.candidates.hosts); setVms(d.candidates.vms); setDefaults(d.defaults); setMissing(d.missing || []);
      } catch (e: any) {
        if (my === ticket.current) setError(e.message);
      } finally {
        if (my === ticket.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [saved, scanAt]);

  const targets = saved.targets ?? defaults.targets;
  const chosen = saved.vms ?? defaults.vms;
  const opt = saved.options;
  const setOpt = (patch: Partial<Options>) => setSaved((s) => ({ ...s, options: { ...s.options, ...patch } }));
  const toggle = (key: 'targets' | 'vms', name: string, list: string[]) =>
    setSaved((s) => ({ ...s, [key]: list.includes(name) ? list.filter((n) => n !== name) : [...list, name] }));
  const editPlanned = (i: number, patch: Partial<PlannedSpec>) => setSaved((s) => ({ ...s, planned: s.planned.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const editExtra = (i: number, patch: Partial<ExtraSpec>) => setSaved((s) => ({ ...s, extra: s.extra.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  const verdict = plan ? STATUS[plan.verdict] : null;
  const VerdictIcon = verdict?.icon || Info;
  const savings = plan && plan.options.basis === 'observed' && plan.demand.observedVms
    ? { vcpu: plan.demand.allocatedVcpu - plan.demand.vcpu, mem: plan.demand.allocatedMemoryBytes - plan.demand.memoryBytes } : null;
  const unplacedSet = useMemo(() => new Set((plan?.unplaced || []).map((u) => u.vm)), [plan]);

  const exportCsv = () => {
    if (!plan) return;
    const rows: Array<Array<string | number | undefined>> = [['Section', 'Name', 'Value', 'Detail']];
    rows.push(['verdict', plan.verdict, plan.summary, '']);
    for (const f of plan.resources) rows.push(['resource', f.label, f.utilPct ?? '', `${amount(f, f.demand)} needed / ${amount(f, f.capacity)} usable (${amount(f, f.capacityAllUp)} all up)`]);
    if (plan.hostsNeeded) rows.push(['hosts needed', plan.hostsNeeded.spec, plan.hostsNeeded.count, `${plan.hostsNeeded.sockets} socket licences, incl. ${plan.hostsNeeded.failover} for failover`]);
    for (const p of plan.placement) rows.push(['placement', p.host, p.vms.length, p.vms.join(' ')]);
    for (const u of plan.unplaced) rows.push(['unplaced', u.vm, '', u.reason]);
    for (const [k, v] of Object.entries(plan.options)) rows.push(['option', k, String(v), '']);
    downloadText(toCsv(rows), `trinetra-vme-capacity-${stamp()}.csv`, 'text/csv');
  };

  return (
    <>
      {/* ── The answer ── */}
      <div className="panel-card" style={{ borderLeft: `3px solid ${verdict?.color || 'var(--border-color)'}` }}>
        <div className="panel-card-title">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <VerdictIcon size={18} color={verdict?.color} /> {plan ? plan.summary : busy ? 'Planning…' : 'No plan yet'}
          </h2>
          <button className="btn secondary" onClick={exportCsv} disabled={!plan} style={{ padding: '6px 12px', fontSize: 12 }}><Download size={13} /> CSV</button>
        </div>
        {error && <div style={{ color: 'var(--status-error)', fontSize: 12.5 }}><AlertTriangle size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
        {plan && (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <span><strong>{plan.demand.vms}</strong> VM{plan.demand.vms === 1 ? '' : 's'}{plan.demand.manual ? ` (${plan.demand.manual} typed in)` : ''} → <strong>{plan.supply.hosts}</strong> server{plan.supply.hosts === 1 ? '' : 's'}{plan.supply.planned ? ` (${plan.supply.planned} planned)` : ''}</span>
              <span>sized on <strong>{plan.options.basis === 'observed' ? 'observed use (p95)' : 'allocated size'}</strong></span>
              {plan.supply.failedHosts.length > 0 && <span>failover: survives losing {plan.supply.failedHosts.join(', ')}</span>}
              {savings && (savings.vcpu > 0 || savings.mem > 0) && (
                <span style={{ color: 'var(--text-heading)' }}>right-sizing frees {savings.vcpu} vCPU and {bytes(savings.mem)} vs. allocated</span>
              )}
            </div>
            {plan.hostsNeeded && (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-primary)' }}>
                <Calculator size={14} style={{ verticalAlign: -2 }} /> In one server model, this takes <strong>{plan.hostsNeeded.count} × {plan.hostsNeeded.spec}</strong>
                {plan.hostsNeeded.failover ? ` (incl. ${plan.hostsNeeded.failover} for failover)` : ''} = <strong>{plan.hostsNeeded.sockets} VME socket licences</strong>
                <span style={{ color: 'var(--text-muted)' }}> · sized by {plan.hostsNeeded.by}</span>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18, marginTop: 14 }}>
              {plan.resources.map((f) => <Meter key={f.id} f={f} failures={plan.supply.failedHosts.length} binding={plan.binding === f.id && plan.verdict !== 'empty'} />)}
            </div>
            {plan.supply.failedHosts.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                Bar = capacity with every host up; the tick marks where usable capacity ends with {plan.supply.failedHosts.length} host{plan.supply.failedHosts.length === 1 ? '' : 's'} down. Demand must stay left of the tick.
              </div>
            )}
            {plan.notes.map((n) => <div key={n} style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}><Info size={12} style={{ verticalAlign: -2 }} /> {n}</div>)}
            {missing.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                <Info size={12} style={{ verticalAlign: -2 }} /> Not in the plan until scanned on the Inventory view: {missing.join(', ')}.
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Planning rules ── */}
      <div className="panel-card">
        <div className="panel-card-title"><h2><Calculator size={18} /> Planning rules</h2>
          <button className="btn secondary" onClick={() => setOpt(DEFAULT_OPTIONS)} style={{ padding: '4px 10px', fontSize: 12 }}>Reset</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          <Field label="Size VMs on" hint="Allocated: what each VM is given today. Observed: its 95th-percentile use from Observability, plus headroom — what it would need if right-sized.">
            <select value={opt.basis} onChange={(e) => setOpt({ basis: e.target.value as Options['basis'] })} style={{ ...numInput, width: 150 }}>
              <option value="allocated">allocated size</option>
              <option value="observed">observed use (p95)</option>
            </select>
          </Field>
          {opt.basis === 'observed' && (
            <Field label="Headroom on p95 %"><input type="number" min={0} max={200} value={opt.observedHeadroomPct} onChange={(e) => setOpt({ observedHeadroomPct: Number(e.target.value) })} style={numInput} /></Field>
          )}
          <Field label="vCPU : thread" hint="CPU overcommit. 4:1 is a common ceiling for general workloads; use 1–2 for latency-sensitive ones.">
            <select value={opt.cpuRatio} onChange={(e) => setOpt({ cpuRatio: Number(e.target.value) })} style={numInput}>
              {[1, 2, 3, 4, 6, 8].map((r) => <option key={r} value={r}>{r}:1</option>)}
            </select>
          </Field>
          <Field label="Memory overcommit" hint="1.0 = none, the safe default on KVM.">
            <select value={opt.memRatio} onChange={(e) => setOpt({ memRatio: Number(e.target.value) })} style={numInput}>
              {[1, 1.25, 1.5].map((r) => <option key={r} value={r}>{r.toFixed(2)}</option>)}
            </select>
          </Field>
          <Field label="Survive host failures" hint="The plan must still fit after losing this many of the largest hosts (N+1 = 1).">
            <select value={opt.failures} onChange={(e) => setOpt({ failures: Number(e.target.value) })} style={numInput}>
              {[0, 1, 2].map((r) => <option key={r} value={r}>{r === 0 ? 'none' : `N+${r}`}</option>)}
            </select>
          </Field>
          <Field label="Target use %" hint="Plan to this share of what is left, not 100%.">
            <input type="number" min={10} max={100} value={opt.targetPct} onChange={(e) => setOpt({ targetPct: Number(e.target.value) })} style={numInput} />
          </Field>
          <Field label="Host reserve (threads)"><input type="number" min={0} max={64} value={opt.reserveThreads} onChange={(e) => setOpt({ reserveThreads: Number(e.target.value) })} style={numInput} /></Field>
          <Field label="Host reserve (GiB)"><input type="number" min={0} max={512} value={opt.reserveMemGiB} onChange={(e) => setOpt({ reserveMemGiB: Number(e.target.value) })} style={numInput} /></Field>
          <Field label="Storage" hint="Thin: used space is copied; thick: the provisioned size.">
            <select value={opt.thin ? 'thin' : 'thick'} onChange={(e) => setOpt({ thin: e.target.value === 'thin' })} style={numInput}>
              <option value="thin">thin</option><option value="thick">thick</option>
            </select>
          </Field>
          <Field label="Growth %"><input type="number" min={0} max={300} value={opt.storageGrowthPct} onChange={(e) => setOpt({ storageGrowthPct: Number(e.target.value) })} style={numInput} /></Field>
          <Field label="Shared datastore (TiB)" hint="SAN / NFS capacity the VMs will live on. Empty = use the target hosts' local disks.">
            <input type="number" min={0} step={0.5} value={opt.sharedStorageTiB ?? ''} placeholder="local disks"
              onChange={(e) => setOpt({ sharedStorageTiB: e.target.value === '' ? undefined : Number(e.target.value) })} style={{ ...numInput, width: 96 }} />
          </Field>
        </div>
      </div>

      {/* ── Supply and demand ── */}
      {/* Side by side only when there is room for the editors' columns; stacked otherwise. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 760px), 1fr))', gap: 16 }}>
        <div className="panel-card">
          <div className="panel-card-title"><h2><Server size={18} /> Target servers</h2>
            {saved.targets && <button className="btn secondary" onClick={() => setSaved((s) => ({ ...s, targets: null }))} style={{ padding: '4px 10px', fontSize: 12 }}>Default</button>}
          </div>
          {hosts.length === 0 && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--text-secondary)' }}>No scanned bare-metal servers. Add the servers you plan to use below, or scan them on the Inventory view.</p>}
          {hosts.map((h) => (
            <label key={h.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '3px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={targets.includes(h.name)} onChange={() => toggle('targets', h.name, targets)} />
              <strong>{h.name}</strong>
              <span style={{ color: 'var(--text-muted)' }}>{h.model || ''} · {h.sockets}S / {h.threads}T · {bytes(h.memoryBytes)}{h.gpus ? ` · ${h.gpus} GPU` : ''}</span>
              {h.kvm && <span className="badge running" style={{ textTransform: 'none', fontSize: 10 }}>KVM</span>}
            </label>
          ))}
          <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text-heading)', margin: '12px 0 6px' }}>Servers to buy (planned)</div>
          {saved.planned.length > 0 && (
            <div className="table-wrapper">
              <table className="resource-table">
                <thead><tr><th>Model</th><th>Count</th><th>Sockets</th><th>Cores/socket</th><th>Threads/core</th><th>RAM GiB</th><th>Disk TiB</th><th>GPUs</th><th></th></tr></thead>
                <tbody>{saved.planned.map((p, i) => (
                  <tr key={i}>
                    <td style={cell}><input value={p.label} onChange={(e) => editPlanned(i, { label: e.target.value })} style={textInput} /></td>
                    {(['count', 'sockets', 'coresPerSocket', 'threadsPerCore', 'memoryGiB', 'diskTiB', 'gpus'] as const).map((k) => (
                      <td key={k} style={cell}><input type="number" min={0} value={p[k]} onChange={(e) => editPlanned(i, { [k]: Number(e.target.value) })} style={{ ...numInput, width: 64 }} /></td>
                    ))}
                    <td style={cell}><button className="btn secondary" title="Remove" onClick={() => setSaved((s) => ({ ...s, planned: s.planned.filter((_, j) => j !== i) }))} style={{ padding: '3px 6px' }}><Trash2 size={12} /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <button className="btn secondary" onClick={() => setSaved((s) => ({ ...s, planned: [...s.planned, NEW_PLANNED] }))} style={{ padding: '4px 10px', fontSize: 12, marginTop: 6 }}><Plus size={12} /> Add planned servers</button>
        </div>

        <div className="panel-card">
          <div className="panel-card-title"><h2><Boxes size={18} /> VMs to move</h2>
            {saved.vms && <button className="btn secondary" onClick={() => setSaved((s) => ({ ...s, vms: null }))} style={{ padding: '4px 10px', fontSize: 12 }}>Default</button>}
          </div>
          {vms.length === 0 && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--text-secondary)' }}>No scanned VMs. Add VM groups below (e.g. from a vCenter export), or add the VMs on K8s Nodes and scan them.</p>}
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {vms.map((v) => (
              <label key={v.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '3px 0', cursor: 'pointer', flexWrap: 'wrap' }}>
                <input type="checkbox" checked={chosen.includes(v.name)} onChange={() => toggle('vms', v.name, chosen)} />
                <strong style={{ color: unplacedSet.has(v.name) ? 'var(--status-error)' : undefined }}>{v.name}</strong>
                <span style={{ color: 'var(--text-muted)' }}>
                  {v.vcpus} vCPU · {bytes(v.memoryBytes)} · {bytes(v.usedDiskBytes ?? v.diskBytes)}{v.usedDiskBytes !== undefined ? ' used' : ''}{v.gpus ? ` · ${v.gpus} GPU` : ''}
                </span>
                {v.observed
                  ? <span className="badge neutral" style={{ textTransform: 'none', fontSize: 10 }} title={`${v.observed.samples} samples over ${v.observed.hours} h`}>p95 {v.observed.cpuP95Pct}% CPU · {bytes(v.observed.memP95Bytes)}</span>
                  : <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>no history</span>}
                {(v.virt === 'kvm' || v.virt === 'qemu') && <span className="badge running" style={{ textTransform: 'none', fontSize: 10 }}>already KVM</span>}
              </label>
            ))}
          </div>
          <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text-heading)', margin: '12px 0 6px' }}>VM groups typed in (Windows, not in inventory)</div>
          {saved.extra.length > 0 && (
            <div className="table-wrapper">
              <table className="resource-table">
                <thead><tr><th>Group</th><th>Count</th><th>vCPU</th><th>RAM GiB</th><th>Disk GiB</th><th>GPUs</th><th></th></tr></thead>
                <tbody>{saved.extra.map((p, i) => (
                  <tr key={i}>
                    <td style={cell}><input value={p.label} onChange={(e) => editExtra(i, { label: e.target.value })} style={textInput} /></td>
                    {(['count', 'vcpus', 'memoryGiB', 'diskGiB', 'gpus'] as const).map((k) => (
                      <td key={k} style={cell}><input type="number" min={0} value={p[k]} onChange={(e) => editExtra(i, { [k]: Number(e.target.value) })} style={{ ...numInput, width: 64 }} /></td>
                    ))}
                    <td style={cell}><button className="btn secondary" title="Remove" onClick={() => setSaved((s) => ({ ...s, extra: s.extra.filter((_, j) => j !== i) }))} style={{ padding: '3px 6px' }}><Trash2 size={12} /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <button className="btn secondary" onClick={() => setSaved((s) => ({ ...s, extra: [...s.extra, NEW_EXTRA] }))} style={{ padding: '4px 10px', fontSize: 12, marginTop: 6 }}><Plus size={12} /> Add VM group</button>
        </div>
      </div>

      {/* ── Where they would land ── */}
      {plan && (plan.unplaced.length > 0 || plan.placement.some((p) => p.vms.length)) && (
        <div className="panel-card">
          <div className="panel-card-title"><h2><Server size={18} /> Where the VMs would land</h2>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>biggest VMs first, each onto the server with the most memory left — a sketch, not a schedule</span>
          </div>
          {plan.unplaced.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {plan.unplaced.slice(0, 20).map((u) => (
                <div key={u.vm} style={{ fontSize: 12.5, color: 'var(--text-primary)', padding: '3px 0' }}>
                  <XCircle size={13} color="var(--status-error)" style={{ verticalAlign: -2 }} /> <strong>{u.vm}</strong> <span style={{ color: 'var(--text-secondary)' }}>— {u.reason}</span>
                </div>
              ))}
              {plan.unplaced.length > 20 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>…and {plan.unplaced.length - 20} more</div>}
            </div>
          )}
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr><th>Server</th><th>VMs</th><th>vCPU used / usable</th><th>Memory used / usable</th><th>GPUs</th><th>Placed</th></tr></thead>
              <tbody>{plan.placement.map((p) => {
                const cpuPct = p.vcpuCap ? Math.round((p.vcpu / p.vcpuCap) * 100) : 0;
                const memPct = p.memCap ? Math.round((p.memoryBytes / p.memCap) * 100) : 0;
                return (
                  <tr key={p.host}>
                    <td><strong>{p.host}</strong>{p.planned && <span className="badge neutral" style={{ textTransform: 'none', fontSize: 10, marginLeft: 6 }}>planned</span>}</td>
                    <td>{p.vms.length}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.vcpu} / {p.vcpuCap} <span style={{ color: 'var(--text-muted)' }}>({cpuPct}%)</span></td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{bytes(p.memoryBytes)} / {bytes(p.memCap)} <span style={{ color: 'var(--text-muted)' }}>({memPct}%)</span></td>
                    <td>{p.gpuCap ? `${p.gpus} / ${p.gpuCap}` : '—'}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'normal', maxWidth: 420 }}>
                      {p.vms.slice(0, 8).join(', ')}{p.vms.length > 8 ? ` +${p.vms.length - 8} more` : ''}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
};

export default CapacityPlan;
