// Labels and annotations that are not decoration.
//
// Most metadata is notes. These keys are CONTRACTS: another component reads
// them and changes behaviour — a Service routes by a label, cert-manager issues
// a certificate because of an annotation, Istio injects a sidecar because of a
// namespace label, KServe picks its deployment mode from one. Get one wrong and
// something fails somewhere else, with an error that rarely names the key.
//
// This table is what lets Trinetra say "this is failing BECAUSE of that label",
// and lets Change History say what a metadata edit actually broke. It is the
// single source for the why-engine (why.ts), the history impact notes
// (history/impact.ts) and the UI.

export interface KeyMeaning {
  /** Who reads this key. */
  readBy: string;
  /** What it does, in one sentence. */
  meaning: string;
  /** What breaks when it is missing or wrong. */
  ifWrong: string;
}

/** Exact keys. */
const EXACT: Record<string, KeyMeaning> = {
  // Routing / identity
  app: {
    readBy: 'Services, NetworkPolicies, PodDisruptionBudgets (by selector)',
    meaning: 'The conventional label selectors match on to find these pods.',
    ifWrong: 'A Service selecting the old value stops sending traffic to these pods; a NetworkPolicy may stop (or start) applying to them.',
  },
  'app.kubernetes.io/name': {
    readBy: 'Services, NetworkPolicies, monitoring (by selector)',
    meaning: 'Recommended application-name label; frequently part of Service and workload selectors.',
    ifWrong: 'Selectors using it no longer match — traffic, policies and dashboards lose these pods.',
  },
  'app.kubernetes.io/instance': {
    readBy: 'Helm-built selectors',
    meaning: 'Release instance label Helm charts put in their selectors.',
    ifWrong: 'The chart’s own Service and workload selectors stop matching these pods.',
  },
  // cert-manager
  'cert-manager.io/cluster-issuer': {
    readBy: 'cert-manager (ingress-shim)',
    meaning: 'Asks cert-manager to issue the Ingress TLS certificate from this ClusterIssuer.',
    ifWrong: 'If the ClusterIssuer does not exist or is not Ready, the certificate is never issued and HTTPS fails.',
  },
  'cert-manager.io/issuer': {
    readBy: 'cert-manager (ingress-shim)',
    meaning: 'Asks cert-manager to issue the Ingress TLS certificate from this namespaced Issuer.',
    ifWrong: 'If the Issuer is missing from this namespace or not Ready, the certificate is never issued.',
  },
  'cert-manager.io/issuer-kind': {
    readBy: 'cert-manager (ingress-shim)',
    meaning: 'Kind of the issuer named by cert-manager.io/issuer.',
    ifWrong: 'A wrong kind makes cert-manager look for an issuer that is not there.',
  },
  // Ingress
  'kubernetes.io/ingress.class': {
    readBy: 'Ingress controllers',
    meaning: 'Legacy way to choose which ingress controller serves this Ingress.',
    ifWrong: 'No controller picks the Ingress up — it gets no address and serves nothing.',
  },
  // Istio
  'istio-injection': {
    readBy: 'Istio sidecar injector (namespace label)',
    meaning: 'enabled = every new pod in the namespace gets an Envoy sidecar.',
    ifWrong: 'Without the sidecar, mesh routing, mTLS and gateway traffic to these pods fail (PCAI apps and KServe Serverless rely on it).',
  },
  'istio.io/rev': {
    readBy: 'Istio revision-based injection (namespace label)',
    meaning: 'Selects which Istio control-plane revision injects sidecars.',
    ifWrong: 'A revision that does not exist means no sidecar is injected.',
  },
  'sidecar.istio.io/inject': {
    readBy: 'Istio sidecar injector (pod annotation/label)',
    meaning: 'Per-pod override: "false" skips the sidecar even in an injected namespace.',
    ifWrong: '"false" on a pod that must be in the mesh cuts it off from mesh traffic.',
  },
  // KServe / Knative
  'serving.kserve.io/deploymentMode': {
    readBy: 'KServe controller',
    meaning: 'Serverless (Knative), RawDeployment (plain Deployment) or ModelMesh.',
    ifWrong: 'An unknown value, or Serverless on a cluster without Knative, means the model is never deployed.',
  },
  'serving.kserve.io/inferenceservice': {
    readBy: 'KServe (set on predictor pods)',
    meaning: 'Ties predictor/transformer pods to their InferenceService.',
    ifWrong: 'Hand-editing it detaches the pods from the InferenceService’s Services and status.',
  },
  'serving.kserve.io/autoscalerClass': {
    readBy: 'KServe controller',
    meaning: 'Which autoscaler drives the predictor (hpa, keda, external).',
    ifWrong: 'An autoscaler that is not installed leaves the predictor unscaled.',
  },
  // Workload control
  'kubectl.kubernetes.io/restartedAt': {
    readBy: 'Deployment/StatefulSet controller',
    meaning: 'Set by `kubectl rollout restart`; changing it rolls every pod.',
    ifWrong: 'Not a failure in itself — but it explains why all pods were just replaced.',
  },
  'kubernetes.io/change-cause': {
    readBy: 'kubectl rollout history',
    meaning: 'Human note attached to a rollout revision.',
    ifWrong: 'Informational only.',
  },
  // Storage
  'storageclass.kubernetes.io/is-default-class': {
    readBy: 'PVC admission',
    meaning: 'Marks the StorageClass used when a PVC names none.',
    ifWrong: 'With no default (or two), PVCs without a storageClassName stay Pending.',
  },
  'volume.kubernetes.io/selected-node': {
    readBy: 'Volume scheduler',
    meaning: 'Node a WaitForFirstConsumer volume was provisioned for.',
    ifWrong: 'If that node is gone, the PVC cannot be used anywhere else.',
  },
  // Helm
  'helm.sh/resource-policy': {
    readBy: 'Helm',
    meaning: '"keep" stops `helm uninstall` from deleting this object.',
    ifWrong: 'Removing it means the next uninstall deletes the object (and its data).',
  },
  'meta.helm.sh/release-name': {
    readBy: 'Helm',
    meaning: 'Which Helm release owns this object.',
    ifWrong: 'A mismatch makes the next `helm upgrade` refuse to adopt the object.',
  },
  'meta.helm.sh/release-namespace': {
    readBy: 'Helm',
    meaning: 'Namespace of the owning Helm release.',
    ifWrong: 'A mismatch makes the next `helm upgrade` refuse to adopt the object.',
  },
  // Monitoring
  'prometheus.io/scrape': {
    readBy: 'Prometheus (annotation-based discovery)',
    meaning: 'Opts the pod/service into scraping.',
    ifWrong: 'Metrics and alerts for this workload go silent.',
  },
};

