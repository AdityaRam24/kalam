import React, { useState, useRef, useEffect } from 'react';
import { 
  Send, 
  Trash2, 
  SlidersHorizontal, 
  Check, 
  Download, 
  Sparkles, 
  Copy,
  Terminal,
  Activity,
  ShieldAlert,
  Server,
  Database,
  Cpu,
  Layers,
  User
} from 'lucide-react';
import MermaidChart from './MermaidChart';

export interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  actions?: Array<{
    type: string;
    id?: string;
    name?: string;
    namespace?: string;
    replicas?: number;
    label: string;
  }>;
  actionStatuses?: Record<string, { status: 'idle' | 'running' | 'success' | 'error'; output?: string }>;
}

interface HPEAgentChatProps {
  chatHistory: ChatMessage[];
  setChatHistory: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  chatLoading: boolean;
  chatInput: string;
  setChatInput: (val: string) => void;
  handleSendMessage: (e: React.FormEvent) => void;
  handleExecuteAgentAction: (msgIdx: number, actionIdx: number, action: any) => void;
  agentMermaidChart: string;
  setAgentMermaidChart: (chart: string) => void;
  provider: string;
  apiKey: string;
  localModel?: string;
  handleNodeHover?: (nodeKey: string | null, clientX: number, clientY: number) => void;
}

const QUICK_PROMPTS = [
  { icon: Activity, label: 'HPE InfoSight Diagnostic', prompt: 'Run a full HPE InfoSight predictive health diagnostic on all local containers and nodes.' },
  { icon: ShieldAlert, label: 'Audit Container CVEs', prompt: 'Audit all running Docker container images for CVE vulnerabilities and suggest secure Alpine/slim base image upgrades.' },
  { icon: Layers, label: 'Draw Cluster Topology', prompt: 'Generate a visual Mermaid diagram showing the relationship between my local Docker containers and Kubernetes pods.' },
  { icon: Server, label: 'Check Pod Restarts', prompt: 'Check if any Kubernetes pods in my cluster have failed restarts or CrashLoopBackOff errors.' },
  { icon: Database, label: 'List Port Mappings', prompt: 'List all running Docker containers with exposed host port mappings.' },
  { icon: Cpu, label: 'Scale Deployment', prompt: 'Show me how to scale my active Kubernetes deployment replicas up or down.' }
];

