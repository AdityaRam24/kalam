// The "show everything" half of the VME page: the per-object details drawer
// (disks, NICs, every field), Manager & License, Backups, Images & Plans, the
// raw Explorer, and the extra sections for Networks, Storage and Monitoring.
// Raw objects arrive already sanitized by the server (no passwords, tokens or
// keys); nothing here talks to the Manager.

import React, { useMemo, useState } from 'react';
import {
  X, Copy, Check, Search, Download, Server, ShieldCheck, ScrollText, Cloud, Archive, Image as ImageIcon, Ruler, Database,
  Network as NetIcon, HardDrive, Activity, AlertTriangle, CheckCircle2, Info, Boxes,
} from 'lucide-react';
import { downloadText, stamp, toCsv } from '../../lib/health';
import { gib, pct, pctColor, sevColor, ago, isOff, type VmeView, type ServerDetail } from './types';

// ── helpers ────────────────────────────────────────────────────────────────
const match = (q: string, ...xs: Array<unknown>) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase()));
const fmt = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const Meter: React.FC<{ value: number | null; label: string }> = ({ value, label }) => (
  <div style={{ minWidth: 120 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: pctColor(value), fontWeight: 650 }}>{value === null ? '—' : `${Math.round(value)}%`}</span>
    </div>
    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%`, height: '100%', background: pctColor(value) }} />
    </div>
  </div>
);

const StatusBadge: React.FC<{ s?: string }> = ({ s }) => {
  const v = (s || 'unknown').toLowerCase();
  const cls = /^(ok|success|succeeded|available|active|online|running|provisioned|enabled|open)$/.test(v) && v !== 'open' ? 'running'
    : /fail|error|down|critical|offline|unavailable/.test(v) ? 'error' : /warn|degraded|pending|open/.test(v) ? 'warning' : 'neutral';
  return <span className={`badge ${cls}`} style={{ textTransform: 'none' }}>{s || 'unknown'}</span>;
};

const Section: React.FC<{ icon: React.ReactNode; title: string; count?: number; q?: string; setQ?: (s: string) => void; onCsv?: () => void; children: React.ReactNode; note?: React.ReactNode }> = ({ icon, title, count, q, setQ, onCsv, children, note }) => (
  <div className="panel-card">
    <div className="panel-card-title">
      <h2>{icon} {title}{count !== undefined ? ` (${count})` : ''}</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {setQ && (
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
            <input className="form-input" placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ padding: '5px 10px 5px 28px', fontSize: 12, width: 190 }} />
          </div>
        )}
        {onCsv && <button className="btn secondary" onClick={onCsv} style={{ padding: '5px 10px', fontSize: 12 }}><Download size={13} /> CSV</button>}
      </div>
    </div>
    {note}
    {children}
  </div>
);

const Unread: React.FC<{ view: VmeView; source: string; what: string }> = ({ view, source, what }) => {
  const s = view.snapshot.sources[source];
  if (!s || s.ok) return null;
  return <p style={{ fontSize: 12.5, color: 'var(--status-warning)', margin: '0 0 8px' }}>{what} could not be read: {s.error}</p>;
};

const Table: React.FC<{ head: string[]; children: React.ReactNode; empty?: boolean; emptyText?: string }> = ({ head, children, empty, emptyText }) => (
  empty ? <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{emptyText || 'Nothing reported.'}</p> : (
    <div className="table-wrapper">
      <table className="resource-table"><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table>
    </div>
  )
);

/** Every leaf of an object as path → value, for the "All fields" tab and the Explorer. */
function flatten(v: any, prefix = '', out: Array<[string, string]> = [], depth = 0): Array<[string, string]> {
  if (depth > 8) { out.push([prefix, '…']); return out; }
  if (Array.isArray(v)) {
    if (!v.length) out.push([prefix, '[]']);
    v.slice(0, 200).forEach((x, i) => flatten(x, `${prefix}[${i}]`, out, depth + 1));
  } else if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) out.push([prefix, '{}']);
    for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out.push([prefix, v === null ? 'null' : String(v)]);
  return out;
}

// ── Object drawer ──────────────────────────────────────────────────────────
export const FieldTable: React.FC<{ obj: any }> = ({ obj }) => {
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => flatten(obj), [obj]);
  const shown = rows.filter(([k, v]) => match(q, k, v));
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
          <input className="form-input" placeholder={`filter ${rows.length} fields…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ padding: '5px 10px 5px 28px', fontSize: 12, width: '100%' }} />
        </div>
        <button className="btn secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => {
          navigator.clipboard?.writeText(JSON.stringify(obj, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
        }}>{copied ? <Check size={13} /> : <Copy size={13} />} JSON</button>
      </div>
      <div style={{ maxHeight: '55vh', overflow: 'auto', border: '1px solid var(--border-color)', borderRadius: 6 }}>
        <table className="resource-table" style={{ fontSize: 11.5 }}>
          <tbody>
            {shown.map(([k, v]) => (
              <tr key={k}><td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
                <td style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all', color: v === '<redacted>' ? 'var(--status-warning)' : undefined }}>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>Exactly what the Manager returned, except passwords, tokens and keys, which never leave the Trinetra server.</p>
    </div>
  );
};

type DrawerTarget = { kind: 'host' | 'vm'; id: number };

export const ServerDrawer: React.FC<{ view: VmeView; target: DrawerTarget; onClose: () => void }> = ({ view, target, onClose }) => {
  const [tab, setTab] = useState<'summary' | 'disks' | 'nics' | 'fields'>('summary');
  const s = view.snapshot;
  const obj: (ServerDetail & Record<string, any>) | undefined = target.kind === 'host' ? s.hosts.find((h) => h.id === target.id) : s.vms.find((v) => v.id === target.id);
  const raw = (s.raw?.servers || []).find((x: any) => x?.id === target.id);
  const vols = s.volumes.filter((v) => v.refId === target.id);
  if (!obj) return null;
  const summary: Array<[string, unknown]> = target.kind === 'host'
    ? [['Cluster', obj.cluster], ['IP', obj.ip], ['Power', obj.power], ['Status', obj.status], ['Cores', obj.cores], ['CPU', obj.cpuPct !== null ? `${Math.round(obj.cpuPct)}%` : null],
      ['Memory', `${gib(obj.memUsed)} / ${gib(obj.memTotal)}`], ['Storage', `${gib(obj.storageUsed)} / ${gib(obj.storageTotal)}`], ['VMs', obj.vmIds?.length], ['OS', obj.os],
      ['Agent', obj.agent.installed ? `${obj.agent.version || 'installed'}${obj.agentLastSeen ? ` · last seen ${ago(obj.agentLastSeen)}` : ''}` : 'not installed'],
      ['Created', obj.created], ['Owner', obj.owner], ['Tags', obj.tags.join(', ')], ['External id', obj.externalId]]
    : [['Host', obj.host], ['Cluster', obj.cluster], ['Power', obj.power], ['Status', obj.status], ['Instance', obj.instance], ['Plan', obj.plan],
      ['vCPU', obj.cores], ['CPU', obj.cpuPct !== null ? `${Math.round(obj.cpuPct)}%` : null], ['Memory', `${gib(obj.memUsed)} / ${gib(obj.memTotal)}`], ['GPUs', obj.gpus],
      ['IPs', (obj.ips || []).join(', ')], ['Kubernetes node', obj.k8sNode], ['OS', obj.os],
      ['Guest agent', obj.agent.installed ? `${obj.agent.version || 'installed'} (${obj.agent.guest || '?'})` : `not installed (${obj.agent.guest || '?'})`],
      ['Created', obj.created], ['Last updated', obj.updated], ['Owner', obj.owner], ['Group', obj.group], ['Tags', obj.tags.join(', ')],
      ['Hourly cost', obj.hourlyCost], ['External id', obj.externalId]];
  const findings = view.findings.filter((f) => f.subject && f.subject.kind === target.kind && f.subject.id === target.id);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 980, width: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Server size={16} /> {obj.name} <span className="badge neutral" style={{ textTransform: 'none' }}>{target.kind === 'host' ? 'host' : 'VM'}</span></h3>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {([['summary', 'Summary'], ['disks', `Disks (${obj.disks.length || vols.length})`], ['nics', `NICs (${obj.nics.length})`], ['fields', 'All fields']] as const).map(([id, label]) => (
            <button key={id} className={`subnav-pill-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        {tab === 'summary' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '4px 18px', fontSize: 12.5 }}>
              {summary.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 8 }}><span style={{ color: 'var(--text-muted)', minWidth: 110 }}>{k}</span><span style={{ wordBreak: 'break-all' }}>{fmt(v)}</span></div>
              ))}
            </div>
            <div style={{ marginTop: 12, fontSize: 12.5, fontWeight: 650 }}>Findings</div>
            {findings.length ? findings.map((f) => (
              <div key={f.id} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {f.severity === 'info' ? <Info size={13} color={sevColor('info')} /> : <AlertTriangle size={13} color={sevColor(f.severity)} />}
                <div><div style={{ fontSize: 12.5, fontWeight: 600 }}>{f.title}</div><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{f.detail}</div></div>
              </div>
            )) : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>None.</div>}
          </>
        )}
        {tab === 'disks' && (
          <Table head={['Disk', 'Size', 'Used', 'Datastore', 'Pool / device', 'Root']} empty={!obj.disks.length && !vols.length}>
            {(vols.length ? vols.map((v) => ({ name: v.name, size: v.size, used: v.used, datastore: v.datastore, extra: [v.pool, v.device].filter(Boolean).join(' · '), root: v.root }))
              : obj.disks.map((d) => ({ name: d.name, size: d.size, used: null, datastore: d.datastore, extra: '', root: d.root }))).map((d, i) => (
              <tr key={i}><td><strong>{d.name}</strong></td><td>{gib(d.size)}</td><td>{d.used !== null ? <Meter value={pct(d.used, d.size)} label={gib(d.used)} /> : '—'}</td>
                <td>{d.datastore || '—'}</td><td style={{ fontSize: 12 }}>{d.extra || '—'}</td><td>{d.root ? 'yes' : ''}</td></tr>
            ))}
          </Table>
        )}
        {tab === 'nics' && (
          <Table head={['NIC', 'IP', 'MAC', 'Network', 'Type', 'Primary', 'DHCP']} empty={!obj.nics.length}>
            {obj.nics.map((n, i) => (
              <tr key={i}><td><strong>{n.name}</strong></td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{n.ip || '—'}{n.ipv6 ? <div style={{ color: 'var(--text-muted)' }}>{n.ipv6}</div> : null}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{n.mac || '—'}</td><td>{n.network || '—'}</td><td style={{ fontSize: 12 }}>{n.type || '—'}</td><td>{n.primary ? 'yes' : ''}</td><td>{n.dhcp === undefined ? '—' : n.dhcp ? 'yes' : 'no'}</td></tr>
            ))}
          </Table>
        )}
        {tab === 'fields' && (raw ? <FieldTable obj={raw} /> : <p style={{ fontSize: 13 }}>No raw record for this server.</p>)}
      </div>
    </div>
  );
};

// ── Manager & License ──────────────────────────────────────────────────────
export const VmeManager: React.FC<{ view: VmeView }> = ({ view }) => {
  const s = view.snapshot;
  const h = s.health;
  const l = s.license;
  const [lvl, setLvl] = useState<'problems' | 'all'>('problems');
  const [q, setQ] = useState('');
  const logs = s.logs.filter((x) => (lvl === 'all' || /ERROR|WARN|FATAL|SEVERE/.test(x.level)) && match(q, x.message, x.host, x.level, x.source));
  const comp: Array<[string, string | undefined]> = h ? [['CPU', h.cpu?.status], ['Memory', h.memory?.status], ['Database', h.database?.status], ['Threads', h.threads?.status], ['Elasticsearch', h.elastic], ['RabbitMQ', h.rabbit]] : [];
  const hostsUsed = s.hosts.length;
  const hostCap = l?.maxMvm || l?.maxHosts || null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
        <Section icon={<Activity size={18} />} title="Manager appliance health">
          <Unread view={view} source="health" what="Health" />
          {h ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <StatusBadge s={h.overall} /><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{h.url || s.manager?.appliance} · VME {h.version || s.manager?.version || '?'}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                {comp.filter(([, v]) => v).map(([k, v]) => <span key={k} style={{ fontSize: 12 }}>{k} <StatusBadge s={v} /></span>)}
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                <Meter value={h.memory?.systemPct ?? null} label="Appliance system memory" />
                <Meter value={h.memory?.usedPct ?? null} label="Manager JVM memory" />
                <Meter value={h.database?.used && h.database.max ? (h.database.used / h.database.max) * 100 : null} label={`DB connections ${h.database?.used ?? '?'} / ${h.database?.max ?? '?'} (peak ${h.database?.maxUsed ?? '?'})`} />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>CPU load {h.cpu?.load ?? '—'} · system load {h.cpu?.systemLoad?.toFixed(2) ?? '—'} on {h.cpu?.processors ?? '?'} CPUs · {h.threads?.total ?? '?'} threads</div>
              </div>
            </>
          ) : <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>No health data (needs a user allowed to read /api/health).</p>}
        </Section>
        <Section icon={<ShieldCheck size={18} />} title="License">
          <Unread view={view} source="license" what="The license" />
          {l ? (
            <div style={{ display: 'grid', gap: 10, fontSize: 12.5 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 15 }}>{l.tier || 'License'}</strong>{l.trial && <span className="badge warning">trial</span>}{l.hardLimit && <span className="badge neutral" style={{ textTransform: 'none' }}>hard limit</span>}
                <span style={{ color: 'var(--text-muted)' }}>{l.account}</span>
              </div>
              <div>Valid {l.start?.slice(0, 10) || '?'} → <b style={{ color: l.daysLeft !== null && l.daysLeft < 30 ? sevColor(l.daysLeft < 7 ? 'critical' : 'warning') : undefined }}>{l.end?.slice(0, 10) || '?'}</b>
                {l.daysLeft !== null && <span style={{ color: 'var(--text-muted)' }}> ({l.daysLeft < 0 ? `expired ${-l.daysLeft} d ago` : `${l.daysLeft} days left`})</span>}</div>
              {hostCap && <Meter value={(hostsUsed / hostCap) * 100} label={`Hypervisor hosts ${hostsUsed} / ${hostCap}`} />}
              {l.maxInstances ? <Meter value={(s.vms.length / l.maxInstances) * 100} label={`VMs ${s.vms.length} / ${l.maxInstances}`} /> : null}
              {l.maxMvmSockets ? <div style={{ color: 'var(--text-secondary)' }}>Licensed HPE VM sockets: <b>{l.maxMvmSockets}</b></div> : null}
            </div>
          ) : <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>No license data (needs a user allowed to read /api/license).</p>}
        </Section>
      </div>

      <Section icon={<ScrollText size={18} />} title="Manager logs (last 24 h)" count={logs.length} q={q} setQ={setQ}
        onCsv={() => downloadText(toCsv([['When', 'Level', 'Host', 'Source', 'Message'], ...logs.map((x) => [x.at, x.level, x.host, x.source, x.message])]), `trinetra-vme-logs-${stamp()}.csv`, 'text/csv')}
        note={<div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {(['problems', 'all'] as const).map((k) => <button key={k} className={`subnav-pill-btn ${lvl === k ? 'active' : ''}`} onClick={() => setLvl(k)} style={{ fontSize: 12 }}>{k === 'problems' ? 'Errors & warnings' : 'All levels'}</button>)}
        </div>}>
        <Unread view={view} source="logs" what="Logs" />
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          {logs.length ? logs.map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border-color)', alignItems: 'baseline' }}>
              <span style={{ width: 80, flexShrink: 0, color: 'var(--text-muted)' }} title={x.at}>{ago(x.at)}</span>
              <span className={`badge ${/ERROR|FATAL|SEVERE/.test(x.level) ? 'error' : /WARN/.test(x.level) ? 'warning' : 'neutral'}`} style={{ flexShrink: 0 }}>{x.level}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, wordBreak: 'break-word', flex: 1 }}>{x.message}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{x.host}</span>
            </div>
          )) : <p style={{ margin: 0, fontSize: 13, color: 'var(--status-success)' }}><CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> Nothing at this level in the last 24 h.</p>}
        </div>
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
        <Section icon={<Cloud size={18} />} title="Clouds" count={s.clouds.length}>
          <Unread view={view} source="zones" what="Clouds" />
          <Table head={['Cloud', 'Type', 'Status', 'Enabled']} empty={!s.clouds.length}>
            {s.clouds.map((c) => <tr key={c.id}><td><strong>{c.name}</strong></td><td>{c.type || '—'}</td><td><StatusBadge s={c.status} /></td><td>{c.enabled ? 'yes' : 'no'}</td></tr>)}
          </Table>
        </Section>
        <Section icon={<Boxes size={18} />} title="Groups" count={s.groups.length}>
          <Unread view={view} source="groups" what="Groups" />
          <Table head={['Group', 'Clouds']} empty={!s.groups.length}>
            {s.groups.map((g) => <tr key={g.id}><td><strong>{g.name}</strong></td><td>{g.clouds}</td></tr>)}
          </Table>
          {s.powerSchedules > 0 && <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 0' }}>{s.powerSchedules} power schedule(s) defined — VMs on them stop and start on a timetable.</p>}
        </Section>
      </div>
    </div>
  );
};

// ── Backups ────────────────────────────────────────────────────────────────
export const VmeBackups: React.FC<{ view: VmeView }> = ({ view }) => {
  const s = view.snapshot;
  const [q, setQ] = useState('');
  const covered = new Set(s.backups.filter((b) => b.enabled).map((b) => b.instanceId).filter((x) => x !== undefined));
  const bare = s.vms.filter((v) => !isOff(v.power) && v.instanceId !== undefined && !covered.has(v.instanceId));
  const ok = s.backupResults.filter((r) => /SUCCE/.test(r.status)).length;
  const failed = s.backupResults.filter((r) => /FAIL|ERROR/.test(r.status)).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {[['Backup jobs', `${s.backups.length}`, `${s.backups.filter((b) => b.enabled).length} enabled`],
          ['Recent runs', `${s.backupResults.length}`, `${ok} succeeded · ${failed} failed`],
          ['Success rate', s.backupResults.length ? `${Math.round((ok / s.backupResults.length) * 100)}%` : '—', 'of the runs listed below'],
          ['Running VMs with no backup', `${bare.length}`, `${bare.filter((v) => v.k8sNode).length} of them are Kubernetes nodes`]].map(([label, value, sub]) => (
          <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 650, color: label === 'Recent runs' && failed ? 'var(--status-warning)' : 'var(--text-heading)' }}>{value}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>
          </div>
        ))}
      </div>
      <Section icon={<Archive size={18} />} title="Backups" count={s.backups.length} q={q} setQ={setQ}
        onCsv={() => downloadText(toCsv([['Backup', 'VM', 'Enabled', 'Schedule', 'Next run', 'Last status', 'Last run'], ...s.backups.map((b) => [b.name, b.instance, b.enabled ? 'yes' : 'no', b.schedule, b.nextRun, b.lastStatus, b.lastAt])]), `trinetra-vme-backups-${stamp()}.csv`, 'text/csv')}>
        <Unread view={view} source="backups" what="Backups" />
        <Table head={['Backup', 'VM', 'Schedule', 'Next run', 'Last result', 'Last run']} empty={!s.backups.length} emptyText="No backup jobs defined.">
          {s.backups.filter((b) => match(q, b.name, b.instance, b.lastStatus)).map((b) => (
            <tr key={b.id}><td><strong>{b.name}</strong>{!b.enabled && <span className="badge neutral" style={{ marginLeft: 6 }}>disabled</span>}</td><td>{b.instance || '—'}</td>
              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{b.schedule || '—'}</td><td style={{ fontSize: 12 }}>{b.nextRun ? b.nextRun.slice(0, 16).replace('T', ' ') : '—'}</td>
              <td><StatusBadge s={b.lastStatus} /></td><td style={{ fontSize: 12 }}>{ago(b.lastAt)}</td></tr>
          ))}
        </Table>
      </Section>
      <Section icon={<Activity size={18} />} title="Recent backup runs" count={s.backupResults.length}>
        <Unread view={view} source="backupResults" what="Backup results" />
        <Table head={['Backup', 'Status', 'Started', 'Duration', 'Size', 'Error']} empty={!s.backupResults.length}>
          {s.backupResults.map((r) => (
            <tr key={r.id}><td><strong>{r.backup || `#${r.backupId}`}</strong></td><td><StatusBadge s={r.status} /></td><td style={{ fontSize: 12 }}>{ago(r.started)}</td>
              <td style={{ fontSize: 12 }}>{r.durationMs !== null ? `${Math.round(r.durationMs / 60000)} min` : '—'}</td><td style={{ fontSize: 12 }}>{r.sizeMb !== null ? `${(r.sizeMb / 1024).toFixed(1)} GiB` : '—'}</td>
              <td style={{ fontSize: 12, color: r.error ? 'var(--status-error)' : undefined }}>{r.error || ''}</td></tr>
          ))}
        </Table>
      </Section>
      <Section icon={<AlertTriangle size={18} />} title="Running VMs with no backup job" count={bare.length}>
        <Table head={['VM', 'Host', 'Kubernetes node', 'Size']} empty={!bare.length} emptyText="Every running VM has a backup job.">
          {bare.map((v) => <tr key={v.id}><td><strong>{v.name}</strong></td><td>{v.host || '—'}</td><td>{v.k8sNode || '—'}</td><td style={{ fontSize: 12 }}>{v.cores ?? '?'} vCPU · {gib(v.memTotal)}</td></tr>)}
        </Table>
      </Section>
    </div>
  );
};

// ── Images & Plans ─────────────────────────────────────────────────────────
export const VmeCatalog: React.FC<{ view: VmeView }> = ({ view }) => {
  const s = view.snapshot;
  const [q, setQ] = useState('');
  const usedPlans = new Map<string, number>();
  for (const v of s.vms) if (v.plan) usedPlans.set(v.plan, (usedPlans.get(v.plan) || 0) + 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section icon={<ImageIcon size={18} />} title="Virtual images" count={s.images.length} q={q} setQ={setQ}
        onCsv={() => downloadText(toCsv([['Image', 'Type', 'OS', 'Size', 'Cloud-init', 'Visibility', 'Created'], ...s.images.map((i) => [i.name, i.type, i.os, i.size, i.cloudInit ? 'yes' : 'no', i.visibility, i.created])]), `trinetra-vme-images-${stamp()}.csv`, 'text/csv')}>
        <Unread view={view} source="images" what="Images" />
        <Table head={['Image', 'Type', 'OS', 'Size', 'Cloud-init', 'Visibility', 'Created']} empty={!s.images.length}>
          {s.images.filter((i) => match(q, i.name, i.os, i.type)).map((i) => (
            <tr key={i.id}><td><strong>{i.name}</strong></td><td>{i.type || '—'}</td><td>{i.os || '—'}</td><td>{gib(i.size)}</td><td>{i.cloudInit ? 'yes' : 'no'}</td><td>{i.visibility || '—'}</td><td style={{ fontSize: 12 }}>{ago(i.created)}</td></tr>
          ))}
        </Table>
      </Section>
      <Section icon={<Ruler size={18} />} title="Service plans (VM sizes)" count={s.plans.length}>
        <Unread view={view} source="plans" what="Plans" />
        <Table head={['Plan', 'vCPU', 'Memory', 'Storage', 'Provision type', 'VMs using it', 'Active']} empty={!s.plans.length}>
          {s.plans.map((p) => (
            <tr key={p.id}><td><strong>{p.name}</strong></td><td>{p.cores ?? '—'}</td><td>{gib(p.memory)}</td><td>{gib(p.storage)}</td><td>{p.provisionType || '—'}</td><td>{usedPlans.get(p.name) || 0}</td><td>{p.active ? 'yes' : 'no'}</td></tr>
          ))}
        </Table>
      </Section>
    </div>
  );
};

// ── Explorer ───────────────────────────────────────────────────────────────
const LABEL: Record<string, string> = {
  whoami: 'Who am I', servers: 'Servers (hosts + VMs)', instances: 'Instances', clusters: 'Clusters', datastores: 'Datastores', networks: 'Networks',
  alarms: 'Alarms', activity: 'Activity', health: 'Manager health', logs: 'Manager logs', license: 'License', zones: 'Clouds', groups: 'Groups',
  subnets: 'Subnets', ipPools: 'IP pools', securityGroups: 'Security groups', virtualSwitches: 'Virtual switches', storageServers: 'Storage servers',
  storageVolumes: 'Storage volumes', images: 'Virtual images', plans: 'Service plans', backups: 'Backups', backupJobs: 'Backup jobs',
  backupResults: 'Backup results', checks: 'Monitoring checks', incidents: 'Monitoring incidents', powerSchedules: 'Power schedules',
};

export const VmeExplorer: React.FC<{ view: VmeView }> = ({ view }) => {
  const raw = view.snapshot.raw || {};
  const keys = Object.keys(LABEL).filter((k) => raw[k] !== undefined || view.snapshot.sources[k]);
  const [key, setKey] = useState(keys.find((k) => Array.isArray(raw[k]) && raw[k].length) || keys[0]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<any>(null);
  const val = raw[key];
  const list: any[] = Array.isArray(val) ? val : val ? [val] : [];
  const shown = list.filter((o) => !q || JSON.stringify(o).toLowerCase().includes(q.toLowerCase()));
  const cols = ['id', 'name', 'status', 'type'].filter((c) => list.some((o) => o && o[c] !== undefined && o[c] !== null));
  const cell = (o: any, c: string) => { const v = o?.[c]; return v && typeof v === 'object' ? v.name || v.code || JSON.stringify(v).slice(0, 60) : fmt(v); };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 250px) 1fr', gap: 16, alignItems: 'start' }}>
      <div className="panel-card" style={{ padding: 8 }}>
        {keys.map((k) => {
          const v = raw[k];
          const src = view.snapshot.sources[k];
          const n = Array.isArray(v) ? v.length : v ? 1 : 0;
          return (
            <button key={k} onClick={() => { setKey(k); setOpen(null); setQ(''); }} className={`nav-item ${key === k ? 'active' : ''}`} style={{ padding: '6px 10px', fontSize: 12.5 }}>
              <span className="nav-item-text">{LABEL[k]}</span>
              <span className="nav-item-badge" style={{ color: src && !src.ok ? 'var(--status-warning)' : undefined }}>{src && !src.ok ? 'n/a' : n}</span>
            </button>
          );
        })}
      </div>
      <Section icon={<Database size={18} />} title={LABEL[key] || key} count={list.length} q={q} setQ={setQ}
        onCsv={() => downloadText(JSON.stringify(list, null, 2), `trinetra-vme-${key}-${stamp()}.json`, 'application/json')}
        note={view.snapshot.sources[key] && !view.snapshot.sources[key].ok ? <p style={{ fontSize: 12.5, color: 'var(--status-warning)', margin: '0 0 8px' }}>Not available: {view.snapshot.sources[key].error}</p> : null}>
        {open ? (
          <div>
            <button className="btn secondary" style={{ padding: '3px 10px', fontSize: 12, marginBottom: 8 }} onClick={() => setOpen(null)}>← back to the list</button>
            <FieldTable obj={open} />
          </div>
        ) : list.length === 1 && !Array.isArray(val) ? <FieldTable obj={list[0]} /> : (
          <Table head={[...(cols.length ? cols : ['object']), 'fields']} empty={!shown.length} emptyText={list.length ? 'Nothing matches.' : 'The Manager returned none.'}>
            {shown.slice(0, 500).map((o, i) => (
              <tr key={o?.id ?? i} style={{ cursor: 'pointer' }} onClick={() => setOpen(o)}>
                {(cols.length ? cols : ['object']).map((c) => <td key={c} style={{ fontSize: 12 }}>{cols.length ? cell(o, c) : JSON.stringify(o).slice(0, 120)}</td>)}
                <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{o && typeof o === 'object' ? `${Object.keys(o).length} fields →` : ''}</td>
              </tr>
            ))}
          </Table>
        )}
        {!open && shown.length > 500 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Showing the first 500 of {shown.length} — narrow it with search, or download the JSON.</p>}
      </Section>
    </div>
  );
};

