// "Why is this failing?" for one object — the top of the topology drawer.
//
// Three answers, in the order an operator needs them:
//   1. Why it is failing: the cause in plain words, the evidence the cluster
//      gave, the object that is the real root cause, and the fix.
//   2. Its non-negotiables: every reference and label/annotation contract the
//      object depends on, each held / broken / cannot tell.
//   3. The recorded changes that most likely explain it, ranked, each with the
//      reason it was picked.
//
// Everything comes from /api/history/why in focus mode and passes through the
// sanitizer before it is rendered.

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, GitCommitHorizontal, RefreshCw, ShieldCheck, Tag, Wrench, XCircle } from 'lucide-react';
import { sanitizeWhyFocus, type WhyContract, type WhyFinding, type WhyFocus, type WhyRef } from '../lib/sanitize';

const SEV = {
  critical: { c: '#f43f5e', bg: 'rgba(244,63,94,0.08)', b: 'rgba(244,63,94,0.35)', label: 'Failing' },
  warning: { c: '#f59e0b', bg: 'rgba(245,158,11,0.08)', b: 'rgba(245,158,11,0.35)', label: 'At risk' },
  info: { c: '#38bdf8', bg: 'rgba(56,189,248,0.07)', b: 'rgba(56,189,248,0.3)', label: 'Note' },
} as const;

export function ago(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const refText = (r: WhyRef) => `${r.kind} ${r.namespace ? `${r.namespace}/` : ''}${r.name}`;

const Title = ({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '2px 0 6px' }}>
    {icon}{children}
  </div>
);

