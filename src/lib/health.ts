// One vocabulary for "is this OK?" across every view.
//
// The server derives a kubectl-accurate status (CrashLoopBackOff, ImagePullBackOff,
// Init:0/1, Terminating …) and a health bucket for pods and workloads — see
// server/k8s/workloads.ts. The UI only maps those buckets to colours and words,
// so a pod is never green on one page and red on another.

export type Health = 'healthy' | 'progressing' | 'failing' | 'completed' | 'unknown';

export const HEALTH_BADGE: Record<Health, string> = {
  healthy: 'running',
  progressing: 'warning',
  failing: 'error',
  completed: 'neutral',
  unknown: 'neutral',
};

export const HEALTH_COLOR: Record<Health, string> = {
  healthy: 'var(--status-success)',
  progressing: 'var(--status-warning)',
  failing: 'var(--status-error)',
  completed: 'var(--text-muted)',
  unknown: 'var(--text-muted)',
};

export const HEALTH_LABEL: Record<Health, string> = {
  healthy: 'Healthy',
  progressing: 'In progress',
  failing: 'Failing',
  completed: 'Completed',
  unknown: 'Unknown',
};

/** Same rule as the server's podHealth, for payloads that predate it. */
export function podHealthOf(p: { health?: string; displayStatus?: string; status?: string; ready?: string }): Health {
  if (p.health && p.health in HEALTH_BADGE) return p.health as Health;
  const s = p.displayStatus || p.status || '';
  if (s === 'Completed' || s === 'Succeeded') return 'completed';
  if (/BackOff|Err|Error|OOMKilled|Evicted|Failed|Invalid|ExitCode|Signal|ContainerCannotRun|DeadlineExceeded|NodeLost|Unknown/i.test(s)) return 'failing';
  if (s === 'Running') {
    const [r, t] = String(p.ready || '').split('/').map(Number);
    return Number.isFinite(r) && Number.isFinite(t) && t > 0 && r < t ? 'progressing' : 'healthy';
  }
  if (/Pending|ContainerCreating|PodInitializing|Init:|Terminating/i.test(s)) return 'progressing';
  return 'unknown';
}

/** Workload health, falling back to ready/desired for older payloads. */
export function workloadHealthOf(d: { health?: string; ready?: string }): Health {
  if (d.health && d.health in HEALTH_BADGE) return d.health as Health;
  const [r, t] = String(d.ready || '').split('/').map(Number);
  if (!Number.isFinite(r) || !Number.isFinite(t)) return 'unknown';
  if (t === 0) return 'completed';
  if (r >= t) return 'healthy';
  return r === 0 ? 'failing' : 'progressing';
}

export const podStatusText = (p: { displayStatus?: string; status?: string }) => p.displayStatus || p.status || 'Unknown';

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function formatCpu(milli: number | null | undefined): string {
  if (milli === null || milli === undefined || !Number.isFinite(milli)) return '—';
  return milli >= 1000 ? `${(milli / 1000).toFixed(milli >= 10000 ? 0 : 1)} cores` : `${Math.round(milli)}m`;
}

export function ageOf(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Trigger a browser download of text content. */
export function downloadText(text: string, filename: string, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** RFC 4180 CSV from rows of cells. */
export function toCsv(rows: Array<Array<string | number | undefined | null>>): string {
  return rows
    .map((r) => r.map((c) => {
      const s = c === undefined || c === null ? '' : String(c);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\r\n');
}

/** Filesystem-safe timestamp for download names: 2026-10-01_14-03-22. */
export const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
