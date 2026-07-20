import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Cpu, Download, Check, AlertTriangle, Server, Eye, Sparkles, Loader } from 'lucide-react';

interface DiscoveredModel {
  name: string;
  size: number;
  sizeLabel: string;
  family: string;
  paramSize: string;
  quant: string;
  kind: 'chat' | 'embed' | 'vision';
  modified: string | null;
}

interface ModelPickerProps {
  localUrl: string;
  localModel: string;
  onSelectModel: (name: string) => void;
  embedModel: string;
  onSelectEmbed: (name: string) => void;
}

const ModelPicker: React.FC<ModelPickerProps> = ({ localUrl, localModel, onSelectModel, embedModel, onSelectEmbed }) => {
  const [chatModels, setChatModels] = useState<DiscoveredModel[]>([]);
  const [embedModels, setEmbedModels] = useState<DiscoveredModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [endpointUp, setEndpointUp] = useState(true);
  const [source, setSource] = useState<string>('');
  const [manual, setManual] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullStatus, setPullStatus] = useState('');
  const [pullPct, setPullPct] = useState<number | null>(null);
  const [pullName, setPullName] = useState('nomic-embed-text');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/llm/models?localUrl=${encodeURIComponent(localUrl)}`);
      const data = await res.json();
      setEndpointUp(!!data.endpointUp);
      setSource(data.source || '');
      setChatModels(data.chatModels || []);
      setEmbedModels(data.embedModels || []);
    } catch {
      setEndpointUp(false);
      setChatModels([]);
      setEmbedModels([]);
    } finally {
      setLoading(false);
    }
  }, [localUrl]);

  useEffect(() => { load(); }, [load]);

  // The selected chat model may not be in the discovered list (custom / not yet
  // pulled) — show it anyway so the <select> reflects reality.
  const chatOptions = React.useMemo(() => {
    const names = new Set(chatModels.map((m) => m.name));
    const list = [...chatModels];
    if (localModel && !names.has(localModel)) {
      list.unshift({ name: localModel, size: 0, sizeLabel: '', family: '', paramSize: '', quant: '', kind: 'chat', modified: null });
    }
    return list;
  }, [chatModels, localModel]);

  const embedOptions = React.useMemo(() => {
    const names = new Set(embedModels.map((m) => m.name));
    const list = [...embedModels];
    if (embedModel && !names.has(embedModel) && ![...names].some((n) => n.startsWith(embedModel))) {
      list.unshift({ name: embedModel, size: 0, sizeLabel: '', family: '', paramSize: '', quant: '', kind: 'embed', modified: null });
    }
    return list;
  }, [embedModels, embedModel]);

  const selected = chatModels.find((m) => m.name === localModel);

  const pullModel = async (name: string) => {
    if (!name.trim() || pulling) return;
    setPulling(true);
    setPullPct(null);
    setPullStatus('Starting…');
    try {
      const res = await fetch('/api/llm/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localUrl, name: name.trim() }),
      });
      if (!res.body) throw new Error('No stream');
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
            if (evt.status) setPullStatus(evt.status);
            if (typeof evt.pct === 'number') setPullPct(evt.pct);
            if (evt.status === 'error') setPullStatus(`Error: ${evt.error || 'pull failed'}`);
          } catch { /* ignore */ }
        }
      }
      setPullStatus('Done');
      await load();
      onSelectEmbed(name.trim().replace(/:latest$/, ''));
    } catch (e: any) {
      setPullStatus(`Error: ${e.message}`);
    } finally {
      setPulling(false);
    }
  };

  const kindIcon = (kind: string) => (kind === 'vision' ? <Eye size={12} /> : kind === 'embed' ? <Sparkles size={12} /> : <Cpu size={12} />);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Discovery header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <Server size={13} style={{ color: 'var(--hpe-green)' }} />
          Installed models
          {source && <span className="badge neutral" style={{ fontSize: '9px' }}>{source}</span>}
        </span>
        <button type="button" className="icon-btn" onClick={load} title="Rescan for installed models"
          style={{ padding: '5px 8px', fontSize: '11px', display: 'inline-flex', gap: '5px', alignItems: 'center' }}>
          <RefreshCw size={12} className={loading ? 'loader' : ''} /> Rescan
        </button>
      </div>

      {!endpointUp && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '10px', borderRadius: '8px', background: 'rgba(234, 179, 8, 0.08)', border: '1px solid rgba(234, 179, 8, 0.3)' }}>
          <AlertTriangle size={15} style={{ color: '#eab308', flexShrink: 0, marginTop: '1px' }} />
          <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
            No local model server reachable at <code>{localUrl}</code>. Start Ollama (<code>ollama serve</code>) or LM Studio, then click <strong>Rescan</strong>.
          </span>
        </div>
      )}

      {/* Chat model selector */}
      <div className="form-group">
        <label style={{ fontSize: '13px', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Chat / reasoning model</span>
          <button type="button" onClick={() => setManual((v) => !v)}
            style={{ background: 'none', border: 'none', color: 'var(--hpe-green)', fontSize: '11px', cursor: 'pointer' }}>
            {manual ? 'Choose from list' : '+ Enter manually'}
          </button>
        </label>

        {manual ? (
          <input
            type="text" className="form-input" placeholder="qwen2.5-coder:7b"
            value={localModel}
            onChange={(e) => onSelectModel(e.target.value)}
          />
        ) : (
          <select className="form-input" value={localModel} onChange={(e) => onSelectModel(e.target.value)}
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px', borderRadius: '8px' }}>
            {chatOptions.length === 0 && <option value={localModel}>{localModel || 'No models found'}</option>}
            {chatOptions.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}{m.paramSize ? ` — ${m.paramSize}` : ''}{m.sizeLabel ? `, ${m.sizeLabel}` : ''}{m.kind === 'vision' ? ' (vision)' : ''}
              </option>
            ))}
          </select>
        )}

        {selected && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
            {kindIcon(selected.kind)}
            {selected.family || 'model'} · {selected.paramSize || '—'} · {selected.sizeLabel}
            {selected.kind === 'vision' && <span style={{ color: '#eab308' }}> · vision model (better to pick a text model for chat)</span>}
          </span>
        )}
      </div>

      {/* Model chips for quick selection */}
      {chatModels.length > 0 && !manual && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {chatModels.map((m) => {
            const active = m.name === localModel;
            return (
              <button key={m.name} type="button" onClick={() => onSelectModel(m.name)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '5px 9px', borderRadius: '14px', cursor: 'pointer',
                  fontSize: '11px', fontFamily: 'var(--font-mono)',
                  border: `1px solid ${active ? 'var(--hpe-green)' : 'var(--border-color)'}`,
                  background: active ? 'rgba(1, 167, 129, 0.12)' : 'var(--bg-tertiary)',
                  color: active ? 'var(--hpe-green)' : 'var(--text-secondary)',
                }}>
                {active ? <Check size={11} /> : kindIcon(m.kind)}
                {m.name}
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-sans, inherit)' }}>{m.sizeLabel}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Embedding model (RAG) */}
      <div className="form-group" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
        <label style={{ fontSize: '13px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <Sparkles size={13} style={{ color: 'var(--hpe-green)' }} /> Embedding model <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(vector RAG)</span>
        </label>
        <select className="form-input" value={embedModel} onChange={(e) => onSelectEmbed(e.target.value)}
          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px', borderRadius: '8px' }}>
          {embedOptions.length === 0 && <option value={embedModel}>{embedModel}</option>}
          {embedOptions.map((m) => (
            <option key={m.name} value={m.name.replace(/:latest$/, '')}>{m.name}{m.sizeLabel ? ` — ${m.sizeLabel}` : ''}</option>
          ))}
        </select>

        {embedModels.length === 0 ? (
          <div style={{ marginTop: '6px' }}>
            <span style={{ fontSize: '11px', color: '#eab308', display: 'block', marginBottom: '6px' }}>
              No embedding model installed — retrieval falls back to keyword search. Pull one for best semantic RAG:
            </span>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="text" className="form-input" value={pullName} onChange={(e) => setPullName(e.target.value)}
                style={{ flex: 1, fontSize: '12px', padding: '7px 10px' }} placeholder="nomic-embed-text" />
              <button type="button" className="btn primary" disabled={pulling} onClick={() => pullModel(pullName)}
                style={{ fontSize: '12px', padding: '7px 12px', flexShrink: 0 }}>
                {pulling ? <Loader size={13} className="loader" /> : <Download size={13} />}
                <span>{pulling ? 'Pulling…' : 'Pull'}</span>
              </button>
            </div>
          </div>
        ) : (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Used to embed HPE docs & your questions. Rebuild the KB (Train) after changing this.
          </span>
        )}

        {pulling || pullStatus ? (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{pullStatus}</span>
              {pullPct !== null && <span>{pullPct}%</span>}
            </div>
            {pullPct !== null && (
              <div style={{ height: '5px', background: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden', marginTop: '4px' }}>
                <div style={{ height: '100%', width: `${pullPct}%`, background: 'var(--hpe-green)', transition: 'width 0.2s' }} />
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ModelPicker;
