// Unit tests for the Host Logs scanner: rule matching, grouping, the remote
// pre-filter and /var/log path confinement.
// Run with: npm test

import { describe, it, expect } from 'vitest';
import { matchRule, normalizeMessage, scanSources, safeLogPath, extractTimestamp, LOG_RULES } from '../hostlogs/rules.js';
import { PREFILTER, splitMarked } from '../hostlogs/router.js';

// One real-world line per specific rule. Also used to prove the remote grep
// pre-filter never drops a line a rule would have matched.
const SAMPLES: Record<string, string> = {
  'kernel-panic': 'Sep 17 10:02:03 gpu01 kernel: watchdog: BUG: soft lockup - CPU#12 stuck for 22s! [kworker/12:1:123]',
  oom: 'Sep 17 10:02:03 gpu01 kernel: Out of memory: Killed process 4242 (python) total-vm:1234kB',
  'disk-full': '2026-09-17T10:02:03+0000 node1 containerd[812]: write /var/lib/containerd/x: no space left on device',
  'fs-error': 'Sep 17 10:02:03 node1 kernel: EXT4-fs error (device sda1): ext4_find_entry:1455: inode #2',
  'io-error': 'Sep 17 10:02:03 node1 kernel: blk_update_request: I/O error, dev sdb, sector 123456',
  'hardware-mce': 'Sep 17 10:02:03 node1 kernel: mce: [Hardware Error]: Machine check events logged',
  'gpu-xid': 'Sep 17 10:02:03 gpu01 kernel: NVRM: Xid (PCI:0000:3b:00): 79, pid=0, GPU has fallen off the bus.',
  segfault: 'Sep 17 10:02:03 node1 kernel: python[991]: segfault at 0 ip 00007f sp 00007ffd error 4 in libc.so.6',
  'systemd-failed': 'Sep 17 10:02:03 node1 systemd[1]: Failed to start Kubernetes Kubelet.',
  cert: 'Sep 17 10:02:03 node1 etcd[55]: rejected connection: x509: certificate has expired or is not yet valid',
  'auth-failure': 'Sep 17 10:02:03 node1 sshd[2001]: Invalid user admin from 203.0.113.9 port 51234',
  sudo: 'Sep 17 10:02:03 node1 sudo: bob : user NOT in sudoers ; TTY=pts/0 ; COMMAND=/bin/sh',
  'time-sync': "Sep 17 10:02:03 node1 chronyd[700]: System clock wrong by 42.1 seconds",
  kubelet: 'Sep 17 10:02:03 node1 kubelet[900]: E0917 10:02:03.123 kubelet.go:2412] "Skipping pod synchronization" err="PLEG is not healthy"',
  network: 'Sep 17 10:02:03 node1 kernel: ixgbe 0000:01:00.0 eno1: NIC Link is Down',
};

describe('matchRule', () => {
  for (const [id, line] of Object.entries(SAMPLES)) {
    it(`classifies ${id}`, () => {
      expect(matchRule(line)?.id).toBe(id);
    });
  }

  it('falls back to generic severities', () => {
    expect(matchRule('app: fatal: config missing')?.id).toBe('generic-critical');
    expect(matchRule('app: request failed with 502')?.id).toBe('generic-error');
    expect(matchRule('app: WARNING flag is deprecated')?.id).toBe('generic-warning');
    expect(matchRule('app: started ok')).toBeUndefined();
  });

  it('marks OOM and full disks critical', () => {
    expect(matchRule(SAMPLES.oom)?.severity).toBe('critical');
    expect(matchRule(SAMPLES['disk-full'])?.severity).toBe('critical');
  });

  it('every non-generic rule has a sample and read-only checks', () => {
    for (const r of LOG_RULES.filter((r) => !r.id.startsWith('generic'))) {
      expect(SAMPLES[r.id], r.id).toBeTruthy();
      expect(r.checks.length).toBeGreaterThan(0);
      expect(r.explain.length).toBeGreaterThan(20);
    }
  });
});

describe('remote pre-filter', () => {
  const re = new RegExp(PREFILTER, 'i');
  it('keeps every sample line', () => {
    for (const [id, line] of Object.entries(SAMPLES)) expect(re.test(line), id).toBe(true);
  });
  it('drops ordinary lines', () => {
    expect(re.test('Sep 17 10:02:03 node1 systemd[1]: Started Session 4 of user root.')).toBe(false);
  });
});

describe('normalizeMessage / scanSources', () => {
  it('collapses lines that differ only in time, pid, ip and port', () => {
    const a = normalizeMessage('Sep 17 10:02:03 node1 sshd[2001]: Invalid user admin from 203.0.113.9 port 51234');
    const b = normalizeMessage('Sep 18 23:59:59 node1 sshd[77]: Invalid user admin from 198.51.100.4 port 40000');
    expect(a).toBe(b);
  });

  it('groups, counts and orders by severity then frequency', () => {
    const findings = scanSources([
      { file: '/var/log/auth.log', lines: [
        'Sep 17 10:00:00 n sshd[1]: Invalid user admin from 10.0.0.1 port 1',
        'Sep 17 10:05:00 n sshd[2]: Invalid user admin from 10.0.0.2 port 2',
        '',
      ] },
      { file: 'dmesg', lines: [SAMPLES.oom] },
      { file: '/var/log/syslog', lines: ['Sep 17 11:00:00 n sshd[3]: Invalid user admin from 10.0.0.3 port 3'] },
    ]);
    expect(findings).toHaveLength(2);
    expect(findings[0].ruleId).toBe('oom');
    expect(findings[1].count).toBe(3);
    expect(findings[1].files).toEqual(['/var/log/auth.log', '/var/log/syslog']);
    expect(findings[1].firstSeen).toBe('Sep 17 10:00:00');
    expect(findings[1].lastSeen).toBe('Sep 17 11:00:00');
    expect(findings[1].samples).toHaveLength(3);
  });

  it('extracts ISO and dmesg -T timestamps', () => {
    expect(extractTimestamp('2026-09-17T10:02:03+0000 host x')).toBe('2026-09-17T10:02:03+0000');
    expect(extractTimestamp('[Wed Sep 17 10:02:03 2026] eth0: link down')).toBe('Wed Sep 17 10:02:03 2026');
  });
});

describe('safeLogPath', () => {
  it('accepts files under /var/log', () => {
    expect(safeLogPath('/var/log/syslog.2.gz')).toBe('/var/log/syslog.2.gz');
    expect(safeLogPath('/var/log/nginx/access.log')).toBe('/var/log/nginx/access.log');
  });
  it('rejects traversal, other dirs and shell metacharacters', () => {
    for (const p of ['../etc/shadow', '/etc/passwd', '/var/log/../x', '/var/logs/x', '/var/log/a;rm -rf /', '/var/log/$(id)', '/var/log/a b', '', 42]) {
      expect(safeLogPath(p), String(p)).toBeNull();
    }
  });
});

describe('splitMarked', () => {
  it('splits marker blocks and keeps "@@" in log text', () => {
    const out = splitMarked('===TRINETRA:UID===\n0\n===TRINETRA:FILE:/var/log/syslog===\nerror @@x@@\n===TRINETRA:END===\n');
    expect(out.map((b) => b.tag)).toEqual(['UID', 'FILE', 'END']);
    expect(out[1].arg).toBe('/var/log/syslog');
    expect(out[1].body).toEqual(['error @@x@@']);
  });
});
