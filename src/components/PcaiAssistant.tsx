import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Trash2,
  BrainCircuit,
  Database,
  RefreshCw,
  BookOpen,
  Stethoscope,
  MessageSquare,
  ExternalLink,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Search,
  Clock,
} from 'lucide-react';

interface Source {
  ref: number;
  title: string;
  url: string;
  score: number;
}

interface PcaiMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  sources?: Source[];
  mode?: 'ask' | 'diagnose';
}

interface KbStatus {
  ready: boolean;
  ingesting: boolean;
  chunks: number;
  embedProvider: string;
  embedModel: string;
  updatedAt: string | null;
  sources: Array<{ title: string; url: string; chunks: number }>;
  lastIngestLog: string[];
}

interface PcaiAssistantProps {
  provider: string;
  apiKey: string;
  localUrl: string;
  localModel: string;
  embedModel?: string;
  authKey?: string;
}

const QUICK_PROMPTS: Array<{ label: string; prompt: string; mode: 'ask' | 'diagnose' }> = [
  { label: 'What is PCAI and its architecture?', prompt: 'Explain what HPE Private Cloud AI is and walk me through its architecture and main components.', mode: 'ask' },
  { label: 'AI Essentials components', prompt: 'What are the components of HPE AI Essentials (MLDE, MLDM, MLIS) and what does each do?', mode: 'ask' },
  { label: 'Diagnose a failed MLIS deployment', prompt: 'My MLIS inference deployment failed to start serving. What are the likely causes and how do I fix it?', mode: 'diagnose' },
  { label: 'Pod stuck in Pending', prompt: 'A pod on my PCAI cluster is stuck in Pending. How do I diagnose whether it is a GPU, CPU, or memory scheduling problem?', mode: 'diagnose' },
  { label: 'How do I manage users/access?', prompt: 'How do administrators manage users, roles, and entitlements for HPE Private Cloud AI?', mode: 'ask' },
  { label: 'What GPUs / sizing tiers exist?', prompt: 'What sizing tiers and NVIDIA GPU options does HPE Private Cloud AI offer?', mode: 'ask' },
];

const WELCOME: PcaiMessage = {
  role: 'agent',
  content: `Hello! I'm your **HPE Private Cloud AI (PCAI) Assistant**.

I'm a retrieval-grounded expert on **HPE Private Cloud AI** — AI Essentials (MLDE, MLDM, MLIS), the data lakehouse, NVIDIA AI Enterprise / NIM, HPE GreenLake management, and the Kubernetes platform PCAI runs on. Every answer I give is grounded in real HPE documentation and I cite my sources with \`[[n]]\` markers.

**How to use me:**
1. **Ask** anything about PCAI — architecture, setup, day-2 operations.
2. **Diagnose** an error — switch to *Diagnose Error* mode and paste an error message, log, or stack trace.

If the knowledge base isn't built yet, click **Train / Refresh Knowledge Base** on the left to ingest the HPE docs. Then ask away!`,
  timestamp: new Date(),
};

