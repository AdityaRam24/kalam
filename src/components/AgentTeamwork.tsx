import React, { useState, useEffect } from 'react';
import { 
  Play, 
  AlertTriangle, 
  Users, 
  Terminal, 
  CheckCircle2, 
  Cpu, 
  Activity, 
  FileText, 
  Database, 
  Server, 
  ShieldAlert 
} from 'lucide-react';

interface AgentStep {
  agent: 'Planner' | 'Docker Specialist' | 'K8s Administrator' | 'Security Officer' | 'System Verifier';
  status: 'success' | 'working' | 'failed';
  message: string;
  command?: string;
  commandOutput?: string;
}

interface AgentTeamworkProps {
  containers: any[];
  k8sResources: any;
  localUrl: string;
  localModel: string;
  apiKey: string;
  provider: string;
}

const AGENTS_LIST = [
  { name: 'Planner', icon: FileText, role: 'Task & Workflow Coordinator', color: '#01A781', glow: 'rgba(1, 167, 129, 0.25)' },
  { name: 'Docker Specialist', icon: Database, role: 'Container Engine & Logs', color: '#0073E6', glow: 'rgba(0, 115, 230, 0.25)' },
  { name: 'K8s Administrator', icon: Server, role: 'Pods & Cluster Scaling', color: '#00C99B', glow: 'rgba(0, 201, 155, 0.25)' },
  { name: 'Security Officer', icon: ShieldAlert, role: 'CVE Scan & Hardening', color: '#FF8D00', glow: 'rgba(255, 141, 0, 0.25)' },
  { name: 'System Verifier', icon: Activity, role: 'Telemetry & Verification', color: '#10B981', glow: 'rgba(16, 185, 129, 0.25)' }
] as const;