// ── Extra sections for existing subpages ───────────────────────────────────
export const NetworkExtras: React.FC<{ view: VmeView }> = ({ view }) => {
  const s = view.snapshot;
  const cname = new Map(s.clusters.map((c) => [c.id, c.name]));
  return (
    <>
      <Section icon={<NetIcon size={18} />} title="Virtual switches" count={s.switches.length}>
        <Unread view={view} source="virtualSwitches" what="Virtual switches" />
        <Table head={['Switch', 'Cluster', 'Type', 'Bond mode', 'Uplink NICs', 'Networks', 'MTU', 'Status']} empty={!s.switches.length}>
          {s.switches.map((w) => (
            <tr key={w.id}><td><strong>{w.name}</strong></td><td>{w.clusterId !== undefined ? cname.get(w.clusterId) || w.clusterId : '—'}</td><td>{w.type || '—'}</td><td>{w.bondMode || '—'}</td>
              <td style={{ color: w.nics !== null && w.nics < 2 ? 'var(--status-warning)' : undefined }}>{w.nics ?? '—'}</td><td>{w.networks ?? '—'}</td><td>{w.mtu ?? '—'}</td><td><StatusBadge s={w.active ? w.status : 'inactive'} /></td></tr>
          ))}
        </Table>
      </Section>
      <Section icon={<Database size={18} />} title="IP pools" count={s.ipPools.length}>
        <Unread view={view} source="ipPools" what="IP pools" />
        <Table head={['Pool', 'Ranges', 'Used', 'Free', 'Enabled']} empty={!s.ipPools.length}>
          {s.ipPools.map((p) => (
            <tr key={p.id}><td><strong>{p.name}</strong></td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{p.ranges.join(', ') || '—'}</td>
              <td style={{ minWidth: 150 }}><Meter value={p.total ? pct(p.total - (p.free ?? 0), p.total) : null} label={`${p.total !== null && p.free !== null ? p.total - p.free : '?'} / ${p.total ?? '?'}`} /></td><td>{p.free ?? '—'}</td><td>{p.enabled ? 'yes' : 'no'}</td></tr>
          ))}
        </Table>
      </Section>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
        <Section icon={<NetIcon size={18} />} title="Subnets" count={s.subnets.length}>
          <Unread view={view} source="subnets" what="Subnets" />
          <Table head={['Subnet', 'CIDR', 'Gateway', 'Network', 'DHCP']} empty={!s.subnets.length}>
            {s.subnets.map((x) => <tr key={x.id}><td><strong>{x.name}</strong></td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{x.cidr || '—'}</td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{x.gateway || '—'}</td><td>{x.network || '—'}</td><td>{x.dhcp ? 'yes' : 'no'}</td></tr>)}
          </Table>
        </Section>
        <Section icon={<ShieldCheck size={18} />} title="Security groups" count={s.securityGroups.length}>
          <Unread view={view} source="securityGroups" what="Security groups" />
          <Table head={['Group', 'Rules', 'Description']} empty={!s.securityGroups.length}>
            {s.securityGroups.map((x) => <tr key={x.id}><td><strong>{x.name}</strong></td><td>{x.rules ?? '—'}</td><td style={{ fontSize: 12 }}>{x.description || ''}</td></tr>)}
          </Table>
        </Section>
      </div>
    </>
  );
};

