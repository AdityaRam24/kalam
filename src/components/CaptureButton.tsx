// "Capture" in the top bar: keep a record of exactly what the screen shows.
//
// Four ways, because "the current state" means different things to different
// readers: a picture of the whole page (scrolled content included), a picture
// of just the visible screen, the raw data behind the page as JSON, or a
// point-in-time capture written into Change History so later changes are
// diffed against it.

import React, { useEffect, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Monitor, FileJson, History, Check, AlertTriangle } from 'lucide-react';
import { captureElement, captureName, downloadDataUrl } from '../lib/capture';
import { downloadText } from '../lib/health';

interface Props {
  /** What is on screen, used in the file name (e.g. "dashboard"). */
  pageName: string;
  /** Source currently selected ('local', 'all', or a VM name). */
  source: string;
  vmNames: string[];
  /** Everything the page is drawing, for the JSON export. */
  snapshot: () => unknown;
}

export const CaptureButton: React.FC<Props> = ({ pageName, source, vmNames, snapshot }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4500);
    return () => clearTimeout(t);
  }, [note]);

  const run = async (kind: string, fn: () => Promise<string>) => {
    setOpen(false);
    setBusy(kind);
    // Let the menu close before the DOM is cloned, so it is not in the picture.
    await new Promise((r) => setTimeout(r, 80));
    try {
      setNote({ ok: true, text: await fn() });
    } catch (e: any) {
      setNote({ ok: false, text: e?.message || 'Capture failed.' });
    } finally {
      setBusy('');
    }
  };

  const fullPage = () => run('page', async () => {
    const el = document.querySelector('.app-viewport') as HTMLElement | null;
    if (!el) throw new Error('Nothing to capture.');
    downloadDataUrl(await captureElement(el, { fullHeight: true }), captureName(pageName));
    return 'Saved a PNG of the whole page.';
  });

  const screen = () => run('screen', async () => {
    const el = document.querySelector('.app-shell') as HTMLElement | null;
    if (!el) throw new Error('Nothing to capture.');
    downloadDataUrl(await captureElement(el), captureName(`${pageName}-screen`));
    return 'Saved a PNG of the visible screen.';
  });

  const json = () => run('json', async () => {
    const data = { capturedAt: new Date().toISOString(), page: pageName, source, state: snapshot() };
    downloadText(JSON.stringify(data, null, 2), captureName(`${pageName}-state`, 'json'), 'application/json');
    return 'Saved the page data as JSON.';
  });

  const history = () => run('history', async () => {
    const targets = source === 'all' ? vmNames : [source];
    const results = await Promise.all(targets.map(async (s) => {
      const d = await fetch('/api/history/capture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: s }),
      }).then((r) => r.json()).catch((e) => ({ error: e.message }));
      return { s, d };
    }));
    const failed = results.filter((r) => r.d.error);
    if (failed.length === results.length) throw new Error(failed.map((f) => `${f.s}: ${f.d.error}`).join(' · '));
    const changes = results.reduce((a, r) => a + (r.d.changes || 0), 0);
    const objects = results.reduce((a, r) => a + (r.d.objects || 0), 0);
    return `Recorded ${objects} objects in Change History${changes ? ` — ${changes} change${changes === 1 ? '' : 's'} since the last capture` : ''}${failed.length ? ` (${failed.length} host${failed.length === 1 ? '' : 's'} failed)` : ''}.`;
  });

  const item = (icon: React.ReactNode, title: string, sub: string, onClick: () => void) => (
    <button type="button" onClick={onClick}
      style={{ display: 'flex', gap: 10, alignItems: 'flex-start', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '9px 12px', cursor: 'pointer', color: 'var(--text-primary)', borderRadius: 6 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
      <span style={{ color: 'var(--hpe-green)', marginTop: 1 }}>{icon}</span>
      <span>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>{sub}</span>
      </span>
    </button>
  );

  return (
    <div ref={ref} style={{ position: 'relative' }} data-capture-ignore>
      <button
        type="button"
        className={`icon-btn ${busy ? 'success' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Capture the current state — screenshot, data export or a Change History snapshot"
        style={{ padding: '6px 10px', gap: 6, fontSize: 12 }}
        disabled={!!busy}
      >
        <Camera size={14} className={busy ? 'loader' : ''} />
        <span style={{ fontSize: 12 }}>{busy ? 'Capturing…' : 'Capture'}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 2000, width: 300,
          background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10,
          boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))', padding: 6,
        }}>
          {item(<ImageIcon size={15} />, 'Screenshot — full page', 'PNG of this page, including everything scrolled out of view', fullPage)}
          {item(<Monitor size={15} />, 'Screenshot — visible screen', 'PNG of exactly what is on screen now', screen)}
          {item(<FileJson size={15} />, 'Export state as JSON', 'The data behind this page: resources, statuses, source', json)}
          {item(<History size={15} />, 'Snapshot to Change History', `Record the cluster now (${source === 'all' ? 'all hosts' : source === 'local' ? 'this machine' : source}) so later changes diff against it`, history)}
        </div>
      )}

      {note && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 2000, width: 300,
          background: 'var(--bg-card)', border: `1px solid ${note.ok ? 'var(--hpe-green-border, var(--border-color))' : 'var(--status-error)'}`,
          borderRadius: 10, padding: '10px 12px', fontSize: 12, color: note.ok ? 'var(--text-primary)' : 'var(--status-error)',
          boxShadow: 'var(--shadow-md, 0 8px 20px rgba(0,0,0,0.2))', display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          {note.ok ? <Check size={14} style={{ color: 'var(--hpe-green)', flexShrink: 0, marginTop: 1 }} /> : <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />}
          <span>{note.text}</span>
        </div>
      )}
    </div>
  );
};

export default CaptureButton;
