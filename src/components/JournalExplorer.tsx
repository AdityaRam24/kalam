import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen, Play, Square, Download, Copy, Check, RefreshCw, Plus, X, ShieldCheck, ChevronDown, ChevronRight, Filter,
} from 'lucide-react';

// systemd journal explorer: every read-only journalctl option as a form.
// The server (server/hostlogs/journal.ts) validates each field and builds the
// quoted command; the exact command is shown so it can be copied to a shell.
// Follow mode polls with --after-cursor instead of holding a `-f` stream open.

export interface JournalQuery {
  units: string[]; identifiers: string[]; kernel: boolean;
  priority: string; priorityTo: string; boot: string; since: string; until: string;
  grep: string; grepMode: 'fixed' | 'regex'; caseSensitive: boolean;
  fields: Array<{ key: string; value: string }>;
  output: string; outputFields: string; lines: number; reverse: boolean;
  catalog: boolean; utc: boolean; noHostname: boolean;
}

export interface JournalPreset { query: Partial<JournalQuery>; nonce: number }

interface Meta {
  reachable: boolean; error?: string; available: boolean; version: string;
  boots: Array<{ index: number; id: string; first: string; last: string }>;
  units: string[]; identifiers: string[]; fields: string[];
  diskUsage: string; storage: string; config: string[]; priorities: string[]; outputModes: string[];
}

const EMPTY_QUERY: JournalQuery = {
  units: [], identifiers: [], kernel: false, priority: '', priorityTo: '', boot: '', since: '', until: '',
  grep: '', grepMode: 'fixed', caseSensitive: false, fields: [],
  output: 'short-iso', outputFields: '', lines: 500, reverse: false, catalog: false, utc: false, noHostname: false,
};

const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const OUTPUTS = ['short-iso', 'short', 'short-iso-precise', 'short-precise', 'short-monotonic', 'short-full', 'short-unix', 'with-unit', 'cat', 'verbose', 'json', 'json-pretty'];
const COMMON_FIELDS = ['_PID', '_UID', '_GID', '_COMM', '_EXE', '_CMDLINE', '_SYSTEMD_UNIT', '_SYSTEMD_SLICE', '_TRANSPORT', '_HOSTNAME', '_BOOT_ID', 'SYSLOG_IDENTIFIER', 'SYSLOG_FACILITY', 'PRIORITY', 'MESSAGE_ID', 'CONTAINER_NAME', 'CONTAINER_ID', 'IMAGE_NAME', 'COREDUMP_EXE', 'CODE_FILE'];
const TIME_HINTS = ['-15min', '-1h', '-6h', '-24h', '-7d', 'today', 'yesterday', 'now'];
const FOLLOW_MS = 3000;

const post = (url: string, body: object) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const FOLLOW_KEEP = 5000;

const PRESETS: Array<{ label: string; query: Partial<JournalQuery> }> = [
  { label: 'Errors this boot', query: { boot: '0', priority: 'err' } },
  { label: 'Previous boot (warnings+)', query: { boot: '-1', priority: 'warning', lines: 2000 } },
  { label: 'End of previous boot', query: { boot: '-1', lines: 300 } },
  { label: 'Kernel this boot', query: { boot: '0', kernel: true } },
  { label: 'Last hour warnings+', query: { since: '-1h', priority: 'warning' } },
  { label: 'OOM kills', query: { kernel: true, grep: 'Out of memory|oom-kill|Killed process', grepMode: 'regex' } },
  { label: 'SSH / sudo / auth', query: { identifiers: ['sshd', 'sudo', 'su', 'systemd-logind'], since: '-24h' } },
  { label: 'kubelet + containerd', query: { units: ['kubelet.service', 'containerd.service'], since: '-1h' } },
  { label: 'Failed units', query: { identifiers: ['systemd'], grep: 'Failed|failed with result|entered failed state', grepMode: 'regex', since: '-24h' } },
  { label: 'Core dumps', query: { identifiers: ['systemd-coredump'], output: 'verbose', lines: 200 } },
];

function lineColor(l: string): string | undefined {
  if (/\b(emerg|alert|crit|panic|fatal|oom|out of memory)\b/i.test(l)) return '#E5484D';
  if (/\b(error|err|fail(ed|ure)?|denied|refused)\b/i.test(l)) return '#FF8300';
  if (/\bwarn(ing)?\b/i.test(l)) return '#00A3E0';
  return undefined;
}

