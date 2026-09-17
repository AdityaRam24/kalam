// Unit tests for the journal explorer's journalctl builder: option coverage,
// validation, quoting, follow-mode cursors and --list-boots parsing.
// Run with: npm test

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import {
  buildJournalCommand, normalizeTime, splitCursor, parseBoots, buildCheckCommand,
} from '../hostlogs/journal.js';

// Syntax-check generated commands with a real bash when one works. On Windows
// `bash` can resolve to the WSL stub with no distro installed, so probe with a
// trivial script first and skip the check (rather than fail) when bash is unusable.
const bashWorks = (() => {
  try { execFileSync('bash', ['-n', '-c', 'true'], { stdio: 'pipe' }); return true; } catch { return false; }
})();
function bashSyntaxOk(cmd: string): boolean {
  if (!bashWorks) return true;
  try { execFileSync('bash', ['-n', '-c', cmd], { stdio: 'pipe' }); return true; } catch { return false; }
}

describe('buildJournalCommand', () => {
  it('defaults to the last 500 lines in short-iso', () => {
    const b = buildJournalCommand({});
    expect(b.errors).toEqual([]);
    expect(b.display).toBe('journalctl --no-pager -o short-iso -n 500');
  });

  it('covers every filter and output option', () => {
    const b = buildJournalCommand({
      units: ['kubelet.service', 'containerd*'], identifiers: ['sshd'], kernel: true,
      priority: 'warning', priorityTo: 'emerg', boot: '-1',
      since: '2026-09-17T10:00', until: '-5min',
      fields: [{ key: '_PID', value: '900' }, { key: '_TRANSPORT', value: 'stdout' }],
      grep: 'PLEG|timeout', grepMode: 'regex', caseSensitive: false,
      output: 'json', outputFields: ['MESSAGE', '_PID'], lines: 1000, reverse: true, catalog: true, utc: true, noHostname: true,
    });
    expect(b.errors).toEqual([]);
    expect(b.display).toBe(
      "journalctl --no-pager -u 'kubelet.service' -u 'containerd*' -t 'sshd' -k -p emerg..warning -b '-1' " +
      "--since '2026-09-17 10:00' --until '-5min' '_PID=900' '_TRANSPORT=stdout' -g 'PLEG|timeout' --case-sensitive=false " +
      '-o json --output-fields=MESSAGE,_PID -x --utc --no-hostname -n 1000 -r',
    );
    expect(bashSyntaxOk(b.command)).toBe(true);
  });

  it('applies the line limit after a fixed-string filter', () => {
    const b = buildJournalCommand({ grep: "it's broken", lines: 100 });
    expect(b.display).toBe("journalctl --no-pager -o short-iso -n 5000 | grep -aiF -e 'it'\\''s broken' | tail -n 100");
    expect(buildJournalCommand({ grep: 'x', lines: 10, reverse: true, caseSensitive: true }).display).toContain('-r | grep -aF -e \'x\' | head -n 10');
    expect(bashSyntaxOk(b.command)).toBe(true);
  });

  it('follow mode uses cursors and keeps the cursor line through grep', () => {
    const first = buildJournalCommand({ afterCursor: '', lines: 50 });
    expect(first.display).toBe('journalctl --no-pager -o short-iso --show-cursor -n 50');
    const next = buildJournalCommand({ afterCursor: 's=abc;i=1f;b=00ff;m=12;t=5;x=9', grep: 'err' });
    expect(next.display).toContain("--after-cursor='s=abc;i=1f;b=00ff;m=12;t=5;x=9' --show-cursor");
    expect(next.display).toContain("-e '-- cursor:'");
    expect(bashSyntaxOk(next.command)).toBe(true);
    expect(buildJournalCommand({ afterCursor: 'x; rm -rf /' }).errors).toEqual(['Invalid cursor.']);
  });

  it('download mode ignores the cursor', () => {
    expect(buildJournalCommand({ afterCursor: 's=1' }, { forDownload: true }).display).not.toContain('cursor');
  });

  it('rejects injection and bad values with readable errors', () => {
    const b = buildJournalCommand({
      units: ['kubelet; reboot'], identifiers: ['$(id)'], priority: 'loud', boot: '1; ls',
      since: 'last tuesday', fields: [{ key: 'pid', value: '1' }, { key: 'MESSAGE', value: 'a\nb' }],
      output: 'export', outputFields: ['bad field'],
    });
    expect(b.errors).toHaveLength(9);
    expect(b.display).not.toMatch(/reboot|\$\(id\)|ls/);
  });

  it('clamps lines', () => {
    expect(buildJournalCommand({ lines: 999999 }).display).toContain('-n 20000');
    expect(buildJournalCommand({ lines: -3 }).display).toContain('-n 1');
  });

  it('accepts boot ids and all boots', () => {
    expect(buildJournalCommand({ boot: '0123456789abcdef0123456789abcdef' }).display).toContain("-b '0123456789abcdef0123456789abcdef'");
    expect(buildJournalCommand({ boot: 'all' }).display).not.toContain('-b');
  });
});

describe('normalizeTime', () => {
  it('accepts systemd.time formats', () => {
    for (const t of ['2026-09-17', '2026-09-17 10:00:00', '10:30', 'today', 'yesterday', '-1h', '+30min', '-2 days', '2 hours ago', '@1758103200']) {
      expect(normalizeTime(t), t).not.toBeNull();
    }
    expect(normalizeTime('2026-09-17T08:15')).toBe('2026-09-17 08:15');
  });
  it('rejects anything else', () => {
    for (const t of ['last tuesday', "'; id", '2026/09/17', '']) expect(normalizeTime(t), t).toBeNull();
  });
});

describe('splitCursor / parseBoots / checks', () => {
  it('splits the --show-cursor trailer', () => {
    expect(splitCursor(['a', 'b', '-- cursor: s=1;i=2'])).toEqual({ lines: ['a', 'b'], cursor: 's=1;i=2' });
  });

  it('parses old and new --list-boots formats', () => {
    const old = parseBoots([
      '-1 0123456789abcdef0123456789abcdef Tue 2026-09-16 08:00:01 UTC—Wed 2026-09-17 07:59:00 UTC',
      ' 0 fedcba9876543210fedcba9876543210 Wed 2026-09-17 08:01:00 UTC—Wed 2026-09-17 10:00:00 UTC',
    ]);
    expect(old.map((b) => b.index)).toEqual([0, -1]);
    expect(old[1]).toMatchObject({ id: '0123456789abcdef0123456789abcdef', first: 'Tue 2026-09-16 08:00:01 UTC', last: 'Wed 2026-09-17 07:59:00 UTC' });

    const modern = parseBoots([
      'IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY',
      '  0 fedcba9876543210fedcba9876543210 Wed 2026-09-17 08:01:00 UTC Wed 2026-09-17 10:00:00 UTC',
    ]);
    expect(modern).toEqual([{ index: 0, id: 'fedcba9876543210fedcba9876543210', first: 'Wed 2026-09-17 08:01:00 UTC', last: 'Wed 2026-09-17 10:00:00 UTC' }]);
  });

  it('only offers read-only checks', () => {
    expect(buildCheckCommand('verify')).toContain('--verify');
    expect(buildCheckCommand('header')).toContain('--header');
    for (const op of ['vacuum-size', 'rotate', 'flush', 'sync']) expect(buildCheckCommand(op)).toBeNull();
  });
});