export const StorageExtras: React.FC<{ view: VmeView }> = ({ view }) => {
  const s = view.snapshot;
  const [q, setQ] = useState('');
  const vmName = new Map(s.vms.map((v) => [v.id, v.name]));
  const vols = s.volumes.filter((v) => match(q, v.name, v.datastore, v.pool, vmName.get(v.refId ?? -1)));
  return (
    <>
      <Section icon={<HardDrive size={18} />} title="Storage servers" count={s.storageServers.length}>
        <Unread view={view} source="storageServers" what="Storage servers" />
        <Table head={['Server', 'Type', 'Status', 'Endpoint']} empty={!s.storageServers.length}>
          {s.storageServers.map((x) => <tr key={x.id}><td><strong>{x.name}</strong></td><td>{x.type || '—'}</td><td><StatusBadge s={x.status} /></td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{x.url || '—'}</td></tr>)}
        </Table>
      </Section>
      <Section icon={<HardDrive size={18} />} title="Disks (storage volumes)" count={s.volumes.length} q={q} setQ={setQ}
        onCsv={() => downloadText(toCsv([['Volume', 'VM', 'Size', 'Used', 'Datastore', 'Pool', 'Device', 'Root', 'Status'], ...vols.map((v) => [v.name, vmName.get(v.refId ?? -1) || `${v.refType || ''} ${v.refId ?? ''}`, v.size, v.used, v.datastore, v.pool, v.device, v.root ? 'yes' : '', v.status])]), `trinetra-vme-volumes-${stamp()}.csv`, 'text/csv')}>
        <Unread view={view} source="storageVolumes" what="Storage volumes" />
        <Table head={['Volume', 'Attached to', 'Size', 'Used', 'Datastore', 'Pool / device', 'Status']} empty={!vols.length}>
          {vols.slice(0, 500).map((v) => (
            <tr key={v.id}><td><strong>{v.name}</strong>{v.root && <span className="badge neutral" style={{ marginLeft: 6 }}>root</span>}</td>
              <td style={{ fontSize: 12 }}>{v.refId !== undefined ? vmName.get(v.refId) || `${v.refType || ''} ${v.refId}` : '—'}</td><td>{gib(v.size)}</td>
              <td style={{ minWidth: 130 }}>{v.used !== null ? <Meter value={pct(v.used, v.size)} label={gib(v.used)} /> : '—'}</td><td>{v.datastore || '—'}</td>
              <td style={{ fontSize: 12 }}>{[v.pool, v.device].filter(Boolean).join(' · ') || '—'}</td><td><StatusBadge s={v.status} /></td></tr>
          ))}
        </Table>
      </Section>
    </>
  );
};

