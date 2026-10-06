// The list-style VME subpages: Overview, Hosts, VMs, Storage, Networks,
// Alarms & Activity, Capacity. All read the one snapshot VmePage fetched;
// "show on map" hands a topology node id back up so the Topology subpage
// opens focused on it.

import React, { useMemo, useState } from 'react';
import { AlertTriangle, Info, CheckCircle2, Search, Download, MapPin, Server, Monitor, HardDrive, Network as NetIcon, Bell, Gauge, Boxes, Cpu } from 'lucide-react';
import { downloadText, stamp, toCsv } from '../../lib/health';
import { gib, pct, pctColor, sevColor, isOff, ago, type VmeView, type Finding } from './types';

type Focus = (topoId: string) => void;

// ── small building blocks ──────────────────────────────────────────────────
export const Bar: React.FC<{ value: number | null; label?: string }> = ({ value, label }) => (
  <div style={{ minWidth: 90 }} title={label}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: pctColor(value), fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{value === null ? '—' : `${Math.round(value)}%`}</span>
    </div>
    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%`, height: '100%', background: pctColor(value) }} />
    </div>
  </div>
);

const Tile: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; color?: string; onClick?: () => void }> = ({ icon, label, value, sub, color, onClick }) => (
  <div onClick={onClick} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', minWidth: 0, cursor: onClick ? 'pointer' : undefined }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>{icon}{label}</div>
    <div style={{ fontSize: 22, fontWeight: 650, color: color || 'var(--text-heading)', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
  </div>
);

const Power: React.FC<{ power: string }> = ({ power }) => (
  <span className={`badge ${isOff(power) ? 'error' : /on|running/i.test(power) ? 'running' : 'neutral'}`} style={{ textTransform: 'none' }}>{power}</span>
);

const topoIdOf = (f: Finding) => (f.subject ? `${f.subject.kind}:${f.subject.id}` : undefined);

export const FindingList: React.FC<{ findings: Finding[]; onFocus?: Focus; limit?: number }> = ({ findings, onFocus, limit }) => {
  const [all, setAll] = useState(false);
  const shown = all || !limit ? findings : findings.slice(0, limit);
  if (!findings.length) return <p style={{ margin: 0, fontSize: 13, color: 'var(--status-success)' }}><CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> Nothing needs attention.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {shown.map((f) => (
        <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 6, background: f.severity === 'info' ? undefined : 'var(--bg-tertiary)' }}>
          <div style={{ marginTop: 2 }}>{f.severity === 'info' ? <Info size={14} color={sevColor('info')} /> : <AlertTriangle size={14} color={sevColor(f.severity)} />}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: f.severity === 'info' ? 500 : 650, color: 'var(--text-heading)' }}>
              {f.title} <span className="badge neutral" style={{ textTransform: 'none', fontSize: 10, marginLeft: 4 }}>{f.area}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{f.detail}</div>
          </div>
          {onFocus && topoIdOf(f) && (
            <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11 }} title="Show on the topology map" onClick={() => onFocus(topoIdOf(f)!)}>
              <MapPin size={11} /> map
            </button>
          )}
        </div>
      ))}
      {limit && findings.length > limit && (
        <button className="btn secondary" style={{ alignSelf: 'flex-start', padding: '3px 10px', fontSize: 12 }} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${findings.length}`}
        </button>
      )}
    </div>
  );
};

/** Search box + CSV button, shared by every table. */
const TableBar: React.FC<{ title: React.ReactNode; query: string; setQuery: (q: string) => void; onCsv: () => void; extra?: React.ReactNode }> = ({ title, query, setQuery, onCsv, extra }) => (
  <div className="panel-card-title">
    <h2>{title}</h2>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {extra}
      <div style={{ position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
        <input className="form-input" placeholder="search…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ padding: '5px 10px 5px 28px', fontSize: 12, width: 200 }} />
      </div>
      <button className="btn secondary" onClick={onCsv} style={{ padding: '5px 10px', fontSize: 12 }}><Download size={13} /> CSV</button>
    </div>
  </div>
);
const match = (q: string, ...xs: Array<unknown>) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase()));
const MapBtn: React.FC<{ id: string; onFocus: Focus }> = ({ id, onFocus }) => (
  <button className="icon-btn secondary" title="Show on the topology map" onClick={() => onFocus(id)} style={{ padding: 3 }}><MapPin size={12} /></button>
);

