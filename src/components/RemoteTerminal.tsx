// A real terminal against an inventory VM.
//
// The first version of this panel was a text box plus a <pre>: a command was
// typed locally and sent on Enter, and output was appended as text. That is
// fine for `ls`, and useless for anything full-screen — `kubectl edit`, vim,
// less, top — because those programs need every keystroke as it happens (Esc,
// arrows, `:wq`) and draw with cursor-addressing escape codes a <pre> cannot
// interpret. So `kubectl edit` opened an editor nobody could type into.
//
// This is xterm.js on the same persistent PTY session: every key is sent raw,
// the screen is a proper VT emulator, and the PTY is resized to match the
// panel. It behaves like MobaXterm or any desktop terminal.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, X, RefreshCw, ShieldAlert, Copy, Check, Trash2, Maximize2, Minimize2, ClipboardPaste } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  vm: string;
  /** Open the session already elevated to root. */
  asRoot?: boolean;
  onClose: () => void;
}

const TERM_THEME = {
  background: '#0b0f14',
  foreground: '#d5e3dd',
  cursor: '#01a982',
  cursorAccent: '#0b0f14',
  selectionBackground: 'rgba(1, 169, 130, 0.35)',
  black: '#1b2028', red: '#f0616d', green: '#3fcf8e', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d5e3dd',
  brightBlack: '#5c6370', brightRed: '#ff7b86', brightGreen: '#5ee0a5', brightYellow: '#f2d48f',
  brightBlue: '#82c4ff', brightMagenta: '#d896ec', brightCyan: '#7fd3dd', brightWhite: '#ffffff',
};