export const MonitoringExtras: React.FC<{ view: VmeView }> = ({ view }) => {
  const s = view.snapshot;
  return (
    <>
      <Section icon={<AlertTriangle size={18} />} title="Monitoring incidents (open)" count={s.incidents.length}>
        <Unread view={view} source="incidents" what="Incidents" />
        <Table head={['Severity', 'Incident', 'Since', 'Last error']} empty={!s.incidents.length} emptyText="No open incidents.">
          {s.incidents.map((i) => <tr key={i.id}><td><span className={`badge ${i.severity === 'critical' ? 'error' : i.severity === 'warning' ? 'warning' : 'neutral'}`}>{i.severity}</span></td><td><strong>{i.name}</strong></td><td style={{ fontSize: 12 }}>{ago(i.started)}</td><td style={{ fontSize: 12 }}>{i.lastError || ''}</td></tr>)}
        </Table>
      </Section>
      <Section icon={<Activity size={18} />} title="Monitoring checks" count={s.checks.length}>
        <Unread view={view} source="checks" what="Checks" />
        <Table head={['Check', 'Type', 'Status', 'Availability', 'Last run', 'Last error']} empty={!s.checks.length}>
          {s.checks.map((c) => (
            <tr key={c.id}><td><strong>{c.name}</strong>{c.muted && <span className="badge neutral" style={{ marginLeft: 6 }}>muted</span>}</td><td>{c.type || '—'}</td><td><StatusBadge s={c.status} /></td>
              <td>{c.availability !== null ? `${c.availability}%` : '—'}</td><td style={{ fontSize: 12 }}>{ago(c.lastRun)}</td><td style={{ fontSize: 12 }}>{c.lastError || ''}</td></tr>
          ))}
        </Table>
      </Section>
    </>
  );
};