// Chip list with autocomplete from a datalist.
const ChipInput: React.FC<{ label: string; values: string[]; options: string[]; placeholder: string; onChange: (v: string[]) => void; id: string }> =
  ({ label, values, options, placeholder, onChange, id }) => {
    const [draft, setDraft] = useState('');
    const add = () => {
      const v = draft.trim();
      if (v && !values.includes(v)) onChange([...values, v]);
      setDraft('');
    };
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          {values.map((v) => (
            <span key={v} className="badge neutral" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              {v}<X size={11} style={{ cursor: 'pointer' }} onClick={() => onChange(values.filter((x) => x !== v))} />
            </span>
          ))}
          <input className="form-input" list={id} value={draft} placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            onBlur={add}
            style={{ flex: 1, minWidth: 140, padding: '4px 8px', fontSize: 12 }} />
          <datalist id={id}>{options.slice(0, 1500).map((o) => <option key={o} value={o} />)}</datalist>
        </div>
      </label>
    );
  };

interface Props {
  vm: string;
  preset?: JournalPreset | null;
  onDownload: (url: string, body: object, fallbackName: string) => Promise<void>;
}

export const JournalExplorer: React.FC<Props> = ({ vm, preset, onDownload }) => {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [q, setQ] = useState<JournalQuery>(EMPTY_QUERY);
  const [advanced, setAdvanced] = useState(false);

  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [running, setRunning] = useState(false);
  const [following, setFollowing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string[]>>({});
  const [check, setCheck] = useState<{ op: string; output: string; failures: number } | null>(null);
  const [checking, setChecking] = useState('');
  const [showConfig, setShowConfig] = useState(false);

  const cursorRef = useRef<string | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followRef = useRef(false);
  const outRef = useRef<HTMLPreElement | null>(null);

  const set = <K extends keyof JournalQuery>(k: K, v: JournalQuery[K]) => setQ((cur) => ({ ...cur, [k]: v }));

  const toPayload = (query: JournalQuery) => ({
    ...query,
    outputFields: query.outputFields.split(/[\s,]+/).filter(Boolean),
    fields: query.fields.filter((f) => f.key || f.value),
  });

  const stopFollow = useCallback(() => {
    followRef.current = false;
    setFollowing(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // Reset everything when the VM changes; load pickers.
  useEffect(() => {
    stopFollow();
    setLines([]); setCommand(''); setError(''); setInfo(''); setCheck(null); setFieldValues({});
    if (!vm) return;
    setMetaLoading(true);
    post('/api/logs/journal/meta', { name: vm })
      .then((r) => r.json()).then(setMeta)
      .catch((e) => setMeta({ reachable: false, error: e.message } as Meta))
      .finally(() => setMetaLoading(false));
    return stopFollow;
  }, [vm, stopFollow]);

  const run = useCallback(async (query: JournalQuery = q) => {
    if (!vm) return;
    stopFollow();
    setRunning(true); setError(''); setInfo('');
    try {
      const r = await post('/api/logs/journal', { name: vm, query: toPayload(query) });
      const d = await r.json();
      setCommand(d.command || '');
      if (d.error) { setError(d.error); setLines([]); return; }
      setLines(d.lines || []);
      setInfo(d.empty ? 'No entries match.' : `${d.lines.length} lines · ${(d.durationMs / 1000).toFixed(1)}s${d.truncated ? ' · output hit the size cap' : ''}`);
    } catch (e: any) { setError(e.message); }
    finally { setRunning(false); }
  }, [vm, q, stopFollow]);

  // Presets pushed from outside (a service's "Open in journal", etc.). Each
  // preset is a new object, so this runs once per request; runRef keeps it from
  // re-running whenever `run` changes identity.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!preset) return;
    const next = { ...EMPTY_QUERY, ...preset.query };
    setQ(next);
    runRef.current(next);
    document.getElementById('hostlogs-journal')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [preset]);

  const poll = useCallback(async (query: JournalQuery) => {
    if (!followRef.current) return;
    try {
      const r = await post('/api/logs/journal', { name: vm, query: { ...toPayload(query), reverse: false, afterCursor: cursorRef.current ?? '' } });
      const d = await r.json();
      if (!followRef.current) return;
      if (d.error) { setError(d.error); stopFollow(); return; }
      setCommand(d.command || '');
      if (d.cursor) cursorRef.current = d.cursor;
      if (d.lines?.length) {
        setLines((cur) => [...cur, ...d.lines].slice(-FOLLOW_KEEP));
        requestAnimationFrame(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; });
      }
      setInfo(`Following · updated ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setError(e.message);
    }
    if (followRef.current) timerRef.current = setTimeout(() => poll(query), FOLLOW_MS);
  }, [vm, stopFollow]);

  const startFollow = () => {
    stopFollow();
    cursorRef.current = undefined;
    setLines([]); setError('');
    followRef.current = true;
    setFollowing(true);
    poll({ ...q, reverse: false });
  };

  const loadFieldValues = async (field: string) => {
    if (!field || fieldValues[field] || !/^_{0,2}[A-Z0-9][A-Z0-9_]*$/.test(field)) return;
    try {
      const d = await (await post('/api/logs/journal/field-values', { name: vm, field })).json();
      if (d.values) setFieldValues((cur) => ({ ...cur, [field]: d.values }));
    } catch { /* picker just stays empty */ }
  };

  const runCheck = async (op: 'verify' | 'header') => {
    setChecking(op);
    try {
      const d = await (await post('/api/logs/journal/check', { name: vm, op })).json();
      setCheck({ op, output: d.output || d.error || '', failures: d.failures || 0 });
    } catch (e: any) { setCheck({ op, output: e.message, failures: 0 }); }
    finally { setChecking(''); }
  };

  const small = { padding: '5px 12px', fontSize: 12 };
  const input = { padding: '4px 8px', fontSize: 12 };
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 };
  const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 };
  const muted = { color: 'var(--text-muted)' };

  return (
    <div className="panel-card" id="hostlogs-journal">
      <div className="panel-card-title">
        <h3><BookOpen size={15} /> Journal explorer <span style={{ fontWeight: 400, fontSize: 12, ...muted }}>journalctl</span></h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>
          {metaLoading && <span><span className="loader" /> loading journal info…</span>}
          {meta?.version && <span>{meta.version}</span>}
          {meta?.storage && <span className={`badge ${meta.storage === 'persistent' ? 'success' : 'warning'}`} title={meta.storage === 'volatile' ? 'No /var/log/journal — logs are lost on reboot, so previous boots are unavailable.' : 'Stored in /var/log/journal — survives reboots.'}>{meta.storage}</span>}
          {meta?.diskUsage && <span title={meta.diskUsage}>{meta.diskUsage.replace(/^Archived and active journals take up /, '').replace(/ in the file system\.?$/, '')}</span>}
          {meta?.boots && <span>{meta.boots.length} boots</span>}
          <button className="btn secondary" style={small} disabled={!!checking || !vm} onClick={() => runCheck('verify')} title="journalctl --verify (read-only)">
            {checking === 'verify' ? <RefreshCw size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Verify
          </button>
          <button className="btn secondary" style={small} disabled={!!checking || !vm} onClick={() => runCheck('header')} title="journalctl --header (read-only)">
            {checking === 'header' ? <RefreshCw size={13} className="animate-spin" /> : <BookOpen size={13} />} Header
          </button>
        </div>
      </div>

      {meta?.error && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#E5484D' }}>{meta.error}</p>}
      {meta && meta.reachable && !meta.available && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#FF8300' }}>journalctl is not installed on this host — use the file viewer below instead.</p>}

      {check && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginBottom: 4 }}>
            <strong>journalctl --{check.op}</strong>
            {check.op === 'verify' && <span className={`badge ${check.failures ? 'error' : 'success'}`}>{check.failures ? `${check.failures} failures` : 'no failures'}</span>}
            <X size={13} style={{ cursor: 'pointer', marginLeft: 'auto' }} onClick={() => setCheck(null)} />
          </div>
          <pre style={{ ...mono, margin: 0, padding: 8, maxHeight: 220, overflow: 'auto', borderRadius: 4, background: 'var(--bg-code, rgba(0,0,0,0.25))' }}>{check.output || '(no output)'}</pre>
        </div>
      )}

      {/* Presets */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {PRESETS.map((p) => (
          <button key={p.label} className="btn secondary" style={{ padding: '3px 10px', fontSize: 11.5 }} disabled={running || !vm}
            onClick={() => { const next = { ...EMPTY_QUERY, ...p.query }; setQ(next); run(next); }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Main filters */}
      <form onSubmit={(e) => { e.preventDefault(); run(); }}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginBottom: 10 }}>
        <ChipInput id="jx-units" label="Units (-u, globs ok)" values={q.units} options={meta?.units || []} placeholder="kubelet.service" onChange={(v) => set('units', v)} />
        <ChipInput id="jx-idents" label="Identifiers (-t)" values={q.identifiers} options={meta?.identifiers || []} placeholder="sshd" onChange={(v) => set('identifiers', v)} />
        <label style={lbl}>
          <span style={muted}>Priority (-p)</span>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <select className="form-input" value={q.priority} onChange={(e) => set('priority', e.target.value)} style={input}>
              <option value="">any</option>
              {PRIORITIES.map((p, i) => <option key={p} value={p}>{i} {p}</option>)}
            </select>
            <span style={muted}>to</span>
            <select className="form-input" value={q.priorityTo} onChange={(e) => set('priorityTo', e.target.value)} style={input} disabled={!q.priority} title="Optional: makes a range, e.g. err..warning">
              <option value="">(and worse)</option>
              {PRIORITIES.map((p, i) => <option key={p} value={p}>{i} {p}</option>)}
            </select>
          </span>
        </label>
        <label style={lbl}>
          <span style={muted}>Boot (-b)</span>
          <select className="form-input" value={q.boot} onChange={(e) => set('boot', e.target.value)} style={input}>
            <option value="">all boots</option>
            <option value="0">0 — current boot</option>
            <option value="-1">-1 — previous boot</option>
            {(meta?.boots || []).filter((b) => b.index < -1).map((b) => (
              <option key={b.id} value={String(b.index)}>{b.index} — {b.first} → {b.last}</option>
            ))}
            {(meta?.boots || []).map((b) => <option key={`id-${b.id}`} value={b.id}>id {b.id.slice(0, 12)}… ({b.first})</option>)}
          </select>
        </label>
        <label style={lbl}>
          <span style={muted}>Since (--since)</span>
          <input className="form-input" list="jx-times" value={q.since} onChange={(e) => set('since', e.target.value)} placeholder="-1h · today · 2026-09-17 10:00" style={input} />
        </label>
        <label style={lbl}>
          <span style={muted}>Until (--until)</span>
          <input className="form-input" list="jx-times" value={q.until} onChange={(e) => set('until', e.target.value)} placeholder="now · -5min" style={input} />
          <datalist id="jx-times">{TIME_HINTS.map((t) => <option key={t} value={t} />)}</datalist>
        </label>
        <label style={{ ...lbl, gridColumn: 'span 2' }}>
          <span style={muted}>Search message</span>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="form-input" value={q.grep} onChange={(e) => set('grep', e.target.value)} placeholder={q.grepMode === 'regex' ? 'PCRE, e.g. timeout|refused' : 'text'} style={{ ...input, flex: 1, minWidth: 160 }} />
            <select className="form-input" value={q.grepMode} onChange={(e) => set('grepMode', e.target.value as 'fixed' | 'regex')} style={input}>
              <option value="fixed">text</option>
              <option value="regex">regex (-g)</option>
            </select>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={q.caseSensitive} onChange={(e) => set('caseSensitive', e.target.checked)} /> case</label>
          </span>
        </label>
        <label style={lbl}>
          <span style={muted}>Output (-o) · lines (-n)</span>
          <span style={{ display: 'flex', gap: 4 }}>
            <select className="form-input" value={q.output} onChange={(e) => set('output', e.target.value)} style={input}>
              {(meta?.outputModes || OUTPUTS).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select className="form-input" value={q.lines} onChange={(e) => set('lines', Number(e.target.value))} style={input}>
              {[100, 300, 500, 1000, 2000, 5000, 10000, 20000].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </span>
        </label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', fontSize: 12 }}>
          <label title="-k: kernel messages only"><input type="checkbox" checked={q.kernel} onChange={(e) => set('kernel', e.target.checked)} /> kernel (-k)</label>
          <label title="-r: newest first"><input type="checkbox" checked={q.reverse} onChange={(e) => set('reverse', e.target.checked)} /> newest first (-r)</label>
          <label title="-x: add explanations from the message catalog"><input type="checkbox" checked={q.catalog} onChange={(e) => set('catalog', e.target.checked)} /> explain (-x)</label>
        </div>
        <button type="submit" style={{ display: 'none' }} />
      </form>

      {/* Advanced */}
      <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 11.5, marginBottom: 8 }} onClick={() => setAdvanced((a) => !a)}>
        {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />} <Filter size={12} /> Field matches &amp; more options
      </button>
      {advanced && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10, padding: 10, borderRadius: 6, background: 'var(--bg-subtle, rgba(127,127,127,0.06))' }}>
          <div style={{ fontSize: 12, ...muted }}>
            Field matches (<code className="code-tag">FIELD=value</code>): the same field repeated is OR, different fields are AND. Use them for <code className="code-tag">_PID</code>, <code className="code-tag">_UID</code>, <code className="code-tag">_COMM</code>, <code className="code-tag">_TRANSPORT</code>, <code className="code-tag">SYSLOG_FACILITY</code>, <code className="code-tag">CONTAINER_NAME</code>…
          </div>
          {q.fields.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="form-input" list="jx-fields" value={f.key} placeholder="_SYSTEMD_UNIT"
                onChange={(e) => set('fields', q.fields.map((x, j) => (j === i ? { ...x, key: e.target.value.toUpperCase() } : x)))}
                onBlur={() => loadFieldValues(f.key)} style={{ ...input, width: 200 }} />
              <span>=</span>
              <input className="form-input" list={`jx-fv-${i}`} value={f.value} placeholder="value"
                onFocus={() => loadFieldValues(f.key)}
                onChange={(e) => set('fields', q.fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ ...input, flex: 1, minWidth: 160 }} />
              <datalist id={`jx-fv-${i}`}>{(fieldValues[f.key] || []).map((v) => <option key={v} value={v} />)}</datalist>
              <button className="btn secondary" style={{ padding: '2px 6px' }} onClick={() => set('fields', q.fields.filter((_, j) => j !== i))}><X size={12} /></button>
            </div>
          ))}
          <datalist id="jx-fields">{[...new Set([...COMMON_FIELDS, ...(meta?.fields || [])])].map((f) => <option key={f} value={f} />)}</datalist>
          <div>
            <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 11.5 }} onClick={() => set('fields', [...q.fields, { key: '', value: '' }])}>
              <Plus size={12} /> Add field match
            </button>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={muted}>--output-fields</span>
              <input className="form-input" value={q.outputFields} onChange={(e) => set('outputFields', e.target.value.toUpperCase())} placeholder="MESSAGE,_PID (verbose/json/cat)" style={{ ...input, width: 240 }} />
            </label>
            <label><input type="checkbox" checked={q.utc} onChange={(e) => set('utc', e.target.checked)} /> --utc</label>
            <label><input type="checkbox" checked={q.noHostname} onChange={(e) => set('noHostname', e.target.checked)} /> --no-hostname</label>
            <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 11.5 }} onClick={() => setShowConfig((s) => !s)} disabled={!meta?.config?.length}>
              journald.conf ({meta?.config?.length || 0} settings)
            </button>
          </div>
          {showConfig && !!meta?.config?.length && (
            <pre style={{ ...mono, margin: 0, padding: 8, borderRadius: 4, background: 'var(--bg-code, rgba(0,0,0,0.25))' }}>{meta.config.join('\n')}</pre>
          )}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <button className="btn primary" style={small} onClick={() => run()} disabled={running || !vm}>
          {running ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />} Run
        </button>
        {following
          ? <button className="btn secondary" style={{ ...small, color: '#E5484D' }} onClick={stopFollow}><Square size={13} /> Stop following</button>
          : <button className="btn secondary" style={small} onClick={startFollow} disabled={running || !vm} title="Like journalctl -f: polls every 3s for new entries"><RefreshCw size={13} /> Follow (-f)</button>}
        <button className="btn secondary" style={small} disabled={!vm}
          onClick={() => onDownload('/api/logs/journal/download', { name: vm, query: toPayload(q) }, `${vm}-journal.log`)}>
          <Download size={13} /> Download result
        </button>
        <button className="btn secondary" style={small} onClick={() => { stopFollow(); setQ(EMPTY_QUERY); }}>Reset</button>
        {info && <span style={{ fontSize: 12, color: following ? '#01A982' : 'var(--text-secondary)' }}>{following && <span className="loader" />} {info}</span>}
      </div>

      {command && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
          <code className="code-tag" style={{ ...mono, flex: 1, overflowX: 'auto', whiteSpace: 'nowrap' }}>{command}</code>
          <button className="btn secondary" style={{ padding: '2px 6px' }} title="Copy command"
            onClick={() => { navigator.clipboard?.writeText(command).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      )}
      {error && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#E5484D', whiteSpace: 'pre-wrap' }}>{error}</p>}

      {(lines.length > 0 || running) && (
        <pre ref={outRef} style={{ ...mono, margin: 0, padding: 10, borderRadius: 6, maxHeight: 560, overflow: 'auto', background: 'var(--bg-code, rgba(0,0,0,0.25))', whiteSpace: 'pre' }}>
          {running && !lines.length ? 'Running…' : lines.map((l, i) => <div key={i} style={{ color: lineColor(l) }}>{l || ' '}</div>)}
        </pre>
      )}
    </div>
  );
};

export default JournalExplorer;
