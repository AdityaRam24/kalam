import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollText, RefreshCw, Search, Download, FileText, FileArchive, AlertTriangle, ShieldAlert,
  ChevronDown, ChevronRight, Copy, Check, Lightbulb, RotateCcw, Info, X,
} from 'lucide-react';
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

  const [downloading, setDownloading] = useState('');
  const [note, setNote] = useState('');

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [busyUnit, setBusyUnit] = useState('');
  const [svcResult, setSvcResult] = useState<ServiceResult | null>(null);
  const [journalPreset, setJournalPreset] = useState<JournalPreset | null>(null);
  const openJournal = (query: JournalPreset['query']) => setJournalPreset({ query, nonce: Date.now() });

  useEffect(() => {
    fetch('/api/vms').then((r) => r.json()).then((d) => {
      const list: VmEntry[] = Array.isArray(d) ? d : d.vms || [];
      setVms(list);
      if (list.length) setVm((cur) => cur || list[0].name);
    }).catch(() => setVms([]));
  }, []);

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
    return (scan?.findings || []).filter((f) =>
      (sevFilter === 'all' || f.severity === sevFilter) &&
      (!q || `${f.title} ${f.message} ${f.category} ${f.files.join(' ')}`.toLowerCase().includes(q)));
  }, [scan, sevFilter, findingQuery]);

  const visibleFiles = useMemo(() => {
    const q = fileQuery.toLowerCase();
    return files.filter((f) => !q || f.path.toLowerCase().includes(q));
  }, [files, fileQuery]);

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
          No VMs in the SSH inventory yet. Add one on the <strong>Virtual Machines</strong> page, then come back to scan its <code className="code-tag">/var/log</code>.
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

      {/* ─── Findings ─── */}
      <div className="panel-card">
        <div className="panel-card-title">
          <h3><AlertTriangle size={15} /> Findings {scan?.reachable ? `(${visibleFindings.length}${scan.totalGroups > scan.findings.length ? ` of ${scan.totalGroups}` : ''})` : ''}</h3>
          {scan?.reachable && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
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
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Checks to run (read-only — not executed by Kalam)</div>
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
            </form>
          )}
        </div>
        {!viewPath && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>Click a file, the journal or dmesg to read it here.</p>}
        {viewError && <p style={{ margin: '0 0 8px', fontSize: 12.5, color: '#FF8300' }}>{viewError}</p>}
        {viewPath && (
          <pre style={{ ...mono, margin: 0, padding: 10, borderRadius: 6, maxHeight: 520, overflow: 'auto', background: 'var(--bg-code, rgba(0,0,0,0.25))', whiteSpace: 'pre' }}>
            {viewing ? 'Loading…' : viewLines.length ? viewLines.map((l, i) => {
              const s = lineSeverity(l);
              return <div key={i} style={{ color: s ? SEV_COLOR[s] : undefined }}>{l || ' '}</div>;
            }) : 'No lines.'}
          </pre>
        )}
      </div>
    </div>
  );
};

export default HostLogs;
