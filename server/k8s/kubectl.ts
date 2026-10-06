// One way to run kubectl, wherever the cluster happens to be.
//
// Trinetra talks to two kinds of cluster: the one this machine's kubeconfig points
// at, and one reachable only by SSH-ing into an inventory VM. Every feature
// that reads cluster state needs both, so the mechanics live here once:
//
//   - LOCAL  — `execFile('kubectl', args)` per step, run in parallel. No shell,
//              so nothing has to be escaped and nothing can be injected.
//   - REMOTE — all steps folded into ONE ssh round trip separated by `@@TAG@@`
//              markers (the convention `vms.ts` and `graph/router.ts` already
//              use), because ssh latency, not kubectl, dominates the cost.
//
// A step may be `optional`: its failure degrades the answer instead of failing
// the request, which is what lets Trinetra work against clusters missing an API
// (no Ingress, no CRDs) or a kubectl too old for a flag.

import { execFile } from 'child_process';
import { loadVms, section, sshRun } from '../vms.js';

/** Names we are willing to put into a remote shell command. */
export const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/;

/** Concurrent local kubectl processes per runSteps call (see runSteps). */
const LOCAL_PARALLEL = Math.max(1, Number(process.env.TRINETRA_KUBECTL_PARALLEL || 6));

export interface Step {
  /** Section marker for the remote path; also the key in the result map. */
  tag: string;
  args: string[];
  /** Failure here degrades the answer instead of failing the request. */
  optional?: boolean;
}

export interface StepResult {
  out: Record<string, string>;
  /** Tags whose command actually produced output — see `ok` below. */
  ok: Set<string>;
  /**
   * Remote only: tags whose section marker never came back — the SSH call
   * timed out (or was cut off) before reaching them. "Never ran" and "ran and
   * printed nothing" need different words on screen.
   */
  missing?: Set<string>;
  error?: string;
}

/** How the remote script runs its steps. Default: one after another. */
export interface RemoteOptions {
  /** Run up to this many steps at once on the remote host (batched). */
  parallel?: number;
  /** Kill any single step after this many seconds (needs coreutils `timeout`). */
  stepTimeoutSec?: number;
}

/**
 * Quote one argument for a remote shell. kubectl templates are full of braces,
 * spaces and asterisks (`-o jsonpath={range .items[*]}…`), none of which may
 * reach the remote shell unquoted.
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.,:/=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line of kubectl's stderr worth showing a person.
 *
 * kubectl prefixes the real message with klog noise ("E1001 23:33:59.86 37164
 * memcache.go:265] Unhandled Error ..."), so the first line is usually the
 * least readable one. Prefer kubectl's own summary ("Unable to connect to the
 * server: ...", "error: ...", "Error from server (Forbidden): ..."), else the
 * last line with the klog prefix stripped.
 */
export function kubectlErrorLine(stderr: string): string {
  const lines = (stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const plain = lines.find((l) => /^(Unable to connect|The connection to the server|error:|Error from server)/i.test(l));
  const pick = plain || lines[lines.length - 1] || '';
  return pick.replace(/^[EWIF]\d{4}\s+[\d:.]+\s+\d+\s+\S+\]\s*/, '').slice(0, 300);
}

/** Run one kubectl invocation locally, without a shell. */
export function runLocalKubectl(
  args: string[],
  timeout = 20000,
  maxBuffer = 1024 * 1024 * 24
): Promise<{ stdout: string; ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile('kubectl', args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || (err ? err.message : ''), ok: !err });
    });
  });
}

/**
 * Execute every step and return each one's stdout by tag.
 *
 * `ok` reports which steps actually ran. This distinction matters more than it
 * looks: a caller diffing two snapshots must be able to tell "this kind has no
 * objects" from "this query never ran", or a truncated read turns into a
 * fictional mass deletion.
 */
