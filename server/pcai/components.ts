// Component knowledge catalog — the "brain" behind node discovery.
//
// Discovery tells you a pod named `spire-agent-x9k2` is running. This catalog
// turns that into an explanation: what SPIRE is, WHY an agent runs on every
// worker node, and what breaks when it stops. Matching is purely lexical
// (pod name + image + namespace), so it works offline with no LLM call.
//
// Order matters: entries are matched top-down, so put specific components
// (nvidia-dcgm-exporter) above generic ones (prometheus).

export type Category =
  | 'Identity & Security'
  | 'Policy & Governance'
  | 'Kubernetes Core'
  | 'Networking'
  | 'Storage'
  | 'GPU & Accelerators'
  | 'Observability'
  | 'AI / Data Platform'
  | 'Delivery & Ops'
  | 'Data Services';

export interface ComponentInfo {
  id: string;
  title: string;
  category: Category;
  what: string;   // what the component is
  why: string;    // why it is running on THIS node
  impact: string; // what stops working if it goes down
}

interface CatalogEntry extends ComponentInfo {
  match: RegExp; // tested against "<pod name> <image> <namespace>" lowercased
}

const CATALOG: CatalogEntry[] = [
  // ---- Identity & Security -------------------------------------------------
  {
    id: 'spire-agent',
    title: 'SPIRE Agent (SPIFFE workload identity)',
    category: 'Identity & Security',
    match: /spire-agent|spire.*agent/,
    what: 'The node-local half of SPIRE, the reference implementation of SPIFFE. It attests the node to the SPIRE server, then attests each workload that asks for an identity and hands it a short-lived SVID (an X.509 certificate or JWT naming the workload, e.g. spiffe://cluster/ns/ezmeral/sa/query-engine).',
    why: 'It runs as a DaemonSet, so there is one agent on EVERY node including this worker. A workload can only be identified by something running on the same machine as it — the agent inspects the calling process (its PID, cgroup, service account) to prove which pod is asking, then issues that pod its identity over a local Unix socket. That is why you see it here even though you never deployed it yourself: the platform (HPE Ezmeral / PCAI) uses SPIFFE identities instead of static secrets for service-to-service mTLS.',
    impact: 'Existing certificates keep working until they expire (typically ~1 hour), then mTLS handshakes start failing. Newly scheduled pods on this node never get an identity and hang or crash at startup with "failed to fetch SVID" / TLS errors.',
  },
  {
    id: 'spire-server',
    title: 'SPIRE Server (identity authority)',
    category: 'Identity & Security',
    match: /spire-server|spire.*server/,
    what: 'The central authority that signs SVIDs, holds the registration entries (which selectors map to which SPIFFE ID), and acts as the CA for the trust domain.',
    why: 'Normally a StatefulSet on control-plane-ish nodes; seeing it here means this node hosts the identity control plane (or the scheduler placed it here for capacity).',
    impact: 'Agents cannot renew SVIDs cluster-wide. Everything keeps running until certificates expire, then service-to-service mTLS fails cluster-wide — a slow, cluster-wide outage.',
  },
  {
    id: 'spiffe-csi',
    title: 'SPIFFE CSI Driver',
    category: 'Identity & Security',
    match: /spiffe-csi|spiffe.*csi/,
    what: 'A CSI driver that mounts the SPIRE agent socket into workload pods as a volume.',
    why: 'It lets pods reach the SPIRE agent without a hostPath mount (which policy usually forbids). Runs per-node alongside the agent.',
    impact: 'New pods that request the SPIFFE workload API volume fail to mount and stay in ContainerCreating.',
  },
  {
    id: 'cert-manager',
    title: 'cert-manager',
    category: 'Identity & Security',
    match: /cert-manager|certmanager/,
    what: 'Automates issuance and renewal of TLS certificates in Kubernetes from Issuers (internal CA, Vault, ACME/Let\'s Encrypt).',
    why: 'Ingress and webhook endpoints in the stack need TLS certs that rotate automatically.',
    impact: 'Certificates stop renewing. Ingress and admission webhooks break once existing certs expire.',
  },
  {
    id: 'vault',
    title: 'HashiCorp Vault / secrets agent',
    category: 'Identity & Security',
    match: /\bvault\b|vault-agent|vault-injector/,
    what: 'Secret store and dynamic credential broker; the injector sidecar/agent fetches secrets into pods at runtime.',
    why: 'Workloads on this node pull database/API credentials at start instead of storing them in manifests.',
    impact: 'Pods that inject secrets at startup fail to start; leases stop renewing.',
  },
  {
    id: 'keycloak',
    title: 'Keycloak / Dex / OAuth2 Proxy (SSO)',
    category: 'Identity & Security',
    match: /keycloak|\bdex\b|oauth2-proxy|oidc/,
    what: 'Identity provider and OIDC broker for user (human) login to the platform UIs.',
    why: 'The platform console, notebooks and dashboards authenticate users through it.',
    impact: 'Users cannot log in to the UI. Running workloads are unaffected.',
  },
  {
    id: 'falco',
    title: 'Falco / Tetragon (runtime security)',
    category: 'Identity & Security',
    match: /falco|tetragon|sysdig/,
    what: 'Kernel-level runtime threat detection — watches syscalls/eBPF events for suspicious behavior.',
    why: 'DaemonSet: it must run on every node because syscalls happen on the node where the container runs.',
    impact: 'You lose runtime security telemetry from this node. Workloads keep running unmonitored.',
  },

  // ---- Policy & Governance -------------------------------------------------
  {
    id: 'kyverno',
    title: 'Kyverno (policy engine)',
    category: 'Policy & Governance',
    match: /kyverno/,
    what: 'A Kubernetes-native policy engine that runs as an admission webhook. Policies are plain Kubernetes resources (ClusterPolicy) that validate, mutate, or generate other resources — e.g. "reject images not from our registry", "add a securityContext to every pod", "auto-create a NetworkPolicy in each new namespace", "require resource limits".',
    why: 'The API server calls Kyverno on every create/update, so the controllers must be running somewhere in the cluster — the scheduler put one here. Split-out pods have distinct jobs: the *admission controller* answers webhook calls, the *background controller* applies policy to resources that already exist, the *reports controller* produces PolicyReports, and the *cleanup controller* deletes resources matching cleanup policies. In PCAI/Ezmeral it is what enforces the platform guardrails you did not write yourself.',
    impact: 'Depends on the policies\' failurePolicy. With failurePolicy=Fail (the safe default for security policies), the API server cannot reach the webhook and REJECTS creates/updates for matched resources — deployments across the cluster stall with "failed calling webhook". With failurePolicy=Ignore, admission silently proceeds unchecked and non-compliant resources slip in.',
  },
  {
    id: 'gatekeeper',
    title: 'OPA Gatekeeper',
    category: 'Policy & Governance',
    match: /gatekeeper|open-policy-agent|\bopa\b/,
    what: 'The other common policy engine — Rego-based constraints enforced through an admission webhook.',
    why: 'Same role as Kyverno: cluster-wide admission guardrails.',
    impact: 'Constraint enforcement stops, or admission is blocked entirely if failurePolicy=Fail.',
  },
  {
    id: 'policy-reporter',
    title: 'Policy Reporter',
    category: 'Policy & Governance',
    match: /policy-reporter/,
    what: 'Aggregates PolicyReport results from Kyverno/Gatekeeper into a UI and alerts.',
    why: 'Gives the platform a compliance view of policy violations.',
    impact: 'Only reporting/visibility is lost; enforcement continues.',
  },

  // ---- Kubernetes core -----------------------------------------------------
  {
    id: 'kube-proxy',
    title: 'kube-proxy',
    category: 'Kubernetes Core',
    match: /kube-proxy/,
    what: 'Programs iptables/IPVS rules on the node so that traffic to a Service ClusterIP is load-balanced to healthy pod IPs.',
    why: 'DaemonSet on every node — Service routing has to be implemented locally on each machine that sends traffic.',
    impact: 'Service IPs stop resolving to endpoints on this node; new Services never get routes here. Existing connections survive.',
  },
  {
    id: 'coredns',
    title: 'CoreDNS',
    category: 'Kubernetes Core',
    match: /coredns|kube-dns|node-local-dns|nodelocaldns/,
    what: 'Cluster DNS — resolves Service and pod names (my-svc.my-ns.svc.cluster.local). node-local-dns is a per-node cache in front of it.',
    why: 'Almost every workload resolves service names; the cache variant runs per-node to cut latency and DNS load.',
    impact: 'Name resolution fails cluster-wide (or on this node for the local cache) — the most common cause of "connection refused" storms.',
  },
  {
    id: 'metrics-server',
    title: 'metrics-server',
    category: 'Kubernetes Core',
    match: /metrics-server/,
    what: 'Collects CPU/memory from each kubelet and serves the Metrics API.',
    why: 'Backs `kubectl top` and Horizontal Pod Autoscaler decisions.',
    impact: '`kubectl top` and HPA scaling stop working.',
  },
  {
    id: 'kubelet',
    title: 'kubelet (host service)',
    category: 'Kubernetes Core',
    match: /^kubelet$|kubelet\.service/,
    what: 'The node agent: it takes PodSpecs from the API server and makes them real by driving the container runtime, and reports node/pod status back.',
    why: 'This is what makes the machine a Kubernetes node at all. It is a systemd service, not a pod.',
    impact: 'The node goes NotReady after ~40s; the control plane starts evicting its pods after the toleration window (default 5 min).',
  },
  {
    id: 'containerd',
    title: 'containerd / CRI-O (container runtime)',
    category: 'Kubernetes Core',
    match: /^containerd|containerd\.service|cri-o|crio\.service|dockerd|docker\.service/,
    what: 'The runtime that actually pulls images and runs containers, driven by kubelet over the CRI socket.',
    why: 'Every node that runs pods needs a runtime.',
    impact: 'No container can start or restart on this node; the node effectively stops accepting work.',
  },
  {
    id: 'etcd',
    title: 'etcd',
    category: 'Kubernetes Core',
    match: /\betcd\b/,
    what: 'The key-value store holding all cluster state.',
    why: 'Its presence means this node is (or hosts part of) the control plane — unusual for a pure worker.',
    impact: 'Loss of quorum makes the whole cluster read-only or unavailable.',
  },
  {
    id: 'kube-apiserver',
    title: 'Control plane component',
    category: 'Kubernetes Core',
    match: /kube-apiserver|kube-controller-manager|kube-scheduler/,
    what: 'API server / controller-manager / scheduler — the Kubernetes control plane.',
    why: 'Seeing these means the node is a control-plane node, not a plain worker.',
    impact: 'Cluster-wide: no scheduling, no reconciliation, no API access.',
  },

  // ---- Networking ----------------------------------------------------------
  {
    id: 'calico',
    title: 'Calico (CNI)',
    category: 'Networking',
    match: /calico/,
    what: 'The pod network: assigns pod IPs, sets up routes/veth pairs, and enforces NetworkPolicy.',
    why: 'calico-node is a DaemonSet — the data plane must exist on every node that hosts pods.',
    impact: 'New pods on this node get no network (stuck in ContainerCreating) and NetworkPolicy stops being enforced here.',
  },
  {
    id: 'cilium',
    title: 'Cilium (eBPF CNI)',
    category: 'Networking',
    match: /cilium|hubble/,
    what: 'eBPF-based pod networking, load balancing, and network policy; Hubble adds flow observability.',
    why: 'Per-node data plane, same reason as Calico.',
    impact: 'Pod networking and policy enforcement break on this node.',
  },
  {
    id: 'flannel-canal',
    title: 'Flannel / Canal / Weave (CNI)',
    category: 'Networking',
    match: /flannel|canal|weave/,
    what: 'Overlay pod network providing cross-node pod-to-pod connectivity.',
    why: 'Per-node overlay endpoint.',
    impact: 'Cross-node pod traffic fails from this node.',
  },
  {
    id: 'multus',
    title: 'Multus / Whereabouts / SR-IOV',
    category: 'Networking',
    match: /multus|whereabouts|sriov|rdma/,
    what: 'Attaches additional network interfaces to pods (secondary NICs, SR-IOV VFs, RDMA) beyond the single default CNI interface.',
    why: 'AI/HPC workloads need high-throughput secondary networks (e.g. GPUDirect RDMA over Spectrum-X), so these run on GPU worker nodes.',
    impact: 'Pods requesting secondary networks fail to start; high-speed fabric paths are unavailable.',
  },
  {
    id: 'ingress',
    title: 'Ingress controller (NGINX / Traefik / Istio gateway)',
    category: 'Networking',
    match: /ingress-nginx|nginx-ingress|traefik|istio.*gateway|envoy|contour|haproxy-ingress/,
    what: 'Terminates external HTTP(S) traffic and routes it to Services based on Ingress/HTTPRoute rules.',
    why: 'This node is in the path for north-south traffic into the cluster.',
    impact: 'External access to applications routed through this replica fails.',
  },
  {
    id: 'istio',
    title: 'Istio / Linkerd (service mesh)',
    category: 'Networking',
    match: /istiod|istio-|linkerd/,
    what: 'Service mesh control plane; injects sidecar proxies that carry mTLS, retries, and traffic policy between services.',
    why: 'Mesh-enabled namespaces need the control plane reachable to push config to sidecars.',
    impact: 'Sidecars keep last-known config, but new routing/identity config stops propagating.',
  },
  {
    id: 'metallb',
    title: 'MetalLB / kube-vip',
    category: 'Networking',
    match: /metallb|kube-vip|speaker/,
    what: 'Provides LoadBalancer Service IPs on bare metal by announcing them via ARP/BGP.',
    why: 'The speaker is a DaemonSet — the node announcing an IP must be the node receiving that traffic.',
    impact: 'LoadBalancer IPs stop being announced from this node; external VIPs may fail over or go dark.',
  },

  // ---- Storage -------------------------------------------------------------
  {
    id: 'hpe-csi',
    title: 'HPE CSI Driver / GreenLake for File Storage',
    category: 'Storage',
    match: /hpe-csi|hpe.*storage|greenlake.*file|nimble|primera|alletra/,
    what: 'CSI driver connecting Kubernetes PersistentVolumes to HPE arrays / GreenLake File Storage.',
    why: 'The node plugin runs per-node because attaching and mounting a volume happens on the node where the pod lands.',
    impact: 'Pods with PVCs on this node cannot mount storage and stay in ContainerCreating.',
  },
  {
    id: 'csi-generic',
    title: 'CSI driver / node plugin',
    category: 'Storage',
    match: /csi-|csi\.|node-driver-registrar|external-provisioner|external-attacher|nfs-subdir/,
    what: 'Container Storage Interface plugin — provisions, attaches and mounts persistent volumes.',
    why: 'The node component must run wherever volumes are mounted.',
    impact: 'Volume mounts fail on this node; stateful pods cannot start.',
  },
  {
    id: 'longhorn-rook',
    title: 'Longhorn / Rook-Ceph (software-defined storage)',
    category: 'Storage',
    match: /longhorn|rook|ceph|\bosd\b/,
    what: 'Distributed block/file storage built from the nodes\' own disks.',
    why: 'This node contributes local disks to the storage pool, so it runs storage daemons.',
    impact: 'Replicas on this node go degraded; volumes stay available if other replicas survive.',
  },
  {
    id: 'minio',
    title: 'MinIO (S3 object storage)',
    category: 'Storage',
    match: /minio/,
    what: 'S3-compatible object store, commonly used for datasets, model artifacts and MLflow/Kubeflow backends.',
    why: 'AI pipelines on this cluster read training data and write checkpoints/models to it.',
    impact: 'Model/dataset reads and writes fail; training and serving jobs that pull artifacts break.',
  },

  // ---- GPU & Accelerators --------------------------------------------------
  {
    id: 'nvidia-dcgm',
    title: 'NVIDIA DCGM Exporter',
    category: 'GPU & Accelerators',
    match: /dcgm/,
    what: 'Exports GPU telemetry (utilization, memory, temperature, ECC errors, XID faults) in Prometheus format.',
    why: 'GPU metrics can only be read on the machine holding the GPUs, so it is a DaemonSet on GPU nodes — its presence tells you this node has GPUs.',
    impact: 'GPU dashboards and GPU-based autoscaling go blind for this node.',
  },
  {
    id: 'nvidia-device-plugin',
    title: 'NVIDIA Device Plugin',
    category: 'GPU & Accelerators',
    match: /nvidia-device-plugin|device-plugin/,
    what: 'Advertises nvidia.com/gpu as a schedulable resource to the kubelet and wires the right devices into containers that request GPUs.',
    why: 'Without it Kubernetes has no idea this node has GPUs. It must run on the node whose GPUs it advertises.',
    impact: 'GPU capacity disappears from the node; GPU pods stop being scheduled here and existing ones may fail on restart.',
  },
  {
    id: 'gpu-operator',
    title: 'NVIDIA GPU Operator (driver / toolkit / MIG)',
    category: 'GPU & Accelerators',
    match: /gpu-operator|nvidia-driver|container-toolkit|mig-manager|gpu-feature-discovery|nvidia-operator/,
    what: 'Manages the full GPU stack on the node: driver, container toolkit, device plugin, MIG partitioning and feature labels.',
    why: 'It installs and validates the GPU software stack directly on GPU worker nodes.',
    impact: 'GPU driver/toolkit lifecycle stops; a driver mismatch after reboot leaves GPUs unusable.',
  },
  {
    id: 'nfd',
    title: 'Node Feature Discovery',
    category: 'GPU & Accelerators',
    match: /node-feature-discovery|\bnfd-/,
    what: 'Labels nodes with detected hardware features (CPU flags, PCI devices, GPU models, NIC capabilities).',
    why: 'Those labels are how GPU/RDMA workloads get steered to the right nodes.',
    impact: 'Feature labels go stale; hardware-specific scheduling becomes unreliable.',
  },

  // ---- Observability -------------------------------------------------------
  {
    id: 'node-exporter',
    title: 'Prometheus node-exporter',
    category: 'Observability',
    match: /node-exporter/,
    what: 'Exposes host-level metrics (CPU, memory, disk, filesystem, network) from /proc and /sys.',
    why: 'DaemonSet — host metrics must be read on the host itself.',
    impact: 'Node-level dashboards and capacity alerts go blind for this machine.',
  },
  {
    id: 'prometheus',
    title: 'Prometheus / Thanos / VictoriaMetrics',
    category: 'Observability',
    match: /prometheus|thanos|victoria|alertmanager|kube-state-metrics/,
    what: 'Metrics collection, storage and alerting for the cluster.',
    why: 'This node hosts a scraper/store replica (kube-state-metrics translates API objects into metrics).',
    impact: 'Metrics gaps and missed alerts during the outage.',
  },
  {
    id: 'logging',
    title: 'Log shipper (Fluent Bit / Fluentd / Vector / Promtail)',
    category: 'Observability',
    match: /fluent|vector|promtail|filebeat|logstash/,
    what: 'Tails container logs from the node filesystem and ships them to a central store.',
    why: 'DaemonSet — logs are written on the node where the container runs.',
    impact: 'Logs from this node stop reaching the central store (and may be lost when rotated).',
  },
  {
    id: 'log-store',
    title: 'Log/trace store (Loki / OpenSearch / Elastic / Jaeger)',
    category: 'Observability',
    match: /\bloki\b|opensearch|elasticsearch|kibana|jaeger|tempo|grafana/,
    what: 'Central store and UI for logs, traces and dashboards.',
    why: 'A store/query replica landed on this node.',
    impact: 'Log/trace search and dashboards degrade or fail.',
  },
  {
    id: 'otel',
    title: 'OpenTelemetry Collector',
    category: 'Observability',
    match: /opentelemetry|otel|otelcol/,
    what: 'Receives, processes and forwards traces/metrics/logs from instrumented workloads.',
    why: 'Applications on this node export telemetry to a local or nearby collector.',
    impact: 'Telemetry from local workloads is dropped.',
  },

  // ---- AI / Data platform --------------------------------------------------
  {
    id: 'nim',
    title: 'NVIDIA NIM (Inference Microservice)',
    category: 'AI / Data Platform',
    match: /\bnim\b|nim-|nemo|triton|tensorrt/,
    what: 'Prebuilt, GPU-optimized inference microservices from NVIDIA AI Enterprise — a model served behind an OpenAI-compatible or Triton API.',
    why: 'It runs where the GPUs are. Its presence means this node is actively serving model inference.',
    impact: 'Inference requests to this model endpoint fail or fall back to another replica; latency spikes.',
  },
  {
    id: 'ezmeral',
    title: 'HPE Ezmeral / AI Essentials platform service',
    category: 'AI / Data Platform',
    match: /ezmeral|\bezua\b|hpe-|aioli|\bhpecp\b/,
    what: 'HPE\'s platform layer (Ezmeral Unified Analytics / AI Essentials) that provides the console, data fabric connectors, and managed analytics/AI tooling on top of Kubernetes.',
    why: 'This node runs part of the PCAI platform layer itself, not just user workloads.',
    impact: 'The affected platform capability (console, connector, service) degrades for all users.',
  },
  {
    id: 'kserve',
    title: 'KServe / Seldon / Knative (model serving)',
    category: 'AI / Data Platform',
    match: /kserve|seldon|knative|kourier|activator|autoscaler-hpa/,
    what: 'Serverless model-serving layer: scales inference services up and down (including to zero) behind a stable URL.',
    why: 'Inference endpoints hosted on this node.',
    impact: 'Model endpoints stop scaling; scaled-to-zero models cannot cold-start.',
  },
  {
    id: 'kubeflow',
    title: 'Kubeflow / MLflow / notebooks',
    category: 'AI / Data Platform',
    match: /kubeflow|mlflow|katib|notebook|jupyter|pipelines/,
    what: 'ML lifecycle tooling — pipelines, experiment tracking, model registry, and user notebook servers.',
    why: 'Data scientists\' notebooks and pipeline steps are scheduled onto worker nodes like this one.',
    impact: 'Running notebooks/pipeline steps on this node die; experiment tracking writes fail.',
  },
  {
    id: 'compute-engines',
    title: 'Distributed compute (Spark / Ray / Dask / Flink)',
    category: 'AI / Data Platform',
    match: /spark|\bray-|raycluster|dask|flink|trino|presto/,
    what: 'Distributed execution engines for data processing, training and batch inference.',
    why: 'Executors/workers are spread across worker nodes for parallelism — this node is running a share of them.',
    impact: 'In-flight jobs lose executors; frameworks usually retry the lost tasks elsewhere, with a slowdown.',
  },
  {
    id: 'airflow',
    title: 'Airflow / workflow orchestrator',
    category: 'AI / Data Platform',
    match: /airflow|argo-workflow|\bargo-/,
    what: 'Schedules and runs multi-step data/ML workflows as pods.',
    why: 'Task pods are executed on worker nodes; a scheduler/controller replica may also live here.',
    impact: 'In-flight tasks fail and are retried; new workflow runs stall if the scheduler is the affected part.',
  },
  {
    id: 'vectordb',
    title: 'Vector database (Milvus / Weaviate / Qdrant / Chroma / pgvector)',
    category: 'AI / Data Platform',
    match: /milvus|weaviate|qdrant|chroma|pgvector|vector-db/,
    what: 'Stores embeddings and serves similarity search — the retrieval half of a RAG system.',
    why: 'RAG applications on this cluster query it for context before calling a model.',
    impact: 'RAG retrieval fails; assistants answer without context or error out.',
  },

  // ---- Delivery & Ops ------------------------------------------------------
  {
    id: 'gitops',
    title: 'GitOps controller (Argo CD / Flux / Fleet)',
    category: 'Delivery & Ops',
    match: /argocd|argo-cd|\bflux\b|fluxcd|helm-controller|kustomize-controller|\bfleet\b/,
    what: 'Continuously reconciles cluster state against a Git repository — the thing that installs and updates most of what you see here.',
    why: 'A controller replica runs on this node.',
    impact: 'Deployments stop syncing; the cluster drifts from Git but keeps running.',
  },
  {
    id: 'velero',
    title: 'Velero (backup/restore)',
    category: 'Delivery & Ops',
    match: /velero|restic|kopia/,
    what: 'Backs up cluster resources and persistent volumes to object storage.',
    why: 'The node agent snapshots volumes attached to pods on this node.',
    impact: 'Backups for this node\'s volumes silently stop — a risk you only discover at restore time.',
  },
  {
    id: 'autoscaler',
    title: 'Cluster Autoscaler / Descheduler / Karpenter',
    category: 'Delivery & Ops',
    match: /cluster-autoscaler|descheduler|karpenter/,
    what: 'Adds/removes nodes or rebalances pods based on pending workloads and utilization.',
    why: 'A controller replica landed here.',
    impact: 'The cluster stops adding capacity for pending pods and stops rebalancing.',
  },
  {
    id: 'registry',
    title: 'Harbor / container registry',
    category: 'Delivery & Ops',
    // Not a bare /registry/ — every image reference contains a registry host.
    match: /harbor|docker-registry|registry-(server|core|deploy)/,
    what: 'Private container image registry with scanning and signing.',
    why: 'Nodes pull images from it; a replica is hosted here.',
    impact: 'Image pulls fail cluster-wide — new pods and restarts stall on ImagePullBackOff.',
  },
  {
    id: 'scanner',
    title: 'Image scanner (Trivy / Clair)',
    category: 'Delivery & Ops',
    match: /trivy|clair|grype/,
    what: 'Scans container images for known vulnerabilities.',
    why: 'Runs as part of the supply-chain guardrails, often paired with policy enforcement.',
    impact: 'Vulnerability reports go stale; admission policies that require a scan result may block deploys.',
  },

  // ---- Data services -------------------------------------------------------
  {
    id: 'postgres',
    title: 'PostgreSQL / MySQL',
    category: 'Data Services',
    match: /postgres|\bpgsql\b|mysql|mariadb|patroni/,
    what: 'Relational database backing platform services (metadata stores, registries, consoles).',
    why: 'A database replica is scheduled on this node with its PersistentVolume.',
    impact: 'Services that depend on this database fail their writes/reads until failover completes.',
  },
  {
    id: 'redis',
    title: 'Redis / Valkey / Memcached',
    category: 'Data Services',
    match: /redis|valkey|memcached/,
    what: 'In-memory cache, queue and session store.',
    why: 'Latency-sensitive services on this node cache here.',
    impact: 'Cache misses spike; anything using it as a queue or lock loses state.',
  },
  {
    id: 'kafka',
    title: 'Kafka / Zookeeper / Pulsar / NATS',
    category: 'Data Services',
    match: /kafka|zookeeper|pulsar|\bnats\b|rabbitmq/,
    what: 'Message broker for event streams between services.',
    why: 'A broker replica with its log storage lives on this node.',
    impact: 'Partitions led by this broker become unavailable until leadership moves; producers back up.',
  },
];

/** Match a discovered workload to catalog knowledge. `haystack` should be the
 *  pod/container name, image and namespace joined together. */
export function identifyComponent(haystack: string): ComponentInfo | null {
  const h = haystack.toLowerCase();
  for (const e of CATALOG) {
    if (e.match.test(h)) {
      const { match: _m, ...info } = e;
      return info;
    }
  }
  return null;
}

export const CATALOG_SIZE = CATALOG.length;