// ── Overview ───────────────────────────────────────────────────────────────
export const VmeOverview: React.FC<{ view: VmeView; onFocus: Focus; go: (s: any) => void }> = ({ view, onFocus, go }) => {
  const s = view.snapshot;
  const k = useMemo(() => {
    const hostsUp = s.hosts.filter((h) => !isOff(h.power));
    const memT = hostsUp.reduce((a, h) => a + (h.memTotal || 0), 0);
    const memU = hostsUp.reduce((a, h) => a + (h.memUsed || 0), 0);
    const cpu = hostsUp.map((h) => h.cpuPct).filter((x): x is number => x !== null);
    const dsT = s.datastores.reduce((a, d) => a + (d.total || 0), 0);
    const dsF = s.datastores.reduce((a, d) => a + (d.free || 0), 0);
    return {
      hostsUp: hostsUp.length, vmsOn: s.vms.filter((v) => !isOff(v.power)).length,
      mem: pct(memU, memT), memU, memT, cpu: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : null,
      ds: pct(dsT - dsF, dsT), dsT, dsF,
      k8s: s.vms.filter((v) => v.k8sNode).length, gpus: s.vms.reduce((a, v) => a + (v.gpus || 0), 0),
      crit: view.findings.filter((f) => f.severity === 'critical').length, warn: view.findings.filter((f) => f.severity === 'warning').length,
      alarms: s.alarms.filter((a) => !a.acknowledged).length,
    };
  }, [s, view.findings]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 12 }}>
        <Tile icon={<Boxes size={13} />} label="Clusters" value={`${new Set(s.hosts.map((h) => h.clusterId ?? 'none')).size}`} sub={`${s.clusters.length} known to the Manager`} onClick={() => go('capacity')} />
        <Tile icon={<Server size={13} />} label="Hosts up" value={`${k.hostsUp}/${s.hosts.length}`} color={k.hostsUp < s.hosts.length ? 'var(--status-warning)' : undefined} onClick={() => go('hosts')} />
        <Tile icon={<Monitor size={13} />} label="VMs running" value={`${k.vmsOn}/${s.vms.length}`} sub={`${k.k8s} are Kubernetes nodes${k.gpus ? ` · ${k.gpus} GPUs passed through` : ''}`} onClick={() => go('vms')} />
        <Tile icon={<Cpu size={13} />} label="Host CPU (avg)" value={k.cpu === null ? '—' : `${Math.round(k.cpu)}%`} color={pctColor(k.cpu)} />
        <Tile icon={<Gauge size={13} />} label="Host memory" value={k.mem === null ? '—' : `${Math.round(k.mem)}%`} color={pctColor(k.mem)} sub={`${gib(k.memU)} of ${gib(k.memT)}`} />
        <Tile icon={<HardDrive size={13} />} label="Datastores used" value={k.ds === null ? '—' : `${Math.round(k.ds)}%`} color={pctColor(k.ds)} sub={k.dsT ? `${gib(k.dsF)} free of ${gib(k.dsT)}` : undefined} onClick={() => go('storage')} />
        <Tile icon={<Bell size={13} />} label="Needs attention" value={`${k.crit + k.warn}`} color={k.crit ? 'var(--status-error)' : k.warn ? 'var(--status-warning)' : 'var(--status-success)'} sub={`${k.crit} critical · ${k.alarms} open alarm${k.alarms === 1 ? '' : 's'}`} onClick={() => go('events')} />
      </div>

      <div className="panel-card">
        <div className="panel-card-title"><h2><AlertTriangle size={18} /> What needs attention</h2>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>joined across Manager, hosts, VMs, datastores{s.k8s ? ' and Kubernetes' : ''}</span></div>
        <FindingList findings={view.findings} onFocus={onFocus} limit={12} />
      </div>

      <div className="panel-card">
        <div className="panel-card-title"><h2><Info size={18} /> What was read</h2></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {Object.entries(s.sources).map(([k2, v]) => (
            <span key={k2} className={`badge ${v.ok ? 'running' : 'warning'}`} style={{ textTransform: 'none' }} title={v.error || ''}>
              {k2}{v.ok ? (v.count !== undefined ? ` · ${v.count}` : '') : ' · unavailable'}
            </span>
          ))}
          {s.k8s && (
            <span className={`badge ${s.k8s.error ? 'warning' : 'running'}`} style={{ textTransform: 'none' }} title={s.k8s.error || ''}>
              kubernetes ({s.k8s.source}) · {s.k8s.nodes.length} nodes, {s.k8s.nodes.length - s.k8s.unmatched.length} matched to VMs
            </span>
          )}
        </div>
        {Object.values(s.sources).some((v) => !v.ok) && (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)' }}>
            {Object.entries(s.sources).filter(([, v]) => !v.ok).map(([k2, v]) => <li key={k2}><b>{k2}</b>: {v.error}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
};

// ── Hosts ──────────────────────────────────────────────────────────────────
export const VmeHosts: React.FC<{ view: VmeView; onFocus: Focus }> = ({ view, onFocus }) => {
  const [q, setQ] = useState('');
  const rows = view.snapshot.hosts.filter((h) => match(q, h.name, h.cluster, h.ip, h.status, h.os));
  const csv = () => downloadText(toCsv([
    ['Host', 'Cluster', 'IP', 'Power', 'Status', 'Cores', 'CPU %', 'Mem used', 'Mem total', 'Storage used', 'Storage total', 'VMs', 'Agent last seen'],
    ...rows.map((h) => [h.name, h.cluster, h.ip, h.power, h.status, h.cores, h.cpuPct === null ? '' : Math.round(h.cpuPct), h.memUsed, h.memTotal, h.storageUsed, h.storageTotal, h.vmIds.length, h.agentLastSeen]),
  ]), `trinetra-vme-hosts-${stamp()}.csv`, 'text/csv');
  return (
    <div className="panel-card">
      <TableBar title={<><Server size={18} /> Hypervisor hosts ({rows.length})</>} query={q} setQuery={setQ} onCsv={csv} />
      <div className="table-wrapper">
        <table className="resource-table">
          <thead><tr><th>Host</th><th>Cluster</th><th>Power</th><th>CPU</th><th>Memory</th><th>Storage</th><th>VMs</th><th>Agent</th><th></th></tr></thead>
          <tbody>
            {rows.map((h) => {
              const kNodes = view.snapshot.vms.filter((v) => v.hostId === h.id && v.k8sNode).length;
              return (
                <tr key={h.id}>
                  <td><strong>{h.name}</strong><div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{h.ip || ''}{h.os ? ` · ${h.os}` : ''}</div></td>
                  <td style={{ fontSize: 12 }}>{h.cluster || '—'}</td>
                  <td><Power power={h.power} /></td>
                  <td><Bar value={h.cpuPct} label={h.cores ? `${h.cores} cores` : ''} /></td>
                  <td><Bar value={pct(h.memUsed, h.memTotal)} label={`${gib(h.memUsed)} / ${gib(h.memTotal)}`} /></td>
                  <td><Bar value={pct(h.storageUsed, h.storageTotal)} label={gib(h.storageTotal)} /></td>
                  <td style={{ fontSize: 12 }}>{h.vmIds.length}{kNodes ? <span style={{ color: 'var(--text-muted)' }}> ({kNodes} k8s)</span> : ''}</td>
                  <td style={{ fontSize: 11.5, color: h.agentLastSeen && Date.now() - Date.parse(h.agentLastSeen) > 15 * 60_000 ? 'var(--status-warning)' : 'var(--text-secondary)' }}>{ago(h.agentLastSeen)}</td>
                  <td><MapBtn id={`host:${h.id}`} onFocus={onFocus} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── VMs ────────────────────────────────────────────────────────────────────
export const VmeVms: React.FC<{ view: VmeView; onFocus: Focus }> = ({ view, onFocus }) => {
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'k8s' | 'gpu' | 'off'>('all');
  const nodes = new Map((view.snapshot.k8s?.nodes || []).map((n) => [n.name, n]));
  const rows = view.snapshot.vms.filter((v) =>
    (only === 'all' || (only === 'k8s' && v.k8sNode) || (only === 'gpu' && v.gpus) || (only === 'off' && isOff(v.power))) &&
    match(q, v.name, v.host, v.cluster, v.ips.join(' '), v.k8sNode, v.instance, v.os, v.plan));
  const csv = () => downloadText(toCsv([
    ['VM', 'Instance', 'Host', 'Cluster', 'Power', 'Status', 'vCPU', 'CPU %', 'Mem used', 'Mem total', 'GPUs', 'IPs', 'Kubernetes node', 'OS', 'Plan'],
    ...rows.map((v) => [v.name, v.instance, v.host, v.cluster, v.power, v.status, v.cores, v.cpuPct === null ? '' : Math.round(v.cpuPct), v.memUsed, v.memTotal, v.gpus, v.ips.join(' '), v.k8sNode, v.os, v.plan]),
  ]), `trinetra-vme-vms-${stamp()}.csv`, 'text/csv');
  return (
    <div className="panel-card">
      <TableBar title={<><Monitor size={18} /> Virtual machines ({rows.length})</>} query={q} setQuery={setQ} onCsv={csv}
        extra={
          <select className="form-input" value={only} onChange={(e) => setOnly(e.target.value as any)} style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}>
            <option value="all">All VMs</option>
            <option value="k8s">Kubernetes nodes only</option>
            <option value="gpu">With GPUs</option>
            <option value="off">Powered off</option>
          </select>
        } />
      <div className="table-wrapper">
        <table className="resource-table">
          <thead><tr><th>VM</th><th>Host</th><th>Power</th><th>CPU</th><th>Memory</th><th>Size</th><th>IPs</th><th>Kubernetes node</th><th></th></tr></thead>
          <tbody>
            {rows.map((v) => {
              const n = v.k8sNode ? nodes.get(v.k8sNode) : undefined;
              return (
                <tr key={v.id}>
                  <td><strong>{v.name}</strong>{v.instance && v.instance !== v.name && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>instance {v.instance}</div>}</td>
                  <td style={{ fontSize: 12 }}>{v.host || '—'}<div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{v.cluster || ''}</div></td>
                  <td><Power power={v.power} /></td>
                  <td><Bar value={isOff(v.power) ? null : v.cpuPct} /></td>
                  <td><Bar value={isOff(v.power) ? null : pct(v.memUsed, v.memTotal)} /></td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{v.cores ?? '—'} vCPU · {gib(v.memTotal)}{v.gpus ? <span className="badge running" style={{ marginLeft: 6, textTransform: 'none' }}>{v.gpus} GPU</span> : null}</td>
                  <td style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>{v.ips.join(', ') || '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {v.k8sNode ? <>
                      <span className={`badge ${n && !n.ready ? 'error' : 'running'}`} style={{ textTransform: 'none' }}>{v.k8sNode}</span>
                      {n && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{n.roles.join(', ') || 'worker'} · {n.pods} pods{n.ready ? '' : ' · NotReady'}</div>}
                    </> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td><MapBtn id={`vm:${v.id}`} onFocus={onFocus} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!!view.snapshot.k8s?.unmatched.length && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '10px 0 0' }}>
          Kubernetes nodes with no matching VM: {view.snapshot.k8s.unmatched.join(', ')} — bare metal, another hypervisor, or an IP/name that differs from the VM record.
        </p>
      )}
    </div>
  );
};

// ── Storage ────────────────────────────────────────────────────────────────
export const VmeStorage: React.FC<{ view: VmeView; onFocus: Focus }> = ({ view, onFocus }) => {
  const [q, setQ] = useState('');
  const cname = new Map(view.snapshot.clusters.map((c) => [c.id, c.name]));
  const rows = view.snapshot.datastores.filter((d) => match(q, d.name, d.type, d.cloud, d.clusterId !== undefined ? cname.get(d.clusterId) : ''))
    .sort((a, b) => (pct(b.total && b.free !== null ? b.total - b.free : null, b.total) ?? -1) - (pct(a.total && a.free !== null ? a.total - a.free : null, a.total) ?? -1));
  const csv = () => downloadText(toCsv([['Datastore', 'Type', 'Cluster', 'Total', 'Free', 'Used %', 'Online', 'Active'],
    ...rows.map((d) => [d.name, d.type, d.clusterId !== undefined ? cname.get(d.clusterId) : '', d.total, d.free, d.total && d.free !== null ? Math.round(((d.total - d.free) / d.total) * 100) : '', d.online ? 'yes' : 'no', d.active ? 'yes' : 'no'])]),
  `trinetra-vme-datastores-${stamp()}.csv`, 'text/csv');
  return (
    <div className="panel-card">
      <TableBar title={<><HardDrive size={18} /> Datastores ({rows.length})</>} query={q} setQuery={setQ} onCsv={csv} />
      {view.snapshot.sources.datastores && !view.snapshot.sources.datastores.ok && (
        <p style={{ fontSize: 12.5, color: 'var(--status-warning)', margin: '0 0 8px' }}>Datastores could not be read: {view.snapshot.sources.datastores.error}</p>
      )}
      <div className="table-wrapper">
        <table className="resource-table">
          <thead><tr><th>Datastore</th><th>Type</th><th>Cluster</th><th>Used</th><th>Free</th><th>State</th><th></th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td><strong>{d.name}</strong></td>
                <td style={{ fontSize: 12 }}>{d.type || '—'}</td>
                <td style={{ fontSize: 12 }}>{d.clusterId !== undefined ? cname.get(d.clusterId) || d.clusterId : d.cloud || '—'}</td>
                <td style={{ minWidth: 160 }}><Bar value={d.total && d.free !== null ? ((d.total - d.free) / d.total) * 100 : null} label={gib(d.total)} /></td>
                <td style={{ fontSize: 12 }}>{gib(d.free)}</td>
                <td><span className={`badge ${d.online && d.active ? 'running' : 'error'}`} style={{ textTransform: 'none' }}>{!d.online ? 'offline' : !d.active ? 'inactive' : 'online'}</span></td>
                <td><MapBtn id={`datastore:${d.id}`} onFocus={onFocus} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Networks ───────────────────────────────────────────────────────────────
export const VmeNetworks: React.FC<{ view: VmeView }> = ({ view }) => {
  const [q, setQ] = useState('');
  const rows = view.snapshot.networks.filter((n) => match(q, n.name, n.type, n.cidr, n.vlan, n.gateway, n.cloud));
  // Which VMs sit in each CIDR (IPv4 only) — a quick answer to "who is on this VLAN".
  const inCidr = (ip: string, cidr?: string) => {
    const m = cidr?.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (!m || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
    const toN = (s: string) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
    const bits = Number(m[2]);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((toN(ip) & mask) >>> 0) === ((toN(m[1]) & mask) >>> 0);
  };
  const csv = () => downloadText(toCsv([['Network', 'Type', 'CIDR', 'VLAN', 'Gateway', 'Active', 'VMs in CIDR'],
    ...rows.map((n) => [n.name, n.type, n.cidr, n.vlan, n.gateway, n.active ? 'yes' : 'no', view.snapshot.vms.filter((v) => v.ips.some((ip) => inCidr(ip, n.cidr))).length])]),
  `trinetra-vme-networks-${stamp()}.csv`, 'text/csv');
  return (
    <div className="panel-card">
      <TableBar title={<><NetIcon size={18} /> Networks ({rows.length})</>} query={q} setQuery={setQ} onCsv={csv} />
      <div className="table-wrapper">
        <table className="resource-table">
          <thead><tr><th>Network</th><th>Type</th><th>CIDR</th><th>VLAN</th><th>Gateway</th><th>VMs in this CIDR</th></tr></thead>
          <tbody>
            {rows.map((n) => {
              const vms = view.snapshot.vms.filter((v) => v.ips.some((ip) => inCidr(ip, n.cidr)));
              return (
                <tr key={n.id}>
                  <td><strong>{n.name}</strong>{!n.active && <span className="badge warning" style={{ marginLeft: 6, textTransform: 'none' }}>inactive</span>}</td>
                  <td style={{ fontSize: 12 }}>{n.type || '—'}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{n.cidr || '—'}</td>
                  <td>{n.vlan ?? '—'}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{n.gateway || '—'}</td>
                  <td style={{ fontSize: 12 }} title={vms.map((v) => v.name).join(', ')}>{vms.length ? `${vms.length}: ${vms.slice(0, 4).map((v) => v.name).join(', ')}${vms.length > 4 ? '…' : ''}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Alarms & Activity ──────────────────────────────────────────────────────
export const VmeEvents: React.FC<{ view: VmeView }> = ({ view }) => {
  const [showAck, setShowAck] = useState(false);
  const [q, setQ] = useState('');
  const alarms = view.snapshot.alarms.filter((a) => showAck || !a.acknowledged);
  const acts = view.snapshot.activity.filter((a) => match(q, a.name, a.message, a.user, a.type, a.objectType));
  const vmByInstance = new Map(view.snapshot.vms.filter((v) => v.instanceId !== undefined).map((v) => [v.instanceId!, v]));
  const csv = () => downloadText(toCsv([['When', 'Type', 'Action', 'Message', 'User', 'Object', 'Success'],
    ...acts.map((a) => [a.at, a.type, a.name, a.message, a.user, `${a.objectType || ''} ${a.objectId ?? ''}`.trim(), a.success ? 'yes' : 'no'])]),
  `trinetra-vme-activity-${stamp()}.csv`, 'text/csv');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel-card">
        <div className="panel-card-title"><h2><Bell size={18} /> Alarms ({alarms.length})</h2>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={showAck} onChange={(e) => setShowAck(e.target.checked)} /> Include acknowledged
          </label>
        </div>
        {view.snapshot.sources.alarms && !view.snapshot.sources.alarms.ok && <p style={{ fontSize: 12.5, color: 'var(--status-warning)', margin: 0 }}>Alarms could not be read: {view.snapshot.sources.alarms.error}</p>}
        {alarms.length === 0 ? <p style={{ margin: 0, fontSize: 13, color: 'var(--status-success)' }}><CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> No open alarms.</p> : (
          <div className="table-wrapper">
            <table className="resource-table">
              <thead><tr><th>Severity</th><th>Alarm</th><th>Resource</th><th>Since</th><th>State</th></tr></thead>
              <tbody>
                {alarms.map((a) => (
                  <tr key={a.id}>
                    <td><span className={`badge ${a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'neutral'}`}>{a.severity}</span></td>
                    <td><strong>{a.name}</strong></td>
                    <td style={{ fontSize: 12 }}>{a.resource || '—'}{a.refType ? <span style={{ color: 'var(--text-muted)' }}> ({a.refType})</span> : ''}</td>
                    <td style={{ fontSize: 12 }}>{ago(a.started)}</td>
                    <td style={{ fontSize: 12 }}>{a.acknowledged ? 'acknowledged' : a.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="panel-card">
        <TableBar title={<><Info size={18} /> Activity — last 24 h ({acts.length})</>} query={q} setQuery={setQ} onCsv={csv} />
        {view.snapshot.sources.activity && !view.snapshot.sources.activity.ok && <p style={{ fontSize: 12.5, color: 'var(--status-warning)', margin: '0 0 8px' }}>Activity could not be read: {view.snapshot.sources.activity.error}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {acts.map((a) => {
            const vm = a.objectType === 'Instance' && a.objectId !== undefined ? vmByInstance.get(a.objectId) : undefined;
            return (
              <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12.5, padding: '4px 0', borderBottom: '1px solid var(--border-color)' }}>
                <span style={{ width: 90, flexShrink: 0, color: 'var(--text-muted)', fontSize: 11.5 }} title={a.at}>{ago(a.at)}</span>
                <span className={`badge ${a.success ? 'neutral' : 'error'}`} style={{ textTransform: 'none', flexShrink: 0 }}>{a.name || a.type}</span>
                <span style={{ flex: 1, color: 'var(--text-primary)' }}>{a.message}
                  {vm?.k8sNode && <span className="badge warning" style={{ marginLeft: 6, textTransform: 'none' }}>Kubernetes node {vm.k8sNode}</span>}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>{a.user || ''}</span>
              </div>
            );
          })}
          {!acts.length && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>No activity in the last 24 hours.</p>}
        </div>
      </div>
    </div>
  );
};

// ── Capacity ───────────────────────────────────────────────────────────────
export const VmeCapacity: React.FC<{ view: VmeView; onFocus: Focus }> = ({ view, onFocus }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    {view.capacity.map((c) => {
      const memP = pct(c.memUsed, c.memTotal);
      const allocP = pct(c.memAllocated, c.memTotal);
      return (
        <div key={String(c.id)} className="panel-card" style={{ borderLeft: `3px solid ${c.hosts >= 2 && !c.survivesHostLoss ? 'var(--status-warning)' : 'var(--hpe-green)'}` }}>
          <div className="panel-card-title">
            <h2><Gauge size={18} /> {c.name}</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className={`badge ${c.hosts < 2 ? 'neutral' : c.survivesHostLoss ? 'running' : 'warning'}`} style={{ textTransform: 'none' }}>
                {c.hosts < 2 ? 'single host — no failover' : c.survivesHostLoss ? 'survives losing one host' : 'cannot absorb losing a host'}
              </span>
              {typeof c.id === 'number' && <MapBtn id={`cluster:${c.id}`} onFocus={onFocus} />}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            <div><Bar value={memP} label={`Memory in use · ${gib(c.memUsed)} / ${gib(c.memTotal)}`} />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>Allotted to running VMs: {gib(c.memAllocated)} ({allocP === null ? '—' : `${Math.round(allocP)}%`} of physical)</div></div>
            <div><Bar value={c.cores ? (c.vcpus / c.cores) * 25 : null} label={`vCPU : core = ${c.cores ? (c.vcpus / c.cores).toFixed(1) : '—'} : 1`} />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{c.vcpus} vCPUs on {c.cores} cores (bar full at 4:1)</div></div>
            <div><Bar value={pct(c.storageUsed, c.storageTotal)} label={`Host storage · ${gib(c.storageUsed)} / ${gib(c.storageTotal)}`} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 12, fontSize: 12.5, color: 'var(--text-secondary)' }}>
            <span>Hosts <b>{c.hosts}</b> · running VMs <b>{c.vms}</b></span>
            <span>Biggest VM that still fits: <b>{gib(c.largestFit)}</b> RAM</span>
            <span>If <b>{c.biggestHost || '—'}</b> fails, its <b>{gib(c.memOnBiggest)}</b> of VMs must fit in the <b>{gib(c.memFreeAfterLoss)}</b> free on the other hosts</span>
          </div>
        </div>
      );
    })}
    {!view.capacity.length && <div className="panel-card"><p style={{ margin: 0, fontSize: 13 }}>No hosts reported.</p></div>}
  </div>
);
