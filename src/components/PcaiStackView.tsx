import React, { useCallback, useMemo, useState } from 'react';
import { Layers, Cpu, Server, Activity, Sparkles, Boxes, Shield, Network, Database, GraduationCap, HardDrive, ChevronDown, ChevronRight } from 'lucide-react';
import MermaidChart from './MermaidChart';

// ---------------------------------------------------------------------------
// Types (subset of the App's cluster model)
// ---------------------------------------------------------------------------
interface ResourceAmounts { cpuMilli: number; memBytes: number; gpu: number; }
interface Container { name: string; image?: string; ready: boolean; state: string; requests?: ResourceAmounts; limits?: ResourceAmounts; }
interface Pod {
  name: string; namespace: string; status: string; ready: string; node: string; restarts: number;
  ip?: string; containers?: Container[]; claims?: string[];
}
interface Service { name: string; namespace: string; type: string; clusterIp: string; ports: string; }
interface Deployment { name: string; namespace: string; ready: string; replicas: number; kind?: string; }
interface NodeResource { name: string; status: string; version: string; ip: string; gpus?: string; }
interface ComponentInfo { id: string; title: string; category: string; what: string; why: string; impact: string; }
interface K8sResources { pods: Pod[]; services: Service[]; deployments: Deployment[]; nodes: NodeResource[]; }

export interface LlmParams {
  provider: 'gemini' | 'local';
  apiKey?: string;
  localUrl?: string;
  localModel?: string;
  authKey?: string;
}

interface Props {
  k8sResources: K8sResources;
  status: { kubernetes: { running: boolean } };
  llm: LlmParams;
  /** False when the deployment turned AI off: the health-read card is hidden. */
  aiEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// PCAI logical component classification (by resource name / namespace).
// Order matters — first match wins.
// ---------------------------------------------------------------------------
const PCAI_COMPONENTS: { label: string; subs: string[]; icon: React.ReactNode }[] = [
  { label: 'MLIS · Inference', subs: ['mlis', 'aioli', 'kserve', 'inference', 'nim', 'knative', 'serving'], icon: <Sparkles size={16} /> },
  { label: 'MLDM · Data Management', subs: ['mldm', 'pachyderm', 'pachd'], icon: <Database size={16} /> },
  { label: 'MLDE · Training', subs: ['mlde', 'determined'], icon: <GraduationCap size={16} /> },
  { label: 'Data Lakehouse', subs: ['ezpresto', 'presto', 'trino', 'lakehouse', 'spark', 'airflow', 'superset', 'mlflow', 'feast'], icon: <HardDrive size={16} /> },
  { label: 'Identity · Keycloak', subs: ['keycloak', 'oidc', 'dex', 'auth'], icon: <Shield size={16} /> },
  { label: 'GPU Operator', subs: ['nvidia', 'gpu-operator', 'device-plugin', 'dcgm'], icon: <Cpu size={16} /> },
  { label: 'Ingress / Network', subs: ['ingress', 'istio', 'nginx', 'metallb', 'cert-manager', 'gateway'], icon: <Network size={16} /> },
];
const OTHER = { label: 'Platform / Other', icon: <Boxes size={16} /> };

function classify(name: string, ns: string): string {
  const hay = `${ns} ${name}`.toLowerCase();
  for (const c of PCAI_COMPONENTS) if (c.subs.some((s) => hay.includes(s))) return c.label;
  return OTHER.label;
}

function iconFor(label: string): React.ReactNode {
  return PCAI_COMPONENTS.find((c) => c.label === label)?.icon ?? OTHER.icon;
}

const sid = (s: string) => 'n' + s.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);

interface CompBucket {
  deployments: Deployment[]; pods: Pod[]; services: Service[]; unhealthy: number;
  requested: ResourceAmounts;
  nodes: Set<string>;
  claims: Set<string>;
  images: Set<string>;
}