export const AgentTeamwork: React.FC<AgentTeamworkProps> = ({
  containers: _containers,
  k8sResources: _k8sResources,
  localUrl,
  localModel,
  apiKey,
  provider
}) => {
  const [goal, setGoal] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<AgentStep[]>([]);
  const [visibleSteps, setVisibleSteps] = useState<AgentStep[]>([]);
  const [swarmActive, setSwarmActive] = useState<boolean>(false);

  // Auto-reveal steps across all agents concurrently side-by-side
  useEffect(() => {
    if (trace.length === 0) {
      setSwarmActive(false);
      return;
    }
    
    setSwarmActive(true);
    let currentIdx = 0;
    setVisibleSteps([]);

    const interval = setInterval(() => {
      if (currentIdx < trace.length) {
        const step = trace[currentIdx];
        if (step) {
          setVisibleSteps(prev => [...prev, step]);
        }
        currentIdx++;
      } else {
        clearInterval(interval);
        setSwarmActive(false);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [trace]);

  const deployTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;

    setLoading(true);
    setError(null);
    setTrace([]);
    setVisibleSteps([]);
    setSwarmActive(true);

    try {
      const res = await fetch('/api/agent/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: goal,
          provider,
          localUrl,
          localModel,
          apiKey
        })
      });

      const json = await res.json();
      if (res.ok) {
        setTrace(json.trace || []);
      } else {
        setError(json.error || json.details || 'Failed to deploy agent teamwork.');
        setSwarmActive(false);
      }
    } catch (err: any) {
      setError(err.message || 'Error executing agentic pipeline.');
      setSwarmActive(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%' }}>
      
      {/* Top Dispatcher Form Card */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h2>
            <Users size={18} style={{ color: 'var(--hpe-green)' }} />
            <span>HPE GreenLake Agentic Swarm Orchestrator</span>
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`badge ${swarmActive || loading ? 'running' : visibleSteps.length > 0 ? 'success' : 'neutral'}`}>
              <Activity size={12} className={swarmActive || loading ? 'loader' : ''} />
              {loading ? 'Initializing Swarm...' : swarmActive ? 'Concurrent Execution Active' : visibleSteps.length > 0 ? 'Swarm Task Complete' : 'Swarm Standby'}
            </span>
          </div>
        </div>

        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
          Deploy 5 specialized enterprise AI agents working <strong>side-by-side in parallel</strong>. Each agent handles a specific domain (Workflow Planning, Docker Runtime, Kubernetes Cluster, Security Audit, Telemetry Verification) concurrently.
        </p>

        <form onSubmit={deployTeam} style={{ display: 'flex', gap: '12px', marginTop: '6px' }}>
          <input
            type="text"
            placeholder="e.g., Audit default namespace, scan container CVEs, check pod health, and scale deployments..."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={loading}
            style={{
              flex: 1,
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '12px 16px',
              color: 'var(--text-primary)',
              fontSize: '13.5px',
              outline: 'none'
            }}
          />
          <button
            type="submit"
            className="btn primary"
            disabled={loading || !goal.trim()}
            style={{ padding: '0 22px', height: '44px', whiteSpace: 'nowrap' }}
          >
            {loading ? (
              <>
                <span className="loader"></span>
                <span>Deploying Swarm...</span>
              </>
            ) : (
              <>
                <Play size={15} />
                <span>Deploy Side-by-Side Swarm</span>
              </>
            )}
          </button>
        </form>
      </div>

      {error && (
        <div className="panel-card" style={{ borderLeft: '4px solid var(--status-error)', padding: '14px 18px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', color: 'var(--status-error)' }}>
            <AlertTriangle size={18} />
            <strong style={{ fontSize: '14px' }}>Swarm Deployment Error:</strong>
          </div>
          <p style={{ margin: '6px 0 0 0', color: 'var(--text-secondary)', fontSize: '13px' }}>{error}</p>
        </div>
      )}

      {/* ─── SIDE-BY-SIDE 5-COLUMN AGENT SWARM GRID ─── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Cpu size={16} style={{ color: 'var(--hpe-green)' }} />
            <span>Active Side-by-Side Swarm Matrix (5 Parallel Agents)</span>
          </h3>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            All 5 agents operate simultaneously in dedicated side-by-side swimlanes
          </span>
        </div>

        <div className="agent-swarm-grid">
          {AGENTS_LIST.map((agentMeta) => {
            const AgentIcon = agentMeta.icon;
            const agentSteps = visibleSteps.filter(s => s.agent === agentMeta.name);
            const isAgentActive = (swarmActive || loading) && (agentSteps.length > 0 || visibleSteps.length === 0);
            const hasFinished = visibleSteps.length > 0 && !swarmActive && !loading;

            return (
              <div 
                key={agentMeta.name} 
                className={`agent-column-card ${isAgentActive ? 'active' : ''}`}
                style={{
                  background: 'var(--bg-card)',
                  border: `1px solid ${isAgentActive ? agentMeta.color : 'var(--border-color)'}`,
                  borderRadius: '12px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  boxShadow: isAgentActive ? `0 0 16px ${agentMeta.glow}` : 'var(--shadow-sm)',
                  transition: 'all 0.25s ease',
                  minHeight: '380px'
                }}
              >
                {/* Agent Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${agentMeta.color}40`, color: agentMeta.color }}>
                      <AgentIcon size={18} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <strong style={{ fontSize: '13.5px', color: agentMeta.color }}>{agentMeta.name}</strong>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{agentMeta.role}</span>
                    </div>
                  </div>
                </div>

                {/* Status Dot Pill */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', background: 'var(--bg-tertiary)', padding: '4px 8px', borderRadius: '6px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Status:</span>
                  {isAgentActive ? (
                    <span style={{ color: '#fbbf24', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span className="loader" style={{ width: '10px', height: '10px', borderWidth: '1.5px', borderTopColor: '#fbbf24' }}></span>
                      <span>Working...</span>
                    </span>
                  ) : hasFinished ? (
                    <span style={{ color: 'var(--status-success)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <CheckCircle2 size={12} />
                      <span>Task Complete</span>
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>Standby</span>
                  )}
                </div>

                {/* Messages & Actions Body */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto', maxHeight: '280px' }}>
                  {loading && agentSteps.length === 0 ? (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '12px 0', textAlign: 'center' }}>
                      Initializing side-by-side agent thread...
                    </div>
                  ) : agentSteps.length === 0 ? (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '12px 0', textAlign: 'center' }}>
                      Awaiting task dispatch...
                    </div>
                  ) : (
                    agentSteps.map((step, sIdx) => (
                      <div 
                        key={sIdx}
                        style={{
                          background: 'var(--bg-tertiary)',
                          borderLeft: `3px solid ${agentMeta.color}`,
                          padding: '10px 12px',
                          borderRadius: '0 8px 8px 0',
                          fontSize: '12.5px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px'
                        }}
                      >
                        <span style={{ lineHeight: '1.4', color: 'var(--text-primary)' }}>{step.message}</span>
                        {step.command && (
                          <div style={{ background: 'var(--bg-primary)', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', marginTop: '2px' }}>
                            <div style={{ fontSize: '10px', color: 'var(--hpe-green)', fontFamily: 'var(--font-mono)' }}>
                              $ {step.command}
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── BOTTOM COMBINED COMMAND & TERMINAL EXECUTION STREAM ─── */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h3>
            <Terminal size={16} style={{ color: 'var(--hpe-green)' }} />
            <span>Parallel Terminal Command Stream</span>
          </h3>
          <span className="badge neutral">Real-Time Output</span>
        </div>

        <div className="logs-pre" style={{ maxHeight: '220px', minHeight: '120px' }}>
          {visibleSteps.filter(s => s.command).length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No CLI commands executed yet. Deploy the swarm to see side-by-side parallel terminal output...
            </span>
          ) : (
            visibleSteps.filter(s => s.command).map((step, idx) => {
              const agentMeta = AGENTS_LIST.find(a => a.name === step.agent);
              return (
                <div key={idx} style={{ marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span className="badge" style={{ background: `${agentMeta?.color}20`, color: agentMeta?.color, border: `1px solid ${agentMeta?.color}40`, fontSize: '10px' }}>
                      [{step.agent}]
                    </span>
                    <span style={{ color: 'var(--status-success)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                      $ {step.command}
                    </span>
                  </div>
                  <pre style={{ margin: 0, paddingLeft: '12px', color: 'var(--text-secondary)', fontSize: '11px', whiteSpace: 'pre-wrap' }}>
                    {step.commandOutput || 'Executed successfully.'}
                  </pre>
                </div>
              );
            })
          )}
        </div>
      </div>

    </div>
  );
};

export default AgentTeamwork;
