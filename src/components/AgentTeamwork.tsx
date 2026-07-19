import React, { useState, useEffect } from 'react';
import { Play, RotateCw, AlertTriangle, Users, Terminal, MessageSquare } from 'lucide-react';

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
  const [activeAgent, setActiveAgent] = useState<string | null>(null);

  // Auto-reveal steps sequentially to simulate live agent cooperation
  useEffect(() => {
    if (trace.length === 0) return;
    
    // Show first step immediately to prevent blank screen transition
    setVisibleSteps([trace[0]]);
    setActiveAgent(trace[0].agent);
    
    if (trace.length <= 1) {
      setActiveAgent(null);
      return;
    }
    
    let currentIdx = 1;
    const interval = setInterval(() => {
      if (currentIdx < trace.length) {
        const nextStep = trace[currentIdx];
        if (nextStep) {
          setVisibleSteps(prev => [...prev, nextStep]);
          setActiveAgent(nextStep.agent);
        }
        currentIdx++;
      }
      
      if (currentIdx >= trace.length) {
        clearInterval(interval);
        setActiveAgent(null);
      }
    }, 2500); // 2.5s delay to show dialogue progression

    return () => clearInterval(interval);
  }, [trace]);

  const deployTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;

    setLoading(true);
    setError(null);
    setTrace([]);
    setVisibleSteps([]);
    setActiveAgent(null);

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
      }
    } catch (err: any) {
      setError(err.message || 'Error executing agentic pipeline.');
    } finally {
      setLoading(false);
    }
  };

  const getAgentAvatar = (agent: string) => {
    switch (agent) {
      case 'Planner': return '📋';
      case 'Docker Specialist': return '🐳';
      case 'K8s Administrator': return '☸️';
      case 'Security Officer': return '🛡️';
      case 'System Verifier': return '🔬';
      default: return '🤖';
    }
  };

  const getAgentColor = (agent: string) => {
    switch (agent) {
      case 'Planner': return '#38bdf8'; // light blue
      case 'Docker Specialist': return '#0ea5e9'; // sky blue
      case 'K8s Administrator': return '#a78bfa'; // violet
      case 'Security Officer': return '#ef4444'; // rose red
      case 'System Verifier': return '#10b981'; // emerald
      default: return '#94a3b8';
    }
  };

  const agents = ['Planner', 'Docker Specialist', 'K8s Administrator', 'Security Officer', 'System Verifier'];

  return (
    <div style={{ padding: '16px', fontFamily: 'Outfit, sans-serif', color: '#f8fafc', boxSizing: 'border-box' }}>
      
      {/* Goal Input form */}
      <form onSubmit={deployTeam} className="panel-card" style={{ padding: '20px', background: 'rgba(15, 23, 42, 0.4)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', marginBottom: '20px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 10px 0', fontSize: '15px', fontWeight: 600 }}>
          <Users size={18} style={{ color: '#38bdf8' }} /> Deploy DevOps Agent Team
        </h3>
        <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: '#94a3b8' }}>
          Define a high-level task. The system will deploy a team of specialized local agents running on your GPU to execute the planning, Docker auditing, Kubernetes scaling, and security verifications.
        </p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            placeholder="e.g. Audit default namespace, check container vulnerabilities, and scale active deployments..."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={loading}
            style={{
              flexGrow: 1,
              background: 'rgba(2, 6, 23, 0.6)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              padding: '10px 14px',
              color: '#f8fafc',
              fontSize: '13px',
              outline: 'none',
              fontFamily: 'inherit'
            }}
          />
          <button
            type="submit"
            disabled={loading || !goal.trim()}
            style={{
              background: '#38bdf8',
              color: '#0f172a',
              border: 'none',
              borderRadius: '8px',
              padding: '10px 20px',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'opacity 0.2s'
            }}
          >
            {loading ? (
              <>
                <RotateCw size={14} className="animate-spin" /> Deploying...
              </>
            ) : (
              <>
                <Play size={14} /> Deploy Team
              </>
            )}
          </button>
        </div>
      </form>

      {error && (
        <div style={{ background: 'rgba(244,63,94,0.1)', border: '1px solid #f43f5e', color: '#f43f5e', padding: '12px', borderRadius: '8px', marginBottom: '20px', fontSize: '13px' }}>
          <AlertTriangle size={16} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
          {error}
        </div>
      )}

      {/* Main Orchestration Panel Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '20px' }}>
        
        {/* ─── Step 1: Agent Flowchart Visualizer ─── */}
        <div className="panel-card" style={{ padding: '20px', background: 'rgba(15, 23, 42, 0.4)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <h4 style={{ margin: '0 0 16px 0', fontSize: '13px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.05em' }}>
            Agent Collaboration Pipeline
          </h4>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '14px', position: 'relative' }}>
            {agents.map((name, idx) => {
              const isActive = activeAgent === name;
              const hasRun = visibleSteps.some(s => s.agent === name);
              const isWorking = loading && idx === 0 && visibleSteps.length === 0;

              let cardBg = 'rgba(2, 6, 23, 0.4)';
              let borderStyle = '1px solid rgba(255,255,255,0.06)';
              let glow = 'none';

              if (isActive || isWorking) {
                cardBg = 'rgba(15, 23, 42, 0.8)';
                borderStyle = `2px solid ${getAgentColor(name)}`;
                glow = `0 0 15px ${getAgentColor(name)}40`;
              } else if (hasRun) {
                borderStyle = `1.5px solid ${getAgentColor(name)}80`;
              }

              return (
                <React.Fragment key={name}>
                  <div
                    style={{
                      flex: '1 1 150px',
                      background: cardBg,
                      border: borderStyle,
                      borderRadius: '10px',
                      padding: '12px',
                      textAlign: 'center',
                      boxShadow: glow,
                      transition: 'all 0.3s ease',
                      position: 'relative'
                    }}
                  >
                    <div style={{ fontSize: '24px', marginBottom: '6px' }}>{getAgentAvatar(name)}</div>
                    <div style={{ fontSize: '12px', fontWeight: 600 }}>{name}</div>
                    <div
                      style={{
                        fontSize: '9px',
                        marginTop: '4px',
                        textTransform: 'uppercase',
                        fontWeight: 'bold',
                        color: isActive || isWorking ? '#fbbf24' : hasRun ? '#10b981' : '#64748b'
                      }}
                    >
                      {isActive || isWorking ? '● Working' : hasRun ? '✓ Idle' : '○ Standby'}
                    </div>
                  </div>
                  {idx < agents.length - 1 && (
                    <div style={{ color: '#475569', fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      →
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* ─── Step 2: Interactive Dialogue Chat Stream & Terminal Logs ─── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 0.8fr)', gap: '20px', flexWrap: 'wrap' }}>
          
          {/* dialogue pane */}
          <div className="panel-card" style={{ padding: '20px', background: 'rgba(15, 23, 42, 0.4)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', minHeight: '350px', display: 'flex', flexDirection: 'column' }}>
            <h4 style={{ margin: '0 0 16px 0', fontSize: '13px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <MessageSquare size={14} /> Agent Communication Channel
            </h4>
            <div style={{ flexGrow: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '400px', paddingRight: '4px' }}>
              {loading && visibleSteps.length === 0 && (
                <div style={{ padding: '40px 0', textAlign: 'center', color: '#94a3b8' }}>
                  <RotateCw size={24} className="animate-spin" style={{ display: 'block', margin: '0 auto 12px auto', color: '#38bdf8' }} />
                  Planner Agent is analyzing the live system status and planning step execution...
                </div>
              )}
              {visibleSteps.map((step, idx) => {
                if (!step) return null;
                return (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      gap: '12px',
                      background: 'rgba(2,6,23,0.3)',
                      borderLeft: `3px solid ${getAgentColor(step.agent)}`,
                      borderRadius: '0 8px 8px 0',
                      padding: '10px 12px',
                      animation: 'fadeIn 0.5s ease-out'
                    }}
                  >
                    <div style={{ fontSize: '20px' }}>{getAgentAvatar(step.agent)}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left' }}>
                      <span style={{ fontSize: '11px', fontWeight: 'bold', color: getAgentColor(step.agent) }}>
                        {step.agent}
                      </span>
                      <span style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.4 }}>{step.message}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* host command terminal logs */}
          <div className="panel-card" style={{ padding: '20px', background: 'rgba(15, 23, 42, 0.4)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', minHeight: '350px', display: 'flex', flexDirection: 'column' }}>
            <h4 style={{ margin: '0 0 16px 0', fontSize: '13px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Terminal size={14} /> CLI Command Executions
            </h4>
            <div style={{ flexGrow: 1, overflowY: 'auto', background: '#020617', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px', padding: '12px', fontFamily: 'monospace', fontSize: '10px', color: '#38bdf8', maxHeight: '400px', textAlign: 'left' }}>
              {visibleSteps.length === 0 ? (
                <div style={{ color: '#475569', fontStyle: 'italic' }}>Waiting for agent commands...</div>
              ) : (
                visibleSteps.map((step, idx) => {
                  if (!step || !step.command) return null;
                  return (
                    <div key={idx} style={{ marginBottom: '14px' }}>
                      <div style={{ color: '#e2e8f0', display: 'flex', justifyItems: 'center', gap: '4px', marginBottom: '3px' }}>
                        <span style={{ color: '#10b981' }}>$</span> {step.command}
                      </div>
                      <pre style={{ margin: 0, paddingLeft: '8px', color: '#64748b', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {step.commandOutput || 'Executed successfully.'}
                      </pre>
                    </div>
                  );
                })
              )}
            </div>
          </div>

        </div>

      </div>

    </div>
  );
};

export default AgentTeamwork;
