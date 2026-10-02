import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollText, RefreshCw, Search, Download, FileText, FileArchive, AlertTriangle, ShieldAlert,
  ChevronDown, ChevronRight, Copy, Check, Lightbulb, RotateCcw, Info, X, Brain, CheckCircle2,
  ChevronsDownUp, ChevronsUpDown, Radio,
} from 'lucide-react';
import { downloadText, stamp, toCsv } from '../lib/health';
import HostOverview, { type Overview, type ServiceAction } from './HostOverview';
import { unitBadge } from '../lib/hostlogs';
import JournalExplorer, { type JournalPreset } from './JournalExplorer';

// Host Logs: /var/log on a VM from the SSH inventory.
//
// Views over the same host: a system overview (resources, health checks,
// systemd services with status/start/restart), grouped findings from the
// deterministic rule engine (server/hostlogs/rules.ts), the file list, and a
// tail viewer. "Explain" shows the rule's built-in explanation and read-only
// checks — it needs no LLM. Start/restart are the only actions that change the
// host, and each one is confirmed first.

interface VmEntry { name: string; host: string; user: string; runsAsRoot?: boolean }
type Severity = 'critical' | 'warning' | 'info';

interface Evidence {
  kind: 'log' | 'health' | 'metric' | 'graph';
  severity: Severity; summary: string; detail?: string; count?: number;
}
interface Issue {
  id: string; concern: string; severity: Severity; title: string; subject: string;
  confidence: 'confirmed' | 'likely'; why: string; evidence: Evidence[];
  checks: string[]; units: string[];
}
interface InsightResult {
  subject: string;
  issues: Issue[];
  verdict: { severity: Severity | 'ok'; summary: string };
  gathered: { overview: boolean; scan: boolean; scanReused: boolean; metrics: boolean; graph: boolean };
  error?: string;
  durationMs?: number;
}

interface LogFile {
  path: string; size: number; mtime: string; owner: string;
  compressed: boolean; binary: boolean; readable: boolean; safe: boolean;
}
interface Finding {
  key: string; ruleId: string; severity: Severity; category: string; title: string;
  explain: string; checks: string[]; message: string; count: number; files: string[];
  samples: string[]; firstSeen?: string; lastSeen?: string; units?: string[];
}
interface ServiceResult {
  ok: boolean; unit: string; action: ServiceAction; error?: string; exitCode?: number; actionOutput?: string;
  state?: { load: string; active: string; sub: string; restarts: string; since: string; pid: string; description: string };
  status?: string; journal?: string[];
}
interface ScanResult {
  reachable: boolean; error?: string; hint?: string; hours: number; runsAsRoot: boolean;
  scannedFiles: string[]; deniedFiles: string[]; matchedLines: number;
  counts: Record<Severity, number>; findings: Finding[]; totalGroups: number;
  truncated: boolean; durationMs: number;
}

const SEV_COLOR: Record<Severity, string> = { critical: '#E5484D', warning: '#FF8300', info: '#00A3E0' };
const SEV_BADGE: Record<Severity, string> = { critical: 'error', warning: 'warning', info: 'neutral' };
const WINDOWS = [
  { h: 1, label: 'Last hour' }, { h: 24, label: 'Last 24h' }, { h: 72, label: 'Last 3 days' },
  { h: 168, label: 'Last 7 days' }, { h: 720, label: 'Last 30 days' },
];

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function lineSeverity(line: string): Severity | null {
  if (/\b(panic|fatal|crit(ical)?|emerg|oom|out of memory|no space left|i\/o error|xid)\b/i.test(line)) return 'critical';
  if (/\b(error|err|fail(ed|ure)?|denied|refused|segfault)\b/i.test(line)) return 'warning';
  if (/\bwarn(ing)?\b/i.test(line)) return 'info';
  return null;
}

const SOURCE_LABEL: Record<string, string> = { journal: 'systemd journal', dmesg: 'kernel ring buffer (dmesg)' };

async function saveResponse(res: Response, fallbackName: string): Promise<string | null> {
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = cd.match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return res.headers.get('X-Kalam-Truncated') === '1'
    ? `Download was capped at ${res.headers.get('X-Kalam-Cap-Mb')} MB and is incomplete — select fewer files or raise KALAM_LOG_BUNDLE_MAX_MB.`
    : null;
}

