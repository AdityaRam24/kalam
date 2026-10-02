// What the correlation engine must get right.
//
// The property that matters: four signals about ONE problem must become one
// issue with four pieces of evidence, not four issues. If this regresses, the
// page goes back to being four lists in a trench coat.

import { describe, it, expect } from 'vitest';
import { correlate, healthConcern, verdict, type CorrelateInput } from '../insight/correlate.js';
import type { HealthCheck } from '../hostlogs/system.js';
import type { LogFinding } from '../hostlogs/rules.js';

const health = (id: string, status: HealthCheck['status'], title: string, unit?: string): HealthCheck =>
  ({ id, status, title, detail: `${title} detail`, unit });

const finding = (ruleId: string, severity: LogFinding['severity'], title: string, count = 1): LogFinding =>
  ({
    key: `${ruleId}-k`, ruleId, severity, category: 'X', title,
    explain: 'because', checks: [`check-${ruleId}`], message: `${title} msg`,
    count, files: ['/var/log/syslog'], samples: ['raw line'],
  });

const base = (over: Partial<CorrelateInput> = {}): CorrelateInput => ({ subject: 'vm-a', ...over });

describe('healthConcern', () => {
  it('maps both bare and subject-scoped ids', () => {
    expect(healthConcern('memory')).toBe('memory');
    expect(healthConcern('disk:/var')).toBe('storage');
    expect(healthConcern('inode:/')).toBe('storage');
    expect(healthConcern('failed:kubelet.service')).toBe('services');
    expect(healthConcern('restarting:containerd.service')).toBe('services');
    expect(healthConcern('load')).toBe('cpu');
  });

  it('treats context as context, not a problem', () => {
    expect(healthConcern('reboot')).toBeNull();
    expect(healthConcern('root')).toBeNull();
  });
});

describe('correlate', () => {
  it('fuses four views of one problem into a single confirmed issue', () => {
    const issues = correlate(base({
      health: [health('disk:/var', 'critical', 'Disk /var 96% full')],
      findings: [finding('disk-full', 'critical', 'Disk or inode space exhausted', 412)],
      metrics: { diskUsedPct: { v: 96, level: 'critical', label: 'Disk (fullest)' } },
    }));

    const storage = issues.filter((i) => i.concern === 'storage');
    expect(storage).toHaveLength(1);                 // one problem, not three
    expect(storage[0].evidence).toHaveLength(3);     // seen three ways
    expect(storage[0].confidence).toBe('confirmed'); // corroborated
    expect(storage[0].severity).toBe('critical');
    expect(new Set(storage[0].evidence.map((e) => e.kind))).toEqual(new Set(['health', 'log', 'metric']));
    expect(storage[0].checks).toContain('check-disk-full');
  });

  it('marks a single-source concern as likely, not confirmed', () => {
    const issues = correlate(base({ findings: [finding('network', 'warning', 'Network errors')] }));
    expect(issues).toHaveLength(1);
    expect(issues[0].confidence).toBe('likely');
  });

  it('keeps genuinely different concerns apart', () => {
    const issues = correlate(base({
      health: [health('disk:/var', 'critical', 'Disk full'), health('memory', 'warning', 'Memory high')],
      findings: [finding('gpu-xid', 'critical', 'NVIDIA Xid error')],
    }));
    expect(issues.map((i) => i.concern).sort()).toEqual(['gpu', 'memory', 'storage']);
  });

  it('ranks critical-and-confirmed above everything else', () => {
    const issues = correlate(base({
      findings: [
        finding('network', 'warning', 'Network errors', 900),   // loud but only one source
        finding('oom', 'critical', 'OOM killer fired', 2),
      ],
      health: [health('memory', 'critical', 'Memory 97% in use')],
      metrics: { memUsedPct: { v: 97, level: 'critical' } },
    }));
    expect(issues[0].concern).toBe('memory');
    expect(issues[0].confidence).toBe('confirmed');
  });

  it('surfaces actionable units from both health checks and log findings', () => {
    const f = { ...finding('systemd-failed', 'warning', 'A unit failed'), units: ['kubelet.service'] } as LogFinding;
    const issues = correlate(base({
      health: [health('failed:containerd.service', 'critical', 'containerd.service failed', 'containerd.service')],
      findings: [f],
    }));
    const svc = issues.find((i) => i.concern === 'services')!;
    expect(svc.units.sort()).toEqual(['containerd.service', 'kubelet.service']);
  });

  it('ignores healthy checks entirely', () => {
    const issues = correlate(base({
      health: [health('disk', 'ok', 'Disk usage'), health('time', 'ok', 'Clock synchronized')],
      metrics: { cpuPct: { v: 4, level: 'ok' } },
    }));
    expect(issues).toEqual([]);
  });

  it('does not let generic info noise invent a concern', () => {
    const issues = correlate(base({ findings: [finding('generic-warning', 'info', 'Something said warning', 50)] }));
    expect(issues).toEqual([]);
  });

  it('folds graph root causes in as Kubernetes evidence', () => {
    const issues = correlate(base({
      graph: [{ title: 'node worker-2 NotReady', casualties: 14 }],
      findings: [finding('kubelet', 'warning', 'kubelet errors')],
    }));
    const k8s = issues.find((i) => i.concern === 'kubernetes')!;
    expect(k8s.confidence).toBe('confirmed');
    expect(k8s.evidence.some((e) => e.kind === 'graph' && e.count === 14)).toBe(true);
  });

  it('says only the useful thing about a host that will not answer', () => {
    const issues = correlate(base({
      unreachable: 'Host unreachable on SSH (port 22)',
      health: [health('disk:/var', 'critical', 'stale reading')],
    }));
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe('Host is unreachable');
    expect(issues[0].severity).toBe('critical');
  });

  it('puts the worst evidence at the top of an issue', () => {
    const issues = correlate(base({
      findings: [finding('fs-error', 'critical', 'Filesystem error', 1)],
      health: [health('disk:/', 'warning', 'Disk 86% full')],
    }));
    expect(issues[0].evidence[0].severity).toBe('critical');
  });
});

describe('verdict', () => {
  it('says so plainly when nothing is wrong', () => {
    expect(verdict([])).toEqual({ severity: 'ok', summary: 'Nothing is wrong that Trinetra can see.' });
  });

  it('leads with the worst issue and counts the rest', () => {
    const issues = correlate(base({
      health: [health('disk:/var', 'critical', 'Disk full'), health('load', 'warning', 'Load high')],
    }));
    const v = verdict(issues);
    expect(v.severity).toBe('critical');
    expect(v.summary).toContain('Storage');
    expect(v.summary).toContain('+1 other');
  });
});