/** Minimal markdown renderer: headings, bold, inline code, fenced code, bullets, [[n]] refs. */
const renderContent = (content: string): React.ReactNode => {
  const blocks: React.ReactNode[] = [];
  const segments = content.split(/```/);
  segments.forEach((seg, i) => {
    const isCode = i % 2 === 1;
    if (isCode) {
      const body = seg.replace(/^[a-zA-Z0-9]*\n/, '');
      blocks.push(
        <pre key={`c${i}`} style={{ margin: '8px 0', padding: '12px', background: 'var(--code-bg)', border: '1px solid var(--code-border)', borderRadius: '8px', overflowX: 'auto', fontFamily: 'var(--font-mono)', fontSize: '12.5px', color: 'var(--code-text)', whiteSpace: 'pre' }}>
          {body.replace(/\n$/, '')}
        </pre>
      );
      return;
    }
    seg.split('\n').forEach((line, li) => {
      const key = `t${i}-${li}`;
      if (!line.trim()) {
        blocks.push(<div key={key} style={{ height: '4px' }} />);
        return;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        blocks.push(
          <div key={key} style={{ fontSize: heading[1].length <= 2 ? '15px' : '13.5px', fontWeight: 700, color: 'var(--text-heading)', margin: '10px 0 4px 0' }}>
            {renderInline(heading[2])}
          </div>
        );
        return;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        blocks.push(
          <div key={key} style={{ display: 'flex', gap: '8px', margin: '2px 0', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--hpe-green)', flexShrink: 0 }}>•</span>
            <span>{renderInline(bullet[1])}</span>
          </div>
        );
        return;
      }
      const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
      if (numbered) {
        blocks.push(
          <div key={key} style={{ display: 'flex', gap: '8px', margin: '2px 0', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--hpe-green)', fontWeight: 700, flexShrink: 0 }}>{numbered[1]}.</span>
            <span>{renderInline(numbered[2])}</span>
          </div>
        );
        return;
      }
      blocks.push(
        <p key={key} style={{ margin: '3px 0', lineHeight: 1.55 }}>{renderInline(line)}</p>
      );
    });
  });
  return blocks;
};

/** Inline formatting: **bold**, `code`, [[n]] source pills. */
const renderInline = (text: string): React.ReactNode => {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[\d+\]\])/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={i} style={{ color: 'var(--text-heading)' }}>{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith('`') && p.endsWith('`')) {
      return <code key={i} style={{ padding: '1px 5px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '4px', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--accent-cyan)' }}>{p.slice(1, -1)}</code>;
    }
    if (/^\[\[\d+\]\]$/.test(p)) {
      return <sup key={i} style={{ color: 'var(--hpe-green)', fontWeight: 700, fontSize: '10px', padding: '0 1px' }}>{p}</sup>;
    }
    return <span key={i}>{p}</span>;
  });
};

const PcaiAssistant: React.FC<PcaiAssistantProps> = ({ provider, apiKey, localUrl, localModel, embedModel, authKey }) => {
  const [messages, setMessages] = useState<PcaiMessage[]>(() => {
    const saved = localStorage.getItem('kalam_pcai_history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length) return parsed.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
      } catch { /* ignore */ }
    }
    return [WELCOME];
  });
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'ask' | 'diagnose'>('ask');
  const [kb, setKb] = useState<KbStatus | null>(null);
  const [crawl, setCrawl] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [ingestLog, setIngestLog] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem('kalam_pcai_history', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, ingestLog]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/pcai/status');
      const data = await res.json();
      setKb(data);
      if (data.ingesting) {
        setIngesting(true);
        setIngestLog(data.lastIngestLog || []);
      } else if (ingesting) {
        // ingestion just finished
        setIngesting(false);
        setIngestLog(data.lastIngestLog || []);
      }
      return data as KbStatus;
    } catch {
      return null;
    }
  }, [ingesting]);

  useEffect(() => {
    fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while ingesting.
  useEffect(() => {
    if (ingesting) {
      pollRef.current = window.setInterval(fetchStatus, 1500);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [ingesting, fetchStatus]);

  const handleTrain = async () => {
    if (ingesting) return;
    setIngesting(true);
    setIngestLog(['Starting ingestion...']);
    try {
      const res = await fetch('/api/pcai/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey, localUrl, embedModel, crawl, maxPages: 80 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setIngestLog((prev) => [...prev, `[FAIL] ${data.error || 'Ingestion failed'}: ${data.details || ''}`]);
      } else {
        setIngestLog(data.log || []);
      }
    } catch (e: any) {
      setIngestLog((prev) => [...prev, `[FAIL] Network error: ${e.message}`]);
    } finally {
      setIngesting(false);
      fetchStatus();
    }
  };

  const send = async (text: string, sendMode: 'ask' | 'diagnose') => {
    if (!text.trim() || loading) return;
    setInput('');
    setLoading(true);
    const userMsg: PcaiMessage = { role: 'user', content: text, timestamp: new Date(), mode: sendMode };
    const history = messages.filter((m) => m !== WELCOME).slice(-6).map((m) => ({ role: m.role, content: m.content }));
    // Add the user message + an empty agent bubble we stream tokens into.
    setMessages((prev) => [...prev, userMsg, { role: 'agent', content: '', timestamp: new Date(), sources: [], mode: sendMode }]);

    // Patch the trailing (agent) message as tokens arrive.
    const patchLast = (patch: (m: PcaiMessage) => PcaiMessage) =>
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = patch(copy[copy.length - 1]);
        return copy;
      });

    try {
      const res = await fetch('/api/pcai/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, mode: sendMode, chatHistory: history, apiKey, provider, localUrl, localModel, authKey }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({} as any));
        patchLast((m) => ({ ...m, content: `**${data.error || 'Error'}**\n\n${data.details || 'Failed to reach backend. Is the server running?'}` }));
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const raw = t.slice(5).trim();
            if (raw === '[DONE]') continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'sources') patchLast((m) => ({ ...m, sources: evt.sources }));
              else if (evt.type === 'delta' && evt.text) patchLast((m) => ({ ...m, content: m.content + evt.text }));
            } catch { /* ignore keepalive */ }
          }
        }
      }
    } catch (e: any) {
      patchLast((m) => ({ ...m, content: (m.content || '') + `\n\n**Failed to reach backend.** ${e.message}` }));
    } finally {
      setLoading(false);
    }
  };

  const clearChat = () => {
    if (window.confirm('Clear the PCAI assistant conversation?')) {
      localStorage.removeItem('kalam_pcai_history');
      setMessages([WELCOME]);
    }
  };

  const lastUpdated = kb?.updatedAt ? new Date(kb.updatedAt).toLocaleString() : null;

  return (
    <div className="tab-panel chat-container" style={{ height: 'calc(100vh - 120px)' }}>
      {/* LEFT: Knowledge Base control panel */}
      <div className="chat-sidebar" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '18px', display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '12px', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '6px', background: 'var(--hpe-green)', color: '#0B0F19', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <BrainCircuit size={18} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: 'var(--text-heading)' }}>PCAI Knowledge Base</h3>
            <span style={{ fontSize: '10px', color: 'var(--hpe-green)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              Retrieval-Grounded Brain
            </span>
          </div>
        </div>

        {/* KB Status */}
        <div className="context-card" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            {kb?.ready ? <CheckCircle2 size={15} style={{ color: 'var(--hpe-green)' }} /> : <AlertTriangle size={15} style={{ color: '#eab308' }} />}
            <strong style={{ color: 'var(--text-heading)' }}>{kb?.ready ? 'Knowledge base ready' : 'Not trained yet'}</strong>
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <span><Database size={11} style={{ verticalAlign: 'middle' }} /> {kb?.chunks || 0} chunks indexed</span>
            <span><Search size={11} style={{ verticalAlign: 'middle' }} /> Retrieval: <strong style={{ color: 'var(--text-primary)' }}>{kb && kb.embedProvider !== 'none' ? `vector (${kb.embedModel})` : 'lexical'}</strong></span>
            {lastUpdated && <span><Clock size={11} style={{ verticalAlign: 'middle' }} /> Updated: {lastUpdated}</span>}
          </div>
        </div>

        {/* Train controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={crawl} onChange={(e) => setCrawl(e.target.checked)} />
            Crawl live HPE docs (uncheck for offline seed only)
          </label>
          <button
            className="btn primary"
            onClick={handleTrain}
            disabled={ingesting}
            style={{ width: '100%' }}
          >
            {ingesting ? <span className="loader" style={{ width: '14px', height: '14px', borderWidth: '2px' }} /> : <RefreshCw size={15} />}
            <span>{ingesting ? 'Training…' : kb?.ready ? 'Refresh Knowledge Base' : 'Train / Build Knowledge Base'}</span>
          </button>
          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
            Uses your {provider === 'local' ? 'local model' : 'Gemini key'} for embeddings. Falls back to lexical search if none.
          </span>
        </div>

        {/* Ingest log */}
        {ingestLog.length > 0 && (
          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '10px', maxHeight: '140px', overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {ingestLog.slice(-40).map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}

        {/* Indexed sources */}
        {kb && kb.sources.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--hpe-green)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <BookOpen size={12} /> Indexed Sources ({kb.sources.length})
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflowY: 'auto' }}>
              {kb.sources.map((s, i) => (
                <a key={i} href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: 'var(--text-secondary)', textDecoration: 'none', display: 'flex', gap: '4px', alignItems: 'baseline' }}>
                  <ExternalLink size={10} style={{ flexShrink: 0, color: 'var(--hpe-green)' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* RIGHT: Chat console */}
      <div className="chat-main" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '12px', display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Header + mode toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border-color)', background: 'rgba(1, 167, 129, 0.04)', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--hpe-green)', boxShadow: '0 0 10px var(--hpe-green)' }} />
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-heading)' }}>HPE Private Cloud AI Assistant</span>
            <span className="badge success" style={{ fontSize: '10px' }}>{provider === 'local' ? localModel : 'Gemini'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ display: 'flex', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
              <button onClick={() => setMode('ask')} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', fontSize: '12px', border: 'none', cursor: 'pointer', background: mode === 'ask' ? 'var(--hpe-green)' : 'transparent', color: mode === 'ask' ? '#0B0F19' : 'var(--text-secondary)', fontWeight: 600 }}>
                <MessageSquare size={13} /> Ask
              </button>
              <button onClick={() => setMode('diagnose')} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', fontSize: '12px', border: 'none', cursor: 'pointer', background: mode === 'diagnose' ? 'var(--hpe-green)' : 'transparent', color: mode === 'diagnose' ? '#0B0F19' : 'var(--text-secondary)', fontWeight: 600 }}>
                <Stethoscope size={13} /> Diagnose Error
              </button>
            </div>
            <button onClick={clearChat} style={{ background: 'rgba(240, 75, 76, 0.1)', border: '1px solid rgba(240, 75, 76, 0.3)', color: '#F04B4C', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '6px' }}>
              <Trash2 size={13} /> <span>Clear</span>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="chat-messages-wrapper" style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {messages.map((msg, idx) => (
            <div key={idx} className={`chat-message ${msg.role}`}>
              <div className="chat-avatar" style={{ background: msg.role === 'user' ? 'var(--hpe-blue)' : 'var(--hpe-green)', color: '#0B0F19', fontWeight: 800 }}>
                {msg.role === 'user' ? 'U' : 'AI'}
              </div>
              <div className="chat-bubble">
                {msg.role === 'user' && msg.mode === 'diagnose' && (
                  <span className="badge warning" style={{ fontSize: '10px', marginBottom: '6px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Stethoscope size={11} /> Error Diagnosis
                  </span>
                )}
                <div className="chat-text-content" style={{ fontSize: '13.5px' }}>
                  {renderContent(msg.content)}
                </div>

                {msg.sources && msg.sources.length > 0 && (
                  <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border-color)' }}>
                    <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--hpe-green)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Sources</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                      {msg.sources.map((s) => (
                        <a key={s.ref} href={s.url} target="_blank" rel="noreferrer" title={s.url} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '3px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '12px', color: 'var(--text-secondary)', textDecoration: 'none' }}>
                          <span style={{ color: 'var(--hpe-green)', fontWeight: 700 }}>[{s.ref}]</span>
                          <span style={{ maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                          <ExternalLink size={10} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="chat-message agent">
              <div className="chat-avatar" style={{ background: 'var(--hpe-green)', color: '#0B0F19', fontWeight: 800 }}>AI</div>
              <div className="chat-bubble" style={{ padding: '16px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div className="loader" />
                  <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>Searching HPE documentation & composing a grounded answer…</span>
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Quick prompts */}
        {messages.length <= 1 && (
          <div style={{ padding: '0 16px 4px 16px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {QUICK_PROMPTS.map((qp, i) => (
              <button key={i} onClick={() => { setMode(qp.mode); send(qp.prompt, qp.mode); }} disabled={loading}
                style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '5px 10px', borderRadius: '6px', fontSize: '11.5px', cursor: 'pointer', textAlign: 'left' }}>
                {qp.label}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="chat-input-wrapper" style={{ padding: '16px', borderTop: '1px solid var(--border-color)', background: 'rgba(0, 0, 0, 0.4)' }}>
          <form onSubmit={(e) => { e.preventDefault(); send(input, mode); }} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
            <textarea
              placeholder={mode === 'diagnose' ? "Paste an error, log, or stack trace from your PCAI system…" : "Ask anything about HPE Private Cloud AI…"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={mode === 'diagnose' ? 3 : 1}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input, mode); } }}
              style={{ flex: 1, background: 'var(--bg-tertiary)', border: `1px solid ${mode === 'diagnose' ? 'var(--hpe-green-border, var(--border-color))' : 'var(--border-color)'}`, borderRadius: '8px', padding: '12px 16px', color: 'var(--text-primary)', fontSize: '13.5px', outline: 'none', resize: 'vertical', fontFamily: mode === 'diagnose' ? 'var(--font-mono)' : 'inherit' }}
            />
            <button type="submit" className="btn primary" disabled={!input.trim() || loading} style={{ height: '44px', padding: '0 20px', flexShrink: 0 }}>
              {mode === 'diagnose' ? <Stethoscope size={16} /> : <Send size={16} />}
              <span>{mode === 'diagnose' ? 'Diagnose' : 'Send'}</span>
            </button>
          </form>
          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '6px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <Sparkles size={11} /> Answers are grounded in indexed HPE docs and cite sources. Not affiliated with HPE.
          </span>
        </div>
      </div>
    </div>
  );
};

export default PcaiAssistant;
