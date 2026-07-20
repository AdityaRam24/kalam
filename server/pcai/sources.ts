// HPE Private Cloud AI (PCAI) knowledge sources.
//
// Two things live here:
//  1) CRAWL_TARGETS  - public HPE doc URLs the ingester will fetch + chunk.
//  2) SEED_KNOWLEDGE - curated, hand-written baseline facts so the assistant is
//     useful immediately (offline / before any crawl). These are grounded in
//     HPE's public documentation and product material.
//
// Re-run ingestion any time to refresh from the live docs ("train yourself").

export interface SeedDoc {
  title: string;
  url: string;
  text: string;
}

// Public, fetchable HPE documentation entry points. The crawler pulls each page
// and, for allowed hosts below, follows same-site links to go deep.
export const CRAWL_TARGETS: string[] = [
  // HPE developer portal (SSR, fetchable)
  'https://developer.hpe.com/platform/hpe-private-cloud-ai/home/',
  // HPE AI Solutions structured docs (static site — deep, high value)
  'https://docs.ai-solutions.ext.hpe.com/products/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/troubleshooting/failed-deployment/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/deployments/add/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/deployments/canary-rollout/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/packaged-models/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/registries/add/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/tokens/tokens-ui/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/admin/set-up/air-gapped/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/admin/object-model-reference/',
  'https://docs.ai-solutions.ext.hpe.com/products/mlis/release-notes/',
  'https://docs.ai-solutions.ext.hpe.com/products/mldm/',
  'https://docs.ai-solutions.ext.hpe.com/products/mldm/latest/debug/pipelines/',
  'https://docs.ai-solutions.ext.hpe.com/products/mldm/latest/debug/common-issues/',
  'https://docs.ai-solutions.ext.hpe.com/products/mldm/latest/debug/view-k8s-events/',
  'https://docs.ai-solutions.ext.hpe.com/products/mldm/latest/set-up/authorization/',
  'https://docs.ai-solutions.ext.hpe.com/products/mldm/latest/set-up/rbac/',
  'https://docs.ai-solutions.ext.hpe.com/products/mldm/latest/get-started/first-time-setup/',
  'https://docs.ai-solutions.ext.hpe.com/products/mldm/release-notes/',
  // MLDE (Determined) documentation
  'https://hpe-mlde.determined.ai/latest/',
  // Pachyderm (upstream engine behind MLDM) — static, deep troubleshooting
  'https://docs.pachyderm.com/products/mldm/latest/debug/common-issues/',
  'https://docs.pachyderm.com/products/mldm/latest/debug/pipelines/',
  'https://docs.pachyderm.com/products/mldm/latest/debug/deployment/',
];

// Hosts the crawler is allowed to follow links within (kept tight on purpose).
export const CRAWL_ALLOWED_HOSTS: string[] = [
  'docs.ai-solutions.ext.hpe.com',
  'hpe-mlde.determined.ai',
  'docs.pachyderm.com',
  'mldm.pachyderm.com',
];

