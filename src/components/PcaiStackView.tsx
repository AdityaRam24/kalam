import React, { useMemo, useState } from 'react';
import { Layers, Cpu, Server, Activity, Sparkles, Boxes, Shield, Network, Database, GraduationCap, HardDrive } from 'lucide-react';
import MermaidChart from './MermaidChart';

// ---------------------------------------------------------------------------
// Types (subset of the App's cluster model)
// ---------------------------------------------------------------------------
interface Pod { name: string; namespace: string; status: string; ready: string; node: string; restarts: number; }
interface Service { name: string; namespace: string; type: string; clusterIp: string; ports: string; }
interface Deployment { name: string; namespace: string; ready: string; replicas: number; }
interface NodeResource { name: string; status: string; version: string; ip: string; gpus?: string; }
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

interface CompBucket { deployments: Deployment[]; pods: Pod[]; services: Service[]; unhealthy: number; }

export const PcaiStackView: React.FC<Props> = ({ k8sResources, status, llm }) => {
  const [health, setHealth] = useState<string>('');
  const [healthLoading, setHealthLoading] = useState(false);

  const inv = useMemo(() => {
    const components: Record<string, CompBucket> = {};
    const push = (label: string, kind: keyof CompBucket, item: any, bad: boolean) => {
      const b = (components[label] ||= { deployments: [], pods: [], services: [], unhealthy: 0 });
      (b[kind] as any[]).push(item);
      if (bad) b.unhealthy++;
    };
    for (const d of k8sResources.deployments) {
      const parts = d.ready.split('/');
      push(classify(d.name, d.namespace), 'deployments', d, parts[0] !== parts[1] || parts[0] === '0');
    }
    for (const p of k8sResources.pods) push(classify(p.name, p.namespace), 'pods', p, p.status !== 'Running' && p.status !== 'Succeeded');
    for (const s of k8sResources.services) push(classify(s.name, s.namespace), 'services', s, false);

    const totalGpu = k8sResources.nodes.reduce((n, node) => n + (parseInt(String(node.gpus || '0')) || 0), 0);
    return {
      components,
      totalGpu,
      readyNodes: k8sResources.nodes.filter((n) => n.status === 'Ready').length,
      totalNodes: k8sResources.nodes.length,
      runningPods: k8sResources.pods.filter((p) => p.status === 'Running').length,
      totalPods: k8sResources.pods.length,
    };
  }, [k8sResources]);

  const orderedLabels = useMemo(() => {
    const order = [...PCAI_COMPONENTS.map((c) => c.label), OTHER.label];
    return order.filter((l) => inv.components[l]);
  }, [inv]);

  const mermaid = useMemo(() => {
    const L: string[] = ['flowchart TB', '  GL["HPE GreenLake<br/>Control Plane"]'];
    const ep = llm.provider === 'gemini' ? 'Gemini' : (llm.authKey ? 'Model Endpoint' : (llm.localModel || 'Local LLM'));
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
  }, [inv, orderedLabels, k8sResources.nodes, llm]);

  const runHealthRead = async () => {
    setHealthLoading(true);
    setHealth('');
    const summary =
      `Nodes: ${inv.readyNodes}/${inv.totalNodes} Ready, GPUs: ${inv.totalGpu}, ` +
      `Pods: ${inv.runningPods}/${inv.totalPods} Running.\nComponents detected:\n` +
      orderedLabels.map((l) => {
        const b = inv.components[l];
        return `- ${l}: ${b.deployments.length} deploy, ${b.pods.length} pods, ${b.services.length} svc, ${b.unhealthy} unhealthy`;
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
            <span className="kpi-label">GPU Capacity</span>
            <div className="kpi-value-row">
              <span className="kpi-number">{inv.totalGpu}</span>
              <span className="kpi-subtext">nvidia.com/gpu</span>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {orderedLabels.map((label) => {
              const b = inv.components[label];
              const healthy = b.unhealthy === 0;
              return (
                <div key={label} className="context-card" style={{ borderLeft: `3px solid ${healthy ? 'var(--hpe-green)' : 'var(--status-error)'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                      <span style={{ color: 'var(--hpe-green)' }}>{iconFor(label)}</span>{label}
                    </div>
                    <span className={`badge ${healthy ? 'running' : 'error'}`} style={{ fontSize: 10 }}>
                      {healthy ? 'Healthy' : `${b.unhealthy} issue${b.unhealthy > 1 ? 's' : ''}`}
                    </span>
                  </div>
                  <div className="context-row"><span className="context-key">Deployments</span><span className="context-val">{b.deployments.length}</span></div>
                  <div className="context-row"><span className="context-key">Pods</span><span className="context-val">{b.pods.length}</span></div>
                  <div className="context-row"><span className="context-key">Services</span><span className="context-val">{b.services.length}</span></div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* AI health read */}
      <div className="panel-card">
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
      </div>
    </div>
  );
};

export default PcaiStackView;
