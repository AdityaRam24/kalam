# Plan — VME Manager integration, /etc/kubernetes insights, next improvements

Status (2026-10-07): §0, §2 and §3 are built. §1 (VME) is on hold, waiting for your input.
Where things live: §2 → Kubernetes → **Node Config**, `server/k8s/nodeconfig.ts`; §3.1–3.3 → GPU page,
`server/k8s/dcgm.ts` + `gpuhistory.ts`; §3.6 fixed in `server/ssh.ts`; §3.7 lazy-loaded topology/resources;
§3.8 notebook sections 9.6 / 9.7 and two new console tabs. The dashboard also gained a Containers selector
(show all / hide Kubernetes pod containers / hide all). Not done: §2's "manifest hashes into the
History timeline" (recent edits show as Node Config findings instead) and §3.4 (other callers opting into
parallel remote batches).
Every item follows Trinetra's existing rules: **read-only**, fixed allow-listed
commands (never free-form), works both locally and over SSH (`runSteps`,
`sshRun`, jump hosts via `via`), and degrades instead of failing when a source
is missing.

---

## 0. Done: GPU Utilization showed old pods, not new ones

The causes, and what changed:

| Cause | Effect | Fix |
|---|---|---|
| Probe list was `workloads.filter(Running).slice(0, 24)` in kubectl's namespace/name order | A newly deployed model in a later-sorting namespace was never probed ("Not probed in this refresh") | Probe **newest first** (`probeTargets`, `byNewest` in `server/k8s/gpu.ts`); default cap 64 |
| Remote probes ran all `kubectl exec`s **one after another** in one SSH call; on timeout the tail was cut off | The pods at the end of the list, often the new ones, came back empty | `buildRemoteScript` in `server/k8s/kubectl.ts` runs them in parallel batches (`TRINETRA_GPU_PARALLEL`, default 8), each killed after 20 s, and prints each batch as soon as it finishes |
| Terminating pods (old ReplicaSet during a rollout) still looked `Running` and were exec'd into | Old pod shown as live; exec could hang the batch | `terminating` flag; not probed; badge in UI |
| Finished (`Succeeded`/`Failed`) pods listed with live ones | Old jobs crowded out current models | Hidden behind "Show N finished" |
| UI had no request sequencing; auto-refresh stacked requests | A slow older response could overwrite a newer one | Per-load ticket, stale responses dropped, background refresh skipped while one is in flight, `cache: 'no-store'` |

The UI now also shows "started 3m ago" and a **new** badge for workloads that appeared since the last refresh.
Tests: `server/__tests__/gpu.test.ts`.

---

## 1. VME (HPE Morpheus VM Essentials) Manager integration

### 1.1 Why
Today Trinetra sees VME hosts only through SSH (metrics, journal, Node Brain).
The VME Manager already knows things SSH can't show cheaply or at all:
which VMs exist on which host and cluster, their power state, placement, datastores,
networks, alarms, and the activity/audit trail. It's one API call
instead of N SSH sessions.

### 1.2 Source: the Morpheus REST API on the VME Manager
- Auth: Bearer token. Either an API token from *User Settings → API Access*, or
  `POST /oauth/token?client_id=morph-api&grant_type=password&scope=write` with
  a **read-only role** user. Store it like VM credentials today (encrypted at
  rest, never returned by `publicVm`-style serializers).
- The reference spec is the public OpenAPI (github.com/HewlettPackard/morpheus-openapi,
  apidocs.morpheusdata.com). **Pin the endpoint list against the VME version
  actually deployed** before building, because VME exposes a subset of full Morpheus.

Candidate read-only endpoints (GET only; to verify on your VME):