export const HostLogs: React.FC = () => {
  const [vms, setVms] = useState<VmEntry[]>([]);
  const [vm, setVm] = useState('');
  const [hours, setHours] = useState(168);

  const [files, setFiles] = useState<LogFile[]>([]);
  const [journal, setJournal] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState('');
  const [hint, setHint] = useState('');

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [sevFilter, setSevFilter] = useState<Severity | 'all'>('all');
  const [findingQuery, setFindingQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState('');

  const [fileQuery, setFileQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [viewPath, setViewPath] = useState('');
  const [viewLines, setViewLines] = useState<string[]>([]);
  const [viewGrep, setViewGrep] = useState('');
  const [viewCount, setViewCount] = useState(500);
  const [viewing, setViewing] = useState(false);
  const [viewError, setViewError] = useState('');
  const [viewLevel, setViewLevel] = useState<'all' | 'problems' | 'critical'>('all');
  const [viewWrap, setViewWrap] = useState(false);
  const [viewNumbers, setViewNumbers] = useState(true);
  const [follow, setFollow] = useState(false);
  const [viewCopied, setViewCopied] = useState(false);

  const [findingSort, setFindingSort] = useState<'severity' | 'count' | 'recent'>('severity');
  const [fileSort, setFileSort] = useState<'path' | 'size' | 'mtime'>('mtime');
  const [withFindingsOnly, setWithFindingsOnly] = useState(false);

  const [downloading, setDownloading] = useState('');
  const [note, setNote] = useState('');

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [busyUnit, setBusyUnit] = useState('');
  const [svcResult, setSvcResult] = useState<ServiceResult | null>(null);
  const [journalPreset, setJournalPreset] = useState<JournalPreset | null>(null);

  const [insight, setInsight] = useState<InsightResult | null>(null);
  const [insightBusy, setInsightBusy] = useState(false);
  const openJournal = (query: JournalPreset['query']) => setJournalPreset({ query, nonce: Date.now() });

  useEffect(() => {
    fetch('/api/vms').then((r) => r.json()).then((d) => {
      const list: VmEntry[] = Array.isArray(d) ? d : d.vms || [];
      setVms(list);
      let saved = '';
      try { saved = localStorage.getItem('kalam_hostlogs_vm') || ''; } catch { /* storage unavailable */ }
      if (list.length) setVm((cur) => cur || (list.some((v) => v.name === saved) ? saved : list[0].name));
    }).catch(() => setVms([]));
  }, []);
  useEffect(() => {
    if (!vm) return;
    try { localStorage.setItem('kalam_hostlogs_vm', vm); } catch { /* storage unavailable */ }
  }, [vm]);

  const post = (url: string, body: object) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const loadFiles = useCallback(async (name: string) => {
    if (!name) return;
    setListing(true); setListError(''); setHint('');
    try {
      const d = await (await post('/api/logs/list', { name })).json();
      if (d.error) { setListError(d.error); setFiles([]); }
      else { setFiles(d.files || []); setJournal(!!d.journal); setHint(d.hint || ''); }
    } catch (e: any) { setListError(e.message); }
    finally { setListing(false); }
  }, []);

  const loadOverview = useCallback(async (name: string) => {
    if (!name) return;
    setOverviewLoading(true);
    try {
      setOverview(await (await post('/api/logs/overview', { name })).json());
    } catch (e: any) {
      setOverview({ reachable: false, error: e.message } as Overview);
    } finally { setOverviewLoading(false); }
  }, []);

  // status is read-only; start/restart are confirmed here and the server
  // refuses them without confirm:true.
  const serviceAction = useCallback(async (unit: string, action: ServiceAction) => {
    if (!vm) return;
    if (action !== 'status') {
      const svc = overview?.services?.find((x) => x.unit === unit);
      const lines = [`Run "systemctl ${action} ${unit}" on ${vm}?`];
      if (svc?.access) lines.push('', `WARNING: ${unit} carries SSH/network access. If it does not come back you may lose access to this host.`);
      else if (svc?.critical) lines.push('', `${unit} is a core node service — workloads on this host may be briefly disrupted.`);
      if (!window.confirm(lines.join('\n'))) return;
    }
    setBusyUnit(unit);
    setSvcResult({ ok: true, unit, action, state: undefined });
    setTimeout(() => document.getElementById('hostlogs-service')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    try {
      const d = await (await post('/api/logs/service', { name: vm, unit, action, confirm: action !== 'status' })).json();
      setSvcResult({ unit, action, ...d });
      if (action !== 'status') loadOverview(vm);
    } catch (e: any) {
      setSvcResult({ ok: false, unit, action, error: e.message });
    } finally { setBusyUnit(''); }
  }, [vm, overview, loadOverview]);

  const runScan = useCallback(async () => {
    if (!vm) return;
    setScanning(true); setNote('');
    try {
      const d = await (await post('/api/logs/scan', { name: vm, hours })).json();
      setScan(d);
      if (d.hint) setHint(d.hint);
    } catch (e: any) { setScan({ reachable: false, error: e.message } as ScanResult); }
    finally { setScanning(false); }
  }, [vm, hours]);

  // Fuse everything Kalam knows about this host into one ranked answer.
  //
  // Findings already on screen are handed to the server rather than re-scanned:
  // a scan is a two-minute SSH read, and paying for it twice to learn what is
  // already rendered would make this button useless.
  const runInsight = useCallback(async () => {
    if (!vm) return;
    setInsightBusy(true);
    try {
      const body: Record<string, unknown> = { name: vm, hours };
      if (scan?.reachable && Array.isArray(scan.findings)) body.findings = scan.findings;
      else body.deep = true;
      setInsight(await (await post('/api/insight/host', body)).json());
    } catch (e: any) {
      setInsight({ subject: vm, issues: [], verdict: { severity: 'ok', summary: '' },
        gathered: { overview: false, scan: false, scanReused: false, metrics: false, graph: false },
        error: e.message });
    } finally { setInsightBusy(false); }
  }, [vm, hours, scan]);

  // A host switch invalidates the previous host's answer.
  useEffect(() => { setInsight(null); }, [vm]);

  const openFile = useCallback(async (p: string, grep = viewGrep, count = viewCount) => {
    if (!vm) return;
    setViewPath(p); setViewGrep(grep); setViewing(true); setViewError('');
    try {
      const d = await (await post('/api/logs/read', { name: vm, path: p, lines: count, grep })).json();
      if (d.error && !d.lines?.length) { setViewError(d.error); setViewLines([]); }
      else { setViewLines(d.lines || []); setViewError(d.error || ''); }
    } catch (e: any) { setViewError(e.message); }
    finally { setViewing(false); }
  }, [vm, viewGrep, viewCount]);

  useEffect(() => {
    if (!follow || !viewPath || !vm) return;
    const id = setInterval(async () => {
      if (document.hidden) return;
      try {
        const d = await (await post('/api/logs/read', { name: vm, path: viewPath, lines: viewCount, grep: viewGrep })).json();
        if (d.lines) setViewLines(d.lines);
      } catch { /* the next tick will try again */ }
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, viewPath, vm, viewCount, viewGrep]);

  // Keep the newest lines in view while following.
  useEffect(() => {
    if (!follow) return;
    const el = document.getElementById('hostlogs-viewer-pre');
    if (el) el.scrollTop = el.scrollHeight;
  }, [viewLines, follow]);

  useEffect(() => {
    setFollow(false);
    setScan(null); setViewPath(''); setViewLines([]); setSelected(new Set()); setOpen({});
    setOverview(null); setSvcResult(null);
    loadFiles(vm);
    loadOverview(vm);
  }, [vm, loadFiles, loadOverview]);

  const download = (body: object, key: string, fallback: string) =>
    downloadFrom('/api/logs/download', { name: vm, ...body }, fallback, key);

  const downloadFrom = async (url: string, body: object, fallback: string, key = url) => {
    setDownloading(key); setNote('');
    try {
      const warn = await saveResponse(await post(url, body), fallback);
      if (warn) setNote(warn);
    } catch (e: any) { setNote(e.message); }
    finally { setDownloading(''); }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied(''), 1500);
  };

  const findingsByFile = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of scan?.findings || []) for (const file of f.files) m.set(file, (m.get(file) || 0) + f.count);
    return m;
  }, [scan]);

  const visibleFindings = useMemo(() => {
    const q = findingQuery.toLowerCase();
    const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
    const when = (f: Finding) => Date.parse(f.lastSeen || '') || 0;
    return (scan?.findings || []).filter((f) =>
      (sevFilter === 'all' || f.severity === sevFilter) &&
      (!q || `${f.title} ${f.message} ${f.category} ${f.files.join(' ')} ${(f.units || []).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => findingSort === 'count' ? b.count - a.count
        : findingSort === 'recent' ? when(b) - when(a) || rank[a.severity] - rank[b.severity]
          : rank[a.severity] - rank[b.severity] || b.count - a.count);
  }, [scan, sevFilter, findingQuery, findingSort]);

  const visibleFiles = useMemo(() => {
    const q = fileQuery.toLowerCase();
    return files
      .filter((f) => (!q || f.path.toLowerCase().includes(q)) && (!withFindingsOnly || findingsByFile.has(f.path)))
      .sort((a, b) => fileSort === 'size' ? b.size - a.size
        : fileSort === 'mtime' ? Date.parse(b.mtime) - Date.parse(a.mtime)
          : a.path.localeCompare(b.path));
  }, [files, fileQuery, withFindingsOnly, findingsByFile, fileSort]);

  // Viewer lines with their original line number, after the level filter.
  const shownLines = useMemo(() => viewLines
    .map((text, i) => ({ text, n: i + 1, sev: lineSeverity(text) }))
    .filter((l) => viewLevel === 'all' || (viewLevel === 'critical' ? l.sev === 'critical' : l.sev === 'critical' || l.sev === 'warning')),
  [viewLines, viewLevel]);
  const viewCounts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 };
    for (const l of viewLines) { const sv = lineSeverity(l); if (sv) c[sv]++; }
    return c;
  }, [viewLines]);

  // Highlight the grep term inside a line (case-insensitive, fixed string).
  const highlight = (text: string): React.ReactNode => {
    const term = viewGrep.trim();
    if (!term) return text || ' ';
    const lower = text.toLowerCase();
    const t = term.toLowerCase();
    const parts: React.ReactNode[] = [];
    let at = 0;
    let i = lower.indexOf(t);
    while (i !== -1 && parts.length < 200) {
      if (i > at) parts.push(text.slice(at, i));
      parts.push(<mark key={i} style={{ background: 'rgba(255, 131, 0, 0.35)', color: 'inherit', borderRadius: 2 }}>{text.slice(i, i + term.length)}</mark>);
      at = i + term.length;
      i = lower.indexOf(t, at);
    }
    parts.push(text.slice(at));
    return parts;
  };

  const exportFindings = () => {
    const header = ['Severity', 'Title', 'Category', 'Count', 'First seen', 'Last seen', 'Units', 'Sources', 'Message', 'Explanation', 'Checks'];
    const body = visibleFindings.map((f) => [f.severity, f.title, f.category, f.count, f.firstSeen, f.lastSeen, (f.units || []).join('; '),
      f.files.join('; '), f.message, f.explain, f.checks.join(' | ')]);
    downloadText(toCsv([header, ...body]), `trinetra-${vm}-log-findings-${stamp()}.csv`, 'text/csv');
  };

  const totalSize = files.reduce((n, f) => n + f.size, 0);
  const small = { padding: '5px 12px', fontSize: 12 };
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 };

  // Jump from a finding to its first real file, filtered to the message.
  const showInViewer = (f: Finding) => {
    const target = f.files[0];
    const sample = f.samples[0] || '';
    // Use a distinctive fragment of the sample line as a fixed-string grep.
    const words = sample.replace(/^\S+\s+\d+\s+[\d:]+\s+\S+\s+/, '').replace(/\[\d+\]/g, '').slice(0, 60).trim();
    openFile(target, words, 500);
    document.getElementById('hostlogs-viewer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (!vms.length) {
    return (
      <div className="panel-card">
        <div className="panel-card-title"><h2><ScrollText size={17} /> Host Logs</h2></div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
          No VMs in the SSH inventory yet. Add one on the <strong>K8s Nodes</strong> page, then come back to scan its <code className="code-tag">/var/log</code>.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ─── Host picker & actions ─── */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h2><ScrollText size={17} /> Host Logs — /var/log</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
            <select className="form-input" value={vm} onChange={(e) => setVm(e.target.value)} style={{ width: 'auto', ...small }}>
              {vms.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.user}@{v.host})</option>)}
            </select>
            <select className="form-input" value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ width: 'auto', ...small }}>
              {WINDOWS.map((w) => <option key={w.h} value={w.h}>{w.label}</option>)}
            </select>
            <button className="btn primary" onClick={runScan} disabled={scanning || !vm} style={small}>
              {scanning ? <RefreshCw size={13} className="animate-spin" /> : <AlertTriangle size={13} />} Scan for issues
            </button>
            <button className="btn secondary" onClick={runInsight} disabled={insightBusy || !vm} style={small}
              title={scan?.reachable
                ? 'Merge the findings above with health checks, metrics and the dependency graph'
                : 'Runs a log scan first, then merges it with health checks, metrics and the dependency graph'}>
              {insightBusy ? <RefreshCw size={13} className="animate-spin" /> : <Brain size={13} />} Understand this host
            </button>
            <button className="btn secondary" onClick={() => loadFiles(vm)} disabled={listing} style={small}>
              <RefreshCw size={13} className={listing ? 'animate-spin' : ''} /> Refresh files
            </button>
            <button className="btn secondary" disabled={!!downloading} style={small}
              onClick={() => download({}, 'all', `${vm}-varlog.tar.gz`)}>
              {downloading === 'all' ? <RefreshCw size={13} className="animate-spin" /> : <FileArchive size={13} />} Download all (.tar.gz)
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)', alignItems: 'center' }}>
          <span>{files.length} files · {human(totalSize)}</span>
          {journal && <span className="badge neutral">journald</span>}
          {scan?.reachable && scan.counts && (
            <>
              {(['critical', 'warning', 'info'] as Severity[]).map((s) => (
                <button key={s} className={`badge ${SEV_BADGE[s]}`} onClick={() => setSevFilter(sevFilter === s ? 'all' : s)}
                  style={{ cursor: 'pointer', border: sevFilter === s ? `1px solid ${SEV_COLOR[s]}` : undefined }}>
                  {scan.counts[s]} {s}
                </button>
              ))}
              <span>{scan.scannedFiles.length} sources · {scan.matchedLines} candidate lines · {(scan.durationMs / 1000).toFixed(1)}s</span>
            </>
          )}
        </div>

        {hint && (
          <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <ShieldAlert size={14} color="#FF8300" style={{ flexShrink: 0, marginTop: 1 }} /> {hint}
          </p>
        )}
        {listError && <p style={{ margin: '10px 0 0', fontSize: 12.5, color: '#E5484D' }}>{listError}</p>}
        {scan?.error && <p style={{ margin: '10px 0 0', fontSize: 12.5, color: '#E5484D' }}>Scan failed: {scan.error}</p>}
        {scan?.truncated && <p style={{ margin: '10px 0 0', fontSize: 12.5, color: '#FF8300' }}>Scan output hit the size cap — results are partial. Try a shorter time window.</p>}
        {note && <p style={{ margin: '10px 0 0', fontSize: 12.5, color: '#FF8300' }}>{note}</p>}
      </div>

      {/* ─── System overview ─── */}
      <HostOverview data={overview} loading={overviewLoading} busyUnit={busyUnit}
        onRefresh={() => loadOverview(vm)} onService={serviceAction} />

      {/* ─── Service status / action result ─── */}
      {svcResult && (
        <div className="panel-card" id="hostlogs-service" style={{ borderLeft: `3px solid ${svcResult.error ? '#E5484D' : svcResult.state?.active === 'active' ? '#01A982' : '#FF8300'}` }}>
          <div className="panel-card-title">
            <h3>{svcResult.action === 'status' ? <Info size={15} /> : <RotateCcw size={15} />} {svcResult.unit}</h3>
            {svcResult.state && <span className={`badge ${unitBadge(svcResult.state)}`}>{svcResult.state.active}/{svcResult.state.sub}</span>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn secondary" style={small} disabled={!!busyUnit} onClick={() => serviceAction(svcResult.unit, 'status')}><RefreshCw size={13} /> Status</button>
              <button className="btn secondary" style={small} disabled={!!busyUnit} onClick={() => serviceAction(svcResult.unit, 'restart')}><RotateCcw size={13} /> Restart</button>
              <button className="btn secondary" style={small} onClick={() => openJournal({ units: [svcResult.unit], lines: 1000 })}><ScrollText size={13} /> Open in journal explorer</button>
              <button className="btn secondary" style={{ padding: '5px 8px' }} onClick={() => setSvcResult(null)} title="Close"><X size={13} /></button>
            </div>
          </div>
          {busyUnit === svcResult.unit ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              <span className="loader" /> {svcResult.action === 'status' ? 'Reading status…' : `Running systemctl ${svcResult.action}…`}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {svcResult.action !== 'status' && !svcResult.error && (
                <p style={{ margin: 0, fontSize: 13, color: '#01A982' }}>
                  systemctl {svcResult.action} succeeded{svcResult.state ? ` — now ${svcResult.state.active}/${svcResult.state.sub}` : ''}.
                  {svcResult.state && svcResult.state.active !== 'active' && <span style={{ color: '#FF8300' }}> It is not active — check the journal below.</span>}
                </p>
              )}
              {svcResult.error && <p style={{ margin: 0, fontSize: 13, color: '#E5484D', whiteSpace: 'pre-wrap' }}>{svcResult.error}</p>}
              {svcResult.state && (
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  {svcResult.state.description && <span>{svcResult.state.description}</span>}
                  {svcResult.state.since && <span>since {svcResult.state.since}</span>}
                  {svcResult.state.pid && svcResult.state.pid !== '0' && <span>PID {svcResult.state.pid}</span>}
                  {svcResult.state.restarts && <span className={Number(svcResult.state.restarts) > 0 ? 'badge warning' : ''}>{svcResult.state.restarts} automatic restarts</span>}
                </div>
              )}
              {svcResult.status && <pre style={{ ...mono, margin: 0, padding: 8, borderRadius: 4, background: 'var(--bg-code, rgba(0,0,0,0.25))', overflowX: 'auto' }}>{svcResult.status}</pre>}
              {!!svcResult.journal?.length && (
                <>
                  <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)' }}>journalctl -u {svcResult.unit} (last {svcResult.journal.length})</div>
                  <pre style={{ ...mono, margin: 0, padding: 8, borderRadius: 4, maxHeight: 320, overflow: 'auto', background: 'var(--bg-code, rgba(0,0,0,0.25))' }}>
                    {svcResult.journal.map((l, i) => { const sv = lineSeverity(l); return <div key={i} style={{ color: sv ? SEV_COLOR[sv] : undefined }}>{l}</div>; })}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── System understanding ─── */}
      {(insight || insightBusy) && (
        <div className="panel-card">
          <div className="panel-card-title">
            <h3><Brain size={15} /> What this host is telling us</h3>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Naming the sources matters: "nothing wrong" means nothing
                  wrong IN WHAT WAS READ, and the user has to be able to see
                  which of the four eyes were actually open. */}
              {insight && (
                <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  merged from {[
                    insight.gathered.overview && 'health checks',
                    insight.gathered.scan && `/var/log${insight.gathered.scanReused ? ' (reused)' : ''}`,
                    insight.gathered.metrics && 'metrics',
                    insight.gathered.graph && 'dependency graph',
                  ].filter(Boolean).join(' · ') || 'nothing'}
                </span>
              )}
              {insight && !insightBusy && (
                <button className="btn secondary" onClick={() => setInsight(null)} style={{ padding: '3px 8px', fontSize: 11 }}>
                  <X size={12} /> Close
                </button>
              )}
            </div>
          </div>

          {insightBusy ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              <span className="loader" />{' '}
              {scan?.reachable
                ? 'Merging the findings above with health checks, metrics and the dependency graph…'
                : 'No scan has been run yet, so this is reading /var/log first — that can take up to two minutes.'}
            </p>
          ) : !insight ? null : insight.error ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--status-error)' }}>{insight.error}</p>
          ) : insight.issues.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 7 }}>
              <CheckCircle2 size={15} style={{ color: 'var(--status-success)' }} />
              Nothing is wrong in what was read.
              {!insight.gathered.scan && <span style={{ color: 'var(--text-muted)' }}> No log scan was included — press <strong>Scan for issues</strong> first to add /var/log.</span>}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {insight.issues.map((i) => {
                const color = i.severity === 'critical' ? 'var(--status-error)'
                  : i.severity === 'warning' ? 'var(--status-warning)' : 'var(--text-muted)';
                const kinds = Array.from(new Set(i.evidence.map((e) => e.kind)));
                return (
                  <div key={i.id} style={{
                    border: '1px solid var(--border-color)', borderLeft: `3px solid ${color}`,
                    borderRadius: 8, padding: '10px 12px', background: 'var(--bg-tertiary)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <AlertTriangle size={13} style={{ color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>{i.title}</span>
                      <span style={{
                        fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                        color: i.confidence === 'confirmed' ? 'var(--status-success)' : 'var(--text-muted)',
                        border: `1px solid ${i.confidence === 'confirmed' ? 'var(--status-success)' : 'var(--border-strong)'}`,
                        borderRadius: 999, padding: '1px 7px',
                      }}>
                        {i.confidence === 'confirmed' ? `corroborated by ${kinds.length} sources` : 'single source'}
                      </span>
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '6px 0 8px', lineHeight: 1.55 }}>
                      {i.why}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {i.evidence.map((e, n) => (
                        <div key={n} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
                          <span style={{
                            fontSize: 9.5, color: 'var(--text-muted)', minWidth: 104, flexShrink: 0,
                            textTransform: 'uppercase', letterSpacing: '0.03em',
                          }}>
                            {e.kind === 'log' ? '/var/log' : e.kind === 'health' ? 'health check'
                              : e.kind === 'metric' ? 'metric' : 'dependency graph'}
                          </span>
                          <span style={{ color: 'var(--text-primary)' }}>
                            {e.summary}
                            {!!e.count && e.count > 1 && <span style={{ color: 'var(--text-muted)' }}> &times;{e.count}</span>}
                          </span>
                        </div>
                      ))}
                    </div>

                    {i.units.length > 0 && (
                      <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>units:</span>
                        {i.units.map((u) => (
                          <button key={u} className="btn secondary" disabled={busyUnit === u}
                            style={{ padding: '2px 8px', fontSize: 11 }}
                            onClick={() => serviceAction(u, 'status')}>
                            <Info size={10} /> {u}
                          </button>
                        ))}
                      </div>
                    )}

                    {i.checks.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>
                          read-only commands to run next
                        </div>
                        {i.checks.map((c) => (
                          <code key={c} style={{
                            display: 'block', fontSize: 11, color: 'var(--text-secondary)',
                            background: 'var(--code-bg)', padding: '3px 7px', borderRadius: 4, marginBottom: 3,
                            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                          }}>{c}</code>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── Findings ─── */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h3><AlertTriangle size={15} /> Findings {scan?.reachable ? `(${visibleFindings.length}${scan.totalGroups > scan.findings.length ? ` of ${scan.totalGroups}` : ''})` : ''}</h3>
          {scan?.reachable && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="form-input" value={findingSort} onChange={(e) => setFindingSort(e.target.value as typeof findingSort)} style={{ width: 'auto', ...small }}>
                <option value="severity">Sort: severity</option>
                <option value="count">Sort: most frequent</option>
                <option value="recent">Sort: most recent</option>
              </select>
              <button className="btn secondary" style={small} disabled={!visibleFindings.length}
                onClick={() => setOpen(Object.fromEntries(visibleFindings.map((f) => [f.key, true])))}>
                <ChevronsUpDown size={13} /> Expand all
              </button>
              <button className="btn secondary" style={small} onClick={() => setOpen({})}>
                <ChevronsDownUp size={13} /> Collapse all
              </button>
              <button className="btn secondary" style={small} disabled={!visibleFindings.length} onClick={exportFindings}>
                <Download size={13} /> CSV
              </button>
              <Search size={13} />
              <input className="form-input" placeholder="Filter findings…" value={findingQuery}
                onChange={(e) => setFindingQuery(e.target.value)} style={{ width: 200, ...small }} />
            </div>
          )}
        </div>

        {!scan && !scanning && (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
            Press <strong>Scan for issues</strong> to check recent logs, the systemd journal and dmesg for OOM kills, full disks,
            kernel/hardware/GPU errors, failed services, auth failures, certificate and clock problems. Detection is rule-based and runs without an LLM.
          </p>
        )}
        {scanning && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}><span className="loader" /> Reading /var/log over SSH…</p>}
        {scan?.reachable && !scanning && visibleFindings.length === 0 && (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>No warnings or errors found in this window{sevFilter !== 'all' || findingQuery ? ' matching the filter' : ''}.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!scanning && visibleFindings.map((f) => {
            const isOpen = !!open[f.key];
            return (
              <div key={f.key} style={{ borderLeft: `3px solid ${SEV_COLOR[f.severity]}`, background: 'var(--bg-subtle, rgba(127,127,127,0.06))', borderRadius: 6, padding: '8px 12px' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer' }}
                  onClick={() => setOpen((o) => ({ ...o, [f.key]: !o[f.key] }))}>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className={`badge ${SEV_BADGE[f.severity]}`}>{f.severity}</span>
                  <strong style={{ fontSize: 13 }}>{f.title}</strong>
                  <span className="badge neutral">{f.category}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>×{f.count}</span>
                  {(f.units || []).map((u) => <span key={u} className="badge neutral" title="systemd unit that logged this">{u}</span>)}
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    {f.files.map((x) => SOURCE_LABEL[x] || x).join(', ')}{f.lastSeen ? ` · last ${f.lastSeen}` : ''}
                  </span>
                </div>
                <div style={{ ...mono, marginTop: 6, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{f.message}</div>

                {isOpen && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', marginBottom: 4 }}>Sample lines</div>
                      <pre style={{ ...mono, margin: 0, padding: 8, borderRadius: 4, background: 'var(--bg-code, rgba(0,0,0,0.25))', overflowX: 'auto', whiteSpace: 'pre' }}>
                        {f.samples.join('\n')}
                      </pre>
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600, marginBottom: 2 }}><Lightbulb size={14} /> Explanation</div>
                      {f.explain}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Checks to run (read-only — not executed by Trinetra)</div>
                      {f.checks.map((c) => (
                        <div key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                          <code className="code-tag" style={{ ...mono, flex: 1, overflowX: 'auto', whiteSpace: 'nowrap' }}>{c}</code>
                          <button className="btn secondary" style={{ padding: '2px 6px' }} onClick={() => copy(c)} title="Copy">
                            {copied === c ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn secondary" style={small} onClick={() => showInViewer(f)}>
                        <FileText size={13} /> Show in viewer
                      </button>
                      {(f.units || []).map((u) => (
                        <React.Fragment key={u}>
                          <button className="btn secondary" style={small} disabled={!!busyUnit} onClick={() => serviceAction(u, 'status')}>
                            <Info size={13} /> {u} status
                          </button>
                          <button className="btn secondary" style={small} disabled={!!busyUnit} onClick={() => serviceAction(u, 'restart')}>
                            {busyUnit === u ? <RefreshCw size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restart {u}
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Journal explorer ─── */}
      <JournalExplorer vm={vm} preset={journalPreset} onDownload={(url, body, name) => downloadFrom(url, body, name)} />

      {/* ─── Files ─── */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h3><FileText size={15} /> Files</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {journal && <button className="btn secondary" style={small} onClick={() => openJournal({})}>Open journal explorer</button>}
            <button className="btn secondary" style={small} onClick={() => openFile('dmesg', '', viewCount)}>View dmesg</button>
            {scan?.reachable && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={withFindingsOnly} onChange={(e) => setWithFindingsOnly(e.target.checked)} /> With findings only
              </label>
            )}
            <select className="form-input" value={fileSort} onChange={(e) => setFileSort(e.target.value as typeof fileSort)} style={{ width: 'auto', ...small }}>
              <option value="mtime">Sort: recently modified</option>
              <option value="size">Sort: largest</option>
              <option value="path">Sort: path</option>
            </select>
            <input className="form-input" placeholder="Filter paths…" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} style={{ width: 180, ...small }} />
            <button className="btn secondary" style={small} disabled={!selected.size || !!downloading}
              onClick={() => download({ paths: [...selected] }, 'selected', `${vm}-varlog-selected.tar.gz`)}>
              {downloading === 'selected' ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />} Download selected ({selected.size})
            </button>
          </div>
        </div>

        <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', position: 'sticky', top: 0, background: 'var(--bg-card, var(--bg-primary))' }}>
                <th style={{ padding: 6, width: 28 }}>
                  <input type="checkbox" checked={visibleFiles.length > 0 && visibleFiles.every((f) => selected.has(f.path))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(visibleFiles.filter((f) => f.safe).map((f) => f.path)) : new Set())} />
                </th>
                <th style={{ padding: 6 }}>Path</th>
                <th style={{ padding: 6 }}>Size</th>
                <th style={{ padding: 6 }}>Modified</th>
                <th style={{ padding: 6 }}>Owner</th>
                <th style={{ padding: 6 }} />
              </tr>
            </thead>
            <tbody>
              {visibleFiles.map((f) => {
                const hits = findingsByFile.get(f.path);
                return (
                  <tr key={f.path} style={{ borderTop: '1px solid var(--border, rgba(127,127,127,0.2))', background: viewPath === f.path ? 'rgba(1,169,130,0.08)' : undefined }}>
                    <td style={{ padding: 6 }}>
                      <input type="checkbox" disabled={!f.safe} checked={selected.has(f.path)}
                        onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(f.path); else n.delete(f.path); return n; })} />
                    </td>
                    <td style={{ padding: 6, ...mono }}>
                      <span style={{ cursor: f.binary && !/wtmp|btmp/.test(f.path) ? 'default' : 'pointer', textDecoration: f.safe ? undefined : 'line-through' }}
                        onClick={() => f.safe && !(f.binary && !/wtmp|btmp/.test(f.path)) && openFile(f.path, '', viewCount)}>
                        {f.path}
                      </span>
                      {' '}
                      {!f.readable && <span className="badge warning" title="Not readable by the SSH user">no access</span>}
                      {f.compressed && <span className="badge neutral">compressed</span>}
                      {f.binary && <span className="badge neutral">binary</span>}
                      {hits ? <span className="badge error">{hits} findings</span> : null}
                    </td>
                    <td style={{ padding: 6, whiteSpace: 'nowrap' }}>{human(f.size)}</td>
                    <td style={{ padding: 6, whiteSpace: 'nowrap' }} title={f.mtime}>{ago(f.mtime)}</td>
                    <td style={{ padding: 6 }}>{f.owner}</td>
                    <td style={{ padding: 6 }}>
                      <button className="btn secondary" style={{ padding: '2px 6px' }} title="Download this file" disabled={!f.safe || !!downloading}
                        onClick={() => download({ path: f.path, raw: true }, f.path, f.path.split('/').pop() || 'log')}>
                        {downloading === f.path ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!visibleFiles.length && !listing && (
                <tr><td colSpan={6} style={{ padding: 10, color: 'var(--text-muted)' }}>No files{fileQuery ? ' match the filter' : ''}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Viewer ─── */}
      <div className="panel-card" id="hostlogs-viewer">
        <div className="panel-card-title">
          <h3><ScrollText size={15} /> Viewer {viewPath && <code className="code-tag" style={{ marginLeft: 6 }}>{SOURCE_LABEL[viewPath] || viewPath}</code>}</h3>
          {viewPath && (
            <form style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
              onSubmit={(e) => { e.preventDefault(); openFile(viewPath, viewGrep, viewCount); }}>
              <input className="form-input" placeholder="grep (fixed string)…" value={viewGrep} onChange={(e) => setViewGrep(e.target.value)} style={{ width: 220, ...small }} />
              <select className="form-input" value={viewCount} onChange={(e) => setViewCount(Number(e.target.value))} style={{ width: 'auto', ...small }}>
                {[200, 500, 1000, 2000, 5000].map((n) => <option key={n} value={n}>last {n} lines</option>)}
              </select>
              <button className="btn secondary" type="submit" disabled={viewing} style={small}>
                <RefreshCw size={13} className={viewing ? 'animate-spin' : ''} /> Load
              </button>
              <button type="button" className={`btn ${follow ? 'primary' : 'secondary'}`} style={small} onClick={() => setFollow((f) => !f)}
                title="Re-read the newest lines every 5 seconds, like tail -f">
                <Radio size={13} className={follow ? 'loader' : ''} /> {follow ? 'Following' : 'Follow'}
              </button>
            </form>
          )}
        </div>
        {!viewPath && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>Click a file, the journal or dmesg to read it here.</p>}
        {viewError && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#FF8300' }}>{viewError}</p>}
        {viewPath && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, fontSize: 12 }}>
            <div className="subnav-pills">
              <button className={`subnav-pill-btn ${viewLevel === 'all' ? 'active' : ''}`} onClick={() => setViewLevel('all')}>All ({viewLines.length})</button>
              <button className={`subnav-pill-btn ${viewLevel === 'problems' ? 'active' : ''}`} onClick={() => setViewLevel('problems')}>
                Errors + warnings ({viewCounts.critical + viewCounts.warning})
              </button>
              <button className={`subnav-pill-btn ${viewLevel === 'critical' ? 'active' : ''}`} onClick={() => setViewLevel('critical')}>
                Critical ({viewCounts.critical})
              </button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={viewNumbers} onChange={(e) => setViewNumbers(e.target.checked)} /> Line numbers
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={viewWrap} onChange={(e) => setViewWrap(e.target.checked)} /> Wrap
            </label>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn secondary" style={small} disabled={!shownLines.length}
                onClick={() => {
                  navigator.clipboard?.writeText(shownLines.map((l) => l.text).join('\n')).then(() => { setViewCopied(true); setTimeout(() => setViewCopied(false), 1500); }).catch(() => {});
                }}>
                {viewCopied ? <Check size={13} /> : <Copy size={13} />} Copy
              </button>
              <button className="btn secondary" style={small} disabled={!shownLines.length}
                onClick={() => downloadText(shownLines.map((l) => l.text).join('\n'), `${vm}-${(viewPath.split('/').pop() || 'log').replace(/[^a-z0-9._-]+/gi, '_')}-${stamp()}.log`)}>
                <Download size={13} /> Save view
              </button>
            </div>
          </div>
        )}
        {viewPath && (
          <pre id="hostlogs-viewer-pre" style={{ ...mono, margin: 0, padding: 10, borderRadius: 6, maxHeight: 520, overflow: 'auto', background: 'var(--bg-code, rgba(0,0,0,0.25))', whiteSpace: viewWrap ? 'pre-wrap' : 'pre', wordBreak: viewWrap ? 'break-word' : undefined }}>
            {viewing ? 'Loading…' : shownLines.length ? shownLines.map((l) => (
              <div key={l.n} style={{ color: l.sev ? SEV_COLOR[l.sev] : undefined, display: 'flex', gap: 10 }}>
                {viewNumbers && <span style={{ color: 'var(--text-muted)', userSelect: 'none', minWidth: 42, textAlign: 'right', flexShrink: 0, opacity: 0.7 }}>{l.n}</span>}
                <span style={{ flex: 1, minWidth: 0 }}>{highlight(l.text)}</span>
              </div>
            )) : viewLines.length ? 'No lines at this level — choose "All" above.' : 'No lines.'}
          </pre>
        )}
      </div>
    </div>
  );
};

export default HostLogs;