export const HPEAgentChat: React.FC<HPEAgentChatProps> = ({
  chatHistory,
  setChatHistory,
  chatLoading,
  chatInput,
  setChatInput,
  handleSendMessage,
  handleExecuteAgentAction,
  agentMermaidChart,
  setAgentMermaidChart,
  provider,
  apiKey,
  handleNodeHover
}) => {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, chatLoading]);

  const handleClearHistory = () => {
    if (window.confirm('Are you sure you want to clear your HPE InfoSight chat transcript?')) {
      localStorage.removeItem('kalam_chat_history');
      setChatHistory([
        {
          role: 'agent',
          content: `Hello! I am **HPE InfoSight AI Assistant**, your intelligent DevOps copilot powered by **HPE GreenLake**.

I have synced your live cluster environment. I can inspect Docker daemons, Kubernetes resources, and HPE infrastructure metrics in real time.

**How I can assist you:**
1. **Predictive Health Audits**: Run full diagnostic sweeps on nodes and container workloads.
2. **Interactive Remediations**: One-click actions to restart containers, scale deployments, or patch CVE base images.
3. **Architecture Diagrams**: Render live Mermaid topology flowcharts of your infrastructure.

Use the quick diagnostic prompt chips below or type any command to get started!`,
          timestamp: new Date()
        }
      ]);
      setAgentMermaidChart('');
    }
  };

  const handleExportTranscript = () => {
    const text = chatHistory
      .map(m => `### [${m.role.toUpperCase()}] - ${new Date(m.timestamp).toLocaleTimeString()}\n${m.content}\n`)
      .join('\n---\n\n');
    
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hpe_greenlake_chat_transcript_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyCodeToClipboard = (code: string, idx: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const triggerQuickPrompt = (promptText: string) => {
    setChatInput(promptText);
  };

  return (
    <div className="tab-panel chat-container" style={{ height: 'calc(100vh - 120px)' }}>
      {/* Left Panel: Diagram / Visualizer View */}
      <div className="chat-sidebar" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '18px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        
        {/* HPE InfoSight Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '12px', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '6px', background: 'var(--hpe-green)', color: '#0B0F19', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '800', fontSize: '12px' }}>
            HPE
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--text-heading)' }}>HPE InfoSight Visualizer</h3>
            <span style={{ fontSize: '10px', color: 'var(--hpe-green)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              GreenLake Architecture
            </span>
          </div>
        </div>

        <div className="chat-sidebar-section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 10px 0' }}>
            Mermaid cluster architecture diagrams generated by HPE InfoSight will render below:
          </p>
          <div className="mermaid-wrapper" style={{ flex: 1, minHeight: '320px', maxHeight: '520px', padding: '12px', background: 'var(--viz-surface)', border: '1px solid var(--viz-border)', borderRadius: '10px', overflowY: 'auto' }}>
            {agentMermaidChart ? (
              <MermaidChart chart={agentMermaidChart} onNodeHover={handleNodeHover} />
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic', padding: '32px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                <Activity size={32} style={{ color: 'var(--hpe-green)', opacity: 0.6 }} />
                <span>No topology diagram generated yet. Ask HPE InfoSight: <strong>"Draw a graph of my cluster."</strong></span>
              </div>
            )}
          </div>
        </div>

        {/* Quick Diagnostic Prompt Pills Carousel */}
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--hpe-green)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Sparkles size={12} />
            <span>HPE Ezmeral Quick Diagnostics</span>
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {QUICK_PROMPTS.map((qp, qIdx) => {
              const QIcon = qp.icon;
              return (
                <button
                  key={qIdx}
                  onClick={() => triggerQuickPrompt(qp.prompt)}
                  style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    fontSize: '11.5px',
                    cursor: 'pointer',
                    transition: 'var(--transition-fast)',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--hpe-green)';
                    e.currentTarget.style.background = 'rgba(1, 167, 129, 0.1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border-color)';
                    e.currentTarget.style.background = 'var(--bg-tertiary)';
                  }}
                >
                  <QIcon size={13} style={{ color: 'var(--hpe-green)' }} />
                  <span>{qp.label}</span>
                </button>
              );
            })}
          </div>
        </div>

      </div>

      {/* Right Panel: Main HPE Chat Console */}
      <div className="chat-main" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '12px', display: 'flex', flexDirection: 'column', height: '100%' }}>
        
        {/* Chat Console Top Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border-color)', background: 'rgba(1, 167, 129, 0.04)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--hpe-green)', boxShadow: '0 0 10px var(--hpe-green)' }}></span>
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-heading)' }}>HPE InfoSight AI Copilot Channel</span>
            <span className="badge success" style={{ fontSize: '10px' }}>Live Cluster Sync</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={handleExportTranscript}
              style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '6px' }}
              title="Export Chat History as Markdown"
            >
              <Download size={13} />
              <span>Export</span>
            </button>

            <button 
              onClick={handleClearHistory}
              style={{ background: 'rgba(240, 75, 76, 0.1)', border: '1px solid rgba(240, 75, 76, 0.3)', color: '#F04B4C', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '6px' }}
              title="Clear Chat History"
            >
              <Trash2 size={13} />
              <span>Clear</span>
            </button>
          </div>
        </div>

        {/* Message Stream Area */}
        <div className="chat-messages-wrapper" style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {chatHistory.map((msg, msgIdx) => (
            <div key={msgIdx} className={`chat-message ${msg.role}`}>
              <div className="chat-avatar" style={{ background: msg.role === 'user' ? 'var(--hpe-blue)' : 'var(--hpe-green)', color: '#0B0F19', fontWeight: 800 }}>
                {msg.role === 'user' ? <User size={16} /> : <Cpu size={16} />}
              </div>
              <div className="chat-bubble">
                <div className="chat-text-content" style={{ whiteSpace: 'pre-wrap' }}>
                  {msg.content.split('\n').map((line, lineIdx) => {
                    if (line.startsWith('```')) {
                      return null;
                    }
                    return (
                      <p key={lineIdx} style={{ margin: '0 0 6px 0', lineHeight: '1.5' }}>
                        {line.split(' ').map((word, wIdx) => {
                          if (word.startsWith('**') && word.endsWith('**')) {
                            return <strong key={wIdx} style={{ color: 'var(--text-heading)' }}>{word.slice(2, -2)} </strong>;
                          }
                          if (word.startsWith('*') && word.endsWith('*')) {
                            return <em key={wIdx}>{word.slice(1, -1)} </em>;
                          }
                          if (word.startsWith('`') && word.endsWith('`')) {
                            return <code key={wIdx} style={{ padding: '2px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '4px', fontFamily: 'var(--font-mono)', fontSize: '12.5px', color: 'var(--accent-cyan)' }}>{word.slice(1, -1)}</code>;
                          }
                          return word + ' ';
                        })}
                      </p>
                    );
                  })}
                </div>

                {/* Code snippets & copy button */}
                {msg.content.includes('```') && (
                  <div style={{ marginTop: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', background: 'rgba(1, 167, 129, 0.08)', borderBottom: '1px solid var(--border-color)', fontSize: '11px', color: 'var(--hpe-green)', fontWeight: 700 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Terminal size={12} />
                        <span>Code & Manifest Output</span>
                      </span>
                      <button
                        onClick={() => copyCodeToClipboard(msg.content, msgIdx)}
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        {copiedIdx === msgIdx ? <Check size={12} style={{ color: 'var(--hpe-green)' }} /> : <Copy size={12} />}
                        <span>{copiedIdx === msgIdx ? 'Copied!' : 'Copy Code'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Recommended Agent Actions */}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="chat-actions-container" style={{ marginTop: '12px', padding: '12px', background: 'rgba(1, 167, 129, 0.05)', border: '1px solid var(--hpe-green-border)', borderRadius: '8px' }}>
                    <span className="chat-actions-title" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--hpe-green)', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                      <SlidersHorizontal size={14} />
                      <span>HPE InfoSight Recommended Remediation Actions</span>
                    </span>
                    <div className="chat-actions-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {msg.actions.map((action, actionIdx) => {
                        const actKey = `act-${actionIdx}`;
                        const statusObj = msg.actionStatuses?.[actKey] || { status: 'idle' };

                        return (
                          <div key={actionIdx} style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <button
                                className="btn primary"
                                disabled={statusObj.status === 'running' || statusObj.status === 'success'}
                                onClick={() => handleExecuteAgentAction(msgIdx, actionIdx, action)}
                                style={{ padding: '6px 14px', fontSize: '12.5px', height: 'auto' }}
                              >
                                {statusObj.status === 'running' && <span className="loader" style={{ width: '12px', height: '12px', borderWidth: '2px' }}></span>}
                                {statusObj.status === 'success' && <Check size={14} style={{ color: 'var(--on-accent)' }} />}
                                <span>{action.label}</span>
                              </button>
                            </div>

                            {statusObj.output && (
                              <div style={{ padding: '8px 12px', background: 'var(--code-bg)', border: '1px solid var(--code-border)', borderRadius: '6px', fontSize: '12px', fontFamily: 'var(--font-mono)', color: statusObj.status === 'error' ? '#ff6b6b' : 'var(--code-text)' }}>
                                {statusObj.output}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              </div>
            </div>
          ))}

          {chatLoading && (
            <div className="chat-message agent">
              <div className="chat-avatar" style={{ background: 'var(--hpe-green)', color: '#0B0F19', fontWeight: 800 }}>
                <Cpu size={16} />
              </div>
              <div className="chat-bubble" style={{ padding: '16px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div className="loader"></div>
                  <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>HPE InfoSight is analyzing telemetry & cluster state...</span>
                </div>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Bottom Chat Input Form */}
        <div className="chat-input-wrapper" style={{ padding: '16px', borderTop: '1px solid var(--border-color)', background: 'rgba(0, 0, 0, 0.4)' }}>
          <form className="chat-input-form" onSubmit={handleSendMessage} style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <textarea 
              className="chat-input"
              placeholder={(provider === 'local' || apiKey) ? "Ask HPE InfoSight: 'Run health audit' or 'Scale my deployment to 3 replicas'" : "Configure your model settings in top header to start chat..."}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              disabled={(provider === 'gemini' && !apiKey) || chatLoading}
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage(e);
                }
              }}
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
              disabled={!chatInput.trim() || (provider === 'gemini' && !apiKey) || chatLoading}
              style={{ height: '44px', padding: '0 20px', flexShrink: 0 }}
            >
              <Send size={16} />
              <span>Send</span>
            </button>
          </form>
        </div>

      </div>
    </div>
  );
};

export default HPEAgentChat;
