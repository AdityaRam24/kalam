// Cluster resource metrics: CPU, memory, GPU and pod capacity — used and asked for.
//
// Two different numbers, and both matter:
//   - USED      what workloads are burning right now (metrics API / kubectl top)
//   - REQUESTED what the scheduler has promised them (sum of pod requests)
// A node can be 20% used and 100% requested — nothing new will schedule there
// even though it looks idle — so they are shown side by side, against each
// node's allocatable capacity. Without metrics-server only the requested half
// exists, and the panel says so instead of going blank.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu, MemoryStick, Zap, Layers, RefreshCw, Gauge, AlertTriangle, Server } from 'lucide-react';
import { formatBytes, formatCpu } from '../lib/health';

interface NodeTop { name: string; cpuMilli: number; cpuPct: number | null; memBytes: number; memPct: number | null; host?: string }
interface PodTop { namespace: string; name: string; cpuMilli: number; memBytes: number; host?: string }

interface Props {
  k8sResources: { pods: any[]; nodes: any[] };
  source: string;
  vmNames: string[];
  /** Compact = dashboard; full adds the per-pod tables' namespace filter. */
  compact?: boolean;
}

const pctColor = (p: number | null | undefined) =>
  p === null || p === undefined || !Number.isFinite(p) ? 'var(--text-muted)'
    : p >= 90 ? 'var(--status-error)' : p >= 75 ? 'var(--status-warning)' : 'var(--status-success)';

