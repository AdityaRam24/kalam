// GPU utilization — which model is on which GPU, and how hard it is working.
//
// Kubernetes says who asked for GPUs (pod requests, node capacity); nvidia-smi
// run inside each GPU pod (`kubectl exec <pod> -- nvidia-smi …`) says what
// those GPUs are doing. The backend joins both (server/k8s/gpu.ts); this page
// lays it out per model, with every nvidia-smi view one click away.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Zap, RefreshCw, Server, Thermometer, Gauge, MemoryStick, Cpu, Search, Download, Terminal, X,
  AlertTriangle, Box, Info, Activity, Copy, Check,
} from 'lucide-react';
import { downloadText, stamp, toCsv } from '../lib/health';

interface GpuReading {
  index: number; uuid: string; name: string; busId: string; driver: string; pstate: string;
  tempC: number | null; utilPct: number | null; memUtilPct: number | null;
  memTotalMiB: number | null; memUsedMiB: number | null; memFreeMiB: number | null;
  powerW: number | null; powerLimitW: number | null; smClockMHz: number | null; memClockMHz: number | null;
  maxSmClockMHz: number | null; fanPct: number | null; persistence: string; computeMode: string; pcie: string;
  mig?: string; eccUncorrected?: number | null; throttle?: string[]; memTempC?: number | null; encoderSessions?: number | null;
  processes: Array<{ pid: string; name: string; usedMiB: number | null }>;
  source?: 'dcgm' | 'nvidia-smi'; xid?: number | null; engineActivePct?: number | null;
}
interface Finding { id: string; severity: 'critical' | 'warning' | 'info'; title: string; detail: string; subject?: string; host?: string }
interface HistPoint { t: number; util: number | null; mem: number | null }
interface DcgmInfo { exporters: number; read: number; error?: string; unassigned?: Record<string, number>; gpus: number; host?: string }
interface Workload {
  namespace: string; pod: string; container: string; node: string; phase: string; gpus: number; image: string; owner?: string;
  startedAt?: string; terminating?: boolean;
  model: { model?: string; server: string; evidence: Array<{ source: string; value: string }> };
  host?: string;
}
interface GpuNode {
  name: string; capacity: number; allocatable: number; allocated: number; product: string;
  memoryMiB: number | null; migStrategy: string; driver: string; cuda: string; host?: string;
}

const RAW_MODES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'summary', label: 'nvidia-smi', hint: 'The standard summary table' },
  { id: 'query', label: '-q', hint: 'Every attribute nvidia-smi knows' },
  { id: 'list', label: '-L', hint: 'List GPUs and UUIDs (and MIG devices)' },
  { id: 'topology', label: 'topo -m', hint: 'GPU/NIC interconnect matrix (NVLink, PCIe)' },
  { id: 'memory', label: 'memory + ECC', hint: '-q -d MEMORY,ECC' },
  { id: 'clocks', label: 'clocks + perf', hint: '-q -d CLOCK,PERFORMANCE (throttle reasons)' },
  { id: 'power', label: 'power + temp', hint: '-q -d POWER,TEMPERATURE' },
  { id: 'processes', label: 'processes', hint: '-q -d PIDS' },
  { id: 'help', label: '--help', hint: 'Every nvidia-smi option' },
];

const pctColor = (p: number | null | undefined) =>
  p === null || p === undefined ? 'var(--text-muted)' : p >= 90 ? 'var(--status-error)' : p >= 70 ? 'var(--status-warning)' : 'var(--status-success)';
const tempColor = (t: number | null | undefined) =>
  t === null || t === undefined ? 'var(--text-muted)' : t >= 85 ? 'var(--status-error)' : t >= 75 ? 'var(--status-warning)' : 'var(--text-primary)';