export async function runSteps(
  steps: Step[],
  vmName?: string,
  timeoutMs = 45000,
  maxBuffer = 1024 * 1024 * 16,
  remote: RemoteOptions = {}
): Promise<StepResult> {
  if (!vmName) {
    // At most LOCAL_PARALLEL kubectl processes at once. Each one holds a whole
    // list in memory while it serialises it; two dozen at once on a big cluster
    // is enough to push a 1 GiB pod into the OOM killer.
    const results: Array<{ stdout: string; ok: boolean; stderr: string }> = new Array(steps.length);
    let next = 0;
    const worker = async () => {
      while (next < steps.length) {
        const i = next++;
        results[i] = await runLocalKubectl(steps[i].args, Math.min(timeoutMs, 60000), maxBuffer);
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOCAL_PARALLEL, steps.length) }, worker));
    const out: Record<string, string> = {};
    const ok = new Set<string>();
    let error: string | undefined;
    steps.forEach((s, i) => {
      out[s.tag] = results[i].stdout;
      if (results[i].ok) ok.add(s.tag);
      else if (!s.optional && !error) {
        error = kubectlErrorLine(results[i].stderr) || 'kubectl failed';
      }
    });
    return { out, ok, error };
  }

  const vm = (await loadVms()).find((v) => v.name === vmName);
  if (!vm) return { out: {}, ok: new Set(), error: `VM "${vmName}" is not in the inventory.` };

  const cmd = buildRemoteScript(steps, remote);

  const { stdout, stderr, ok: sshOk } = await sshRun(vm, cmd, timeoutMs, maxBuffer);
  if (!sshOk && !stdout.trim()) {
    return { out: {}, ok: new Set(), error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 300) };
  }

  const out: Record<string, string> = {};
  const ok = new Set<string>();
  const missing = new Set<string>();
  for (const s of steps) {
    if (!stdout.includes(`@@${s.tag}@@`)) missing.add(s.tag);
    const raw = section(stdout, s.tag);
    out[s.tag] = raw;
    // `|| true` swallows the exit code remotely, so presence of output is the
    // only signal available. An empty section means "nothing came back".
    if (raw.trim()) ok.add(s.tag);
  }
  return { out, ok, missing };
}

/**
 * The one shell script that runs every step on the remote host.
 *
 * Sequential by default. With `parallel`, steps run in background batches and
 * each batch's output is printed (behind its markers) as soon as the batch
 * finishes — so if the SSH call times out, what was read so far still comes
 * back instead of nothing. Steps are written to a temp dir rather than straight
 * to stdout because concurrent writers would interleave their lines.
 */
export function buildRemoteScript(steps: Step[], opts: RemoteOptions = {}): string {
  // `section()` slices to the next literal "@@", so any value in the output
  // containing "@@" would silently truncate the rest of the section. Defusing
  // it in the stream costs one sed and removes a whole class of phantom data
  // loss; the substitution only ever lands inside a string value.
  const parallel = Math.max(1, Math.floor(opts.parallel || 1));
  const limit = opts.stepTimeoutSec && opts.stepTimeoutSec > 0 ? Math.floor(opts.stepTimeoutSec) : 0;
  const kubectl = (s: Step) =>
    `(${limit ? `_to ${limit} ` : ''}kubectl ${s.args.map(shellQuote).join(' ')} 2>/dev/null || true) | sed "s/@@/@ @/g"`;
  // A host without coreutils `timeout` still runs the step, just unbounded.
  const prelude = limit
    ? ['_to() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }']
    : [];

  if (parallel === 1) {
    return [
      ...prelude,
      ...steps.flatMap((s) => [`echo @@${s.tag}@@`, kubectl(s)]),
      'echo @@END@@',
    ].join('; ');
  }

  const lines: string[] = [
    ...prelude,
    '_T=$(mktemp -d 2>/dev/null || (d=/tmp/trinetra.$$; mkdir -p "$d" && echo "$d"))',
  ];
  for (let start = 0; start < steps.length; start += parallel) {
    const batch = steps.slice(start, start + parallel);
    batch.forEach((s, j) => lines.push(`${kubectl(s)} > "$_T/${start + j}" &`));
    lines.push('wait');
    batch.forEach((s, j) => lines.push(`echo @@${s.tag}@@; cat "$_T/${start + j}"`));
  }
  lines.push('echo @@END@@', 'rm -rf "$_T"');
  // `&` already ends a command; a following `;` would be a syntax error.
  return lines.map((l) => (l.endsWith('&') ? `${l} ` : `${l}; `)).join('').trim().replace(/;$/, '');
}

/** Parse a step's output as JSON, tolerating empty output from a missing binary. */
export function parseJson(raw: string | undefined): any {
  const t = (raw || '').trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}
