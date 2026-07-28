// Kubectl Reference Guide & Tools.
//
// Four surfaces over one shared idea: a command is not just text to copy, it is
// something with a risk level, placeholders to fill, and — when it is read-only
// and fully resolved — something Kalam can actually run against a connected VM
// and show you the output of.
//
// All catalog data and the rules that decide what may execute live in
// src/lib/kubectl.ts, where they are unit-tested.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Terminal, Search, Copy, Check, HelpCircle, Zap, BookOpen, Play, RotateCcw,
  Code, Info, ChevronRight, ShieldAlert, Server, AlertTriangle, Trophy, Wrench,
} from 'lucide-react';
import {
  CATEGORIES, COMMANDS, DEFAULT_BUILDER, QUIZ_QUESTIONS, RISK_LABEL, SCENARIOS,
  buildCommand, canRun, categoryCounts, classifyRisk, extractPlaceholders,
  fillPlaceholders, pickQuiz, riskOf, searchCommands, validateBuilder,
  type BuilderState, type BuilderVerb, type CategoryKey,
  type QuizQuestion, type Risk,
} from '../lib/kubectl';

// ---------------------------------------------------------------------------
// Shared style helpers — these repeated blobs were the bulk of the old file.
// ---------------------------------------------------------------------------

const input: React.CSSProperties = {
  width: '100%', background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', padding: '9px 10px', borderRadius: 8, fontSize: 13,
};
const label: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 6,
};
const card: React.CSSProperties = {
  border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', borderRadius: 12,
};
const codeChip: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: '#34d399',
  background: '#090d12', padding: '7px 12px', borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.08)', wordBreak: 'break-all', lineHeight: 1.5,
};

const RISK_STYLE: Record<Risk, { color: string; bg: string; border: string }> = {
  read: { color: 'var(--hpe-green)', bg: 'var(--hpe-green-dim)', border: 'var(--hpe-green-border)' },
  mutate: { color: 'var(--status-warning)', bg: 'var(--status-warning-glow)', border: 'var(--status-warning)' },
  destructive: { color: 'var(--status-error)', bg: 'var(--status-error-glow)', border: 'var(--status-error)' },
};

const RiskBadge: React.FC<{ risk: Risk }> = ({ risk }) => {
  const s = RISK_STYLE[risk];
  return (
    <span
      title={
        risk === 'read' ? 'Inspects only — safe to run.'
          : risk === 'mutate' ? 'Changes cluster state.'
            : 'Deletes or evicts resources. Read it twice.'
      }
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700,
        letterSpacing: '0.03em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 5,
        color: s.color, background: s.bg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap',
      }}
    >
      {risk !== 'read' && <ShieldAlert size={10} />}
      {RISK_LABEL[risk]}
    </span>
  );
};

