// journalctl query builder for the Host Logs journal explorer.
//
// The browser sends a structured query; this file validates every field and
// turns it into shell-quoted journalctl arguments. Nothing typed in the browser
// reaches the shell unquoted, and every value is checked against what
// journalctl itself accepts, so a bad field is reported as a readable error
// instead of a confusing journalctl failure.
//
// Coverage (see JOURNAL_OPTION_HELP for the user-facing list):
//   filters   -u  -t  -k  -p (level or range)  -b (index / id / all)
//             --since / --until  -g (+ --case-sensitive)  FIELD=value matches
//             _PID _UID _COMM _TRANSPORT SYSLOG_FACILITY via field matches
//   output    -o <mode>  -n  -r  -x  --utc  --no-hostname  --output-fields
//   follow    --show-cursor / --after-cursor (polled, stands in for -f)
//   metadata  --list-boots  -F <field>  -N  --disk-usage  --verify  --header
//
// Not offered, on purpose: --vacuum-*, --rotate, --flush, --sync (they delete
// or rewrite journal files) and --file/-D/-M/--user (other journals).

import { shQuote } from '../ssh.js';

export interface JournalQuery {
  units?: string[];
  identifiers?: string[];
  kernel?: boolean;
  priority?: string;            // emerg..debug or 0..7
  priorityTo?: string;          // makes a range: -p <priority>..<priorityTo>
  boot?: string;                // '' (all boots) | '0' | '-1' | '-N' | 32-hex boot id
  since?: string;
  until?: string;
  grep?: string;
  grepMode?: 'fixed' | 'regex'; // fixed → grep -F on the output; regex → journalctl -g
  caseSensitive?: boolean;
  fields?: Array<{ key: string; value: string }>;
  output?: string;
  outputFields?: string[];
  lines?: number;
  reverse?: boolean;
  catalog?: boolean;
  utc?: boolean;
  noHostname?: boolean;
  afterCursor?: string;         // follow mode: only entries after this cursor
}

export interface BuiltJournal {
  command: string;              // full remote command
  display: string;              // what a human would type (shown + copyable)
  errors: string[];
}

export const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

export const OUTPUT_MODES = [
  'short-iso', 'short', 'short-iso-precise', 'short-precise', 'short-monotonic', 'short-full', 'short-unix',
  'with-unit', 'cat', 'verbose', 'json', 'json-pretty',
];

export const MAX_LINES = 20000;

const UNIT_RE = /^[A-Za-z0-9@_.:\\*?[\]-]{1,200}$/;          // -u accepts globs
const IDENT_RE = /^[A-Za-z0-9@_.:/-]{1,100}$/;
const FIELD_KEY_RE = /^_{0,2}[A-Z0-9][A-Z0-9_]{0,63}$/;
const BOOT_RE = /^(0|[+-]?\d{1,4}|[0-9a-f]{32})$/;
const CURSOR_RE = /^[A-Za-z0-9=;_+-]{1,512}$/;

// Time specs journalctl understands (systemd.time(7)). The HTML datetime-local
// input yields "2026-09-17T10:00", which journalctl rejects, so T becomes a space.
export function normalizeTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 ');
  if (!t) return null;
  const ok =
    /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?( UTC)?$/.test(t) ||
    /^\d{2}:\d{2}(:\d{2})?$/.test(t) ||
    /^(now|today|yesterday|tomorrow)$/.test(t) ||
    /^[-+]\d{1,6} ?(us|ms|s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks|M|month|months|y|year|years)$/.test(t) ||
    /^\d{1,6} ?(s|sec|m|min|minutes?|h|hours?|d|days?|w|weeks?|months?|y|years?) ago$/.test(t) ||
    /^@\d{1,12}$/.test(t);
  return ok ? t : null;
}

// A newline or NUL would break one journalctl argument across shell lines, so
// values containing them are rejected outright.
function hasLineBreakOrNul(v: string): boolean {
  return v.includes('\n') || v.includes('\r') || v.includes(String.fromCharCode(0));
}

function priorityValue(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  if (/^[0-7]$/.test(p)) return p;
  return PRIORITIES.includes(p) ? p : null;
}

