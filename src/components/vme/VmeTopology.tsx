// VME topology: Manager → clusters → hosts → VMs → the Kubernetes nodes those
// VMs are, with datastores hanging off their cluster. Colours come from the
// same findings as every other subpage, so the map and the lists agree.
//
// Built to not flicker (see the Topology map history): fixed card sizes are
// passed to React Flow on every node, nothing animates, no CSS filters, and
// the node array only changes when the data or a filter does.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, { Background, Controls, MiniMap, ReactFlowProvider, useReactFlow, Handle, Position, type Node, type Edge, type NodeProps } from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from '@dagrejs/dagre';
import { Cloud, Boxes, Server, Monitor, Container, HardDrive, X, AlertTriangle, Info } from 'lucide-react';
import { sevColor, type VmeView, type TopoNode } from './types';

const SIZE: Record<TopoNode['kind'], { w: number; h: number }> = {
  manager: { w: 210, h: 58 }, cluster: { w: 200, h: 58 }, host: { w: 220, h: 78 },
  vm: { w: 210, h: 72 }, k8s: { w: 200, h: 58 }, datastore: { w: 200, h: 62 },
};
const ICON: Record<TopoNode['kind'], React.ComponentType<{ size?: number }>> = {
  manager: Cloud, cluster: Boxes, host: Server, vm: Monitor, k8s: Container, datastore: HardDrive,
};
const KIND_LABEL: Record<TopoNode['kind'], string> = {
  manager: 'VME Manager', cluster: 'Cluster', host: 'Host', vm: 'VM', k8s: 'Kubernetes node', datastore: 'Datastore',
};
const READABLE = 0.85;
const levelColor = (l: TopoNode['level']) => (l === 'off' ? '#8b95a1' : l === 'unknown' ? 'var(--text-muted)' : sevColor(l));

const MiniBar: React.FC<{ v: number | null | undefined; label: string }> = ({ v, label }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: 'var(--text-muted)' }}>
    <span style={{ width: 24 }}>{label}</span>
    <div style={{ flex: 1, height: 4, background: 'var(--bg-secondary)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, v ?? 0))}%`, height: '100%', background: v === null || v === undefined ? 'transparent' : v >= 90 ? 'var(--status-error)' : v >= 75 ? 'var(--status-warning)' : 'var(--status-success)' }} />
    </div>
    <span style={{ width: 26, textAlign: 'right' }}>{v === null || v === undefined ? '—' : `${Math.round(v)}%`}</span>
  </div>
);

const Card = memo(({ data }: NodeProps<TopoNode & { focused?: boolean; dim?: boolean }>) => {
  const Icon = ICON[data.kind];
  const sz = SIZE[data.kind];
  return (
    <div style={{
      width: sz.w, height: sz.h, boxSizing: 'border-box', borderRadius: 8, padding: '6px 9px',
      background: 'var(--bg-card)', border: `1px solid ${data.focused ? 'var(--hpe-green)' : 'var(--border-color)'}`,
      borderLeft: `4px solid ${levelColor(data.level)}`, opacity: data.dim ? 0.35 : data.level === 'off' ? 0.7 : 1,
      boxShadow: data.focused ? '0 0 0 3px var(--hpe-green-dim)' : undefined, overflow: 'hidden',
    }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: levelColor(data.level), display: 'flex' }}><Icon size={14} /></span>
        <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--text-heading)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={data.label}>{data.label}</span>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }} title={data.sub}>
        {data.level === 'off' ? 'powered off' : data.sub || KIND_LABEL[data.kind]}
      </div>
      {(data.kind === 'host' || data.kind === 'vm') && data.level !== 'off' && (
        <div style={{ marginTop: 4, display: 'grid', gap: 2 }}>
          <MiniBar v={data.cpu} label="CPU" />
          <MiniBar v={data.mem} label="MEM" />
        </div>
      )}
      {data.kind === 'datastore' && <div style={{ marginTop: 4 }}><MiniBar v={data.mem} label="used" /></div>}
    </div>
  );
});
const nodeTypes = { card: Card };