/** Prefix families. */
const PREFIX: Array<[string, KeyMeaning]> = [
  ['pod-security.kubernetes.io/', {
    readBy: 'Pod Security Admission (namespace label)',
    meaning: 'Which pod security level the namespace enforces, audits or warns about.',
    ifWrong: 'Tightening it rejects new pods that were allowed before (privileged, hostPath, root…).',
  }],
  ['node-role.kubernetes.io/', {
    readBy: 'Schedulers, selectors and tolerations',
    meaning: 'Node role (control-plane, worker, gpu…).',
    ifWrong: 'Workloads that select or avoid this role land somewhere else, or nowhere.',
  }],
  ['nvidia.com/', {
    readBy: 'NVIDIA GPU operator / scheduling selectors',
    meaning: 'GPU presence, product and MIG configuration of a node.',
    ifWrong: 'GPU workloads selecting these labels cannot be scheduled on the node.',
  }],
  ['nginx.ingress.kubernetes.io/', {
    readBy: 'ingress-nginx',
    meaning: 'Per-Ingress behaviour of the NGINX controller (rewrites, auth, TLS, timeouts).',
    ifWrong: 'Requests are rewritten, rejected or time out differently.',
  }],
  ['autoscaling.knative.dev/', {
    readBy: 'Knative autoscaler',
    meaning: 'Scale bounds and targets for Serverless revisions (KServe Serverless).',
    ifWrong: 'min-scale 0 means cold starts; wrong targets mean over/under-scaling.',
  }],
  ['traffic.sidecar.istio.io/', {
    readBy: 'Istio sidecar',
    meaning: 'Which ports/CIDRs the sidecar intercepts.',
    ifWrong: 'Traffic bypasses or is blackholed by the sidecar.',
  }],
];

/** What a label/annotation key does, when it is one that matters. */
export function meaningOf(key: string): KeyMeaning | undefined {
  if (EXACT[key]) return EXACT[key];
  for (const [p, m] of PREFIX) if (key.startsWith(p)) return m;
  return undefined;
}

/**
 * Annotations that change on their own or duplicate tracked fields. They are
 * never reported as changes: they would bury the ones that matter.
 */
const NOISY_ANNOTATIONS = [
  /^kubectl\.kubernetes\.io\/last-applied-configuration$/,
  /^deployment\.kubernetes\.io\/(revision|desired-replicas|max-replicas)$/,
  /^control-plane\.alpha\.kubernetes\.io\/leader$/,
  /^autoscaling\.alpha\.kubernetes\.io\//,
  /^node\.alpha\.kubernetes\.io\/ttl$/,
  /^volumes\.kubernetes\.io\/controller-managed-attach-detach$/,
  /^projectcalico\.org\//,
  /^flannel\.alpha\.coreos\.com\//,
  /^csi\.volume\.kubernetes\.io\/nodeid$/,
  /^kubeadm\.alpha\.kubernetes\.io\//,
  /^endpoints\.kubernetes\.io\/last-change-trigger-time$/,
  /^cluster-autoscaler\.kubernetes\.io\/scale-down-disabled$/,
  /^kubernetes\.io\/change-cause$/,        // tracked separately as `cause`
  /^cert-manager\.io\/(certificate-revision|private-key-secret-name)$/,
  /^serving\.knative\.dev\/(creator|lastModifier|routingStateModified)$/,
];

/** Controller bookkeeping, whatever the vendor: heartbeats, sync stamps, leases. */
const BOOKKEEPING = /(heartbeat|last-?(seen|update|updated|sync|synced|handled|reconciled?|observed|transition)|observed-?generation|leader|renew-?time)/i;

export function isNoisyAnnotation(key: string): boolean {
  return NOISY_ANNOTATIONS.some((r) => r.test(key)) || BOOKKEEPING.test(key);
}

/** Labels that carry no meaning and change constantly. */
export function isNoisyLabel(key: string): boolean {
  return key === 'nvidia.com/gfd.timestamp' || key === 'pod-template-hash' || key === 'controller-revision-hash' || key === 'pod-template-generation'
    || key === 'statefulset.kubernetes.io/pod-name' || key === 'batch.kubernetes.io/controller-uid' || key === 'controller-uid';
}
