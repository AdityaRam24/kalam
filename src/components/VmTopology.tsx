// VM topology — the inventory drawn as a graph instead of a table.
//
// Layers, left to right:
//   Kalam (this machine) → jump hosts → VMs → (expanded) platform components
//
// Edges follow the real SSH path: a VM with `via` set hangs off its jump host,
// so you can see at a glance which hosts are only reachable through another.
// Component children come from the Node Brain report (/api/vms/explain) and
// only appear for VMs that have been analyzed and expanded.

import React, { useMemo, useEffect } from 'react';
import ReactFlow, {
  Background, Controls, Handle, Position, MarkerType, ReactFlowProvider, useReactFlow,
} from 'reactflow';
import type { NodeProps, Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from '@dagrejs/dagre';
import {
  Server, Brain, Laptop, ChevronRight, ChevronDown, Cpu, Boxes, ShieldCheck, Network,
  Layers, HardDrive, Eye, GitBranch, Database, Zap, Lock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface TopoVm { name: string; host: string; user: string; port: number; via?: string; }
export interface TopoMetrics { reachable?: boolean; error?: string; load?: string; ncpu?: string; mem?: string; gpu?: string; up?: string; }
export interface TopoBrain {
  kubectlAvailable?: boolean;
  identity?: { role: string; gpus: number; cpu: string; memory: string; ready: boolean | null; nodeName: string | null };
  components?: Array<{ id: string; title: string; category: string; unhealthy: number; workloads: any[] }>;
  otherWorkloads?: any[];
}

interface Props {
  vms: TopoVm[];
  metrics: Record<string, TopoMetrics>;
  brains: Record<string, TopoBrain>;
  expanded: Record<string, boolean>;
  onToggleExpand: (name: string) => void;
  onExplain: (name: string) => void;
  busy: Record<string, boolean>;
}

const CATEGORY_ICON: Record<string, LucideIcon> = {
  'Identity & Security': Lock,
  'Policy & Governance': ShieldCheck,
  'Kubernetes Core': Layers,
  'Networking': Network,
  'Storage': HardDrive,
  'GPU & Accelerators': Zap,
  'Observability': Eye,
  'AI / Data Platform': Brain,
  'Delivery & Ops': GitBranch,
  'Data Services': Database,
};

const CATEGORY_COLOR: Record<string, string> = {
  'Identity & Security': '#f472b6',
  'Policy & Governance': '#fbbf24',
  'Kubernetes Core': '#38bdf8',
  'Networking': '#818cf8',
  'Storage': '#2dd4bf',
  'GPU & Accelerators': '#76b900', // NVIDIA green
  'Observability': '#a78bfa',
  'AI / Data Platform': '#34d399',
  'Delivery & Ops': '#fb923c',
  'Data Services': '#94a3b8',
};

// ─── Node renderers ─────────────────────────────────────────────────────────

const RootNode = ({ data }: NodeProps) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderLeft: '3px solid var(--hpe-green)',
    minWidth: 150,
  }}>
    <Laptop size={18} style={{ color: 'var(--hpe-green)' }} />
    <div>
      <div style={{ fontSize: 13, fontWeight: 700 }}>Kalam</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{data.count} host(s) over SSH</div>
    </div>
    <Handle type="source" position={Position.Right} style={{ background: 'var(--hpe-green)', width: 7, height: 7 }} />
  </div>
);