/** Highlight every search term inside a piece of text. */
const Highlight: React.FC<{ text: string; terms: string[] }> = ({ text, terms }) => {
  if (!terms.length) return <>{text}</>;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
  if (!escaped.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'));
  const lower = terms.map((t) => t.toLowerCase());
  return (
    <>
      {parts.map((p, i) =>
        lower.includes(p.toLowerCase())
          ? <mark key={i} style={{ background: 'var(--hpe-green-dim)', color: 'var(--hpe-green)', padding: '0 2px', borderRadius: 3 }}>{p}</mark>
          : <React.Fragment key={i}>{p}</React.Fragment>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Execution target
// ---------------------------------------------------------------------------

interface VmTarget { name: string; host: string; via?: string }

/**
 * Kalam runs commands through the existing read-only SSH path
 * (POST /api/vms/exec) against a VM from the inventory. There is deliberately
 * no "run on this machine" option: that would mean adding a general local
 * shell endpoint, and the guide is not worth that attack surface.
 */
function useTargets() {
  const [targets, setTargets] = useState<VmTarget[]>([]);
  const [target, setTarget] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/vms')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const vms: VmTarget[] = d.vms || [];
        setTargets(vms);
        setTarget((cur) => cur || vms[0]?.name || '');
      })
      .catch(() => { /* offline backend: the guide still works as a reference */ });
    return () => { cancelled = true; };
  }, []);

  return { targets, target, setTarget };
}

// ---------------------------------------------------------------------------
// CommandBlock — the reusable unit: fill placeholders, copy, run, show output.
// ---------------------------------------------------------------------------

interface CommandBlockProps {
  command: string;
  /** Shared across the whole guide, so filling <pod-name> once fills it everywhere. */
  values: Record<string, string>;
  onValueChange: (name: string, value: string) => void;
  target: string;
  hasTargets: boolean;
  compact?: boolean;
}

const CommandBlock: React.FC<CommandBlockProps> = ({
  command, values, onValueChange, target, hasTargets, compact,
}) => {
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);

  const resolved = useMemo(() => fillPlaceholders(command, values), [command, values]);
  const placeholders = useMemo(() => extractPlaceholders(command), [command]);
  const runnability = useMemo(() => canRun(resolved), [resolved]);
  const risk = useMemo(() => classifyRisk(resolved), [resolved]);

  const copy = () => {
    navigator.clipboard?.writeText(resolved);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const run = async () => {
    if (!runnability.runnable || !target) return;
    setRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/vms/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: target, command: resolved }),
      });
      const d = await res.json();
      setOutput({ ok: !!d.ok, text: (d.output || d.error || '(no output)').slice(0, 20000) });
    } catch (e) {
      setOutput({ ok: false, text: e instanceof Error ? e.message : 'Request failed' });
    } finally {
      setRunning(false);
    }
  };

  const blockedReason = !hasTargets
    ? 'Add a VM in VM Monitor to run commands from here.'
    : !target ? 'Pick a target VM first.' : runnability.reason;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <code style={{ ...codeChip, flex: '1 1 320px' }}>{resolved}</code>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={copy}
            className="btn secondary"
            title="Copy to clipboard"
            style={{ padding: '7px 11px', display: 'flex', alignItems: 'center', gap: 6, height: 34 }}
          >
            {copied ? <Check size={14} style={{ color: 'var(--hpe-green)' }} /> : <Copy size={14} />}
            <span style={{ fontSize: 12 }}>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            onClick={run}
            disabled={!runnability.runnable || !target || running}
            className="btn secondary"
            title={runnability.runnable && target ? `Run on ${target} over SSH` : blockedReason}
            style={{
              padding: '7px 11px', display: 'flex', alignItems: 'center', gap: 6, height: 34,
              opacity: runnability.runnable && target ? 1 : 0.45,
              cursor: runnability.runnable && target ? 'pointer' : 'not-allowed',
            }}
          >
            {running ? <span className="loader" style={{ width: 13, height: 13 }} /> : <Play size={14} />}
            <span style={{ fontSize: 12 }}>{running ? 'Running…' : 'Run'}</span>
          </button>
        </div>
      </div>

      {/* Placeholder inputs — the command above updates as you type. */}
      {placeholders.length > 0 && !compact && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {placeholders.map((p) => (
            <div key={p} style={{ flex: '1 1 170px', minWidth: 140 }}>
              <label style={{ ...label, fontSize: 11, marginBottom: 3, color: 'var(--text-muted)' }}>{`<${p}>`}</label>
              <input
                type="text"
                value={values[p] || ''}
                onChange={(e) => onValueChange(p, e.target.value)}
                placeholder={p}
                style={{ ...input, padding: '6px 9px', fontSize: 12, fontFamily: 'var(--font-mono)' }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Why Run is unavailable — stated instead of a silently dead button. */}
      {!runnability.runnable && risk !== 'read' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <ShieldAlert size={12} style={{ color: RISK_STYLE[risk].color, flexShrink: 0 }} />
          <span>{runnability.reason}</span>
        </div>
      )}

      {output && (
        <pre
          style={{
            margin: 0, background: '#090d12', color: output.ok ? '#d5dbe4' : '#fca5a5',
            border: `1px solid ${output.ok ? 'rgba(255,255,255,0.08)' : 'var(--status-error)'}`,
            borderRadius: 8, padding: 12, fontSize: 11.5, fontFamily: 'var(--font-mono)',
            whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto',
          }}
        >
          {output.text}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type SubTab = 'directory' | 'builder' | 'troubleshoot' | 'quiz';

const TABS: Array<{ id: SubTab; label: string; icon: React.ReactNode }> = [
  { id: 'directory', label: 'Command Directory', icon: <BookOpen size={16} /> },
  { id: 'builder', label: 'Command Builder', icon: <Code size={16} /> },
  { id: 'troubleshoot', label: 'Runbooks', icon: <Wrench size={16} /> },
  { id: 'quiz', label: 'Practice Quiz', icon: <HelpCircle size={16} /> },
];

export const KubectlCheatSheet: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('directory');
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);
  const searchRef = useRef<HTMLInputElement>(null);

  // Placeholder values are shared by the directory, the runbooks and the
  // builder, so naming your pod once carries through the whole investigation.
  const [values, setValues] = useState<Record<string, string>>({});
  const setValue = useCallback((name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
  }, []);

  const { targets, target, setTarget } = useTargets();
  const [builder, setBuilder] = useState<BuilderState>(DEFAULT_BUILDER);

  // Quiz state — questions are drawn per run, so repeats are not the same five.
  const [quiz, setQuiz] = useState<QuizQuestion[] | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(false);
  const [highScore, setHighScore] = useState(0);

  useEffect(() => {
    try {
      setHighScore(Number(localStorage.getItem('kalam_kubectl_quiz_highscore') || '0'));
    } catch { /* storage disabled (private mode) — the quiz just won't persist */ }
  }, []);

  // "/" focuses search, the way every reference tool behaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
        setActiveSubTab('directory');
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const terms = useMemo(() => searchQuery.toLowerCase().split(/\s+/).filter(Boolean), [searchQuery]);
  const filtered = useMemo(
    () => searchCommands(COMMANDS, searchQuery, selectedCategory),
    [searchQuery, selectedCategory]
  );
  // Counts reflect the active search, so a category pill showing 0 tells you
  // not to bother clicking it.
  const counts = useMemo(() => categoryCounts(searchCommands(COMMANDS, searchQuery)), [searchQuery]);

  const generated = useMemo(() => buildCommand(builder), [builder]);
  const issues = useMemo(() => validateBuilder(builder), [builder]);
  const setB = <K extends keyof BuilderState>(key: K, v: BuilderState[K]) =>
    setBuilder((s) => ({ ...s, [key]: v }));

  const blockProps = { values, onValueChange: setValue, target, hasTargets: targets.length > 0 };

  // ---- quiz actions -------------------------------------------------------
  const startQuiz = () => {
    setQuiz(pickQuiz(8));
    setQIndex(0);
    setChosen(null);
    setScore(0);
    setFinished(false);
  };

  const answer = (i: number) => {
    if (chosen !== null || !quiz) return;
    setChosen(i);
    if (i === quiz[qIndex].correct) setScore((s) => s + 1);
  };

  const nextQuestion = () => {
    if (!quiz) return;
    if (qIndex + 1 < quiz.length) {
      setQIndex((i) => i + 1);
      setChosen(null);
      return;
    }
    // Score is already final here: it was incremented when the answer was
    // chosen. (The old version added the last answer a second time.)
    setFinished(true);
    if (score > highScore) {
      setHighScore(score);
      try {
        localStorage.setItem('kalam_kubectl_quiz_highscore', String(score));
      } catch { /* storage disabled */ }
    }
  };

  return (
    <div className="tab-panel animate-fade-in" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', height: '100%' }}>

      {/* ---- Header ------------------------------------------------------ */}
      <div className="panel-card" style={{ ...card, background: 'linear-gradient(135deg, var(--bg-secondary) 0%, rgba(1, 169, 130, 0.05) 100%)', padding: 22, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', right: -30, top: -30, opacity: 0.07, pointerEvents: 'none' }}>
          <Terminal size={170} style={{ color: 'var(--hpe-green)' }} />
        </div>
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ flex: '1 1 420px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, background: 'var(--hpe-green-dim)', border: '1px solid var(--hpe-green-border)', borderRadius: 8 }}>
                <Terminal size={20} style={{ color: 'var(--hpe-green)' }} />
              </div>
              <h2 style={{ fontSize: 21, fontWeight: 700, color: 'var(--text-heading)', margin: 0 }}>Kubectl Reference Guide &amp; Tools</h2>
              <span className="badge neutral" style={{ fontSize: 11 }}>{COMMANDS.length} commands · {SCENARIOS.length} runbooks</span>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13.5, maxWidth: 760, margin: 0, lineHeight: 1.5 }}>
              Every command is labelled by what it can do to your cluster, fills in its own placeholders,
              and — when it is read-only — runs against a connected VM right here. Press <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '1px 5px', border: '1px solid var(--border-color)', borderRadius: 4, background: 'var(--bg-tertiary)' }}>/</kbd> to search.
            </p>
          </div>

          {/* Target selector */}
          <div style={{ flex: '0 1 260px', minWidth: 220 }}>
            <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Server size={13} style={{ color: 'var(--hpe-green)' }} /> Run commands on
            </label>
            {targets.length ? (
              <>
                <select value={target} onChange={(e) => setTarget(e.target.value)} style={input}>
                  {targets.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} ({v.host}){v.via ? ` via ${v.via}` : ''}
                    </option>
                  ))}
                </select>
                <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  Read-only commands only, over the existing SSH path. Anything that changes state is copy-only.
                </p>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                No VMs in the inventory yet. Add one in <strong>VM Monitor</strong> to run read-only
                commands directly from this guide.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ---- Sub-tabs ---------------------------------------------------- */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', gap: 6, overflowX: 'auto' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveSubTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px', border: 'none',
              background: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap',
              color: activeSubTab === t.id ? 'var(--hpe-green)' : 'var(--text-secondary)',
              borderBottom: `2px solid ${activeSubTab === t.id ? 'var(--hpe-green)' : 'transparent'}`,
              transition: 'all 0.15s ease',
            }}
          >
            {t.icon}<span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* ================= DIRECTORY ================= */}
      {activeSubTab === 'directory' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          <div style={{ position: 'relative' }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-muted)' }} />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search commands, descriptions and explanations — try: logs previous, oomkilled, rbac"
              style={{ ...input, padding: '10px 74px 10px 36px' }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{ position: 'absolute', right: 10, top: 8, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 4 }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Category pills with live counts */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(Object.keys(CATEGORIES) as CategoryKey[]).map((key) => {
              const n = counts[key] || 0;
              const active = selectedCategory === key;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedCategory(key)}
                  disabled={n === 0 && key !== 'all'}
                  style={{
                    padding: '6px 12px', borderRadius: 20, fontSize: 12.5, fontWeight: 600, cursor: n === 0 && key !== 'all' ? 'not-allowed' : 'pointer',
                    border: `1px solid ${active ? 'var(--hpe-green-border)' : 'var(--border-color)'}`,
                    background: active ? 'var(--hpe-green-dim)' : 'var(--bg-secondary)',
                    color: active ? 'var(--hpe-green)' : n === 0 && key !== 'all' ? 'var(--text-muted)' : 'var(--text-secondary)',
                    opacity: n === 0 && key !== 'all' ? 0.45 : 1, transition: 'all 0.15s ease',
                  }}
                >
                  {CATEGORIES[key]} <span style={{ opacity: 0.7 }}>{n}</span>
                </button>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {filtered.length} command{filtered.length === 1 ? '' : 's'}
            {searchQuery && <> matching “{searchQuery}”</>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filtered.map((item) => {
              const risk = riskOf(item);
              const isOpen = expanded === item.command;
              return (
                <div
                  key={item.command}
                  className="panel-card"
                  style={{ ...card, padding: 15, display: 'flex', flexDirection: 'column', gap: 11, borderLeft: `3px solid ${RISK_STYLE[risk].color}` }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <RiskBadge risk={risk} />
                    {item.tags.map((tag) => (
                      <span key={tag} className="badge neutral" style={{ fontSize: 10, padding: '2px 6px' }}>{tag}</span>
                    ))}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                      {CATEGORIES[item.category]}
                    </span>
                  </div>

                  <CommandBlock command={item.command} {...blockProps} />

                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.45 }}>
                    <Highlight text={item.description} terms={terms} />
                  </p>

                  {item.explanation && (
                    <>
                      <button
                        onClick={() => setExpanded(isOpen ? null : item.command)}
                        style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}
                      >
                        <Info size={13} />
                        {isOpen ? 'Hide details' : 'Why it matters'}
                      </button>
                      {isOpen && (
                        <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderLeft: '3px solid var(--hpe-green)', borderRadius: 8, padding: '11px 13px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                          <Highlight text={item.explanation} terms={terms} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            {!filtered.length && (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                <Search size={30} style={{ marginBottom: 10, opacity: 0.5 }} />
                <p style={{ margin: 0, fontSize: 14 }}>No commands match “{searchQuery}”.</p>
                <button onClick={() => { setSearchQuery(''); setSelectedCategory('all'); }} className="btn secondary" style={{ marginTop: 12 }}>
                  Reset filters
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= BUILDER ================= */}
      {activeSubTab === 'builder' && (
        <div className="dashboard-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.15fr)', gap: 18, alignItems: 'start' }}>

          <div className="panel-card" style={{ ...card, display: 'flex', flexDirection: 'column', gap: 14, padding: 18 }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 15, color: 'var(--text-heading)' }}>
              <Code size={17} style={{ color: 'var(--hpe-green)' }} /> Configure
            </h3>

            <div>
              <label style={label}>Verb</label>
              <select value={builder.verb} onChange={(e) => setB('verb', e.target.value as BuilderVerb)} style={input}>
                <option value="get">get — list and view resources</option>
                <option value="describe">describe — full detail plus events</option>
                <option value="logs">logs — container output</option>
                <option value="exec">exec — run a command inside a container</option>
                <option value="top">top — live CPU and memory</option>
                <option value="rollout">rollout — status, restart, undo, history</option>
                <option value="scale">scale — change replica count</option>
                <option value="port-forward">port-forward — tunnel to your machine</option>
                <option value="delete">delete — remove resources</option>
              </select>
            </div>

            {builder.verb === 'rollout' && (
              <div>
                <label style={label}>Rollout action</label>
                <select value={builder.rolloutAction} onChange={(e) => setB('rolloutAction', e.target.value as BuilderState['rolloutAction'])} style={input}>
                  <option value="status">status — watch until complete</option>
                  <option value="restart">restart — rolling restart of all pods</option>
                  <option value="undo">undo — roll back a revision</option>
                  <option value="history">history — list revisions</option>
                </select>
              </div>
            )}

            <div>
              <label style={label}>Resource kind</label>
              <select value={builder.resource} onChange={(e) => setB('resource', e.target.value)} style={input}>
                <option value="pods">pods (po)</option>
                <option value="deployments">deployments (deploy)</option>
                <option value="daemonsets">daemonsets (ds)</option>
                <option value="statefulsets">statefulsets (sts)</option>
                <option value="services">services (svc)</option>
                <option value="nodes">nodes (no)</option>
                <option value="namespaces">namespaces (ns)</option>
                <option value="configmaps">configmaps (cm)</option>
                <option value="secrets">secrets</option>
                <option value="ingresses">ingresses (ing)</option>
                <option value="persistentvolumeclaims">persistentvolumeclaims (pvc)</option>
                <option value="events">events</option>
              </select>
            </div>

            <div>
              <label style={label}>
                Resource name {['logs', 'exec', 'scale', 'rollout', 'port-forward'].includes(builder.verb) && <span style={{ color: 'var(--status-error)' }}>*</span>}
              </label>
              <input
                type="text"
                value={builder.name}
                onChange={(e) => setB('name', e.target.value)}
                placeholder={builder.verb === 'logs' ? 'e.g. web-backend-7d9f8b6c4d-x9k2' : 'leave empty to list everything'}
                style={{ ...input, fontFamily: 'var(--font-mono)' }}
              />
            </div>

            <div>
              <label style={label}>Namespace scope</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {([['default', 'Current'], ['specific', 'Named'], ['all', 'All (-A)']] as const).map(([opt, text]) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setB('namespaceOpt', opt)}
                    className={`btn ${builder.namespaceOpt === opt ? 'primary' : 'secondary'}`}
                    style={{ flex: 1, padding: '7px 8px', fontSize: 12, height: 34 }}
                  >
                    {text}
                  </button>
                ))}
              </div>
              {builder.namespaceOpt === 'specific' && (
                <input
                  type="text"
                  value={builder.namespace}
                  onChange={(e) => setB('namespace', e.target.value)}
                  placeholder="namespace, e.g. ezmeral"
                  style={{ ...input, marginTop: 8, fontFamily: 'var(--font-mono)' }}
                />
              )}
            </div>

            {!builder.name.trim() && ['get', 'describe', 'delete', 'top'].includes(builder.verb) && (
              <div>
                <label style={label}>Label selector (optional)</label>
                <input
                  type="text"
                  value={builder.selector}
                  onChange={(e) => setB('selector', e.target.value)}
                  placeholder="app=web,tier=frontend"
                  style={{ ...input, fontFamily: 'var(--font-mono)' }}
                />
              </div>
            )}

            {builder.verb === 'get' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--border-color)', paddingTop: 13 }}>
                <div>
                  <label style={label}>Output format</label>
                  <select value={builder.format} onChange={(e) => setB('format', e.target.value as BuilderState['format'])} style={input}>
                    <option value="standard">Standard table</option>
                    <option value="wide">Wide — adds node and pod IP</option>
                    <option value="yaml">YAML</option>
                    <option value="json">JSON</option>
                    <option value="name">Names only (scripting)</option>
                    <option value="jsonpath">jsonpath expression</option>
                  </select>
                </div>
                {builder.format === 'jsonpath' && (
                  <input
                    type="text"
                    value={builder.jsonpath}
                    onChange={(e) => setB('jsonpath', e.target.value)}
                    placeholder="{.items[*].metadata.name}"
                    style={{ ...input, fontFamily: 'var(--font-mono)' }}
                  />
                )}
                <div>
                  <label style={label}>Sort by field (optional)</label>
                  <select value={builder.sortBy} onChange={(e) => setB('sortBy', e.target.value)} style={input}>
                    <option value="">No sorting</option>
                    <option value=".metadata.creationTimestamp">Newest last (creation time)</option>
                    <option value=".status.containerStatuses[0].restartCount">Restart count</option>
                    <option value=".metadata.name">Name</option>
                  </select>
                </div>
                <Toggle id="b-watch" checked={builder.watch} onChange={(v) => setB('watch', v)} text="Watch for changes (--watch)" />
              </div>
            )}

            {builder.verb === 'logs' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--border-color)', paddingTop: 13 }}>
                <div>
                  <label style={label}>Container (optional, needed for sidecars)</label>
                  <input type="text" value={builder.container} onChange={(e) => setB('container', e.target.value)} placeholder="container name" style={{ ...input, fontFamily: 'var(--font-mono)' }} />
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label style={label}>Lines</label>
                    <select value={builder.tail} onChange={(e) => setB('tail', e.target.value)} style={input}>
                      <option value="50">Last 50</option>
                      <option value="100">Last 100</option>
                      <option value="500">Last 500</option>
                      <option value="all">Everything</option>
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={label}>Since (optional)</label>
                    <select value={builder.since} onChange={(e) => setB('since', e.target.value)} style={input}>
                      <option value="">Any time</option>
                      <option value="5m">Last 5 minutes</option>
                      <option value="15m">Last 15 minutes</option>
                      <option value="1h">Last hour</option>
                    </select>
                  </div>
                </div>
                <Toggle id="b-prev" checked={builder.previous} onChange={(v) => setB('previous', v)} text="Previous instance (--previous) — for CrashLoopBackOff" />
                <Toggle id="b-follow" checked={builder.follow} onChange={(v) => setB('follow', v)} text="Stream new lines (-f)" />
              </div>
            )}

            {builder.verb === 'exec' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--border-color)', paddingTop: 13 }}>
                <div>
                  <label style={label}>Container (optional)</label>
                  <input type="text" value={builder.container} onChange={(e) => setB('container', e.target.value)} placeholder="container name" style={{ ...input, fontFamily: 'var(--font-mono)' }} />
                </div>
                <div>
                  <label style={label}>Command to run inside</label>
                  <input type="text" value={builder.execCommand} onChange={(e) => setB('execCommand', e.target.value)} placeholder="/bin/sh" style={{ ...input, fontFamily: 'var(--font-mono)' }} />
                </div>
              </div>
            )}

            {builder.verb === 'scale' && (
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 13 }}>
                <label style={label}>Replicas</label>
                <input type="number" min={0} value={builder.replicas} onChange={(e) => setB('replicas', e.target.value)} style={input} />
              </div>
            )}

            {builder.verb === 'port-forward' && (
              <div style={{ display: 'flex', gap: 10, borderTop: '1px solid var(--border-color)', paddingTop: 13 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>Local port</label>
                  <input type="text" value={builder.localPort} onChange={(e) => setB('localPort', e.target.value)} style={input} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>Remote port</label>
                  <input type="text" value={builder.remotePort} onChange={(e) => setB('remotePort', e.target.value)} style={input} />
                </div>
              </div>
            )}

            {builder.verb === 'delete' && (
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 13 }}>
                <Toggle id="b-force" checked={builder.force} onChange={(v) => setB('force', v)} text="Force (--force --grace-period=0)" danger />
              </div>
            )}

            {['delete', 'scale', 'rollout'].includes(builder.verb) && (
              <Toggle id="b-dry" checked={builder.dryRun} onChange={(v) => setB('dryRun', v)} text="Dry run — show what would happen, change nothing" />
            )}
          </div>

          {/* Preview + validation */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="panel-card" style={{ ...card, background: '#0e1721', border: '1px solid var(--code-border)', padding: 18, color: '#e2e8f0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 10, marginBottom: 14 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['#ef4444', '#f59e0b', '#10b981'].map((c) => (
                    <span key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c, display: 'inline-block' }} />
                  ))}
                </div>
                <RiskBadge risk={classifyRisk(generated)} />
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontFamily: 'var(--font-mono)', minHeight: 60 }}>
                <span style={{ color: 'var(--hpe-green)', fontSize: 15, fontWeight: 700 }}>$</span>
                <div style={{ fontSize: 14.5, color: '#3ddc97', wordBreak: 'break-all', lineHeight: 1.5 }}>{generated}</div>
              </div>

              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <CommandBlock command={generated} {...blockProps} compact />
              </div>
            </div>

            {issues.length > 0 && (
              <div className="panel-card" style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {issues.map((issue, i) => (
                  <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                    <AlertTriangle
                      size={15}
                      style={{ flexShrink: 0, marginTop: 1, color: issue.level === 'error' ? 'var(--status-error)' : 'var(--status-warning)' }}
                    />
                    <span style={{ fontSize: 12.5, color: issue.level === 'error' ? 'var(--status-error)' : 'var(--text-secondary)', lineHeight: 1.45 }}>
                      {issue.message}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!issues.length && (
              <div className="panel-card" style={{ ...card, padding: 14, display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                <Check size={17} style={{ color: 'var(--hpe-green)', flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  This command is well-formed. Kalam only runs it for you when it is read-only —
                  anything that changes state is yours to run deliberately.
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= RUNBOOKS ================= */}
      {activeSubTab === 'troubleshoot' && (
        <div className="dashboard-grid" style={{ gridTemplateColumns: '260px minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <h4 style={{ margin: '0 0 4px 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
              Common failures
            </h4>
            {SCENARIOS.map((s) => {
              const active = scenarioId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setScenarioId(s.id)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '11px 13px',
                    borderRadius: 8, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s ease',
                    background: active ? 'var(--hpe-green-dim)' : 'var(--bg-secondary)',
                    color: active ? 'var(--hpe-green)' : 'var(--text-primary)',
                    border: `1px solid ${active ? 'var(--hpe-green-border)' : 'var(--border-color)'}`,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{s.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.35 }}>{s.description}</span>
                </button>
              );
            })}
          </div>

          {(() => {
            const scenario = SCENARIOS.find((s) => s.id === scenarioId) || SCENARIOS[0];
            return (
              <div className="panel-card" style={{ ...card, display: 'flex', flexDirection: 'column', gap: 16, padding: 20 }}>
                <div>
                  <h3 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 6px', color: 'var(--text-heading)' }}>
                    Runbook: {scenario.title}
                  </h3>
                  <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {scenario.description}
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderLeft: '3px solid var(--status-warning)', borderRadius: 8, padding: '9px 12px' }}>
                    <Zap size={14} style={{ color: 'var(--status-warning)', flexShrink: 0, marginTop: 2 }} />
                    <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                      <strong style={{ color: 'var(--text-primary)' }}>Symptom: </strong>{scenario.symptom}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {scenario.steps.map((step) => (
                    <div key={step.step} style={{ display: 'flex', gap: 13 }}>
                      <div style={{
                        flexShrink: 0, width: 26, height: 26, borderRadius: '50%', display: 'flex',
                        alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700,
                        background: 'var(--hpe-green-dim)', color: 'var(--hpe-green)',
                        border: '1px solid var(--hpe-green-border)',
                      }}>
                        {step.step}
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, paddingBottom: 14, borderBottom: '1px solid var(--border-color)' }}>
                        <strong style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>{step.title}</strong>
                        <CommandBlock command={step.cmd} {...blockProps} />
                        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{step.notes}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ================= QUIZ ================= */}
      {activeSubTab === 'quiz' && (
        <div style={{ maxWidth: 720, width: '100%', margin: '0 auto' }}>
          {!quiz ? (
            <div className="panel-card" style={{ ...card, padding: 34, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
              <HelpCircle size={44} style={{ color: 'var(--hpe-green)', opacity: 0.85 }} />
              <h3 style={{ fontSize: 19, fontWeight: 700, margin: 0, color: 'var(--text-heading)' }}>Practice Quiz</h3>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)', maxWidth: 460, lineHeight: 1.5 }}>
                Eight questions drawn at random from a pool of {QUIZ_QUESTIONS.length} — real diagnostic
                situations, not syntax trivia. Every answer is explained.
              </p>
              {highScore > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', background: 'var(--hpe-green-dim)', border: '1px solid var(--hpe-green-border)', borderRadius: 6, fontSize: 13, color: 'var(--hpe-green)', fontWeight: 600 }}>
                  <Trophy size={14} /> Best so far: {highScore} / 8
                </div>
              )}
              <button onClick={startQuiz} className="btn primary" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 22px', height: 42, marginTop: 6, background: 'var(--hpe-green)', borderColor: 'var(--hpe-green)' }}>
                <Play size={16} /> Start
              </button>
            </div>
          ) : finished ? (
            <div className="panel-card" style={{ ...card, padding: 34, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
              <h3 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--text-heading)' }}>
                {score} / {quiz.length}
              </h3>
              <div style={{ width: '100%', maxWidth: 320, height: 8, background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${(score / quiz.length) * 100}%`, height: '100%', background: score >= quiz.length * 0.7 ? 'var(--hpe-green)' : 'var(--status-warning)', transition: 'width 0.4s ease' }} />
              </div>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 }}>
                {score === quiz.length ? 'Perfect run.'
                  : score >= quiz.length * 0.7 ? 'Solid diagnostic instincts.'
                    : 'Worth a pass through the runbooks.'}
              </p>
              {score >= highScore && score > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--hpe-green)' }}>
                  <Trophy size={13} /> New best score
                </span>
              )}
              <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                <button onClick={startQuiz} className="btn primary" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', background: 'var(--hpe-green)', borderColor: 'var(--hpe-green)' }}>
                  <RotateCcw size={15} /> New questions
                </button>
                <button onClick={() => setActiveSubTab('troubleshoot')} className="btn secondary" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px' }}>
                  <Wrench size={15} /> Review runbooks
                </button>
              </div>
            </div>
          ) : (
            <div className="panel-card" style={{ ...card, padding: 22, display: 'flex', flexDirection: 'column', gap: 17 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Question {qIndex + 1} of {quiz.length}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--hpe-green)' }}>Score {score}</span>
              </div>

              <div style={{ height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${((qIndex + (chosen !== null ? 1 : 0)) / quiz.length) * 100}%`, height: '100%', background: 'var(--hpe-green)', transition: 'width 0.3s ease' }} />
              </div>

              <h3 style={{ fontSize: 15.5, fontWeight: 600, color: 'var(--text-heading)', margin: 0, lineHeight: 1.45 }}>
                {quiz[qIndex].question}
              </h3>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {quiz[qIndex].options.map((option, idx) => {
                  const isChosen = chosen === idx;
                  const isCorrect = idx === quiz[qIndex].correct;
                  const revealed = chosen !== null;

                  let bg = 'var(--bg-tertiary)';
                  let border = 'var(--border-color)';
                  let color = 'var(--text-primary)';
                  if (revealed && isCorrect) { bg = 'var(--hpe-green-dim)'; border = 'var(--hpe-green)'; color = 'var(--hpe-green)'; }
                  else if (revealed && isChosen) { bg = 'var(--status-error-glow)'; border = 'var(--status-error)'; color = 'var(--status-error)'; }
                  else if (revealed) { color = 'var(--text-muted)'; }

                  return (
                    <button
                      key={idx}
                      onClick={() => answer(idx)}
                      disabled={revealed}
                      style={{
                        width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: 8,
                        border: `1px solid ${border}`, background: bg, color,
                        cursor: revealed ? 'default' : 'pointer', fontSize: 13,
                        fontFamily: 'var(--font-mono)', fontWeight: 500, transition: 'all 0.15s ease',
                      }}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>

              {chosen !== null && (
                <>
                  <div style={{
                    padding: 13, borderRadius: 8, background: 'var(--bg-tertiary)', fontSize: 12.5,
                    color: 'var(--text-secondary)', lineHeight: 1.5,
                    borderLeft: `3px solid ${chosen === quiz[qIndex].correct ? 'var(--hpe-green)' : 'var(--status-error)'}`,
                  }}>
                    <strong style={{ display: 'block', color: 'var(--text-primary)', marginBottom: 4 }}>
                      {chosen === quiz[qIndex].correct ? 'Correct' : 'Not quite'}
                    </strong>
                    {quiz[qIndex].explanation}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={nextQuestion} className="btn primary" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 18px', background: 'var(--hpe-green)', borderColor: 'var(--hpe-green)' }}>
                      <span>{qIndex + 1 === quiz.length ? 'See result' : 'Next'}</span>
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Checkbox with a label, used throughout the builder. */
const Toggle: React.FC<{
  id: string; checked: boolean; onChange: (v: boolean) => void; text: string; danger?: boolean;
}> = ({ id, checked, onChange, text, danger }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ cursor: 'pointer' }} />
    <label htmlFor={id} style={{ fontSize: 12.5, cursor: 'pointer', color: danger ? 'var(--status-error)' : 'var(--text-secondary)', lineHeight: 1.4 }}>
      {text}
    </label>
  </div>
);

export default KubectlCheatSheet;