| Endpoint | Gives us |
|---|---|
| `/api/whoami`, `/api/license`, `/api/appliance-settings` | Connectivity check, version, licensed sockets |
| `/api/clusters` | HVM/KVM clusters, hosts per cluster, status |
| `/api/servers` and `/api/servers/:id` | Hypervisor hosts **and** VMs, with `stats` (cpuUsage, usedMemory/maxMemory, usedStorage/maxStorage), power state, parent host |
| `/api/instances` | Logical VMs: owner, plan, IPs, status, which server(s) back them |
| `/api/clouds` + datastores / networks endpoints | Storage pools, capacity, networks/VLANs |
| `/api/health`, `/api/health/alarms`, `/api/health/logs` | Manager's own health, and active alarms |
| `/api/activity` | Who did what, and when (create/delete/migrate/power) |

### 1.3 How it fits Trinetra
- **New source type** `vme-manager` beside VMs in the inventory: `{ name, url, token, verifyTls }`.
  Server module `server/vme/` with a `vmeGet(path, query)` that allows only GET
  and only paths on a fixed allow-list, the same pattern as `RAW_MODES` in `gpu.ts`.
- **Pagination + caching**: `max`/`offset` paging; cache responses for ~30 s so the
  topology, metrics and Why pages share one fetch.
- **Join keys** (the real value):
  - VME host ↔ inventory VM: by hostname / IP (`/api/servers` `externalIp`, `internalIp`, `hostname`).
  - VME VM ↔ Kubernetes node: the PCAI/K8s nodes *are* VMs on VME, so match
    `node.status.addresses` to the instance IPs. That gives **K8s node → VM → physical host → datastore**,
    so "why is this pod slow" can reach "its node VM shares a host that is at 95% memory".
  - GPU passthrough: map VMs with PCI/GPU devices to the GPU nodes in §0 (field names to be confirmed on VME).
- **Where it shows up**
  - Topology: physical hosts → VMs → K8s nodes as one graph (extend `server/graph`).
  - Metrics: add VME `stats` as a sample source alongside SSH samples (no SSH cost).
  - Insight/Why engine (`server/insight/correlate.ts`): new signals for *VM powered off*,
    *host overcommitted*, *datastore > 85%*, *Manager alarm active*, and *recent activity on this VM*
    (that last one is often the answer: "it was migrated 4 minutes ago").
  - History tab: ingest `/api/activity` as change events.
- **SSH complements (on VME hosts, read-only, allow-listed)**: `virsh list --all`,
  `virsh domstats --cpu-total --balloon --block --interface`, `ovs-vsctl show`,
  `multipath -ll`, storage health (Ceph/GFS2 if used), and the VME agent's service/log status.
  The API gives the model; SSH gives the low-level truth when the API is ambiguous.

### 1.4 Phasing
1. Connect + `/api/whoami` + `/api/servers` + `/api/instances` → a "VME" panel and host/VM join (≈2–3 days).
2. Join to K8s nodes and topology; datastore + alarm signals into Why (≈3 days).
3. Activity → History; VME stats as a metrics source (≈2 days).

Open questions for you: VME version, whether a read-only Manager role exists,
and whether the Manager is reachable from where Trinetra runs or only via the DSC jump VM.
If only via the jump VM, the call goes over SSH as `curl` with a fixed URL allow-list.

---

## 2. Insights from `/etc/kubernetes` (control-plane and node config)

### 2.1 What's there and what it tells us
Read on each node over SSH. Most of it needs root/sudo, which the existing `elevate` already handles.
Read-only; **never** read or return private keys or kubeconfig credentials.