function layout(nodes: TopoNode[], edges: Array<{ from: string; to: string }>) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 14, ranksep: 70, marginx: 10, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: SIZE[n.kind].w, height: SIZE[n.kind].h });
  for (const e of edges) if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    pos.set(n.id, { x: p.x - SIZE[n.kind].w / 2, y: p.y - SIZE[n.kind].h / 2 });
  }
  return pos;
}

interface Props { view: VmeView; focus?: string; onClearFocus?: () => void }

const Inner: React.FC<Props> = ({ view, focus, onClearFocus }) => {
  const { fitView, setCenter, setViewport } = useReactFlow();
  const boxRef = useRef<HTMLDivElement>(null);
  const [cluster, setCluster] = useState('all');
  const [k8sOnly, setK8sOnly] = useState(false);
  const [problems, setProblems] = useState(false);
  const [showDs, setShowDs] = useState(true);
  const [selected, setSelected] = useState<string | undefined>(focus);
  useEffect(() => { if (focus) setSelected(focus); }, [focus]);

  const all = view.topology;
  const byId = useMemo(() => new Map(all.nodes.map((n) => [n.id, n])), [all]);
  const clusters = useMemo(() => all.nodes.filter((n) => n.kind === 'cluster'), [all]);

  const visible = useMemo(() => {
    const ancestorsOf = (id: string) => { const out: string[] = []; let p = byId.get(id)?.parent; while (p) { out.push(p); p = byId.get(p)?.parent; } return out; };
    let keep = all.nodes.filter((n) => showDs || n.kind !== 'datastore');
    if (cluster !== 'all') keep = keep.filter((n) => n.kind === 'manager' || n.id === cluster || ancestorsOf(n.id).includes(cluster));
    if (k8sOnly) {
      const k8sVms = new Set(all.edges.filter((e) => e.kind === 'is').map((e) => e.from));
      keep = keep.filter((n) => n.kind !== 'vm' || k8sVms.has(n.id));
      const hostsWithK8s = new Set(keep.filter((n) => n.kind === 'vm').map((n) => n.parent));
      keep = keep.filter((n) => n.kind !== 'host' || hostsWithK8s.has(n.id));
    }
    if (problems) {
      const bad = keep.filter((n) => n.level === 'warning' || n.level === 'critical' || n.level === 'off');
      const need = new Set<string>();
      for (const n of bad) { need.add(n.id); for (const a of ancestorsOf(n.id)) need.add(a); }
      for (const n of keep) if (n.parent && need.has(n.parent) && n.kind === 'k8s') need.add(n.id);
      keep = keep.filter((n) => need.has(n.id));
    }
    const ids = new Set(keep.map((n) => n.id));
    return { nodes: keep, edges: all.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [all, byId, cluster, k8sOnly, problems, showDs]);

  const pos = useMemo(() => layout(visible.nodes, visible.edges), [visible]);

  // Chain of the selected node (ancestors + descendants), so the rest can dim.
  const chain = useMemo(() => {
    if (!selected) return undefined;
    const s = new Set<string>([selected]);
    let p = byId.get(selected)?.parent;
    while (p) { s.add(p); p = byId.get(p)?.parent; }
    const kids = (id: string) => { for (const e of all.edges) if (e.from === id && e.kind !== 'storage' && !s.has(e.to)) { s.add(e.to); kids(e.to); } };
    if (byId.get(selected)?.kind !== 'manager') kids(selected);
    return s;
  }, [selected, byId, all.edges]);

  const rfNodes: Node[] = useMemo(() => visible.nodes.map((n) => ({
    id: n.id, type: 'card', position: pos.get(n.id)!, width: SIZE[n.kind].w, height: SIZE[n.kind].h,
    data: { ...n, focused: n.id === selected, dim: !!chain && !chain.has(n.id) },
    draggable: false, connectable: false,
  })), [visible.nodes, pos, selected, chain]);

  const rfEdges: Edge[] = useMemo(() => visible.edges.map((e) => {
    const target = byId.get(e.to);
    const hot = !!chain && chain.has(e.from) && chain.has(e.to);
    return {
      id: `${e.from}->${e.to}`, source: e.from, target: e.to, type: 'smoothstep',
      style: {
        stroke: target?.level === 'critical' ? 'var(--status-error)' : target?.level === 'warning' ? 'var(--status-warning)' : 'var(--border-color)',
        strokeWidth: hot ? 2.2 : 1.2, strokeDasharray: e.kind === 'storage' ? '5 4' : target?.level === 'off' ? '3 3' : undefined, opacity: chain && !hot ? 0.3 : 1,
      },
    };
  }), [visible.edges, byId, chain]);

  // Fit when the visible set changes; centre on a focused node when asked.
  // Fit when everything fits at a readable size; otherwise open top-left at a
  // readable zoom — a big estate pans (or uses the minimap) instead of
  // shrinking to unreadable dots.
  useEffect(() => {
    if (focus) return;
    const t = setTimeout(() => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box || !visible.nodes.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of visible.nodes) {
        const p = pos.get(n.id)!;
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + SIZE[n.kind].w); maxY = Math.max(maxY, p.y + SIZE[n.kind].h);
      }
      const fit = Math.min(box.width / (maxX - minX + 40), box.height / (maxY - minY + 40));
      if (fit >= READABLE) fitView({ padding: 0.06, duration: 0, maxZoom: 1.1 });
      else setViewport({ x: 20 - minX * READABLE, y: 16 - minY * READABLE, zoom: READABLE });
    }, 30);
    return () => clearTimeout(t);
  }, [visible, pos, fitView, setViewport, focus]);
  useEffect(() => {
    if (!focus) return;
    const p = pos.get(focus);
    const n = byId.get(focus);
    if (p && n) setTimeout(() => setCenter(p.x + SIZE[n.kind].w / 2, p.y + SIZE[n.kind].h / 2, { zoom: 1.1, duration: 300 }), 60);
  }, [focus, pos, byId, setCenter]);

  const onNodeClick = useCallback((_: any, n: Node) => setSelected((cur) => (cur === n.id ? undefined : n.id)), []);
  const sel = selected ? byId.get(selected) : undefined;
  const selFindings = useMemo(() => !sel ? [] : view.findings.filter((f) => f.subject && `${f.subject.kind}:${f.subject.id}` === sel.id), [sel, view.findings]);
  const selDetail = useMemo(() => {
    if (!sel) return [];
    const s = view.snapshot;
    const [kind, rawId] = sel.id.split(/:(.*)/s);
    const id = Number(rawId);
    if (kind === 'host') { const h = s.hosts.find((x) => x.id === id); return h ? [['IP', h.ip], ['Cluster', h.cluster], ['Cores', h.cores], ['Power', h.power], ['Status', h.status], ['VMs', h.vmIds.length], ['OS', h.os]] : []; }
    if (kind === 'vm') { const v = s.vms.find((x) => x.id === id); return v ? [['Host', v.host], ['IPs', v.ips.join(', ')], ['Power', v.power], ['vCPU', v.cores], ['Plan', v.plan], ['GPUs', v.gpus], ['Kubernetes node', v.k8sNode], ['Instance', v.instance]] : []; }
    if (kind === 'k8s') { const n = s.k8s?.nodes.find((x) => x.name === rawId); return n ? [['Roles', n.roles.join(', ') || 'worker'], ['Ready', n.ready ? 'yes' : 'NO'], ['Pods', n.pods], ['GPUs', n.gpus], ['Addresses', n.addresses.join(', ')]] : []; }
    if (kind === 'datastore') { const d = s.datastores.find((x) => x.id === id); return d ? [['Type', d.type], ['Online', d.online ? 'yes' : 'NO'], ['Active', d.active ? 'yes' : 'no']] : []; }
    if (kind === 'cluster') { const c = s.clusters.find((x) => x.id === id); return c ? [['Type', c.type], ['Status', c.status], ['Hosts', c.hostIds.length]] : []; }
    return [['User', s.manager?.user], ['Version', s.manager?.version]];
  }, [sel, view.snapshot]);

  const counts = useMemo(() => ({
    crit: all.nodes.filter((n) => n.level === 'critical').length,
    warn: all.nodes.filter((n) => n.level === 'warning').length,
    off: all.nodes.filter((n) => n.level === 'off').length,
  }), [all]);

  return (
    <div className="panel-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid var(--border-color)' }}>
        <select className="form-input" value={cluster} onChange={(e) => setCluster(e.target.value)} style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }}>
          <option value="all">All clusters</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {[
          ['Kubernetes VMs only', k8sOnly, setK8sOnly], ['Problems only', problems, setProblems], ['Datastores', showDs, setShowDs],
        ].map(([label, v, set]: any) => (
          <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} /> {label}
          </label>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, fontSize: 11.5, color: 'var(--text-muted)', alignItems: 'center' }}>
          <span><b style={{ color: sevColor('critical') }}>■</b> critical {counts.crit}</span>
          <span><b style={{ color: sevColor('warning') }}>■</b> warning {counts.warn}</span>
          <span><b style={{ color: '#8b95a1' }}>■</b> off {counts.off}</span>
          <span><b style={{ color: sevColor('ok') }}>■</b> ok</span>
          <span>– – storage</span>
          <span>{visible.nodes.length} of {all.nodes.length} shown</span>
        </span>
      </div>
      <div ref={boxRef} style={{ position: 'relative', height: 'calc(100vh - 290px)', minHeight: 520 }}>
        <ReactFlow nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes} onNodeClick={onNodeClick} onPaneClick={() => { setSelected(undefined); onClearFocus?.(); }}
          minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false} elementsSelectable>
          <Background gap={18} size={1} color="var(--border-color)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => levelColor((n.data as TopoNode).level)} style={{ background: 'var(--bg-card)' }} />
        </ReactFlow>
        {sel && (
          <div style={{ position: 'absolute', top: 10, right: 10, width: 320, maxHeight: 'calc(100% - 20px)', overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, zIndex: 5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{KIND_LABEL[sel.kind]}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', wordBreak: 'break-all' }}>{sel.label}</div>
              </div>
              <button className="icon-btn" onClick={() => { setSelected(undefined); onClearFocus?.(); }}><X size={14} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px', fontSize: 12, marginTop: 8 }}>
              {selDetail.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => (
                <React.Fragment key={String(k)}><span style={{ color: 'var(--text-muted)' }}>{k}</span><span style={{ wordBreak: 'break-all' }}>{String(v)}</span></React.Fragment>
              ))}
            </div>
            {(sel.kind === 'host' || sel.kind === 'vm') && sel.level !== 'off' && (
              <div style={{ display: 'grid', gap: 3, marginTop: 8 }}><MiniBar v={sel.cpu} label="CPU" /><MiniBar v={sel.mem} label="MEM" /></div>
            )}
            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 650 }}>Findings</div>
            {selFindings.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>None for this {KIND_LABEL[sel.kind].toLowerCase()}.</div> : selFindings.map((f) => (
              <div key={f.id} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {f.severity === 'info' ? <Info size={13} color={sevColor('info')} /> : <AlertTriangle size={13} color={sevColor(f.severity)} />}
                <div><div style={{ fontSize: 12, fontWeight: 600 }}>{f.title}</div><div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{f.detail}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export const VmeTopology: React.FC<Props> = (p) => (
  <ReactFlowProvider><Inner {...p} /></ReactFlowProvider>
);

export default VmeTopology;
