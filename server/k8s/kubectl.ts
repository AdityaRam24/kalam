// One way to run kubectl, wherever the cluster happens to be.
//
// Kalam talks to two kinds of cluster: the one this machine's kubeconfig points
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
// the request, which is what lets Kalam work against clusters missing an API
// (no Ingress, no CRDs) or a kubectl too old for a flag.

import { execFile } from 'child_process';
import { loadVms, section, sshRun } from '../vms.js';

/** Names we are willing to put into a remote shell command. */
export const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/;

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
  error?: string;
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
  maxBuffer = 1024 * 1024 * 16
): Promise<StepResult> {
  if (!vmName) {
    const results = await Promise.all(steps.map((s) => runLocalKubectl(s.args, Math.min(timeoutMs, 60000), maxBuffer)));
    const out: Record<string, string> = {};
    const ok = new Set<string>();
    let error: string | undefined;
    steps.forEach((s, i) => {
      out[s.tag] = results[i].stdout;
      if (results[i].ok) ok.add(s.tag);
      else if (!s.optional && !error) {
        error = (results[i].stderr.split('\n')[0] || 'kubectl failed').slice(0, 300);
      }
    });
    return { out, ok, error };
  }

  const vm = (await loadVms()).find((v) => v.name === vmName);
  if (!vm) return { out: {}, ok: new Set(), error: `VM "${vmName}" is not in the inventory.` };

  // `section()` slices to the next literal "@@", so any value in the output
  // containing "@@" would silently truncate the rest of the section. Defusing
  // it in the stream costs one sed and removes a whole class of phantom data
  // loss; the substitution only ever lands inside a string value.
  const cmd = steps
    .flatMap((s) => [
      `echo @@${s.tag}@@`,
      `(kubectl ${s.args.map(shellQuote).join(' ')} 2>/dev/null || true) | sed "s/@@/@ @/g"`,
    ])
    .concat('echo @@END@@')
    .join('; ');

  const { stdout, stderr, ok: sshOk } = await sshRun(vm, cmd, timeoutMs, maxBuffer);
  if (!sshOk && !stdout.trim()) {
    return { out: {}, ok: new Set(), error: (stderr.split('\n')[0] || 'SSH failed').slice(0, 300) };
  }

  const out: Record<string, string> = {};
  const ok = new Set<string>();
  for (const s of steps) {
    const raw = section(stdout, s.tag);
    out[s.tag] = raw;
    // `|| true` swallows the exit code remotely, so presence of output is the
    // only signal available. An empty section means "nothing came back".
    if (raw.trim()) ok.add(s.tag);
  }
  return { out, ok };
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
