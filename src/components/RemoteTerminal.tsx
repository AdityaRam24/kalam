// A real terminal against an inventory VM.
//
// The old "remote command" box ran each command over its own SSH connection in
// a non-interactive shell, so half of what people typed did not work: `cd` was
// forgotten by the next command, exported variables vanished, anything that
// asked a question (sudo, apt, passwd) hung, and tools that need a TTY refused
// to start. This talks to a persistent login shell on a PTY instead — one
// session, kept open — so those all behave the way they do in MobaXterm.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, X, RefreshCw, ShieldAlert, CornerDownLeft, Trash2, Copy, Check } from 'lucide-react';
import { applyChunk, emptyTerm, termText, type TermState } from '../lib/terminal';

interface Props {
  vm: string;
  /** Open the session already elevated to root. */
  asRoot?: boolean;
  onClose: () => void;
}

export const RemoteTerminal: React.FC<Props> = ({ vm, asRoot = false, onClose }) => {
  const [state, setState] = useState<TermState>(emptyTerm);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [error, setError] = useState('');
  const [root, setRoot] = useState(asRoot);
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);

  // Shell history, the way a terminal does it: Up/Down walk previous commands.
  const history = useRef<string[]>([]);
  const historyPos = useRef<number>(-1);

  const outRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);

  const closeSession = useCallback((id: string | null) => {
    esRef.current?.close();
    esRef.current = null;
    if (!id) return;
    // keepalive so the shell is torn down even if the tab is closing.
    try {
      fetch(`/api/vms/shell/${id}/close`, { method: 'POST', keepalive: true });
    } catch { /* best effort */ }
  }, []);

  const open = useCallback(async (wantRoot: boolean) => {
    closeSession(sessionRef.current);
    sessionRef.current = null;
    setSessionId(null);
    setStatus('connecting');
    setError('');
    setState(emptyTerm());
    try {
      const res = await fetch('/api/vms/shell/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: vm, cols: 120, rows: 30, asRoot: wantRoot }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setStatus('error'); setError(data.error || 'Could not open a shell.'); return; }
      sessionRef.current = data.id;
      setSessionId(data.id);
      setRoot(!!data.root);
      setStatus('open');

      const es = new EventSource(`/api/vms/shell/${data.id}/stream`);
      esRef.current = es;
      es.addEventListener('data', (ev) => {
        setState((s) => applyChunk(s, JSON.parse((ev as MessageEvent).data)));
      });
      es.addEventListener('exit', (ev) => {
        const note = (() => { try { return JSON.parse((ev as MessageEvent).data).note; } catch { return ''; } })();
        setState((s) => applyChunk(s, `\n[${note || 'session closed'}]\n`));
        setStatus('closed');
        es.close();
      });
      es.onerror = () => { /* the exit event carries the real reason */ };
    } catch (e: any) {
      setStatus('error');
      setError(e.message);
    }
  }, [vm, closeSession]);

  useEffect(() => {
    open(asRoot);
    return () => closeSession(sessionRef.current);
    // Re-opening on every prop change would kill the user's shell mid-command;
    // the session is tied to the VM only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm]);

  // Follow the output, the way a terminal scrolls.
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state]);

  const send = useCallback(async (data: string) => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      const res = await fetch(`/api/vms/shell/${id}/input`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
      });
      const out = await res.json();
      if (out.error) setError(out.error);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const submit = () => {
    if (status !== 'open') return;
    if (input.trim()) {
      history.current = [...history.current.filter((h) => h !== input), input].slice(-100);
    }
    historyPos.current = -1;
    send(`${input}\n`);
    setInput('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const h = history.current;
      if (!h.length) return;
      historyPos.current = historyPos.current < 0 ? h.length - 1 : Math.max(0, historyPos.current - 1);
      setInput(h[historyPos.current]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const h = history.current;
      if (historyPos.current < 0) return;
      historyPos.current = historyPos.current + 1;
      if (historyPos.current >= h.length) { historyPos.current = -1; setInput(''); }
      else setInput(h[historyPos.current]);
      return;
    }
    // Control keys go straight through to the shell, so a runaway command can
    // be interrupted and `exit`/EOF work as usual.
    if (e.ctrlKey && !e.altKey) {
      const map: Record<string, string> = { c: '\x03', d: '\x04', z: '\x1a', l: '\x0c', u: '\x15' };
      const seq = map[e.key.toLowerCase()];
      if (seq) {
        e.preventDefault();
        if (e.key.toLowerCase() === 'l') { setState(emptyTerm()); return; }
        send(seq);
        setInput('');
      }
      return;
    }
    if (e.key === 'Tab') {
      // Completion needs the raw byte at the shell, and the reply is echoed
      // into the output pane rather than the input box.
      e.preventDefault();
      send(`${input}\t`);
      setInput('');
    }
  };

  const text = termText(state);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  const statusColor = status === 'open' ? 'var(--hpe-green)' : status === 'connecting' ? 'var(--status-warn, #E5A50A)' : 'var(--status-error)';

  return (
    <div className="panel-card" style={{ borderLeft: '3px solid var(--hpe-green)' }}>
      <div className="panel-card-title">
        <h2><TerminalIcon size={18} /> Terminal · {vm}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`badge ${root ? 'error' : 'neutral'}`} style={{ fontSize: 10 }} title={root ? 'This shell is running as root' : 'Running as the login user'}>
            {root ? 'root' : 'user'}
          </span>
          <span style={{ fontSize: 11, color: statusColor, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
            {status === 'open' ? 'connected' : status}
          </span>
          {!root && (
            <button className="btn secondary" style={{ padding: '6px 10px' }} onClick={() => open(true)} title="Open a new shell as root (sudo -i / su -)">
              <ShieldAlert size={13} /> Become root
            </button>
          )}
          <button className="btn secondary" style={{ padding: '6px 10px' }} onClick={() => open(root)} title="Restart this shell">
            <RefreshCw size={13} className={status === 'connecting' ? 'loader' : ''} /> Reconnect
          </button>
          <button className="icon-btn secondary" title="Copy all output" onClick={copyAll}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
          <button className="icon-btn secondary" title="Clear the screen" onClick={() => setState(emptyTerm())}><Trash2 size={14} /></button>
          <button className="icon-btn" onClick={() => { closeSession(sessionRef.current); onClose(); }}><X size={16} /></button>
        </div>
      </div>

      {error && <p style={{ color: 'var(--status-error)', fontSize: 12, marginTop: 0 }}>{error}</p>}

      <pre
        ref={outRef}
        onClick={() => inputRef.current?.focus()}
        style={{
          background: '#05070d', border: '1px solid var(--border-color)', borderRadius: 8,
          padding: 12, margin: 0, minHeight: 260, maxHeight: 460, overflow: 'auto',
          fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.45, color: '#d5e3dd',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'text',
        }}
      >
        {text || (status === 'connecting' ? 'Opening a shell…' : '')}
      </pre>

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <CornerDownLeft size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          className="form-input"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          disabled={status !== 'open'}
          style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
          placeholder={status === 'open' ? 'Type a command and press Enter — cd, sudo, vim, top all work' : 'Shell is not connected'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="btn primary" onClick={submit} disabled={status !== 'open'}>Send</button>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
        One persistent login shell over SSH{sessionId ? '' : ' (not connected)'} — the working directory, environment and
        interactive prompts survive between commands. Ctrl+C interrupts, Ctrl+D sends EOF, Ctrl+L clears, Tab completes,
        ↑/↓ walk history.
      </p>
    </div>
  );
};

export default RemoteTerminal;