const ZERO: ResourceAmounts = { cpuMilli: 0, memBytes: 0, gpu: 0 };

/** Millicores read as cores past a whole one — "250m" stays "250m". */
function fmtCpu(milli: number): string {
  if (milli <= 0) return '—';
  return milli >= 1000 ? `${(milli / 1000).toFixed(milli % 1000 === 0 ? 0 : 1)} cores` : `${milli}m`;
}

function fmtBytes(b: number): string {
  if (b <= 0) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 2 ? 1 : 0)} ${u[i]}`;
}

/** Strip the registry and digest so a table of images stays readable. */
function shortImage(image: string): string {
  const noDigest = image.split('@')[0];
  const parts = noDigest.split('/');
  return parts.length > 1 ? parts.slice(-2).join('/') : noDigest;
}

const CHIP: React.CSSProperties = {
  fontSize: 10.5, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
  borderRadius: 4, padding: '2px 7px', color: 'var(--text-secondary)',
};

const Metric: React.FC<{ label: string; value: string; accent?: boolean }> = ({ label, value, accent }) => (
  <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '8px 10px' }}>
    <div style={{ fontSize: 9.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    <div style={{
      fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
      color: accent ? 'var(--hpe-purple)' : 'var(--text-primary)',
    }}>{value}</div>
  </div>
);

const Section: React.FC<{ title: string; icon: React.ReactNode; children: React.ReactNode }> = ({ title, icon, children }) => (
  <div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
      {icon} {title}
    </div>
    {children}
  </div>
);

/**
 * A plain table. `bad` marks a row as unhealthy — paired with the status text
 * already in the row, so state never reads by colour alone.
 */
const Table: React.FC<{ head: string[]; rows: string[][]; bad?: (r: string[]) => boolean }> = ({ head, rows, bad }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} style={{
              textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 500,
              fontSize: 10, borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap',
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ color: bad?.(r) ? 'var(--status-error)' : 'var(--text-secondary)' }}>
            {r.map((cell, j) => (
              <td key={j} style={{
                padding: '4px 8px', borderBottom: '1px solid var(--border-color)',
                whiteSpace: 'nowrap', fontFamily: j === 0 ? 'monospace' : undefined,
                color: j === 0 ? 'var(--text-primary)' : undefined,
              }}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const PcaiStackView: React.FC<Props> = ({ k8sResources, status, llm, aiEnabled = true }) => {
  const [health, setHealth] = useState<string>('');
  const [healthLoading, setHealthLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // podName -> "what is this", from the offline catalog. No LLM involved.
  const [identified, setIdentified] = useState<Record<string, ComponentInfo | null>>({});

  const inv = useMemo(() => {
    const components: Record<string, CompBucket> = {};
    const bucket = (label: string): CompBucket =>
      (components[label] ||= {
        deployments: [], pods: [], services: [], unhealthy: 0,
        requested: { ...ZERO }, nodes: new Set(), claims: new Set(), images: new Set(),
      });
    const push = (label: string, kind: 'deployments' | 'pods' | 'services', item: any, bad: boolean) => {
      const b = bucket(label);
      (b[kind] as any[]).push(item);
      if (bad) b.unhealthy++;
      return b;
    };

    for (const d of k8sResources.deployments) {
      const parts = d.ready.split('/');
      push(classify(d.name, d.namespace), 'deployments', d, parts[0] !== parts[1] || parts[0] === '0');
    }

    for (const p of k8sResources.pods) {
      const b = push(classify(p.name, p.namespace), 'pods', p, p.status !== 'Running' && p.status !== 'Succeeded');
      if (p.node && p.node !== 'None') b.nodes.add(p.node);
      for (const c of p.claims || []) b.claims.add(c);
      // Requests, not limits: requests are what the scheduler actually reserved,
      // so they are what this component is holding away from everything else.
      // Succeeded pods have already given their reservation back.
      const holdsResources = p.status !== 'Succeeded' && p.status !== 'Failed';
      for (const c of p.containers || []) {
        if (c.image) b.images.add(c.image);
        if (!holdsResources) continue;
        b.requested.cpuMilli += c.requests?.cpuMilli || 0;
        b.requested.memBytes += c.requests?.memBytes || 0;
        b.requested.gpu += c.requests?.gpu || 0;
      }
    }

    for (const s of k8sResources.services) push(classify(s.name, s.namespace), 'services', s, false);

    const totalGpu = k8sResources.nodes.reduce((n, node) => n + (parseInt(String(node.gpus || '0')) || 0), 0);
    const requestedGpu = Object.values(components).reduce((n, b) => n + b.requested.gpu, 0);
    return {
      components,
      totalGpu,
      requestedGpu,
      readyNodes: k8sResources.nodes.filter((n) => n.status === 'Ready').length,
      totalNodes: k8sResources.nodes.length,
      runningPods: k8sResources.pods.filter((p) => p.status === 'Running').length,
      totalPods: k8sResources.pods.length,
    };
  }, [k8sResources]);

  // Identify on expand rather than up front: a 400-pod cluster should not post
  // 400 names to the server because someone opened the page.
  const toggle = useCallback(async (label: string) => {
    const next = expanded === label ? null : label;
    setExpanded(next);
    if (!next) return;
    const pods = inv.components[next]?.pods || [];
    const unknown = pods.filter((p) => !(p.name in identified));
    if (!unknown.length) return;
    try {
      const res = await fetch('/api/pcai/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: unknown.map((p) => ({
            name: p.name, namespace: p.namespace, image: p.containers?.[0]?.image,
          })),
        }),
      });
      const data = await res.json();
      const add: Record<string, ComponentInfo | null> = {};
      for (const r of data.results || []) add[r.name] = r.info || null;
      setIdentified((cur) => ({ ...cur, ...add }));
    } catch {
      // The catalog is a nicety; the rest of the panel stands without it.
    }
  }, [expanded, inv, identified]);

  const orderedLabels = useMemo(() => {
    const order = [...PCAI_COMPONENTS.map((c) => c.label), OTHER.label];
    return order.filter((l) => inv.components[l]);
  }, [inv]);

  const mermaid = useMemo(() => {
    const L: string[] = ['flowchart TB', '  GL["HPE GreenLake<br/>Control Plane"]'];
    const ep = !aiEnabled ? 'MLIS' : llm.provider === 'gemini' ? 'Gemini' : (llm.authKey ? 'Model Endpoint' : (llm.localModel || 'Local LLM'));
    L.push(`  ME["Served Model Endpoint<br/>${ep}"]`);
    L.push('  subgraph PCAI["HPE Private Cloud AI"]');
    L.push('    direction TB');
    L.push('    subgraph K8S["Kubernetes Platform"]');
    if (k8sResources.nodes.length) {
      for (const n of k8sResources.nodes) {
        const g = parseInt(String(n.gpus || '0')) || 0;
        L.push(`      ${sid(n.name)}["${n.name}<br/>${n.status}${g ? ` &middot; ${g} GPU` : ''}"]`);
      }
    } else {
      L.push('      NONODE["No nodes detected"]');
    }
    L.push('    end');
    for (const label of orderedLabels) {
      const b = inv.components[label];
      L.push(`    subgraph ${sid(label)}["${label}"]`);
      L.push(`      ${sid(label)}i["${b.deployments.length} deploy &middot; ${b.pods.length} pods &middot; ${b.services.length} svc"]`);
      L.push('    end');
    }
    L.push('  end');
    L.push('  GL --> PCAI');
    for (const label of orderedLabels) L.push(`  K8S --> ${sid(label)}`);
    const mlis = orderedLabels.find((l) => l.startsWith('MLIS'));
    L.push(mlis ? `  ${sid(mlis)} --> ME` : '  PCAI --> ME');
    L.push('  classDef gl fill:#01A982,stroke:#01A982,color:#fff;');
    L.push('  classDef ep fill:#00806A,stroke:#00806A,color:#fff;');
    L.push('  class GL gl;');
    L.push('  class ME ep;');
    return L.join('\n');
  }, [inv, orderedLabels, k8sResources.nodes, llm, aiEnabled]);

  const runHealthRead = async () => {
    setHealthLoading(true);
    setHealth('');
    const summary =
      `Nodes: ${inv.readyNodes}/${inv.totalNodes} Ready. ` +
      `GPUs: ${inv.requestedGpu} of ${inv.totalGpu} requested (${Math.max(0, inv.totalGpu - inv.requestedGpu)} free). ` +
      `Pods: ${inv.runningPods}/${inv.totalPods} Running.\nComponents detected:\n` +
      orderedLabels.map((l) => {
        const b = inv.components[l];
        // Resource requests are included because "is this healthy" and "is this
        // starved or hogging" are different questions, and counts only answer one.
        return `- ${l}: ${b.deployments.length} deploy, ${b.pods.length} pods, ${b.services.length} svc, ` +
          `${b.unhealthy} unhealthy, requests ${fmtCpu(b.requested.cpuMilli)} CPU / ${fmtBytes(b.requested.memBytes)} / ${b.requested.gpu} GPU, ` +
          `on ${b.nodes.size} node(s)${b.claims.size ? `, ${b.claims.size} PVC(s)` : ''}`;
      }).join('\n');
    const prompt =
      `Here is a live snapshot of my HPE Private Cloud AI cluster:\n${summary}\n\n` +
      `Give a concise health read of the PCAI stack: which AI Essentials components are up, ` +
      `any risks (GPU capacity, unhealthy workloads, missing services), and the top 3 things to check. Keep it under 200 words.`;
    try {
      const res = await fetch('/api/pcai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, mode: 'ask', ...llm }),
      });
      const data = await res.json();
      setHealth(data.content || data.error || 'No response.');
    } catch (e: any) {
      setHealth(`Could not reach the assistant: ${e.message}`);
    } finally {
      setHealthLoading(false);
    }
  };

  if (!status.kubernetes.running) {
    return (
      <div className="panel-card">
        <div className="panel-card-title"><h2><Layers size={18} /> PCAI Stack Visualizer</h2></div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
          Kubernetes is not reachable. HPE Private Cloud AI runs on Kubernetes, so connect a cluster context to visualize the stack.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Rollup KPIs */}
      <div className="stats-grid-row">
        <div className="kpi-card cyan">
          <div className="kpi-content">
            <span className="kpi-label">Cluster Nodes</span>
            <div className="kpi-value-row">
              <span className="kpi-number">{inv.readyNodes}/{inv.totalNodes}</span>
              <span className="kpi-subtext">Ready</span>
            </div>
          </div>
          <div className="kpi-icon-box"><Server size={22} /></div>
        </div>
        <div className="kpi-card purple">
          <div className="kpi-content">
            <span className="kpi-label">GPU Allocation</span>
            <div className="kpi-value-row">
              {/* Capacity alone never told you whether there was any left. */}
              <span className="kpi-number">{inv.requestedGpu}/{inv.totalGpu}</span>
              <span className="kpi-subtext">
                {inv.totalGpu > 0
                  ? `requested · ${Math.max(0, inv.totalGpu - inv.requestedGpu)} free`
                  : 'nvidia.com/gpu'}
              </span>
            </div>
          </div>
          <div className="kpi-icon-box"><Cpu size={22} /></div>
        </div>
        <div className="kpi-card emerald">
          <div className="kpi-content">
            <span className="kpi-label">Running Pods</span>
            <div className="kpi-value-row">
              <span className="kpi-number">{inv.runningPods}/{inv.totalPods}</span>
              <span className="kpi-subtext">Workloads</span>
            </div>
          </div>
          <div className="kpi-icon-box"><Layers size={22} /></div>
        </div>
        <div className="kpi-card blue">
          <div className="kpi-content">
            <span className="kpi-label">AI Essentials Components</span>
            <div className="kpi-value-row">
              <span className="kpi-number">{orderedLabels.length}</span>
              <span className="kpi-subtext">Detected</span>
            </div>
          </div>
          <div className="kpi-icon-box"><Boxes size={22} /></div>
        </div>
      </div>

      {/* Topology map */}
      <div className="panel-card" style={{ width: '100%' }}>
        <div className="panel-card-title">
          <h2><Network size={18} /> PCAI Stack Topology</h2>
          <span className="badge neutral">GreenLake → Kubernetes → AI Essentials → Endpoint</span>
        </div>
        <div className="topology-visualizer-container" style={{ width: '100%' }}>
          <MermaidChart chart={mermaid} />
        </div>
      </div>

      {/* Component breakdown */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><Boxes size={18} /> AI Essentials Component Map</h2>
          <span className="badge neutral">{orderedLabels.length} layers</span>
        </div>
        {orderedLabels.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, fontStyle: 'italic' }}>
            No workloads classified yet — is kubectl pointed at your PCAI cluster?
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {orderedLabels.map((label) => {
              const b = inv.components[label];
              const healthy = b.unhealthy === 0;
              const isOpen = expanded === label;
              return (
                <div key={label} className="context-card" style={{ borderLeft: `3px solid ${healthy ? 'var(--hpe-green)' : 'var(--status-error)'}`, padding: 0 }}>
                  {/* Header — the rollup answers "what is it using" before you open anything */}
                  <button
                    onClick={() => toggle(label)}
                    style={{
                      width: '100%', background: 'transparent', border: 'none', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', textAlign: 'left',
                    }}
                  >
                    {isOpen
                      ? <ChevronDown size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      : <ChevronRight size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                    <span style={{ color: 'var(--hpe-green)', display: 'flex' }}>{iconFor(label)}</span>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{label}</span>

                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
                      <span>{b.deployments.length} workloads</span>
                      <span>{b.pods.length} pods</span>
                      <span>{b.services.length} svc</span>
                      {b.requested.gpu > 0 && (
                        <span style={{ color: 'var(--hpe-purple)', fontWeight: 600 }}>{b.requested.gpu} GPU</span>
                      )}
                      {b.requested.cpuMilli > 0 && <span>{fmtCpu(b.requested.cpuMilli)}</span>}
                      {b.requested.memBytes > 0 && <span>{fmtBytes(b.requested.memBytes)}</span>}
                      <span className={`badge ${healthy ? 'running' : 'error'}`} style={{ fontSize: 10 }}>
                        {healthy ? 'Healthy' : `${b.unhealthy} issue${b.unhealthy > 1 ? 's' : ''}`}
                      </span>
                    </span>
                  </button>

                  {isOpen && (
                    <div style={{ padding: '0 14px 14px 14px', display: 'flex', flexDirection: 'column', gap: 14, borderTop: '1px solid var(--border-color)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 12 }}>
                        <Metric label="CPU requested" value={fmtCpu(b.requested.cpuMilli)} />
                        <Metric label="Memory requested" value={fmtBytes(b.requested.memBytes)} />
                        <Metric label="GPUs held" value={b.requested.gpu > 0 ? String(b.requested.gpu) : '—'} accent={b.requested.gpu > 0} />
                        <Metric label="Nodes" value={b.nodes.size ? String(b.nodes.size) : '—'} />
                      </div>

                      {b.services.length > 0 && (
                        <Section title="Endpoints — how you reach it" icon={<Network size={13} />}>
                          <Table
                            head={['Service', 'Type', 'Cluster IP', 'Ports']}
                            rows={b.services.map((sv) => [sv.name, sv.type, sv.clusterIp, sv.ports || '—'])}
                          />
                        </Section>
                      )}

                      {b.deployments.length > 0 && (
                        <Section title="Workloads" icon={<Boxes size={13} />}>
                          <Table
                            head={['Name', 'Kind', 'Ready', 'Namespace']}
                            rows={b.deployments.map((d) => [d.name, d.kind || 'Deployment', d.ready, d.namespace])}
                            bad={(r) => {
                              const [ready, want] = String(r[2]).split('/');
                              return ready !== want || ready === '0';
                            }}
                          />
                        </Section>
                      )}

                      {b.pods.length > 0 && (
                        <Section title="Pods — how it is actually running" icon={<Layers size={13} />}>
                          <Table
                            head={['Pod', 'Status', 'Ready', 'Node', 'Restarts', 'GPU']}
                            rows={b.pods.slice(0, 40).map((pd) => {
                              const gpu = (pd.containers || []).reduce((n, c) => n + (c.requests?.gpu || 0), 0);
                              return [pd.name, pd.status, pd.ready, pd.node, String(pd.restarts), gpu > 0 ? String(gpu) : '—'];
                            })}
                            bad={(r) => r[1] !== 'Running' && r[1] !== 'Succeeded'}
                          />
                          {b.pods.length > 40 && (
                            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4 }}>
                              showing 40 of {b.pods.length}
                            </div>
                          )}
                        </Section>
                      )}

                      {b.images.size > 0 && (
                        <Section title="Images" icon={<Boxes size={13} />}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {[...b.images].slice(0, 12).map((img) => (
                              <code key={img} title={img} style={CHIP}>{shortImage(img)}</code>
                            ))}
                          </div>
                        </Section>
                      )}

                      {b.claims.size > 0 && (
                        <Section title="Persistent volumes" icon={<HardDrive size={13} />}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {[...b.claims].map((c) => <code key={c} style={CHIP}>{c}</code>)}
                          </div>
                        </Section>
                      )}

                      {b.nodes.size > 0 && (
                        <Section title="Runs on" icon={<Server size={13} />}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {[...b.nodes].map((n) => <code key={n} style={CHIP}>{n}</code>)}
                          </div>
                        </Section>
                      )}

                      {/* What these things actually are — offline catalog, no LLM */}
                      {(() => {
                        const infos = new Map<string, ComponentInfo>();
                        for (const pd of b.pods) {
                          const info = identified[pd.name];
                          if (info && !infos.has(info.id)) infos.set(info.id, info);
                        }
                        if (!infos.size) return null;
                        return (
                          <Section title="What these are" icon={<Sparkles size={13} />}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                              {[...infos.values()].map((info) => (
                                <div key={info.id} style={{ fontSize: 11.5, lineHeight: 1.55 }}>
                                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                    {info.title}
                                    <span style={{ marginLeft: 6, fontWeight: 400, fontSize: 10, color: 'var(--text-muted)' }}>{info.category}</span>
                                  </div>
                                  <div style={{ color: 'var(--text-secondary)' }}>{info.what}</div>
                                  <div style={{ color: 'var(--status-warning)', marginTop: 2 }}>If it stops: {info.impact}</div>
                                </div>
                              ))}
                            </div>
                          </Section>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* AI health read */}
      {aiEnabled && <div className="panel-card">
        <div className="panel-card-title">
          <h2><Activity size={18} /> PCAI Health Read</h2>
          <button className="btn primary" onClick={runHealthRead} disabled={healthLoading} style={{ padding: '6px 12px' }}>
            <Sparkles size={14} /> {healthLoading ? 'Analyzing…' : 'Analyze stack'}
          </button>
        </div>
        {health ? (
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>{health}</pre>
        ) : (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
            Feed the live component rollup to the PCAI assistant for a grounded health assessment and prioritized checks.
          </p>
        )}
      </div>}
    </div>
  );
};

export default PcaiStackView;