| Path | Insight |
|---|---|
| `pki/*.crt`, `pki/etcd/*.crt` (parse with `openssl x509 -noout -enddate -subject -ext subjectAltName`) | **Certificate expiry countdown**, the most common silent cluster killer. Flag < 30 d warn, < 7 d critical; SANs missing a node IP/hostname |
| `admin.conf`, `kubelet.conf`, `controller-manager.conf`, `scheduler.conf` | Only the **embedded client cert's expiry** and the `server:` endpoint (wrong VIP/LB after a migration). The key data is never read out |
| `manifests/kube-apiserver.yaml` | Flags: `--authorization-mode`, `--anonymous-auth`, `--enable-admission-plugins`, `--audit-log-path`/policy present?, `--encryption-provider-config` present?, `--service-cluster-ip-range`, `--etcd-servers`. Feeds a **security posture** card (pairs with docs/SECURITY-REMEDIATION.md) |
| `manifests/etcd.yaml` | Data dir, peer/client TLS, `--quota-backend-bytes` vs DB size (`etcdctl endpoint status` if available) → "etcd near quota" |
| `manifests/kube-controller-manager.yaml`, `kube-scheduler.yaml` | `--cluster-cidr`, node CIDR mask, `--terminated-pod-gc-threshold`, leader-elect, bind addresses |
| Manifest **drift** between control-plane nodes | Same flags on every master? A mismatch explains "works on one apiserver, not another" |
| `/var/lib/kubelet/config.yaml` (with `/etc/kubernetes/kubelet.conf`) | `evictionHard`, `maxPods`, `cgroupDriver` vs container runtime, `rotateCertificates`, `serverTLSBootstrap`, reserved CPU/memory. This explains evictions and "node full at 110 pods" |
| File mtimes | "apiserver manifest edited 10 min ago" goes into History and the Why engine as a change event |

**Distribution detection** matters: RKE2 (already on `EXTRA_PATH`) keeps these in
`/etc/rancher/rke2/config.yaml`, `/var/lib/rancher/rke2/server/tls/`,
`/var/lib/rancher/rke2/agent/pod-manifests/`; k3s in `/var/lib/rancher/k3s/…`.
Probe all three layouts and report which one was found.

### 2.2 Design
- `server/k8s/nodeconfig.ts`: one SSH script per node, with fixed paths, `@@TAG@@`
  sections, and `|| true` per block, like `metrics/sample.ts`.
  Cert parsing runs **on the host** with `openssl x509 -noout …`, so only
  dates/subjects/SANs travel back. Manifests are parsed for `command:` flags only;
  values of any flag matching `token|password|key=` are redacted server-side before returning.
- Pure parsers + tests (`parseCertDates`, `parseApiserverFlags`, `diffManifests`).
- UI: a "Control plane" card in the K8s tab with a cert expiry table, posture checks
  (pass/warn with the exact flag as evidence), and drift between masters.
- Insight engine: new categories `cert-expiry`, `config-drift`, `etcd-quota`, `kubelet-eviction`.
- History poller: snapshot hashes of manifests + kubelet config, so config changes become timeline events.

---

## 3. Further improvements (ranked by value ÷ effort)

1. **DCGM exporter as the GPU source.** The NVIDIA GPU Operator already runs
   `nvidia-dcgm-exporter` on every GPU node. Scraping its `/metrics` (via
   `kubectl get --raw /api/v1/namespaces/<ns>/services/<svc>:9400/proxy/metrics`)
   gives every GPU with pod/namespace labels **in one call, without exec-ing into
   pods**: no per-pod cap, no nvidia-smi needed in the image, and it covers pods whose
   image lacks nvidia-smi. Keep nvidia-smi exec as the fallback and for the raw views.
2. **GPU history.** Store per-model GPU util/mem samples (reuse `server/metrics/store.ts`)
   so the GPU page shows sparklines and "idle GPU for 6 h" (cost waste) findings.
3. **GPU waste / fit findings**: allocated but < 5% util for N hours; memory near 100% (OOM risk);
   Pending pods waiting for GPUs vs. idle allocated GPUs elsewhere.
4. **Remote batching everywhere**: other `runSteps` callers with many steps
   (graph, why) can opt into `{ parallel }` from §0.
5. **Shared response cache / single-flight** on the server for `pods -o json` so the GPU, topology
   and Why pages opening together don't each list every pod.
6. **Pre-existing test failures**: `server/__tests__/ssh.test.ts` fails 3 tests locally
   (`KEY_EXCHANGE_FAILED` against the embedded test SSH server). Fix it so CI signal is trustworthy.
7. **Bundle size**: the main client chunk is > 500 kB. Split heavier tabs (topology, xterm) further.
8. **Notebook (Trinetra.ipynb) parity**: add the GPU-per-model, VME and cert-expiry panels so the
   single-pane view keeps up with the app.
