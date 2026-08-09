// The change-history model — Kalam's memory of what the cluster used to look like.
//
// WHY THIS EXISTS
//
// Kubernetes is bad at remembering. Events expire after roughly an hour, a
// rolled-back Deployment leaves almost no trace, and a pod that was deleted at
// 3am is simply gone by morning. Everything else Kalam does looks at the
// cluster as it is *right now*; this module is the only part that can answer
// "what changed, when, and who did it".
//
// WHAT WE STORE, AND WHY IT IS SO SMALL
//
// Keeping whole manifests would cost megabytes per capture and still not
// answer the question. Instead each object is reduced to a FINGERPRINT: the
// handful of fields whose change an operator would actually want to hear
// about (image, replicas, selector, taints, ports…), as flat strings. Two
// fingerprints diff into a list of field-level before→after pairs, and only
// those diffs are ever persisted. A capture of a 500-object cluster is tens of
// kilobytes; a quiet hour costs nothing at all, because nothing changed.
//
// THE SECTIONS FIELD IS A CORRECTNESS REQUIREMENT, NOT BOOKKEEPING
//
// Fingerprints arrive per query ("all workloads", "all pods"). If one of those
// queries fails — no Ingress API on this cluster, kubectl too old for a flag,
// a truncated read over SSH — the objects it would have returned are missing
// from the snapshot. Diffing that naively reports every one of them as
// DELETED, which is both alarming and false. So a snapshot records which
// sections actually ran, and the diff only ever considers a section present in
// both sides.

/** Semantic category of a change — what an operator would call it. */
export type ChangeKind =
  | 'created'
  | 'deleted'
  | 'image'        // a container image changed — the classic "what got deployed"
  | 'scaled'       // replica count moved
  | 'spec'         // some other spec edit: env, resources, args, probes, volumes
  | 'config'       // ConfigMap/Secret contents were rewritten
  | 'network'      // Service/Ingress/NetworkPolicy routing changed
  | 'rbac'         // permissions changed
  | 'storage'      // PVC/PV binding or capacity changed
  | 'schedule'     // a pod moved to a different node
  | 'restarted'    // container restart count went up
  | 'lifecycle'    // phase/condition transition worth noticing (Failed, NotReady)
  | 'cordon'       // node made unschedulable, or schedulable again
  | 'taint'
  | 'version';     // kubelet / runtime / image-tagless version bump

export type Severity = 'info' | 'notice' | 'warning';

export interface FieldChange {
  /** Dotted-ish path as it appears in the fingerprint, e.g. "image.main". */
  path: string;
  from?: string;
  to?: string;
}

export interface ChangeEvent {
  /** Stable id — the same observed change never lands in the log twice. */
  id: string;
  /** When Kalam observed it (ISO). See `at` vs `actorAt` below. */
  at: string;
  /**
   * When it really happened, when the cluster was willing to say: an object's
   * own creationTimestamp, or the managedFields time of the writing actor.
   * Absent for updates on clusters that do not track managed fields.
   */
  actualAt?: string;
  /** 'local' or an inventory VM name — one cluster's history per source. */
  source: string;
  kind: ChangeKind;
  severity: Severity;
  /** Kubernetes kind: Deployment, Pod, Node, Service, … */
  objectKind: string;
  name: string;
  namespace?: string;
  /** One line an operator can read without expanding anything. */
  summary: string;
  fields: FieldChange[];
  /** Who wrote it, from managedFields: helm, kubectl-client-side-apply, … */
  actor?: string;
  /** Apply | Update — an Apply is a deliberate declarative change. */
  actorOp?: string;
  /** `kubernetes.io/change-cause`, when whoever did it left a note. */
  cause?: string;
  /** Deployment revision this object was at, when known. */
  revision?: string;
  /** Owning workload key, so pod churn can be folded under its rollout. */
  owner?: string;
  /** Set when this change is a consequence of another in the same capture. */
  causedBy?: string;
}

export interface Fingerprint {
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
  createdAt?: string;
  /**
   * `metadata.generation` / `status.observedGeneration`. Kept OUT of `spec` on
   * purpose: they are corroboration, never a trigger. A generation bump with
   * no field change means the spec was rewritten identically; a controller
   * catching up (observed moving alone) is not a change at all.
   */
  generation?: number;
  observed?: number;
  /** The fields whose change is worth reporting, flattened to strings. */
  spec: Record<string, string>;
  actor?: string;
  actorOp?: string;
  actorAt?: string;
  cause?: string;
  revision?: string;
  owner?: string;
}

export interface Snapshot {
  version: 1;
  source: string;
  /** ISO time the capture completed. */
  at: string;
  /** Query tags that actually returned — see the header note. */
  sections: string[];
  /** key (see objectKey) -> fingerprint */
  objects: Record<string, Fingerprint>;
}

/** Stable identity of an object across captures. */
export function objectKey(kind: string, name: string, namespace?: string): string {
  return namespace ? `${kind}/${namespace}/${name}` : `${kind}/${name}`;
}

export function emptySnapshot(source: string, at = new Date().toISOString()): Snapshot {
  return { version: 1, source, at, sections: [], objects: {} };
}

/** Ranked so the timeline can sort by "how much should I care". */
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, notice: 1, warning: 2 };