export const RemoteTerminal: React.FC<Props> = ({ vm, asRoot = false, onClose }) => {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [error, setError] = useState('');
  const [root, setRoot] = useState(asRoot);
  const [copied, setCopied] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);

  // Keystrokes are sent in order, one request at a time. Parallel POSTs can
  // land out of order, and "jk" arriving as "kj" inside vim is a real bug.
  const pending = useRef('');
  const inflight = useRef(false);

  const flush = useCallback(async () => {
    if (inflight.current || !pending.current) return;
    const id = sessionRef.current;
    if (!id) { pending.current = ''; return; }
    const data = pending.current;
    pending.current = '';
    inflight.current = true;
    try {
      const res = await fetch(`/api/vms/shell/${id}/input`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
      });
      const out = await res.json().catch(() => ({}));
      if (out.error) setError(out.error);
    } catch (e: any) {
      setError(e.message);
    } finally {
      inflight.current = false;
      if (pending.current) void flush();
    }
  }, []);

  const send = useCallback((data: string) => {
    pending.current += data;
    void flush();
  }, [flush]);

  const closeSession = useCallback((id: string | null) => {
    esRef.current?.close();
    esRef.current = null;
    if (!id) return;
    // keepalive so the shell is torn down even if the tab is closing.
    try {
      fetch(`/api/vms/shell/${id}/close`, { method: 'POST', keepalive: true });
    } catch { /* best effort */ }
  }, []);

  const resizeRemote = useCallback(() => {
    const id = sessionRef.current;
    const t = termRef.current;
    if (!id || !t) return;
    fetch(`/api/vms/shell/${id}/resize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: t.cols, rows: t.rows }),
    }).catch(() => { /* the next resize will try again */ });
  }, []);

  const open = useCallback(async (wantRoot: boolean) => {
    closeSession(sessionRef.current);
    sessionRef.current = null;
    pending.current = '';
    setStatus('connecting');
    setError('');
    const t = termRef.current;
    t?.reset();
    t?.write('\x1b[90mOpening a shell…\x1b[0m\r\n');
    try {
      const res = await fetch('/api/vms/shell/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: vm, cols: t?.cols || 120, rows: t?.rows || 30, asRoot: wantRoot }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setStatus('error');
        setError(data.error || 'Could not open a shell.');
        t?.write(`\x1b[31m${data.error || 'Could not open a shell.'}\x1b[0m\r\n`);
        return;
      }
      sessionRef.current = data.id;
      setRoot(!!data.root);
      setStatus('open');
      t?.reset();

      const es = new EventSource(`/api/vms/shell/${data.id}/stream`);
      esRef.current = es;
      es.addEventListener('data', (ev) => {
        try { termRef.current?.write(JSON.parse((ev as MessageEvent).data)); } catch { /* malformed frame */ }
      });
      es.addEventListener('exit', (ev) => {
        const note = (() => { try { return JSON.parse((ev as MessageEvent).data).note; } catch { return ''; } })();
        termRef.current?.write(`\r\n\x1b[90m[${note || 'session closed'}]\x1b[0m\r\n`);
        setStatus('closed');
        es.close();
      });
      es.onerror = () => { /* the exit event carries the real reason */ };
      // The PTY was opened at the size the panel had when we asked; make sure
      // it matches what is on screen now.
      fitRef.current?.fit();
      resizeRemote();
      termRef.current?.focus();
    } catch (e: any) {
      setStatus('error');
      setError(e.message);
    }
  }, [vm, closeSession, resizeRemote]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) termRef.current?.paste(text);
    } catch {
      setError('The browser blocked clipboard access — use Ctrl+Shift+V or right-click → Paste inside the terminal.');
    }
    termRef.current?.focus();
  }, []);

  // Create the emulator once per mount.
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10000,
      theme: TERM_THEME,
      allowProposedApi: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try { fit.fit(); } catch { /* not laid out yet */ }
    termRef.current = term;
    fitRef.current = fit;

    // Terminal copy/paste conventions: Ctrl+Shift+C / Ctrl+Shift+V, and Ctrl+C
    // copies when something is selected (otherwise it is SIGINT, as always).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const k = ev.key.toLowerCase();
      if (ev.ctrlKey && ev.shiftKey && k === 'c') { void copyText(term.getSelection()); return false; }
      if (ev.ctrlKey && ev.shiftKey && k === 'v') { void pasteFromClipboard(); return false; }
      if (ev.ctrlKey && !ev.shiftKey && k === 'c' && term.hasSelection()) {
        void copyText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });

    const dataSub = term.onData((d) => send(d));
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeSub = term.onResize(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeRemote, 120);
    });
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } })
      : null;
    ro?.observe(hostRef.current);

    return () => {
      clearTimeout(resizeTimer);
      ro?.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [send, resizeRemote, copyText, pasteFromClipboard]);

  useEffect(() => {
    void open(asRoot);
    return () => closeSession(sessionRef.current);
    // Re-opening on every prop change would kill the user's shell mid-command;
    // the session is tied to the VM only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm]);

  // Maximize changes the panel size; refit after layout.
  useEffect(() => {
    const t = setTimeout(() => { try { fitRef.current?.fit(); } catch { /* hidden */ } termRef.current?.focus(); }, 60);
    return () => clearTimeout(t);
  }, [maximized]);

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'F11' || (e.key === 'Escape' && e.shiftKey)) { e.preventDefault(); setMaximized(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  const copyAll = () => {
    const t = termRef.current;
    if (!t) return;
    const buf = t.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    void copyText(lines.join('\n').replace(/\n+$/, ''));
  };

  const statusColor = status === 'open' ? 'var(--hpe-green)' : status === 'connecting' ? 'var(--status-warn, #E5A50A)' : 'var(--status-error)';

  return (
    <div
      className="panel-card"
      style={maximized
        ? { position: 'fixed', inset: 12, zIndex: 9000, display: 'flex', flexDirection: 'column', borderLeft: '3px solid var(--hpe-green)', margin: 0 }
        : { borderLeft: '3px solid var(--hpe-green)' }}
    >
      <div className="panel-card-title">
        <h2><TerminalIcon size={18} /> Terminal · {vm}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className={`badge badge-lc ${root ? 'error' : 'neutral'}`} style={{ fontSize: 10 }} title={root ? 'This shell is running as root' : 'Running as the login user'}>
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
          <button className="icon-btn secondary" title="Paste from clipboard (Ctrl+Shift+V)" onClick={pasteFromClipboard}><ClipboardPaste size={14} /></button>
          <button className="icon-btn secondary" title="Copy the whole scrollback" onClick={copyAll}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
          <button className="icon-btn secondary" title="Clear the screen (the shell keeps running)" onClick={() => { termRef.current?.clear(); termRef.current?.focus(); }}><Trash2 size={14} /></button>
          <button className="icon-btn secondary" title={maximized ? 'Restore (Shift+Esc)' : 'Maximize'} onClick={() => setMaximized((m) => !m)}>
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-btn" title="Close the session" onClick={() => { closeSession(sessionRef.current); onClose(); }}><X size={16} /></button>
        </div>
      </div>

      {error && <p style={{ color: 'var(--status-error)', fontSize: 12, marginTop: 0 }}>{error}</p>}

      <div
        onClick={() => termRef.current?.focus()}
        style={{
          background: TERM_THEME.background, border: '1px solid var(--border-color)', borderRadius: 8,
          padding: 8, height: maximized ? undefined : 460, flex: maximized ? 1 : undefined, minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
        A full terminal on one persistent login shell over SSH — every key goes straight to the host, so editors and
        full-screen tools work: <code>kubectl edit</code>, <code>vim</code>, <code>less</code>, <code>top</code>, <code>htop</code>.
        Ctrl+C interrupts (or copies when text is selected) · Ctrl+Shift+C / Ctrl+Shift+V copy and paste ·
        Tab completes · ↑/↓ shell history.
      </p>
    </div>
  );
};

export default RemoteTerminal;