const VmNode = ({ data }: NodeProps) => {
  const { vm, metrics, brain, expanded, onToggleExpand, onExplain, busy } = data;
  const online = metrics?.reachable && !metrics?.error;
  const accent = !metrics ? '#64748b' : online ? '#10b981' : '#f43f5e';
  const id = brain?.identity;
  const componentCount = brain?.components?.length || 0;
  const unhealthy = (brain?.components || []).reduce((a: number, c: any) => a + c.unhealthy, 0);

  return (
    <div style={{
      minWidth: 230, borderRadius: 12, background: 'var(--bg-secondary, var(--bg-tertiary))',
      border: '1px solid var(--border-color)', borderLeft: `3px solid ${accent}`, overflow: 'hidden',
    }}>
      <Handle type="target" position={Position.Left} style={{ background: accent, width: 7, height: 7 }} />
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, boxShadow: online ? `0 0 8px ${accent}` : 'none', flexShrink: 0 }} />
          <Server size={14} style={{ color: 'var(--text-secondary)' }} />
          <strong style={{ fontSize: 13 }}>{vm.name}</strong>
          {id?.gpus > 0 && <span className="badge running" style={{ fontSize: 9 }}>{id.gpus} GPU</span>}
        </div>
        <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
          {vm.user}@{vm.host}:{vm.port}
        </div>

        {id && (
          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
            {id.role}{id.nodeName ? ` · ${id.nodeName}` : ''}{id.ready === false ? ' · NotReady' : ''}
          </div>
        )}

        {metrics && (online ? (
          <div style={{ display: 'flex', gap: 10, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
            <span title="load / cpus"><Cpu size={9} style={{ verticalAlign: -1 }} /> {metrics.load ?? '—'}{metrics.ncpu ? `/${metrics.ncpu}` : ''}</span>
            <span title="memory">{metrics.mem ?? '—'}</span>
            {metrics.gpu && metrics.gpu !== 'none' && <span title="gpu util">GPU {metrics.gpu}%</span>}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: 'var(--status-error)' }}>{metrics.error || 'Unreachable'}</div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {componentCount > 0 ? (
            <button
              className="btn secondary" style={{ padding: '3px 8px', fontSize: 10 }}
              onClick={(e) => { e.stopPropagation(); onToggleExpand(vm.name); }}
            >
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {componentCount} components{unhealthy ? ` · ${unhealthy} unhealthy` : ''}
            </button>
          ) : (
            <button
              className="btn secondary" style={{ padding: '3px 8px', fontSize: 10 }}
              onClick={(e) => { e.stopPropagation(); onExplain(vm.name); }}
              disabled={busy}
            >
              <Brain size={11} className={busy ? 'loader' : ''} /> {busy ? 'Analyzing…' : 'Analyze node'}
            </button>
          )}
          {brain && brain.otherWorkloads && brain.otherWorkloads.length > 0 && (
            <span className="badge neutral" style={{ fontSize: 9 }} title="Application pods not in the component catalog">
              <Boxes size={9} style={{ verticalAlign: -1 }} /> {brain.otherWorkloads.length} app
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: accent, width: 7, height: 7 }} />
    </div>
  );
};

const CategoryNode = ({ data }: NodeProps) => {
  const Icon = CATEGORY_ICON[data.category] || Layers;
  const color = CATEGORY_COLOR[data.category] || '#94a3b8';
  return (
    <div style={{
      minWidth: 190, maxWidth: 240, borderRadius: 10, padding: '8px 10px',
      background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderLeft: `3px solid ${data.unhealthy ? '#f43f5e' : color}`,
    }}>
      <Handle type="target" position={Position.Left} style={{ background: color, width: 6, height: 6 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Icon size={12} style={{ color }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color }}>{data.category}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {data.components.map((c: any) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--text-secondary)' }} title={`${c.what}\n\nWhy here: ${c.why}`}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.unhealthy ? '#f43f5e' : '#10b981', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
            {c.workloads.length > 1 && <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>×{c.workloads.length}</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

const nodeTypes = { root: RootNode, vm: VmNode, category: CategoryNode };

// ─── Graph assembly ─────────────────────────────────────────────────────────

// Rough node sizes for dagre; ReactFlow measures the real ones after render.
const SIZE = { root: [170, 60], vm: [250, 130], category: [220, 90] } as const;

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', ranksep: 90, nodesep: 26, marginx: 20, marginy: 20 });
  for (const n of nodes) {
    const [w, h] = SIZE[(n.type as keyof typeof SIZE)] || SIZE.vm;
    g.setNode(n.id, { width: w, height: n.type === 'category' ? Math.max(h, 40 + (n.data.components?.length || 1) * 16) : h });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - p.width / 2, y: p.y - p.height / 2 } };
  });
}

const Flow: React.FC<Props> = ({ vms, metrics, brains, expanded, onToggleExpand, onExplain, busy }) => {
  const { fitView } = useReactFlow();

  const { nodes, edges } = useMemo(() => {
    const ns: Node[] = [{ id: '__root__', type: 'root', position: { x: 0, y: 0 }, data: { count: vms.length }, draggable: false }];
    const es: Edge[] = [];
    const known = new Set(vms.map((v) => v.name));

    for (const vm of vms) {
      const m = metrics[vm.name];
      const online = m?.reachable && !m?.error;
      ns.push({
        id: `vm:${vm.name}`, type: 'vm', position: { x: 0, y: 0 },
        data: { vm, metrics: m, brain: brains[vm.name], expanded: !!expanded[vm.name], onToggleExpand, onExplain, busy: !!busy[vm.name] },
      });
      // Hang jumped VMs off their jump host so the SSH path is visible.
      const parent = vm.via && known.has(vm.via) ? `vm:${vm.via}` : '__root__';
      es.push({
        id: `e:${parent}->${vm.name}`, source: parent, target: `vm:${vm.name}`,
        type: 'smoothstep', animated: !!online,
        label: vm.via && known.has(vm.via) ? `ssh via ${vm.via}` : 'ssh',
        labelStyle: { fontSize: 9, fill: 'var(--text-muted)' },
        labelBgStyle: { fill: 'transparent' },
        style: { stroke: online ? 'var(--hpe-green)' : '#64748b', strokeWidth: 1.5, strokeDasharray: online ? undefined : '4 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color: online ? 'var(--hpe-green)' : '#64748b', width: 14, height: 14 },
      });

      // Expanded: one node per component category on that host.
      const comps = brains[vm.name]?.components || [];
      if (expanded[vm.name] && comps.length) {
        const byCat = new Map<string, any[]>();
        for (const c of comps) byCat.set(c.category, [...(byCat.get(c.category) || []), c]);
        for (const [category, components] of byCat) {
          const cid = `cat:${vm.name}:${category}`;
          const unhealthy = components.reduce((a, c) => a + c.unhealthy, 0);
          ns.push({ id: cid, type: 'category', position: { x: 0, y: 0 }, data: { category, components, unhealthy } });
          es.push({
            id: `e:${vm.name}->${category}`, source: `vm:${vm.name}`, target: cid, type: 'smoothstep',
            style: { stroke: unhealthy ? '#f43f5e' : (CATEGORY_COLOR[category] || '#64748b'), strokeWidth: 1.2, opacity: 0.7 },
          });
        }
      }
    }
    return { nodes: layout(ns, es), edges: es };
  }, [vms, metrics, brains, expanded, onToggleExpand, onExplain, busy]);

  // Re-fit whenever the shape of the graph changes (expand/collapse, new VM).
  const shape = nodes.length + ':' + edges.length;
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
    return () => clearTimeout(t);
  }, [shape, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      minZoom={0.2}
      maxZoom={1.6}
      nodesConnectable={false}
      elementsSelectable={false}
    >
      <Background gap={18} size={1} color="var(--border-color)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
};

export const VmTopology: React.FC<Props> = (props) => {
  const height = Math.min(760, Math.max(320, 150 + props.vms.length * 90));
  if (props.vms.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Add a VM to see the topology.</p>;
  }
  return (
    <div style={{ height, border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-primary)' }}>
      <ReactFlowProvider>
        <Flow {...props} />
      </ReactFlowProvider>
    </div>
  );
};

export default VmTopology;