export const SEED_KNOWLEDGE: SeedDoc[] = [
  {
    title: 'HPE Private Cloud AI — Overview',
    url: 'https://www.hpe.com/us/en/private-cloud-ai.html',
    text: `HPE Private Cloud AI (PCAI) is a turnkey, co-engineered solution from HPE and NVIDIA (part of "NVIDIA AI Computing by HPE") that delivers a complete, secure, private AI stack you can stand up in hours instead of months. It bundles compute (NVIDIA GPUs), NVIDIA Spectrum-X Ethernet networking, HPE GreenLake for File Storage, and a curated software stack behind a single control plane.

Core value: a production-ready environment for inference, retrieval-augmented generation (RAG), fine-tuning, and agentic AI, with governed access to enterprise data, built-in security policies, logging, and audit.

Management: PCAI is operated and monitored through the HPE GreenLake cloud platform, which provides a unified console to deploy, monitor, update, and govern AI workloads. Cloud administrators use the GreenLake control plane; data scientists and developers use the HPE AI Essentials software layer.

Software stack combines NVIDIA AI Enterprise (NVAIE) — including NVIDIA Inference Microservices (NIM) — with HPE AI Essentials (built on HPE Ezmeral Unified Analytics; a curated set of open-source and HPE tools). An active HPE service agreement/subscription is required.`,
  },
  {
    title: 'PCAI Architecture — The Layers',
    url: 'https://developer.hpe.com/platform/hpe-private-cloud-ai/home/',
    text: `HPE Private Cloud AI is layered:

1. Hardware / Infrastructure: HPE ProLiant Compute servers with NVIDIA GPUs (NVIDIA L40S, H100 NVL, GH200 NVL2, and newer NVIDIA Blackwell options depending on tier), NVIDIA Spectrum-X Ethernet, and HPE storage (HPE GreenLake for File Storage / data fabric). Delivered as a modular, upgradeable rack; network expansion racks scale the platform to 128 GPUs.

2. Kubernetes platform: All workloads run on Kubernetes. The cluster orchestrates AI services, model servers, and data services as pods/deployments. Most PCAI troubleshooting ultimately involves inspecting Kubernetes pods, events, and node GPU capacity. The NVIDIA GPU Operator installs GPU drivers and configures the NVIDIA container runtime across nodes.

3. Data Lakehouse: A federated, unified data layer (EzPresto / Data Lakehouse Gateway) that gives a single view across heterogeneous storage without moving data — feeding RAG, analytics, and training.

4. HPE AI Essentials: The developer/data-scientist experience — model development (MLDE), data management (MLDM), inference serving (MLIS), the data lakehouse, an Import Framework, and GenAI/RAG features.

5. NVIDIA AI Enterprise (NVAIE) + NIM: Optimized inference microservices and enterprise AI libraries.

6. HPE GreenLake control plane: Single pane of glass for provisioning, monitoring, updates, entitlements, and governance.

The architecture is modular so future NVIDIA/HPE/open-source innovations remain compatible.`,
  },
  {
    title: 'HPE AI Essentials — Components & Included Tools',
    url: 'https://support.hpe.com/hpesc/public/docDisplay?docId=sd00006503en_us',
    text: `HPE AI Essentials is the integrated AI/ML software layer of PCAI, built on HPE Ezmeral Unified Analytics. Key components:

- MLDE (Machine Learning Development Environment): all-in-one deep-learning training platform based on Determined AI. Distributed training, hyperparameter search, experiment tracking, GPU scheduling. Docs: hpe-mlde.determined.ai.
- MLDM (Machine Learning Data Management): data pipelines / data versioning based on Pachyderm. Data lineage, versioned data repos, pipeline-driven processing. MLDM + MLDE can run in a combined cluster.
- MLIS (Machine Learning Inference Software/Service): scalable model deployment and serving (backed by Kubernetes/KServe). Most "failed deployment" errors originate here.
- Data Lakehouse / EzPresto / Data Lakehouse Gateway + Import Framework: federate and govern enterprise data for analytics, RAG, and training; import third-party AI apps/frameworks.
- GenAI / Knowledge Base features: build RAG assistants over your own documents.

Curated open-source tools bundled via Ezmeral Unified Analytics (evergreen, enterprise-supported): Apache Spark, Apache Airflow, Apache Superset, Kubeflow, MLflow, Feast (feature store), Presto SQL (EzPresto), and Ray, plus Jupyter notebooks.

AI Essentials versions referenced in docs include 1.5.2, 1.8.x, 1.9.x, 1.10.x, 1.11.x, and 1.12.x (with air-gapped editions). PCAI platform versions include 1.4, 1.7, and 2026.04.0.`,
  },
  {
    title: 'MLIS Troubleshooting — Failed Deployment',
    url: 'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/troubleshooting/failed-deployment/',
    text: `When an MLIS inference deployment fails to start serving, the most common root causes are:

1) Insufficient disk size for the model. Large models (multi-billion-parameter LLMs) need enough ephemeral/persistent storage to download and load weights. If disk is too small, the inference service fails to start serving. Fix: increase the disk/storage size in the deployment/packaged-model config and redeploy.

2) Requesting GPUs on a cluster/node without available GPUs. If the deployment requests GPU resources but no GPU-equipped node has free GPU capacity, the pod stays Pending / the deployment fails. Fix: verify GPU nodes exist and have free GPUs (kubectl describe node — check nvidia.com/gpu allocatable vs allocated), lower the GPU request, or check nodeSelectors/taints/tolerations.

3) Insufficient memory request on the packaged model. If memory request/limit is too low, the model process is OOM-killed or won't schedule. Fix: resubmit/redeploy the packaged model with a higher memory request.

General debugging flow for a failed MLIS deployment:
- kubectl get pods -n <namespace> — look for Pending, CrashLoopBackOff, ImagePullBackOff, or OOMKilled.
- kubectl describe pod <pod> — read Events (scheduling failures, insufficient cpu/memory/gpu, volume issues).
- kubectl logs <pod> [-c <container>] — read the model-server error.
- Confirm the model artifact/registry is reachable and credentials/secrets are valid.`,
  },
  {
    title: 'MLIS — Deployments, Packaged Models, Registries, Tokens, Autoscaling',
    url: 'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/deployments/add/',
    text: `MLIS serves models via two core objects:
- Packaged Model: what to serve. Can reference an external source (S3 bucket or huggingface.co); to reach those you must first configure a Registry (with credentials/token) for that source.
- Deployment: when/how it runs. Specifies which Packaged Model to deploy and the scaling limits (minReplicas / maxReplicas), the scaling metric, and the target value.

CLI (aioli): create a deployment with
  aioli deployment create <name> --model <packaged-model> --namespace <ns> \
    --authentication-required --auto-scaling-min-replicas N --auto-scaling-max-replicas M \
    --auto-scaling-metric <metric> --auto-scaling-target <value>

Autoscaling:
- KPA autoscaler (default) supports "concurrency" and "rps" metrics.
- HPA autoscaler supports the "cpu" metric.

Endpoint security & tokens: if endpoint security is enabled, every request needs a deployment token in the header: "Authorization: Bearer <YOUR_ACCESS_TOKEN>". Create/manage deployment tokens in the UI or via CLI (token create). A 401/403 on the endpoint usually means a missing/expired/incorrect deployment token or the wrong namespace.

Canary rollout: MLIS supports canary rollouts to shift a percentage of traffic to a new model version before full promotion.

Common endpoint issues: model still loading (readiness probe not yet passing — wait / raise probe timeout), wrong endpoint URL/namespace, missing token, or the packaged model's registry credentials being invalid.`,
  },
  {
    title: 'MLDM (Pachyderm) — Pipeline & Deployment Troubleshooting',
    url: 'https://docs.ai-solutions.ext.hpe.com/products/mldm/latest/debug/common-issues/',
    text: `MLDM data pipelines run as Kubernetes pods. Most common system-level failures:
- Malformed or missing credentials preventing connection to object storage, the registry, or external services.
- OOMKilled or other resource-constraint issues (pods can't schedule on available cluster resources).
- Network issues connecting to pachd, etcd, or other internal/external resources; or failure to find/pull a docker image from the registry.

Diagnostic signs: a job stuck in a state (starting, merging) or a pod in CrashLoopBackoff indicates a system-level failure.

Get deeper logs:
  pachctl logs --pipeline=<pipeline_name> --raw
  pachctl logs --master
  kubectl logs <pod_name>
  kubectl get events   (or use the MLDM "View Kubernetes Events" page)

Specific fixes:
- Pods evicted due to disk pressure: nodes' root volume is too small. Each node's root volume must hold the biggest datum you expect to process anywhere in the DAG plus the output files for that datum. Increase node root volume size.
- OOM: increase the pipeline's memory request/limit, or use a larger node.
- File uploads failing with connection errors: pachd or worker sidecars OOM-killed while fetching data from object storage — increase the pipeline spec's cache_size (default 64M).`,
  },
  {
    title: 'MLDE (Determined) — Experiment & GPU Troubleshooting',
    url: 'https://hpe-mlde.determined.ai/latest/',
    text: `MLDE is HPE's Determined-based training platform. Common training failures and fixes:

- CUDA out of memory (cudaErrorMemoryAllocation): the GPU can't allocate requested memory. Causes: batch too large, memory fragmentation, or other processes holding GPU memory. Fixes: reduce global/per-slot batch size (memory scales ~linearly with batch size); set PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb=512 to reduce fragmentation; inspect with torch.cuda.memory_stats().

- Experiment stuck in "Queued"/"Pending": not enough free GPU slots in the resource pool. Check the cluster/resource-pool GPU availability and other running experiments; lower slots_per_trial or free resources.

- Multi-node/distributed training failures: environment variables not propagated to all nodes, so workers can't find Python paths, CUDA toolkit, or custom libraries. Ensure the container image and env are consistent across nodes.

- Experiment errored immediately: usually a code/config error in the model definition or a bad checkpoint/dataset path — read the trial logs in the MLDE UI (or determined CLI: det experiment logs <id>).

MLDE handles GPU scheduling; if trials won't schedule, the root cause is almost always GPU capacity or a resource-pool/priority configuration.`,
  },
  {
    title: 'PCAI — Installation & GreenLake Onboarding',
    url: 'https://developer.hpe.com/platform/hpe-private-cloud-ai/home/',
    text: `Bringing up HPE Private Cloud AI (high level). Prerequisite: an active HPE service agreement, and access to HPE GreenLake (common.cloud.hpe.com) with the PCAI service subscribed.

The PCAI setup wizard walks through:
1. Infrastructure configuration: management network, iLO network, and data network info; discovery of control-plane nodes; vCenter, ESXi, and iLO credentials.
2. Control plane VM setup: control-plane VM networking and credentials.
3. Worker node discovery: discover management servers via iLO + data network.
4. Platform configuration: platform ingress IP, and integration with HPE GreenLake for File Storage.
5. Verification & access: confirm setup completed, then open the GreenLake AI portal (AI Essentials) to deploy AI solutions and grant access to data scientists/developers.

If onboarding stalls: verify iLO/network reachability and credentials, DNS resolution for the ingress hostname, NTP/time sync, and that the GreenLake device/subscription is properly claimed/entitled. Device onboarding issues usually trace to network/credential/entitlement problems.`,
  },
  {
    title: 'PCAI — Air-Gapped Deployment',
    url: 'https://docs.ai-solutions.ext.hpe.com/products/mlis/latest/admin/set-up/air-gapped/',
    text: `Running PCAI / HPE AI Essentials air-gapped (no internet) requires mirroring everything locally:
- A local Docker/container registry hosting mirrors of all required images.
- A local Python package registry hosting all required Python packages (including those MLIS and its dependencies need).
- An S3-compliant object store for models and dependencies (e.g., MinIO, Ceph, or OpenIO).
- For Hugging Face models: build a self-contained container that includes the model, then host that container in the local registry.

Important limitation: NGC/NIM is NOT supported in air-gapped environments, because NIM requires validation against the NVIDIA NGC registry.

Air-gapped AI Essentials editions exist for versions such as 1.7, 1.10, 1.11, and 1.12. Typical air-gapped errors are ImagePullBackOff (image not mirrored), pip/conda failures (package not in the local Python registry), or model-load failures (model not present in the local S3 store) — the fix is always to add the missing artifact to the corresponding local mirror.`,
  },
  {
    title: 'PCAI — Data Lakehouse, EzPresto & External S3',
    url: 'https://support.hpe.com/hpesc/public/docDisplay?docId=a00aie19hen_us&page=ManageClusters/connect-object-stores.html',
    text: `PCAI's federated Data Lakehouse (EzPresto / Data Lakehouse Gateway) gives a single, unified SQL view across heterogeneous storage so you can train/fine-tune without moving data.

Connecting data:
- Administrators connect external data sources, including external S3-compliant object stores (via the S3 Proxy Layer). You provide the endpoint, bucket, and access/secret keys.
- Spark applications can be configured to access data in an external S3 data source through the S3 Proxy Layer.
- Supported model/artifact stores include external or internal object stores such as MinIO.

The Import Framework is an open, extensible mechanism to integrate any AI application, framework, or third-party tool into PCAI. Imported components are then managed through PCAI's unified lifecycle (consistent deployment, monitoring, and governance).

Common data-connection errors: wrong S3 endpoint/region, invalid access/secret keys, TLS/cert issues to the object store, or network/firewall blocking the endpoint. Verify credentials and endpoint reachability first, then check the connector/gateway logs.`,
  },
  {
    title: 'PCAI — Identity, Access & RBAC (Keycloak)',
    url: 'https://docs.ai-solutions.ext.hpe.com/products/mldm/latest/set-up/authorization/',
    text: `HPE AI Essentials uses Keycloak for Identity and Access Management (IAM): SSO, user roles, access controls, authentication tokens, user isolation, and GPU resource governance.

- LDAP/AD federation: Keycloak verifies credentials against your organization's AD/LDAP without storing passwords locally (User Federation). Configure the LDAP connection in the Keycloak realm.
- SSO + tokens: users authenticate once to Keycloak; applications receive JWTs whose claims describe the identity, attributes, and a "groups" claim listing group memberships.
- RBAC/ABAC: Keycloak manages roles, permissions, and groups for fine-grained access. MLDM additionally supports its own authorization roles plus Kubernetes RBAC.

Common auth issues: login fails → check the Keycloak LDAP/AD federation config and that the user is in the right group; API/endpoint 401/403 → expired or missing token, or the user's group lacks the required role; new users can't see resources → group-to-role mapping or namespace/project membership not set.`,
  },
  {
    title: 'PCAI — Ingress, TLS Certificates & DNS',
    url: 'https://support.hpe.com/hpesc/public/docDisplay?docId=sd00007194en_us&page=GUID-65D1AF49-270B-4C1C-A171-868B6CD5AA42.html',
    text: `PCAI exposes services through a Kubernetes ingress gateway with TLS. The platform documents an "Ingress Gateway SSL Certificate" procedure and AI Essentials "SSL Certificates" (update-cert) steps for installing your own CA-signed certificate. Under the hood this typically uses an ingress controller (e.g., Nginx/Istio), cert-manager for certificate lifecycle, and MetalLB or an external load balancer for the ingress IP.

Common ingress/TLS/DNS problems and fixes:
- Browser shows a "fake"/default certificate: the hostname in the ingress rules doesn't match the certificate CN/SAN. Ensure spec.rules host == spec.tls host == the cert's CN/SAN.
- Certificate expired or untrusted: replace it via the platform's ingress/SSL-certificate update procedure; make sure clients trust your CA.
- Service unreachable by hostname: DNS doesn't resolve the ingress hostname to the ingress/LoadBalancer IP — fix DNS or /etc/hosts; confirm the ingress IP is assigned.
- 404/502/503 from ingress: backend Service/pod not ready, wrong service name/port in the ingress, or the ingress controller pod is unhealthy (kubectl get pods -n ingress-... ; kubectl describe ingress).`,
  },
  {
    title: 'PCAI — Common Kubernetes Error Patterns',
    url: 'https://support.hpe.com/hpesc/public/docDisplay?docId=sd00007592en_us',
    text: `Because PCAI runs on Kubernetes, most operational errors surface as pod states. Quick reference:

- Pending: no node can satisfy the pod — insufficient CPU/memory or no free GPU (nvidia.com/gpu), or an unsatisfiable nodeSelector/taint. Check "kubectl describe pod" Events and node allocatable GPUs.
- ImagePullBackOff / ErrImagePull: image name wrong, private-registry auth missing, or (air-gapped) image not mirrored into the local registry. Verify imagePullSecrets and that the image exists internally.
- CrashLoopBackOff: container starts then exits. Read "kubectl logs --previous". Causes: bad config/env, missing model files, license/entitlement not applied, GPU driver mismatch.
- OOMKilled (exit 137): memory limit too low for the model — raise memory request/limit.
- 0/1 Ready / readiness probe failing: service booted but health check fails — often still loading a large model (increase probe initialDelay/timeout) or a dependency (data service, vector DB) is down.
- GPU "unable to find GPU" / CUDA errors: NVIDIA GPU Operator / device plugin unhealthy, or driver/toolkit version mismatch. Check the nvidia-device-plugin and gpu-operator pods.
- Evicted / DiskPressure: node disk full — clean up or grow the node root volume.

Always correlate with GreenLake alerts and the AI Essentials UI for the specific service.`,
  },
  {
    title: 'PCAI — Access, Console, and Day-2 Operations',
    url: 'https://support.hpe.com/hpesc/public/docDisplay?docId=sd00005025en_us',
    text: `Accessing PCAI:
- Cloud administrators manage the system through HPE GreenLake (provisioning, monitoring, software updates, entitlements/licenses, user & access management, health/alerts).
- Data scientists and app developers work in the HPE AI Essentials web UI (launch notebooks, train with MLDE, manage data with MLDM, deploy models with MLIS, connect data via the lakehouse, and build GenAI/RAG apps).

Common day-2 tasks:
- Add/entitle users and assign roles (RBAC) via GreenLake identity + Keycloak.
- Apply software/firmware updates pushed through GreenLake.
- Monitor GPU utilization, node health, and workload status.
- Manage entitlements/licenses — an unapplied or expired entitlement can cause services to refuse to start.

If a whole service is down, check in order: (1) GreenLake system health/alerts, (2) Kubernetes node readiness, (3) the specific AI Essentials service pods, (4) entitlement/license status.`,
  },
  {
    title: 'PCAI — Backup, Data Protection & Upgrades',
    url: 'https://support.hpe.com/connect/s/product?language=en_US&kmpmoid=1014847366&tab=manuals',
    text: `Platform lifecycle and data protection for HPE Private Cloud (incl. PCAI):
- Software/firmware updates are delivered and applied through HPE GreenLake; always follow the version-specific Administration Guide for the upgrade sequence and pre-checks.
- Data protection integrations: HPE StoreOnce, HPE Zerto (continuous data protection and live workload migration from VMware), and Veeam Data Platform (agentless, host-level, image-based backup with changed-block tracking and cross-platform recovery).
- HPE Morpheus provides a unified cloud operating model / upgrade path for private cloud management; unified management of VMs and containers on HPE Private Cloud is on the roadmap (GA targeted Q3 2026).

Before upgrading: check current version and target version compatibility, back up critical data (models, pipeline repos, configs), verify entitlements, and schedule a maintenance window. After upgrading: verify node readiness, GPU operator health, and that each AI Essentials service (MLDE/MLDM/MLIS/lakehouse) comes back healthy.`,
  },
  {
    title: 'PCAI — Sizing Tiers & GPU Options',
    url: 'https://www.hpe.com/us/en/collaterals/collateral.a50009216enw.html',
    text: `HPE Private Cloud AI ships in sizing tiers (described in HPE QuickSpecs, commonly Small / Medium / Large / Extra Large) that differ by GPU compute, CPU, memory, and storage. Smaller tiers target inference/RAG and departmental use; larger tiers target heavy fine-tuning/training and many concurrent workloads.

GPU options vary by tier and generation — for example NVIDIA L40S on smaller configurations, NVIDIA H100 NVL and GH200 NVL2 on larger ones, with NVIDIA Blackwell-based options on newer configurations. Networking uses NVIDIA Spectrum-X Ethernet; network expansion racks allow scaling toward 128 GPUs.

For the precise CPU/GPU/RAM/storage bill of materials for a specific order, consult the current HPE PCAI QuickSpecs document (the numbers change across releases, so treat any specific figure as version-dependent and verify against the QuickSpecs for your order).`,
  },
];