// Build the journalctl invocation for a query. `forDownload` lifts the line
// cap's default and skips follow-mode cursor handling.
export function buildJournalCommand(q: JournalQuery, opts: { forDownload?: boolean } = {}): BuiltJournal {
  const errors: string[] = [];
  const args: string[] = ['--no-pager'];

  for (const u of (q.units || []).filter(Boolean).slice(0, 20)) {
    if (UNIT_RE.test(u)) args.push('-u', shQuote(u));
    else errors.push(`Invalid unit "${u}".`);
  }
  for (const t of (q.identifiers || []).filter(Boolean).slice(0, 20)) {
    if (IDENT_RE.test(t)) args.push('-t', shQuote(t));
    else errors.push(`Invalid identifier "${t}".`);
  }
  if (q.kernel) args.push('-k');

  if (q.priority) {
    const from = priorityValue(q.priority);
    const to = q.priorityTo ? priorityValue(q.priorityTo) : null;
    if (!from) errors.push(`Invalid priority "${q.priority}".`);
    else if (q.priorityTo && !to) errors.push(`Invalid priority "${q.priorityTo}".`);
    // journalctl ranges run from most to least severe ("err..warning" is fine,
    // "warning..err" silently matches nothing), so order them for the user.
    else if (to) {
      const idx = (v: string) => (/^\d$/.test(v) ? Number(v) : PRIORITIES.indexOf(v));
      const [a, b] = idx(from) <= idx(to) ? [from, to] : [to, from];
      args.push('-p', `${a}..${b}`);
    } else args.push('-p', from);
  }

  if (q.boot !== undefined && q.boot !== '' && q.boot !== 'all') {
    if (BOOT_RE.test(String(q.boot))) args.push('-b', shQuote(String(q.boot)));
    else errors.push(`Invalid boot "${q.boot}" — use 0, -1, -2… or a boot ID.`);
  }

  if (q.since) {
    const s = normalizeTime(q.since);
    if (s) args.push('--since', shQuote(s));
    else errors.push(`Invalid "since" time "${q.since}" — e.g. 2026-09-17 10:00, -1h, today, "2 days ago".`);
  }
  if (q.until) {
    const u = normalizeTime(q.until);
    if (u) args.push('--until', shQuote(u));
    else errors.push(`Invalid "until" time "${q.until}".`);
  }

  // Field matches: same key → OR, different keys → AND (journalctl semantics).
  for (const f of (q.fields || []).slice(0, 20)) {
    if (!f || (!f.key && !f.value)) continue;
    if (!FIELD_KEY_RE.test(f.key || '')) { errors.push(`Invalid field name "${f.key}" — journal fields are UPPER_CASE.`); continue; }
    if (typeof f.value !== 'string' || f.value.length > 200 || hasLineBreakOrNul(f.value)) { errors.push(`Invalid value for ${f.key}.`); continue; }
    args.push(shQuote(`${f.key}=${f.value}`));
  }

  const grep = typeof q.grep === 'string' ? q.grep.trim().slice(0, 300) : '';
  const regex = grep && q.grepMode === 'regex';
  if (regex) {
    if (hasLineBreakOrNul(grep)) errors.push('Invalid pattern.');
    else {
      args.push('-g', shQuote(grep));
      // Without it journalctl is case-insensitive only when the pattern is all lower-case.
      args.push(`--case-sensitive=${q.caseSensitive ? 'true' : 'false'}`);
    }
  }

  const output = q.output || 'short-iso';
  if (!OUTPUT_MODES.includes(output)) errors.push(`Invalid output mode "${output}".`);
  else args.push('-o', output);
  if (q.outputFields?.length) {
    const good = q.outputFields.filter((f) => FIELD_KEY_RE.test(f)).slice(0, 30);
    if (good.length !== q.outputFields.length) errors.push('Invalid output field name.');
    // Only honoured by verbose / json / cat modes.
    if (good.length) args.push(`--output-fields=${good.join(',')}`);
  }
  if (q.catalog) args.push('-x');
  if (q.utc) args.push('--utc');
  if (q.noHostname) args.push('--no-hostname');

  const lines = Math.min(Math.max(Math.floor(Number(q.lines) || 500), 1), MAX_LINES);
  const fixed = grep && !regex;

  const follow = !opts.forDownload && q.afterCursor !== undefined;
  if (follow) {
    if (q.afterCursor && !CURSOR_RE.test(q.afterCursor)) errors.push('Invalid cursor.');
    else if (q.afterCursor) args.push(`--after-cursor=${shQuote(q.afterCursor)}`);
    args.push('--show-cursor');
  }

  // Line limit. With a fixed-string filter the limit applies AFTER filtering,
  // so journalctl reads a bounded window and grep/tail trims the result.
  let pipe = '';
  if (fixed) {
    const keepCursor = follow ? ` -e ${shQuote('-- cursor:')}` : '';
    args.push('-n', String(Math.min(lines * 50, 500000)));
    if (q.reverse) args.push('-r');
    const sel = q.reverse ? 'head' : 'tail';
    const grepFlags = q.caseSensitive ? '-aF' : '-aiF';
    pipe = ` | grep ${grepFlags} -e ${shQuote(grep)}${keepCursor} | ${sel} -n ${follow ? lines + 1 : lines}`;
  } else {
    // In follow mode the first poll takes the last N; later polls take
    // everything after the cursor (still capped).
    args.push('-n', String(lines));
    if (q.reverse) args.push('-r');
  }

  const cmdline = `journalctl ${args.join(' ')}`;
  return {
    command: `${cmdline} 2>&1${pipe}`,
    display: `${cmdline}${pipe}`,
    errors,
  };
}

// "-- cursor: s=…" trailer printed by --show-cursor.
export function splitCursor(lines: string[]): { lines: string[]; cursor?: string } {
  let cursor: string | undefined;
  const out: string[] = [];
  for (const l of lines) {
    const m = l.match(/^-- cursor: (\S+)$/);
    if (m) cursor = m[1];
    else out.push(l);
  }
  return { lines: out, cursor };
}

export interface BootEntry { index: number; id: string; first: string; last: string }

// `journalctl --list-boots`, old ("first—last") and new (columns + header) formats.
export function parseBoots(lines: string[]): BootEntry[] {
  const ts = String.raw`(?:[A-Z][a-z]{2} )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [A-Za-z0-9+:_/-]+)?`;
  const re = new RegExp(String.raw`^\s*(-?\d+)\s+([0-9a-f]{32})\s+(${ts})\s*(?:—|\s)\s*(${ts})\s*$`);
  const out: BootEntry[] = [];
  for (const l of lines) {
    const m = l.match(re);
    if (m) out.push({ index: Number(m[1]), id: m[2], first: m[3], last: m[4] });
  }
  return out.sort((a, b) => b.index - a.index);
}

// Read-only journal integrity checks. Operations that delete or rewrite journal
// files (--vacuum-*, --rotate, --flush) are deliberately NOT offered: this page
// is for investigating logs, and it must not be able to destroy them.
export type JournalCheck = 'verify' | 'header';

export function buildCheckCommand(op: unknown): string | null {
  if (op === 'verify') return 'journalctl --verify --no-pager 2>&1 | tail -n 300';
  if (op === 'header') return 'journalctl --header --no-pager 2>&1 | head -n 300';
  return null;
}
