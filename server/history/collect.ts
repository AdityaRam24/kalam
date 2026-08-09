// Take one capture of a cluster and reduce it to a snapshot.
//
// The whole feature stands on this being cheap enough to run every few minutes
// and small enough to survive an SSH pipe, so the queries are chosen with a
// budget in mind:
//
//   - Kinds where the SHAPE matters (workloads, services, nodes, RBAC) are
//     fetched as JSON, with `--show-managed-fields=true` so we learn who last
//     wrote each one. That flag exists only on kubectl 1.21+, so if a step
//     fails it is retried once without it — attribution degrades, the history
//     does not.
//   - Pods are fetched as a COLUMN TABLE. There can be thousands of them and
//     their JSON is enormous; the eight columns we track fit in ~150 bytes per
//     pod, which keeps a 5000-pod cluster inside the SSH buffer.
//   - ConfigMaps and Secrets are fetched as `name|resourceVersion` lines only.
//     resourceVersion moves on every write and on nothing else, so it answers
//     "was this edited?" without Kalam reading — let alone storing — a single
//     byte of their contents.
//
// Every step is read-only, and every step is optional: a cluster with no
// Ingress API, or a kubeconfig without RBAC read permission, produces a
// smaller snapshot rather than an error. `sections` records what actually
// came back so the diff can tell "none exist" from "we could not look".

import { parseJson, runSteps, type Step } from '../k8s/kubectl.js';
import { fingerprintList, parsePodTable, parseRvTable } from './fingerprint.js';
import { objectKey, type Fingerprint, type Snapshot } from './model.js';

/** Columns for the pod table. parsePodTable() depends on this exact order. */
const POD_COLUMNS = [
  'NS:.metadata.namespace',
  'NAME:.metadata.name',
  'NODE:.spec.nodeName',
  'PHASE:.status.phase',
  'OWNERKIND:.metadata.ownerReferences[0].kind',
  'OWNERNAME:.metadata.ownerReferences[0].name',
  'IMAGES:.spec.containers[*].image',
  'RESTARTS:.status.containerStatuses[*].restartCount',
  'READY:.status.containerStatuses[*].ready',
  'CREATED:.metadata.creationTimestamp',
  'UID:.metadata.uid',
].join(',');

/** `ns|name|resourceVersion` — the cheapest possible "did this change?". */
const RV_TEMPLATE = '{range .items[*]}{.metadata.namespace}|{.metadata.name}|{.metadata.resourceVersion}{"\\n"}{end}';
const RV_TEMPLATE_CLUSTER = '{range .items[*]}{.metadata.name}|{.metadata.resourceVersion}{"\\n"}{end}';

interface CaptureStep extends Step {
  /** Turn this step's raw output into fingerprints. */
  parse: (raw: string) => Fingerprint[];
  /** Whether to ask for managedFields (and retry without them on failure). */
  managedFields?: boolean;
}

const STEPS: CaptureStep[] = [
  {
    tag: 'WORKLOADS',
    args: ['get', 'deploy,sts,ds,job,cronjob,hpa,pdb', '-A', '-o', 'json'],
    managedFields: true,
    optional: true,
    parse: (raw) => fingerprintList(parseJson(raw)),
  },
  {
    tag: 'PODS',
    args: ['get', 'pods', '-A', '--no-headers', '-o', `custom-columns=${POD_COLUMNS}`],
    optional: true,
    parse: parsePodTable,
  },
  {
    tag: 'NET',
    args: ['get', 'svc,ing,netpol', '-A', '-o', 'json'],
    managedFields: true,
    optional: true,
    parse: (raw) => fingerprintList(parseJson(raw)),
  },
  {
    tag: 'STORAGE',
    args: ['get', 'pvc,resourcequota,limitrange', '-A', '-o', 'json'],
    managedFields: true,
    optional: true,
    parse: (raw) => fingerprintList(parseJson(raw)),
  },
  {
    tag: 'RBAC',
    args: ['get', 'sa,role,rolebinding', '-A', '-o', 'json'],
    managedFields: true,
    optional: true,
    parse: (raw) => fingerprintList(parseJson(raw)),
  },
  {
    tag: 'CLUSTER',
    args: ['get', 'nodes,ns,pv,storageclass,priorityclass', '-o', 'json'],
    managedFields: true,
    optional: true,
    parse: (raw) => fingerprintList(parseJson(raw)),
  },
  {
    tag: 'CONFIGMAPS',
    args: ['get', 'cm', '-A', '-o', `jsonpath=${RV_TEMPLATE}`],
    optional: true,
    parse: (raw) => parseRvTable(raw, 'ConfigMap'),
  },
  {
    tag: 'SECRETS',
    args: ['get', 'secret', '-A', '-o', `jsonpath=${RV_TEMPLATE}`],
    optional: true,
    parse: (raw) => parseRvTable(raw, 'Secret'),
  },
  {
    tag: 'CLUSTERROLES',
    args: ['get', 'clusterrole', '-o', `jsonpath=${RV_TEMPLATE_CLUSTER}`],
    optional: true,
    parse: (raw) => parseRvTable(raw, 'ClusterRole', false),
  },
  {
    tag: 'CLUSTERROLEBINDINGS',
    args: ['get', 'clusterrolebinding', '-o', `jsonpath=${RV_TEMPLATE_CLUSTER}`],
    optional: true,
    parse: (raw) => parseRvTable(raw, 'ClusterRoleBinding', false),
  },
  {
    tag: 'CRDS',
    args: ['get', 'crd', '-o', `jsonpath=${RV_TEMPLATE_CLUSTER}`],
    optional: true,
    parse: (raw) => parseRvTable(raw, 'CustomResourceDefinition', false),
  },
];