export function FindingCard({ f, onJump, compact }: { f: WhyFinding; onJump?: (r: WhyRef) => void; compact?: boolean }) {
  const s = SEV[f.severity];
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.b}`, borderLeft: `3px solid ${s.c}`, borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <AlertTriangle size={13} style={{ color: s.c, flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontWeight: 650, fontSize: 12, color: 'var(--tp-text, #f8fafc)', lineHeight: 1.35 }}>{f.title}</div>
      </div>
      {f.why && <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--tp-text-3, #cbd5e1)' }}>{f.why}</div>}

      {f.rootCause && (
        <div style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ color: '#64748b', fontWeight: 600 }}>Root cause</span>
          <button
            type="button"
            onClick={() => onJump?.(f.rootCause!)}
            disabled={!onJump}
            style={{ background: 'none', border: 'none', padding: 0, cursor: onJump ? 'pointer' : 'default', color: 'var(--tp-ns, #93c5fd)', fontFamily: 'monospace', fontSize: 11, textDecoration: onJump ? 'underline dotted' : 'none' }}
          >{refText(f.rootCause)}</button>
          {f.rootCause.reason && <span style={{ color: s.c }}>— {f.rootCause.reason}</span>}
        </div>
      )}

      {f.key && (
        <div style={{ fontSize: 10.5, lineHeight: 1.45, background: 'var(--tp-w03, rgba(255,255,255,0.03))', border: '1px solid var(--tp-w06, rgba(255,255,255,0.06))', borderRadius: 5, padding: '5px 7px' }}>
          <Tag size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4, color: '#a78bfa' }} />
          <span style={{ fontFamily: 'monospace', color: '#c4b5fd' }}>{f.key.name}</span>
          <span style={{ color: 'var(--tp-muted, #94a3b8)' }}> is read by {f.key.readBy}. {f.key.ifWrong}</span>
        </div>
      )}

      {!compact && f.evidence.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {f.evidence.slice(0, 5).map((e, i) => (
            <div key={i} style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--tp-muted, #94a3b8)', wordBreak: 'break-word' }}>› {e}</div>
          ))}
        </div>
      )}

      {f.fix.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}><Wrench size={10} /> Fix</div>
          <ol style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {f.fix.slice(0, compact ? 1 : 4).map((x, i) => (
              <li key={i} style={{ fontSize: 10.5, color: 'var(--tp-text-3, #cbd5e1)', wordBreak: 'break-word', fontFamily: /^(kubectl|crictl|systemctl)\b/.test(x) ? 'monospace' : undefined }}>{x}</li>
            ))}
          </ol>
        </div>
      )}

      {f.suspects.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
            <GitCommitHorizontal size={11} /> Changes that may explain this
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {f.suspects.map((sp, i) => (
              <div key={sp.change.id || i} style={{ fontSize: 10.5, borderLeft: `2px solid ${i === 0 ? '#a78bfa' : 'var(--tp-w08, rgba(255,255,255,0.08))'}`, paddingLeft: 7 }}>
                <div style={{ color: 'var(--tp-text, #f8fafc)' }}>
                  {sp.change.summary}
                  <span style={{ color: '#64748b' }}> · {ago(sp.change.actualAt || sp.change.at)}{sp.change.actor ? ` · by ${sp.change.actor}` : ''}</span>
                </div>
                <div style={{ color: '#64748b', fontSize: 9.5 }}>Why suspected: {sp.reason}</div>
                {sp.change.impact.slice(0, 2).map((line, j) => (
                  <div key={j} style={{ color: 'var(--tp-muted, #94a3b8)', fontSize: 9.5 }}>→ {line}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {f.since && <div style={{ fontSize: 9.5, color: '#64748b' }}>Failing since {new Date(f.since).toLocaleString()} ({ago(f.since)})</div>}
    </div>
  );
}

function ContractRow({ c }: { c: WhyContract }) {
  const icon = c.status === 'ok'
    ? <CheckCircle2 size={12} style={{ color: '#10b981', flexShrink: 0, marginTop: 1 }} />
    : c.status === 'violated'
      ? <XCircle size={12} style={{ color: '#f43f5e', flexShrink: 0, marginTop: 1 }} />
      : <CircleHelp size={12} style={{ color: '#64748b', flexShrink: 0, marginTop: 1 }} />;
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11 }}>
      {icon}
      <div style={{ minWidth: 0 }}>
        <div style={{ color: c.status === 'violated' ? 'var(--tp-badge-rose, #fda4af)' : 'var(--tp-text, #f8fafc)', wordBreak: 'break-word' }}>{c.rule}</div>
        <div style={{ color: '#64748b', fontSize: 10, wordBreak: 'break-word' }}>{c.detail}</div>
        {c.key && c.status !== 'ok' && <div style={{ color: 'var(--tp-muted, #94a3b8)', fontSize: 10 }}>{c.key.name}: read by {c.key.readBy}.</div>}
      </div>
    </div>
  );
}

export default function WhyPanel({ source, kind, namespace, name, refreshKey, onJump }: {
  source: string; kind: string; namespace?: string; name: string; refreshKey?: unknown; onJump?: (r: WhyRef) => void;
}) {
  const [data, setData] = useState<WhyFocus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = new URLSearchParams({ source, kind, name, ...(namespace ? { namespace } : {}) });
    fetch(`/api/history/why?${q}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setData(sanitizeWhyFocus(d)); })
      .catch(() => { if (!cancelled) setData(sanitizeWhyFocus({ error: 'Could not reach Trinetra’s server.' })); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // refreshKey re-asks after each map sample; the identity of the object is the rest.
  }, [source, kind, namespace, name, refreshKey]);

  if (!data) {
    return loading ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#38bdf8', fontSize: 11, padding: '4px 0' }}>
        <RefreshCw size={11} className="animate-spin" /> Working out why…
      </div>
    ) : null;
  }
  if (data.error && !data.findings.length) {
    return <div style={{ fontSize: 10.5, color: '#64748b' }}>Why-analysis unavailable: {data.error}</div>;
  }

  const violated = data.contracts.filter((c) => c.status === 'violated');
  const unknown = data.contracts.some((c) => c.status === 'unknown');
  const active = data.findings.filter((f) => f.severity !== 'info');
  const notes = data.findings.filter((f) => f.severity === 'info');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {active.length > 0 ? (
        <div>
          <Title icon={<AlertTriangle size={11} />}>Why it’s failing</Title>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {active.slice(0, 4).map((f) => <FindingCard key={f.id} f={f} onJump={onJump} />)}
          </div>
          {data.causes.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <Title>Upstream — what the root cause itself reports</Title>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.causes.slice(0, 2).map((f) => <FindingCard key={f.id} f={f} onJump={onJump} compact />)}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: violated.length ? '#f59e0b' : '#10b981' }}>
          <ShieldCheck size={13} />
          {violated.length
            ? `Not failing yet — but ${violated.length} non-negotiable${violated.length > 1 ? 's are' : ' is'} broken.`
            : data.contracts.length ? 'Nothing is failing here, and every non-negotiable holds.' : 'Nothing is failing here.'}
        </div>
      )}
      {notes.map((f) => <FindingCard key={f.id} f={f} onJump={onJump} compact />)}

      {data.contracts.length > 0 && (
        <div>
          <Title icon={<ShieldCheck size={11} />}>Non-negotiables ({data.contracts.length - violated.length}/{data.contracts.length} hold)</Title>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {[...violated, ...data.contracts.filter((c) => c.status !== 'violated')].map((c, i) => <ContractRow key={`${c.rule}-${i}`} c={c} />)}
          </div>
          {unknown && (
            <div style={{ fontSize: 9.5, color: '#64748b', marginTop: 4 }}>
              ? = Trinetra cannot read that kind with its current access (Secrets are never granted), so it does not guess.
            </div>
          )}
        </div>
      )}

      {data.metadata.length > 0 && (
        <details open={active.some((f) => f.key) || violated.some((c) => c.key)}>
          <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            <Tag size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
            Labels &amp; annotations other components depend on ({data.metadata.length})
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {data.metadata.map((m) => (
              <div key={`${m.where}:${m.key}`} style={{ fontSize: 10.5, lineHeight: 1.45 }}>
                <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  <span style={{ color: '#64748b' }}>{m.where} </span>
                  <span style={{ color: '#c4b5fd' }}>{m.key}</span>
                  <span style={{ color: 'var(--tp-muted, #94a3b8)' }}>={m.value}</span>
                </div>
                <div style={{ color: 'var(--tp-text-3, #cbd5e1)' }}>{m.meaning} <span style={{ color: '#64748b' }}>Read by {m.readBy}.</span></div>
                <div style={{ color: '#f59e0b', fontSize: 10 }}>If wrong: {m.ifWrong}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