const n0 = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${Math.round(v)}${unit}`);
const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const startMs = (w: { startedAt?: string }) => (w.startedAt ? Date.parse(w.startedAt) || 0 : 0);
const isFinished = (w: { phase: string }) => w.phase === 'Succeeded' || w.phase === 'Failed';
const gib = (mib: number | null | undefined) => (mib === null || mib === undefined ? '—' : `${(mib / 1024).toFixed(mib >= 10240 ? 0 : 1)} GiB`);

// 6 h of compute utilization for one workload, 0–100%. Gaps stay gaps.
const Sparkline: React.FC<{ points: HistPoint[] }> = ({ points }) => {
  const W = 140, H = 30;
  const pts = points.filter((p) => p.util !== null);
  if (pts.length < 2) return null;
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - 2 - (Math.min(100, Math.max(0, v)) / 100) * (H - 4);
  const d = points.map((p, i) => p.util === null ? '' : `${i && points[i - 1].util !== null ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.util).toFixed(1)}`).join('');
  const avg = pts.reduce((a, p) => a + (p.util as number), 0) / pts.length;
  const mins = Math.round((t1 - t0) / 60000);
  return (
    <div title={`Compute utilization, last ${mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`} (${pts.length} readings), average ${Math.round(avg)}%`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--text-muted)' }}>
      <svg width={W} height={H} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 4 }}>
        <path d={d} fill="none" stroke={pctColor(avg)} strokeWidth={1.5} />
      </svg>
      <span>avg {Math.round(avg)}% · {mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`}</span>
    </div>
  );
};

const Meter: React.FC<{ pct: number | null; label: string; sub?: string }> = ({ pct, label, sub }) => (
  <div style={{ minWidth: 0 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 3 }}>
      <span>{label}</span>
      <span style={{ color: pctColor(pct), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{pct === null ? '—' : `${Math.round(pct)}%`}</span>
    </div>
    <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, height: '100%', background: pctColor(pct), transition: 'width .4s ease' }} />
    </div>
    {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{sub}</div>}
  </div>
);

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; color?: string }> = ({ icon, label, value, sub, color }) => (
  <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>{icon}{label}</div>
    <div style={{ fontSize: 22, fontWeight: 650, color: color || 'var(--text-heading)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
  </div>
);

interface Props { source: string; vmNames: string[] }

export const GpuUtilization: React.FC<Props> = ({ source, vmNames }) => {
  const [workloads, setWorkloads] = useState<Workload[]>([]);
  const [nodes, setNodes] = useState<GpuNode[]>([]);
  const [readings, setReadings] = useState<Record<string, { gpus: GpuReading[]; error?: string; source?: string }>>({});
  const [findings, setFindings] = useState<Finding[]>([]);
  const [history, setHistory] = useState<Record<string, HistPoint[]>>({});
  const [dcgm, setDcgm] = useState<DcgmInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [at, setAt] = useState('');
  const [skipped, setSkipped] = useState(0);

  const [live, setLive] = useState(true);
  const [interval, setIntervalSec] = useState(0);
  const [ns, setNs] = useState('all');
  const [query, setQuery] = useState('');
  const [showFinished, setShowFinished] = useState(false);
  // Workloads not present in the previous refresh — flagged so a new
  // deployment is obvious the moment it appears.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seenRef = useRef<Set<string> | null>(null);

  const [raw, setRaw] = useState<{ w: Workload; mode: string; output: string; command: string; loading: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const keyOf = (w: Workload) => `${w.host ? `${w.host}:` : ''}${w.namespace}/${w.pod}/${w.container}`;

  // Keyed by content, not identity (the parent rebuilds the array each render).
  const vmKey = vmNames.join('\n');

  // Every load gets a ticket; only the newest one may write state. Without
  // this, a slow refresh (nvidia-smi in many pods) finishing after a newer one
  // put the OLD snapshot back on screen, and auto-refresh stacked requests.
  const seqRef = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async (opts: { background?: boolean } = {}) => {
    if (opts.background && inFlight.current) return;
    const seq = ++seqRef.current;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const targets = source === 'all' ? (vmKey ? vmKey.split('\n') : []) : [source];
      const res = await Promise.all(targets.map(async (t) => {
        const params = new URLSearchParams();
        if (t !== 'local') params.set('vm', t);
        if (!live) params.set('probe', '0');
        const d = await fetch(`/api/gpu/overview?${params}`, { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: e.message }));
        return { t, d };
      }));
      if (seq !== seqRef.current) return; // a newer load has started; drop this one
      const W: Workload[] = [];
      const N: GpuNode[] = [];
      const R: Record<string, { gpus: GpuReading[]; error?: string; source?: string }> = {};
      const F: Finding[] = [];
      const H: Record<string, HistPoint[]> = {};
      const D: DcgmInfo[] = [];
      const errs: string[] = [];
      let skip = 0;
      for (const { t, d } of res) {
        if (d.error) { errs.push(source === 'all' ? `${t}: ${d.error}` : d.error); continue; }
        const host = source === 'all' ? t : undefined;
        for (const w of d.workloads || []) W.push(host ? { ...w, host } : w);
        for (const n of d.nodes || []) N.push(host ? { ...n, host } : n);
        for (const [k, v] of Object.entries(d.readings || {})) R[host ? `${host}:${k}` : k] = v as any;
        for (const [k, v] of Object.entries(d.history || {})) H[host ? `${host}:${k}` : k] = v as HistPoint[];
        for (const f of d.findings || []) F.push(host ? { ...f, host } : f);
        if (d.dcgm) D.push(host ? { ...d.dcgm, host } : d.dcgm);
        skip += d.skipped || 0;
      }
      W.sort((a, b) => Number(isFinished(a)) - Number(isFinished(b)) || startMs(b) - startMs(a));
      const keys = new Set(W.map(keyOf));
      const seen = seenRef.current;
      setFresh(seen ? new Set([...keys].filter((k) => !seen.has(k))) : new Set());
      seenRef.current = keys;
      setWorkloads(W);
      setNodes(N);
      setReadings(R);
      setFindings(F.sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity] - { critical: 0, warning: 1, info: 2 }[b.severity])));
      setHistory(H);
      setDcgm(D);
      setSkipped(skip);
      setAt(new Date().toLocaleTimeString());
      if (errs.length) setError(errs.join(' · '));
    } finally {
      if (seq === seqRef.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [source, vmKey, live]);

  // A different source is a different cluster: "new since last refresh" restarts.
  useEffect(() => { seenRef.current = null; }, [source, vmKey]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!interval) return;
    const id = setInterval(() => { if (!document.hidden) void load({ background: true }); }, interval * 1000);
    return () => clearInterval(id);
  }, [interval, load]);

  const openRaw = async (w: Workload, mode: string) => {
    setRaw({ w, mode, output: '', command: '', loading: true });
    try {
      const d = await fetch('/api/gpu/raw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vm: w.host || (source === 'local' || source === 'all' ? undefined : source), namespace: w.namespace, pod: w.pod, container: w.container, mode }),
      }).then((r) => r.json());
      setRaw({ w, mode, output: d.output || d.error || '', command: d.command || '', loading: false });
    } catch (e: any) {
      setRaw({ w, mode, output: e.message, command: '', loading: false });
    }
  };

  const namespaces = useMemo(() => Array.from(new Set(workloads.map((w) => w.namespace))).sort(), [workloads]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workloads.filter((w) =>
      (showFinished || !isFinished(w)) &&
      (ns === 'all' || w.namespace === ns) &&
      (!q || `${w.model.model || ''} ${w.model.server} ${w.pod} ${w.namespace} ${w.node} ${w.image} ${w.host || ''}`.toLowerCase().includes(q)));
  }, [workloads, ns, query, showFinished]);
  const finishedCount = useMemo(() => workloads.filter(isFinished).length, [workloads]);

  const allGpus = useMemo(() => Object.values(readings).flatMap((r) => r.gpus), [readings]);
  const kpi = useMemo(() => {
    const util = allGpus.map((g) => g.utilPct).filter((v): v is number => v !== null);
    const memUsed = allGpus.reduce((a, g) => a + (g.memUsedMiB || 0), 0);
    const memTotal = allGpus.reduce((a, g) => a + (g.memTotalMiB || 0), 0);
    const temps = allGpus.map((g) => g.tempC).filter((v): v is number => v !== null);
    const power = allGpus.reduce((a, g) => a + (g.powerW || 0), 0);
    return {
      capacity: nodes.reduce((a, n) => a + n.capacity, 0),
      allocated: nodes.reduce((a, n) => a + n.allocated, 0),
      models: new Set(workloads.filter((w) => !isFinished(w)).map((w) => w.model.model || `${w.namespace}/${w.pod}`)).size,
      avgUtil: util.length ? util.reduce((a, b) => a + b, 0) / util.length : null,
      memUsed, memTotal,
      hottest: temps.length ? Math.max(...temps) : null,
      power,
      throttled: allGpus.filter((g) => (g.throttle || []).some((t) => t !== 'GPU idle')).length,
      ecc: allGpus.reduce((a, g) => a + (g.eccUncorrected || 0), 0),
    };
  }, [allGpus, nodes, workloads]);

  const exportCsv = () => {
    const header = ['Host', 'Namespace', 'Pod', 'Container', 'Model', 'Server', 'Node', 'GPUs requested', 'GPU', 'Name', 'Util %', 'Mem used MiB', 'Mem total MiB', 'Temp C', 'Power W', 'Power limit W', 'SM MHz', 'P-state', 'Throttle', 'ECC uncorrected', 'Processes'];
    const body: Array<Array<string | number | null | undefined>> = [];
    for (const w of visible) {
      const r = readings[keyOf(w)];
      if (!r?.gpus.length) {
        body.push([w.host || source, w.namespace, w.pod, w.container, w.model.model, w.model.server, w.node, w.gpus]);
        continue;
      }
      for (const g of r.gpus) {
        body.push([w.host || source, w.namespace, w.pod, w.container, w.model.model, w.model.server, w.node, w.gpus, g.index, g.name, g.utilPct,
          g.memUsedMiB, g.memTotalMiB, g.tempC, g.powerW, g.powerLimitW, g.smClockMHz, g.pstate, (g.throttle || []).join('; '), g.eccUncorrected,
          g.processes.map((p) => `${p.name}(${p.pid}) ${p.usedMiB ?? '?'}MiB`).join('; ')]);
      }
    }
    downloadText(toCsv([header, ...body]), `trinetra-gpu-${source}-${stamp()}.csv`, 'text/csv');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Controls */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Zap size={18} /> GPU Utilization — models, devices and load</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}
              title="Read live GPU metrics: the DCGM exporter where the GPU Operator runs one, else nvidia-smi inside each running GPU pod (kubectl exec). Off = Kubernetes inventory only, much faster.">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live GPU readings
            </label>
            <select className="form-input" value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}
              title="Auto-refresh. Each refresh execs nvidia-smi in every GPU pod, so keep it modest on large clusters.">
              <option value={0}>Auto-refresh: off</option>
              <option value={15}>Every 15s</option>
              <option value={30}>Every 30s</option>
              <option value={60}>Every 60s</option>
            </select>
            <button className="btn secondary" onClick={exportCsv} disabled={!visible.length} style={{ padding: '6px 12px', fontSize: 12 }}>
              <Download size={13} /> CSV
            </button>
            <button className="btn primary" onClick={() => void load()} style={{ padding: '6px 12px', fontSize: 12 }}>
              <RefreshCw size={13} className={loading ? 'loader' : ''} /> {loading ? 'Reading GPUs…' : 'Refresh'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
          {at && <span>updated {at}</span>}
          {skipped > 0 && <span className="badge warning" style={{ textTransform: 'none' }}>{skipped} older running GPU containers not probed (limit TRINETRA_GPU_MAX_PROBES; newest are probed first)</span>}
          <span>Data: Kubernetes GPU requests + {dcgm.some((x) => x.read > 0)
            ? <>NVIDIA DCGM exporter ({dcgm.reduce((a, x) => a + x.read, 0)} of {dcgm.reduce((a, x) => a + x.exporters, 0)} GPU nodes) + <code className="code-tag">nvidia-smi</code> in pods it does not cover</>
            : <><code className="code-tag">kubectl exec &lt;pod&gt; -- nvidia-smi --query-gpu=…</code>{live && !dcgm.length ? ' (no DCGM exporter found — install the GPU Operator for exec-free readings)' : ''}</>}</span>
          {dcgm.filter((x) => x.error).map((x, i) => <span key={i} className="badge warning" style={{ textTransform: 'none' }}>{x.host ? `${x.host}: ` : ''}{x.error}</span>)}
        </div>
        {error && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--status-error)', fontSize: 12.5, marginTop: 10 }}>
            <AlertTriangle size={14} /> {error}
          </div>
        )}
      </div>

      {/* Headline numbers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <Stat icon={<Zap size={13} />} label="GPUs allocated" value={`${kpi.allocated}/${kpi.capacity}`} sub={`${nodes.length} GPU node${nodes.length === 1 ? '' : 's'}`} />
        <Stat icon={<Box size={13} />} label="Models / GPU workloads" value={`${kpi.models}`} sub={`${workloads.length - finishedCount} GPU container${workloads.length - finishedCount === 1 ? '' : 's'}${fresh.size ? ` · ${fresh.size} new` : ''}`} />
        <Stat icon={<Gauge size={13} />} label="Average GPU util" value={kpi.avgUtil === null ? '—' : `${Math.round(kpi.avgUtil)}%`} color={pctColor(kpi.avgUtil)} sub={`${allGpus.length} GPU${allGpus.length === 1 ? '' : 's'} read live`} />
        <Stat icon={<MemoryStick size={13} />} label="GPU memory used" value={kpi.memTotal ? `${Math.round((kpi.memUsed / kpi.memTotal) * 100)}%` : '—'} color={pctColor(kpi.memTotal ? (kpi.memUsed / kpi.memTotal) * 100 : null)} sub={kpi.memTotal ? `${gib(kpi.memUsed)} of ${gib(kpi.memTotal)}` : undefined} />
        <Stat icon={<Thermometer size={13} />} label="Hottest GPU" value={n0(kpi.hottest, '°C')} color={tempColor(kpi.hottest)} />
        <Stat icon={<Activity size={13} />} label="Power draw" value={kpi.power ? `${Math.round(kpi.power)} W` : '—'}
          sub={kpi.throttled || kpi.ecc ? `${kpi.throttled} throttled · ${kpi.ecc} ECC errors` : 'no throttling or ECC errors'}
          color={kpi.throttled || kpi.ecc ? 'var(--status-warning)' : undefined} />
      </div>

      {/* What needs attention */}
      {findings.length > 0 && (
        <div className="panel-card">
          <div className="panel-card-title"><h2><AlertTriangle size={18} /> What needs attention</h2>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>idle needs ≥1 h of history — keep the page open, or set TRINETRA_GPU_POLL_SEC</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {findings.map((f) => (
              <div key={`${f.host || ''}:${f.id}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                {f.severity === 'info' ? <Info size={14} style={{ color: 'var(--text-secondary)', marginTop: 2 }} />
                  : <AlertTriangle size={14} style={{ color: f.severity === 'critical' ? 'var(--status-error)' : 'var(--status-warning)', marginTop: 2 }} />}
                <div>
                  <div style={{ fontSize: 13, fontWeight: f.severity === 'info' ? 500 : 650, color: 'var(--text-heading)' }}>{f.host ? <span className="code-tag" style={{ marginRight: 6 }}>{f.host}</span> : null}{f.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{f.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Node inventory */}
      <div className="panel-card">
        <div className="panel-card-title"><h2><Server size={18} /> GPU nodes</h2></div>
        {nodes.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            {loading ? 'Reading nodes…' : 'No node advertises GPUs (nvidia.com/gpu, MIG, AMD or Intel). Is the NVIDIA device plugin / GPU operator running?'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr>{source === 'all' && <th>Host</th>}<th>Node</th><th>GPU model</th><th>Allocated</th><th>Capacity / allocatable</th><th>GPU memory</th><th>Driver / CUDA</th><th>MIG</th></tr></thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={`${n.host || ''}/${n.name}`}>
                    {source === 'all' && <td><span className="code-tag">{n.host}</span></td>}
                    <td><strong>{n.name}</strong></td>
                    <td style={{ fontSize: 12 }}>{n.product || '—'}</td>
                    <td style={{ minWidth: 160 }}><Meter pct={n.allocatable ? (n.allocated / n.allocatable) * 100 : null} label={`${n.allocated} of ${n.allocatable}`} /></td>
                    <td style={{ fontSize: 12 }}>{n.capacity} / {n.allocatable}</td>
                    <td style={{ fontSize: 12 }}>{n.memoryMiB ? gib(n.memoryMiB) : '—'}</td>
                    <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{n.driver || '—'}{n.cuda ? ` / ${n.cuda}` : ''}</td>
                    <td style={{ fontSize: 12 }}>{n.migStrategy || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-model cards */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Cpu size={18} /> What runs on the GPUs</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {finishedCount > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}
                title="Pods that completed or failed still carry their GPU request in the spec, but hold no GPU now.">
                <input type="checkbox" checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)} /> Show {finishedCount} finished
              </label>
            )}
            <select className="form-input" value={ns} onChange={(e) => setNs(e.target.value)} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}>
              <option value="all">All namespaces</option>
              {namespaces.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
              <input className="form-input" placeholder="model, pod, node, image…" value={query} onChange={(e) => setQuery(e.target.value)}
                style={{ padding: '5px 10px 5px 28px', fontSize: 12, width: 220 }} />
            </div>
          </div>
        </div>

        {visible.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            {loading ? 'Looking for GPU workloads…' : workloads.length ? (finishedCount === workloads.length && !showFinished ? 'Only finished GPU pods remain — tick "Show finished" to see them.' : 'Nothing matches these filters.') : 'No pod on this cluster requests a GPU.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {visible.map((w) => {
              const r = readings[keyOf(w)];
              return (
                <div key={keyOf(w)} style={{ border: '1px solid var(--border-color)', borderLeft: '3px solid var(--hpe-green)', borderRadius: 10, padding: 14, background: 'var(--bg-tertiary)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Box size={15} style={{ color: 'var(--hpe-green)' }} />
                        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-heading)', wordBreak: 'break-all' }}>{w.model.model || 'Unidentified model'}</span>
                        <span className="badge running" style={{ textTransform: 'none' }}>{w.model.server}</span>
                        <span className={`badge ${w.terminating ? 'warning' : w.phase === 'Running' ? 'running' : w.phase === 'Pending' ? 'warning' : isFinished(w) ? 'neutral' : 'error'}`} style={{ textTransform: 'none' }}>{w.terminating ? 'Terminating' : w.phase}</span>
                        {fresh.has(keyOf(w)) && <span className="badge running" style={{ textTransform: 'none' }}>new</span>}
                        {w.startedAt && <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title={w.startedAt}>started {ago(w.startedAt)}</span>}
                        {r?.source && <span className="badge neutral" style={{ textTransform: 'none' }} title={r.source === 'dcgm' ? 'Read from the NVIDIA DCGM exporter on the node' : 'Read by running nvidia-smi inside this pod'}>{r.source === 'dcgm' ? 'DCGM' : 'nvidia-smi'}</span>}
                        <span className="badge neutral" style={{ textTransform: 'none' }}>{w.gpus} GPU{w.gpus === 1 ? '' : 's'} requested</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                        {w.host ? `${w.host} · ` : ''}{w.namespace}/{w.pod} · container {w.container} · node {w.node}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, wordBreak: 'break-all' }}>image {w.image}{w.owner ? ` · owner ${w.owner}` : ''}</div>
                      {history[keyOf(w)] && <div style={{ marginTop: 6 }}><Sparkline points={history[keyOf(w)]} /></div>}
                      {w.model.evidence.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }} title="Where the model name was found">
                          <Info size={12} style={{ color: 'var(--text-muted)', marginTop: 2 }} />
                          {w.model.evidence.slice(0, 6).map((e, i) => (
                            <span key={i} style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border-color)', color: 'var(--text-secondary)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${e.source}: ${e.value}`}>
                              <span style={{ color: 'var(--text-muted)' }}>{e.source}</span> {e.value}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 420, justifyContent: 'flex-end' }}>
                      {RAW_MODES.map((m) => (
                        <button key={m.id} className="btn secondary" title={`${m.hint} — runs in this pod`}
                          disabled={w.phase !== 'Running'} onClick={() => void openRaw(w, m.id)}
                          style={{ padding: '3px 8px', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                          <Terminal size={11} /> {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Live readings */}
                  {w.phase !== 'Running' ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 0' }}>Not running — no live GPU reading.</p>
                  ) : w.terminating ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 0' }}>Terminating — not probed; its replacement, if any, is listed above.</p>
                  ) : !live ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 0' }}>Live GPU readings are off.</p>
                  ) : !r ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 0' }}>{loading ? 'Reading nvidia-smi…' : 'Not probed in this refresh.'}</p>
                  ) : r.error ? (
                    <p style={{ fontSize: 12, color: 'var(--status-warning)', margin: '10px 0 0' }}><AlertTriangle size={12} style={{ verticalAlign: -2 }} /> {r.error}</p>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 10, marginTop: 12 }}>
                      {r.gpus.map((g) => {
                        const memPct = g.memTotalMiB ? ((g.memUsedMiB || 0) / g.memTotalMiB) * 100 : null;
                        const powPct = g.powerLimitW ? ((g.powerW || 0) / g.powerLimitW) * 100 : null;
                        const throttle = (g.throttle || []).filter((t) => t !== 'GPU idle');
                        return (
                          <div key={g.uuid} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 12 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                              <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text-heading)' }}>GPU {g.index} · {g.name}</span>
                              <span style={{ fontSize: 11, color: tempColor(g.tempC), display: 'flex', alignItems: 'center', gap: 3 }}><Thermometer size={11} />{n0(g.tempC, '°C')}</span>
                            </div>
                            <div style={{ display: 'grid', gap: 8 }}>
                              <Meter pct={g.utilPct} label="Compute (SM) utilization" />
                              <Meter pct={memPct} label="Memory used" sub={`${gib(g.memUsedMiB)} of ${gib(g.memTotalMiB)} · bandwidth ${n0(g.memUtilPct, '%')}`} />
                              <Meter pct={powPct} label="Power" sub={`${n0(g.powerW, ' W')} of ${n0(g.powerLimitW, ' W')} limit`} />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', fontSize: 11, color: 'var(--text-secondary)', marginTop: 10 }}>
                              <span>SM clock <b>{n0(g.smClockMHz)}</b>/{n0(g.maxSmClockMHz)} MHz</span>
                              <span>Mem clock <b>{n0(g.memClockMHz)}</b> MHz</span>
                              <span>P-state <b>{g.pstate || '—'}</b></span>
                              <span>Fan <b>{n0(g.fanPct, '%')}</b></span>
                              <span>PCIe <b>{g.pcie || '—'}</b></span>
                              <span>MIG <b>{g.mig || '—'}</b></span>
                              <span>ECC uncorrected <b style={{ color: g.eccUncorrected ? 'var(--status-error)' : undefined }}>{g.eccUncorrected ?? '—'}</b></span>
                              <span>Persistence <b>{g.persistence || '—'}</b></span>
                              <span>Compute mode <b>{g.computeMode || '—'}</b></span>
                              <span>Driver <b>{g.driver || '—'}</b></span>
                              {g.engineActivePct != null && <span title="DCGM profiling: share of time the compute engine was busy — more honest than 'utilization'">Engine active <b>{n0(g.engineActivePct, '%')}</b></span>}
                              {g.xid ? <span style={{ color: 'var(--status-error)' }}>XID error <b>{g.xid}</b></span> : null}
                            </div>
                            {throttle.length > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--status-warning)', marginTop: 8 }}>
                                <AlertTriangle size={11} style={{ verticalAlign: -1 }} /> Clocks held back: {throttle.join(', ')}
                              </div>
                            )}
                            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 8, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{g.uuid} · {g.busId}</div>
                            {g.processes.length > 0 && (
                              <div style={{ marginTop: 8 }}>
                                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 3 }}>Processes on this GPU</div>
                                {g.processes.map((p) => (
                                  <div key={p.pid} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.name}>{p.pid} {p.name}</span>
                                    <span>{p.usedMiB === null ? '—' : gib(p.usedMiB)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Raw nvidia-smi output */}
      {raw && (
        <div className="modal-overlay" onClick={() => setRaw(null)}>
          <div className="modal-content" style={{ maxWidth: 1000, width: '94vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Terminal size={16} /> {raw.w.namespace}/{raw.w.pod}</h3>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className="icon-btn secondary" title="Copy output" onClick={() => {
                  navigator.clipboard?.writeText(raw.output).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
                }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
                <button className="icon-btn" onClick={() => setRaw(null)}><X size={16} /></button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
              {RAW_MODES.map((m) => (
                <button key={m.id} className={`subnav-pill-btn ${raw.mode === m.id ? 'active' : ''}`} title={m.hint}
                  onClick={() => void openRaw(raw.w, m.id)} style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{m.label}</button>
              ))}
            </div>
            {raw.command && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>$ {raw.command}</div>}
            <pre style={{ background: '#0b0f14', color: '#d5e3dd', borderRadius: 8, padding: 12, maxHeight: '62vh', overflow: 'auto', fontSize: 12, lineHeight: 1.4, margin: 0, whiteSpace: 'pre' }}>
              {raw.loading ? 'Running nvidia-smi…' : raw.output}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default GpuUtilization;