export interface CaptureResult {
  snapshot: Snapshot;
  /** Steps that produced nothing, with the flag fallback already attempted. */
  missing: string[];
  /** Set when attribution is unavailable (kubectl too old for the flag). */
  degraded?: string;
  error?: string;
  durationMs: number;
}

const withFlag = (s: CaptureStep): string[] => (s.managedFields ? [...s.args, '--show-managed-fields=true'] : s.args);

/**
 * Capture one cluster. `source` is 'local' or an inventory VM name.
 *
 * A 16 MB buffer is requested because the workload and node JSON on a large
 * cluster genuinely exceeds the 4 MB `sshRun` default; the compact formats
 * above keep everything else far below it.
 */
export async function captureCluster(source: string): Promise<CaptureResult> {
  const started = Date.now();
  const vm = source === 'local' ? undefined : source;
  const at = new Date().toISOString();

  const first = await runSteps(
    STEPS.map((s) => ({ tag: s.tag, args: withFlag(s), optional: s.optional })),
    vm,
    60000,
    1024 * 1024 * 16
  );

  const out = { ...first.out };
  const ok = new Set(first.ok);
  let degraded: string | undefined;

  // kubectl < 1.21 has no --show-managed-fields. Retry just those steps bare:
  // we lose "who did it", never "what changed".
  const retry = STEPS.filter((s) => s.managedFields && !ok.has(s.tag));
  if (retry.length) {
    const second = await runSteps(
      retry.map((s) => ({ tag: s.tag, args: s.args, optional: true })),
      vm,
      60000,
      1024 * 1024 * 16
    );
    for (const s of retry) {
      if (second.ok.has(s.tag)) {
        out[s.tag] = second.out[s.tag];
        ok.add(s.tag);
        degraded = 'This kubectl does not support --show-managed-fields, so changes cannot be attributed to who made them.';
      }
    }
  }

  const objects: Record<string, Fingerprint> = {};
  const sections: string[] = [];
  const missing: string[] = [];

  for (const step of STEPS) {
    if (!ok.has(step.tag)) {
      missing.push(step.tag);
      continue;
    }
    let fps: Fingerprint[] = [];
    try {
      fps = step.parse(out[step.tag] || '');
    } catch {
      missing.push(step.tag);
      continue;
    }
    // A step that ran but produced nothing parseable is treated as a failed
    // read, not an empty cluster — the diff must not see it as deletions.
    if (!fps.length && (out[step.tag] || '').trim().length < 3) {
      missing.push(step.tag);
      continue;
    }
    sections.push(step.tag);
    for (const fp of fps) objects[objectKey(fp.kind, fp.name, fp.namespace)] = fp;
  }

  return {
    snapshot: { version: 1, source, at, sections, objects },
    missing,
    degraded,
    error: first.error,
    durationMs: Date.now() - started,
  };
}

/** Kinds a capture covers, for the UI's filter list and the status endpoint. */
export const CAPTURED_SECTIONS = STEPS.map((s) => s.tag);