const Bar: React.FC<{ pct: number | null | undefined; label?: string; title?: string }> = ({ pct, label, title }) => {
  const v = pct === null || pct === undefined || !Number.isFinite(pct) ? null : Math.max(0, pct);
  return (
    <div title={title} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 7, borderRadius: 4, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, v ?? 0)}%`, height: '100%', background: pctColor(v), transition: 'width .4s ease' }} />
      </div>
      {label !== '' && (
        <span style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right', whiteSpace: 'nowrap', color: v === null ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {label ?? (v === null ? '—' : `${v.toFixed(0)}%`)}
        </span>
      )}
    </div>
  );
};

const Tile: React.FC<{ icon: React.ReactNode; label: string; value: string; sub: string; pct?: number | null }> = ({ icon, label, value, sub, pct }) => (
  <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>{icon}{label}</div>
    <div style={{ fontSize: 22, fontWeight: 650, color: pct !== undefined ? pctColor(pct) : 'var(--text-heading)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    {pct !== undefined && <Bar pct={pct} label="" />}
    <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={sub}>{sub}</div>
  </div>
);

const ACTIVE = (p: any) => p.status === 'Running' || p.status === 'Pending';

export const ClusterMetrics: React.FC<Props> = ({ k8sResources, source, vmNames, compact = false }) => {
  const [top, setTop] = useState<{ available: boolean; reason?: string; nodes: NodeTop[]; pods: PodTop[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState('');
  const [podSort, setPodSort] = useState<'cpu' | 'mem'>('cpu');
  const [podNs, setPodNs] = useState('all');

  // Keyed by content, not identity (the parent rebuilds the array each render).
  const vmKey = vmNames.join('\n');
  const hasNodes = (k8sResources.nodes || []).length > 0;

  const load = useCallback(async () => {
    if (!hasNodes) return;
    setLoading(true);
    try {
      const targets = source === 'all' ? (vmKey ? vmKey.split('\n') : []) : [source];
      const res = await Promise.all(targets.map(async (t) => {
        const q = t === 'local' ? '' : `?vm=${encodeURIComponent(t)}`;
        const d = await fetch(`/api/k8s/top${q}`).then((r) => r.json()).catch(() => null);
        return { t, d };
      }));
      const nodes: NodeTop[] = [];
      const pods: PodTop[] = [];
      let available = false;
      let reason: string | undefined;
      for (const { t, d } of res) {
        if (!d) continue;
        if (d.available) available = true;
        else reason = reason || d.reason;
        for (const n of d.nodes || []) nodes.push(source === 'all' ? { ...n, host: t } : n);
        for (const p of d.pods || []) pods.push(source === 'all' ? { ...p, host: t } : p);
      }
      setTop({ available, reason, nodes, pods });
      setAt(new Date().toLocaleTimeString());
    } finally {
      setLoading(false);
    }
  }, [source, vmKey, hasNodes]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const nodes = useMemo(() => k8sResources.nodes || [], [k8sResources.nodes]);
  const pods = useMemo(() => k8sResources.pods || [], [k8sResources.pods]);

  // Requests per node, from the pods the scheduler has placed there.
  const requested = useMemo(() => {
    const m = new Map<string, { cpu: number; mem: number; gpu: number; pods: number }>();
    for (const p of pods) {
      if (!ACTIVE(p)) continue;
      const key = `${p.host || ''}|${p.node}`;
      const cur = m.get(key) || { cpu: 0, mem: 0, gpu: 0, pods: 0 };
      cur.pods++;
      for (const c of p.containers || []) {
        cur.cpu += c.requests?.cpuMilli || 0;
        cur.mem += c.requests?.memBytes || 0;
        cur.gpu += Math.max(c.requests?.gpu || 0, c.limits?.gpu || 0);
      }
      m.set(key, cur);
    }
    return m;
  }, [pods]);

  const rows = useMemo(() => nodes.map((n: any) => {
    const key = `${n.host || ''}|${n.name}`;
    const req = requested.get(key) || { cpu: 0, mem: 0, gpu: 0, pods: 0 };
    const t = top?.nodes.find((x) => x.name === n.name && (x.host || '') === (n.host || ''));
    const alloc = n.allocatable || {};
    return {
      n, req, t,
      cpuReqPct: alloc.cpuMilli ? (req.cpu / alloc.cpuMilli) * 100 : null,
      memReqPct: alloc.memBytes ? (req.mem / alloc.memBytes) * 100 : null,
      podPct: alloc.pods ? (req.pods / alloc.pods) * 100 : null,
    };
  }), [nodes, requested, top]);

  const totals = useMemo(() => {
    const sum = (f: (r: any) => number) => rows.reduce((a, r) => a + (f(r) || 0), 0);
    const cpuAlloc = sum((r) => r.n.allocatable?.cpuMilli);
    const memAlloc = sum((r) => r.n.allocatable?.memBytes);
    const gpuAlloc = sum((r) => r.n.allocatable?.gpu ?? Number(r.n.gpus || 0));
    const podAlloc = sum((r) => r.n.allocatable?.pods);
    const cpuUsed = top?.available ? sum((r) => r.t?.cpuMilli) : null;
    const memUsed = top?.available ? sum((r) => r.t?.memBytes) : null;
    return {
      cpuAlloc, memAlloc, gpuAlloc, podAlloc,
      cpuReq: sum((r) => r.req.cpu), memReq: sum((r) => r.req.mem), gpuReq: sum((r) => r.req.gpu), podsActive: sum((r) => r.req.pods),
      cpuUsed, memUsed,
    };
  }, [rows, top]);

  const p = (a: number | null, b: number) => (a === null || !b ? null : (a / b) * 100);

  const podNamespaces = useMemo(() => Array.from(new Set((top?.pods || []).map((x) => x.namespace))).sort(), [top]);
  const topPods = useMemo(() => [...(top?.pods || [])]
    .filter((x) => podNs === 'all' || x.namespace === podNs)
    .sort((a, b) => (podSort === 'cpu' ? b.cpuMilli - a.cpuMilli : b.memBytes - a.memBytes))
    .slice(0, compact ? 8 : 20), [top, podSort, podNs, compact]);

  if (!nodes.length) {
    return (
      <div className="panel-card">
        <div className="panel-card-title"><h2><Gauge size={18} /> Cluster Resource Metrics</h2></div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>No Kubernetes nodes on this source — CPU, memory and GPU metrics appear once a cluster is visible.</p>
      </div>
    );
  }

  return (
    <div className="panel-card">
      <div className="panel-card-title">
        <h2><Gauge size={18} /> Cluster Resource Metrics</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          <span className={`badge ${top?.available ? 'running' : 'warning'}`} style={{ textTransform: 'none' }}>
            {top === null ? 'reading…' : top.available ? 'live usage (metrics API)' : 'requests only'}
          </span>
          {at && <span>updated {at}</span>}
          <button className="icon-btn secondary" onClick={() => void load()} title="Refresh usage" disabled={loading}>
            <RefreshCw size={13} className={loading ? 'loader' : ''} />
          </button>
        </div>
      </div>

      {top && !top.available && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)' }}>
          <AlertTriangle size={14} style={{ color: 'var(--status-warning)', flexShrink: 0, marginTop: 1 }} />
          <span>Live usage is unavailable: {top.reason || 'the metrics API did not answer'}. Showing what workloads have <em>requested</em> against each node's allocatable capacity.</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Tile icon={<Cpu size={13} />} label="CPU used"
          value={totals.cpuUsed === null ? '—' : `${(p(totals.cpuUsed, totals.cpuAlloc) ?? 0).toFixed(0)}%`}
          pct={p(totals.cpuUsed, totals.cpuAlloc)}
          sub={totals.cpuUsed === null ? 'needs metrics-server' : `${formatCpu(totals.cpuUsed)} of ${formatCpu(totals.cpuAlloc)}`} />
        <Tile icon={<Cpu size={13} />} label="CPU requested"
          value={`${(p(totals.cpuReq, totals.cpuAlloc) ?? 0).toFixed(0)}%`} pct={p(totals.cpuReq, totals.cpuAlloc)}
          sub={`${formatCpu(totals.cpuReq)} of ${formatCpu(totals.cpuAlloc)} allocatable`} />
        <Tile icon={<MemoryStick size={13} />} label="Memory used"
          value={totals.memUsed === null ? '—' : `${(p(totals.memUsed, totals.memAlloc) ?? 0).toFixed(0)}%`}
          pct={p(totals.memUsed, totals.memAlloc)}
          sub={totals.memUsed === null ? 'needs metrics-server' : `${formatBytes(totals.memUsed)} of ${formatBytes(totals.memAlloc)}`} />
        <Tile icon={<MemoryStick size={13} />} label="Memory requested"
          value={`${(p(totals.memReq, totals.memAlloc) ?? 0).toFixed(0)}%`} pct={p(totals.memReq, totals.memAlloc)}
          sub={`${formatBytes(totals.memReq)} of ${formatBytes(totals.memAlloc)}`} />
        <Tile icon={<Zap size={13} />} label="GPUs allocated"
          value={totals.gpuAlloc ? `${totals.gpuReq}/${totals.gpuAlloc}` : '0'} pct={totals.gpuAlloc ? p(totals.gpuReq, totals.gpuAlloc) : undefined}
          sub={totals.gpuAlloc ? 'requested by running pods' : 'no GPUs advertised by nodes'} />
        <Tile icon={<Layers size={13} />} label="Pod slots"
          value={`${totals.podsActive}/${totals.podAlloc || '—'}`} pct={totals.podAlloc ? p(totals.podsActive, totals.podAlloc) : undefined}
          sub="running + pending pods vs node pod limits" />
      </div>

      <div className="table-wrapper">
        <table className="resource-table">
          <thead>
            <tr>
              <th>Node</th>
              <th>CPU used</th>
              <th>CPU requested</th>
              <th>Memory used</th>
              <th>Memory requested</th>
              <th>GPU</th>
              <th>Pods</th>
              <th>Condition</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ n, req, t, cpuReqPct, memReqPct }) => (
              <tr key={`${n.host || ''}/${n.name}`}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Server size={12} style={{ color: 'var(--text-muted)' }} />
                    <strong title={n.name}>{n.name}</strong>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                    {n.role}{n.allocatable?.cpuMilli ? ` · ${formatCpu(n.allocatable.cpuMilli)} · ${formatBytes(n.allocatable.memBytes)}` : ''}{n.host ? ` · ${n.host}` : ''}
                  </div>
                </td>
                <td><Bar pct={t?.cpuPct ?? null} title={t ? `${formatCpu(t.cpuMilli)} in use` : 'no live usage'} /></td>
                <td><Bar pct={cpuReqPct} title={`${formatCpu(req.cpu)} requested`} /></td>
                <td><Bar pct={t?.memPct ?? null} title={t ? `${formatBytes(t.memBytes)} in use` : 'no live usage'} /></td>
                <td><Bar pct={memReqPct} title={`${formatBytes(req.mem)} requested`} /></td>
                <td style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                  {(n.allocatable?.gpu || Number(n.gpus || 0)) ? `${req.gpu}/${n.allocatable?.gpu ?? n.gpus}` : '—'}
                  {n.gpuProduct && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{n.gpuProduct}</div>}
                </td>
                <td style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{req.pods}{n.allocatable?.pods ? `/${n.allocatable.pods}` : ''}</td>
                <td>
                  <span className={`badge ${n.status === 'Ready' ? (n.pressure?.length ? 'warning' : 'running') : 'error'}`} style={{ textTransform: 'none' }}>
                    {n.status}{n.pressure?.length ? ` · ${n.pressure.join(', ')}` : ''}
                  </span>
                  {n.schedulable === false && <span className="badge warning" style={{ marginLeft: 4, textTransform: 'none' }}>cordoned</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {top?.available && topPods.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 13, color: 'var(--text-heading)' }}>Top pods by {podSort === 'cpu' ? 'CPU' : 'memory'}</h3>
            <div className="subnav-pills">
              <button className={`subnav-pill-btn ${podSort === 'cpu' ? 'active' : ''}`} onClick={() => setPodSort('cpu')}>CPU</button>
              <button className={`subnav-pill-btn ${podSort === 'mem' ? 'active' : ''}`} onClick={() => setPodSort('mem')}>Memory</button>
            </div>
            <select className="form-input" value={podNs} onChange={(e) => setPodNs(e.target.value)} style={{ width: 'auto', padding: '4px 8px', fontSize: 12, marginLeft: 'auto' }}>
              <option value="all">All namespaces</option>
              {podNamespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
            </select>
          </div>
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr><th>Pod</th><th>Namespace</th><th>CPU</th><th>Memory</th></tr></thead>
              <tbody>
                {topPods.map((x) => {
                  const maxCpu = topPods[0] && podSort === 'cpu' ? topPods[0].cpuMilli : Math.max(...topPods.map((y) => y.cpuMilli), 1);
                  const maxMem = topPods[0] && podSort === 'mem' ? topPods[0].memBytes : Math.max(...topPods.map((y) => y.memBytes), 1);
                  return (
                    <tr key={`${x.host || ''}/${x.namespace}/${x.name}`}>
                      <td title={x.name} style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong>{x.name}</strong></td>
                      <td><span className="code-tag">{x.namespace}</span></td>
                      <td><Bar pct={maxCpu ? (x.cpuMilli / maxCpu) * 100 : 0} label={formatCpu(x.cpuMilli)} /></td>
                      <td><Bar pct={maxMem ? (x.memBytes / maxMem) * 100 : 0} label={formatBytes(x.memBytes)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 10.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>Bars in this table are relative to the busiest pod listed.</p>
        </div>
      )}
    </div>
  );
};

export default ClusterMetrics;
