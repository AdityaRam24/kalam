# Trinetra — What Does What

A map of every page, button and backend endpoint, and which file implements it.
Everything that reads a cluster works against **this machine** (`local`), **one VM**
from the SSH inventory, or **All hosts** — chosen with the source picker in the top bar.

---

## Top bar

| Control | What it does | Code |
|---|---|---|
| Search box | Filters containers, pods, nodes, workloads and "Other Resources" by text (also matches statuses like `CrashLoopBackOff`). | `src/App.tsx` |
| Source picker | Which machine every view reads from: this machine, one VM over SSH, or all hosts merged. | `src/App.tsx` |
| Live Sync / Paused | Re-reads the selected source every 10 s for the whole app. | `src/App.tsx` |
| Refresh (↻) | Re-reads the source once, now. | `src/App.tsx` |
| **Capture** | Menu with four options: **full-page PNG** (including content scrolled out of view), **visible-screen PNG**, **state as JSON** (the data behind the page), and **snapshot to Change History** (records the cluster now so later changes diff against it). | `src/components/CaptureButton.tsx`, `src/lib/capture.ts` |
| Sun / Moon | App light/dark theme. | `src/App.tsx` |

## Sidebar pages

### Dashboard
- **KPI cards** — containers, nodes, pods, kube context.
- **Cluster Topology Map** — see the next section.
- **Cluster Resource Metrics** — CPU and memory **used** (live, from `kubectl top`) next to **requested** (sum of pod requests) against each node's allocatable capacity; GPUs allocated; pod slots; per-node table with pressure and cordon state; top pods by CPU or memory. Without metrics-server it says so and shows requested values only.
- **Workload Status** — pod counts by kubectl status (`Running`, `CrashLoopBackOff`, `ImagePullBackOff`, `Init:0/1`, `Completed`…) and workload counts by rollout state. Click any chip to open the Kubernetes page filtered to it.
- **Host and Daemon Health** — runtime and kubectl availability.

### Cluster Topology Map (on the Dashboard)
| Control | What it does |
|---|---|
| **Sample now** (default mode) | The map is a still picture of one read. Other app refreshes no longer redraw it, so it stays smooth and the layout never shifts. Click to take a fresh sample. |
| **Live** | Asks first, with a warning (each read re-queries the whole cluster, adds API-server and network load, and re-lays out the map). Pick 10 s / 30 s / 1 min / 2 min. Click *Sample now* to go back to a still map. |
| Namespace dropdown | Defaults to **kube-system** on the dashboard when that namespace exists; any manual choice wins. |
| **Light / Dark** | Map colour scheme, independent of the app theme; remembered per browser. |
| **Capture map** | PNG of the canvas exactly as drawn (works in fullscreen). |
| Problems | Shows only unhealthy objects and what they connect to. Uses kubectl status **and the why-engine**, so a Service whose selector matches nothing, or an ISVC with no runtime, counts even though nothing reports it as "failing". |
| **Why line on cards** | A failing card shows one line saying *why* (e.g. `⚠ Issuer not found: ClusterIssuer "letsencrypt-prod"`, `⚠ ConfigMap "app-cfg" is missing`, `⚠ Selector matches no pods`). Hover for the full title. Refreshed after each sample (live mode: at most every 30 s). Not shown in "All hosts". |
| **Drawer → Details: Why it's failing** | Top of the drawer for any Kubernetes card. For each problem: the cause in plain words, the evidence the cluster gave, the **root cause** object (click to jump to it), the label/annotation involved and who reads it, the **fix**, when it started, and **Changes that may explain this** (ranked suspects from Change History, each with the reason it was picked). |
| **Drawer → Non-negotiables** | Every reference and contract the object depends on, each ✓ holds / ✗ broken / ? cannot tell: ConfigMaps/Secrets/PVCs it mounts, its ServiceAccount, image-pull secrets, nodeSelector matching a node, Service selector matching pods, named target ports, Certificate issuer exists and is Ready, Ingress backends/class/TLS, cert-manager annotations, KServe runtime/format/model PVC/deploymentMode. "?" is honest: e.g. Secrets are never granted in-cluster, so Trinetra does not guess. |
| **Drawer → Labels & annotations other components depend on** | The object's labels/annotations (and pod-template ones) that something else reads — who reads it, what it does, and what breaks if it is wrong. |
| Card LEDs | Steady green = healthy; amber blinking = in progress / degraded; red blinking = failing; grey = completed. Only non-healthy LEDs animate. Workload and node cards show status too (e.g. node `Ready · DiskPressure`). |
| **InferenceServices** | KServe ISVCs are drawn as the first column (pink cards: model format, status, storage, URL). Edges: **ISVC → Service** (`serves`) and **ISVC → workload** (`deploys`), taken from the `serving.kserve.io/inferenceservice` label on the predictor pods; if no predictor pod exists yet, KServe's `<isvc>-predictor…` naming is used and the edge is drawn faint with a `?`. Click a card for its YAML, events and model details. "Models x/y ready" appears in the summary bar; type filter "KServe InferenceServices". |
| **Flow: Focus / All / Off** | **Focus** (default): hover or select any card and the whole request path through it animates and lights up — e.g. ISVC → Service → Workload → Pods → Node — everything else dims. **All** animates every link (heavier on big clusters). **Off** = no movement. Remembered per browser. |

Flow order on the map: **InferenceService → Service → Workload → Pod → Node** (and Port → Container for plain containers).

Performance notes (measured on 150 cards / 240 edges): idle 60 fps; no card is unmounted/re-mounted while panning, zooming or refreshing; a live refresh only touches the cards that changed. The flicker was React Flow hiding every re-passed card until re-measured — Trinetra now keeps the measured sizes.

Code: `src/components/TopologyGraph.tsx`, signature in `src/lib/topology.ts`.

### Containers
Docker/containerd/podman containers with start/stop/restart/logs/remove. `src/App.tsx`

### Kubernetes
- **Nodes, Workloads, Services, Pods** tables.
- **Pods** show the **kubectl STATUS** (`CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `OOMKilled`, `Init:1/2`, `Terminating`, `Evicted`, `Completed`…), ready count, restarts with the **reason of the last restart** (e.g. `OOMKilled`), age. Status chips above the table filter it.
- **Workloads** (Deployments, StatefulSets, DaemonSets) show kind and rollout state: `Available`, `Degraded`, `Updating`, `Unavailable`, `Failed` (progress deadline exceeded), `ScaledToZero`.
- **Other Resources** — every other kind, grouped: Workloads (Jobs, CronJobs, HPAs, PDBs), **AI / ML** (KServe **InferenceServices**, ServingRuntimes, Kubeflow Notebooks, RayClusters), **Network** (Ingresses, Istio VirtualServices / Gateways / DestinationRules, NetworkPolicies), **Storage** (**PVCs**, PVs, StorageClasses), **Certificates** (cert-manager Certificates with expiry — *ExpiringSoon* within 14 days, *Expired*; Issuers, ClusterIssuers), **Config** (ConfigMaps, Secrets — names and types only, contents are never read), **Cluster** (Namespaces, ResourceQuotas, warning Events, CRDs). Kinds a cluster doesn't have are shown as `n/a`. Filters: group, kind, namespace, "not healthy only", search; CSV export.

Code: `src/App.tsx`, `src/components/ClusterResources.tsx`, status logic in `server/k8s/workloads.ts`.

### K8s Nodes (formerly "Virtual Machines")
SSH inventory, metrics, discovery, node "brain", diagnose, root access.
- **Terminal** is now a real terminal emulator (xterm.js): every key goes to the host as typed, so `kubectl edit`, `vim`, `less`, `top`, `htop` work. Ctrl+C interrupts (or copies when text is selected), Ctrl+Shift+C / Ctrl+Shift+V copy/paste, Maximize button, the remote PTY follows the panel size.
- `root`, `sudo`, `su` badges are lowercase.

Code: `src/components/VmMonitor.tsx`, `src/components/RemoteTerminal.tsx`, `server/shell.ts`.

### Host Logs
`/var/log`, journal and dmesg on a VM: overview, rule-based findings, "Understand this host", journal explorer, files, viewer.
New: remembers the last host; findings can be **sorted** (severity / frequency / recency), **expanded or collapsed all**, **exported as CSV**; files can be sorted and limited to **files with findings**; the viewer has **severity filters** (all / errors + warnings / critical), **highlighting** of the grep term, **line numbers**, **wrap**, **Follow** (tail -f, re-reads every 5 s), **Copy** and **Save view**.

Code: `src/components/HostLogs.tsx`.

### Observability
Host telemetry over time. New: **Kubernetes resource panel** (same as the dashboard metrics), **auto-refresh** toggle with last-updated time, **CSV export**, fused issues now show their **read-only checks** (with copy) and all evidence, **show all issues**, host cards with **search**, **filter** (need attention / unreachable), **sort** (most affected, CPU, memory, disk, GPU) and **expandable extra metrics** (load, swap, GPU memory/temperature/power).

Code: `src/components/Observability.tsx`.

### Change History
What changed, when, and who did it (from Trinetra's periodic captures).
- **Namespace dropdown** — every namespace Trinetra tracks, with change and object counts, plus *Cluster-scoped objects*.
- **Kind** and **changed-by** (writer, e.g. `helm`, `kubectl-edit`) dropdowns; severity; time window (1 h – 30 d, or everything); change-type chips; search.
- **Overview**: totals, needs-attention count, objects and namespaces affected, most active writer, latest change.
- **Activity histogram** (hourly or daily, red = needs attention) — click a bar to zoom the timeline to that slice.
- **Most-changed objects** — click to see only that object.
- **Group by** day / namespace / object; **Root changes only** hides knock-on changes.
- **Expand / collapse all**, **CSV / JSON export**, **auto-refresh**, **load older changes**, clickable namespace and writer in each row, "All changes to this object" inside each row.
- **Why things are failing now** (top panel) — every current problem, grouped **by cause** ("ConfigMap app-cfg is missing — affects 5 pods + 1 deployment"), each with the explanation, root cause, fix and the **recorded changes most likely to have caused it**. Click an affected object to filter the timeline to it. **Only changes linked to these** narrows the timeline to the suspects.
- **Likely cause** badge on timeline rows that Trinetra links to a current failure; expanding the row says which failure and why it was linked.
- **What this change means** — each change carries its consequence, worked out when it was captured: "Service web no longer selects these pods — its traffic stops", "References ConfigMap x, which does not exist — new pods will not start", "ClusterIssuer x does not exist — cert-manager cannot issue this certificate", "Still referenced by Deployment a, b", "New pods in ns will NOT get an Istio sidecar", "Certificates … depend on it". The first line shows under the row; all lines in the expanded view and in CSV export.
- **Labels and annotations are tracked** (new change types `label` / `annotation`). Keys another component reads (selectors, `cert-manager.io/*`, `istio-injection`, `sidecar.istio.io/inject`, `serving.kserve.io/*`, Helm ownership, pod-security…) are raised to *needs attention*; controller bookkeeping (last-applied-configuration, revision counters, heartbeats) is ignored.
- **More kinds tracked**: cert-manager Certificates / Issuers / ClusterIssuers (incl. Ready flips), KServe InferenceServices (model `storageUri` changes read as deploys) / ServingRuntimes / ClusterServingRuntimes, Istio VirtualServices / Gateways, IngressClasses, and the **moment a pod starts waiting** (ImagePullBackOff, CrashLoopBackOff, CreateContainerConfigError…).
- Upgrading is quiet: the first capture after this version does not report every existing label as "added".

Code: `src/components/ClusterHistory.tsx`, `server/history/router.ts` (`/api/history/facets`, `/api/history/why`), `server/history/impact.ts`, `server/history/suspects.ts`.

### The why-engine (behind the map, drawer and Change History)
`server/k8s/why.ts` reads the cluster (read-only, ~15 s cache per source) and works out **causes**, not statuses:
- **Image pulls** — classifies the registry's answer: credentials refused (and whether the referenced pull secret even exists), image/tag not found, TLS not trusted, registry unreachable, rate-limited.
- **Crashes** — OOMKilled (with the limit), exit 0 (a one-off task run as a server), 126/127 (command not found), 139, 143, liveness probe killing it, restart storms.
- **Config** — missing ConfigMap/Secret or missing key, failed mounts.
- **Scheduling** — insufficient CPU/memory/GPU, untolerated taints, nodeSelector/affinity nobody satisfies, unbound PVCs, cordoned nodes, pod limits.
- **Workloads** — quota rejections, stuck rollouts, and "0/3 ready because …" taken from their pods.
- **Services** — selector matches no pods (with the pod that differs by one label), no ready endpoints and why, named target ports.
- **cert-manager** — issuer missing (and "right name, wrong kind"), issuer not Ready and which certificates it breaks, CA secret missing, expiry.
- **Ingress / Istio** — backend Service/port missing, IngressClass missing, cert-manager annotations pointing at missing/not-Ready issuers, VirtualService gateways and destinations that do not exist.
- **KServe** — no runtime for the model format, named runtime missing, model PVC missing/unbound, invalid deploymentMode, predictor pod failures.
- **Storage / nodes / HPA** — StorageClass missing or no default, provisioning failures, NotReady and pressure, autoscaler targets missing.

The label/annotation knowledge base is `server/k8s/contracts.ts`. Full rule reference: [`docs/WHY-ENGINE.md`](WHY-ENGINE.md).

### Kubectl Cheat Sheet
Reference. `src/components/KubectlCheatSheet.tsx`

### PCAI Stack
PCAI component map and health per component. The AI "health read" card is hidden while model settings are disabled. `src/components/PcaiStackView.tsx`

### GPU Utilization (new)
Which **model** runs on which GPU, and how hard it works.
- **GPU nodes** — model (e.g. A100), allocated / allocatable, GPU memory, driver/CUDA, MIG strategy.
- **One card per GPU workload** — the model name and serving stack (vLLM, NVIDIA NIM, Triton, TGI, KServe…) and *how it was identified* (InferenceService, `--served-model-name`, `--model`, `MODEL_NAME` env, …).
- **Live per-GPU readings** via `kubectl exec <pod> -n <ns> -- nvidia-smi --query-gpu=…`: compute utilization, memory used/total and bandwidth, power vs limit, temperature, SM/memory clocks, P-state, PCIe gen/width, MIG mode, ECC errors, persistence and compute mode, driver, **throttle reasons**, and the processes on each GPU.
- **Raw nvidia-smi buttons** per pod: `nvidia-smi`, `-q`, `-L`, `topo -m`, memory + ECC, clocks + perf, power + temp, processes, `--help` (fixed list — no free-form commands).
- Live nvidia-smi on/off, auto-refresh (15 / 30 / 60 s), namespace filter, search, CSV export. At most 24 containers are probed per refresh (`TRINETRA_GPU_MAX_PROBES`).

Code: `src/components/GpuUtilization.tsx`, `server/k8s/gpu.ts`.

## App-wide behaviour
- **Refresh loop** — the cluster is re-read every 10 s only while a page that shows it is open (Dashboard, Containers, Kubernetes, PCAI Stack, Observability), never while the browser tab is hidden, and never twice at once. A response that arrives after a newer read (or after you switched source) is discarded.
- **Last good read** — if one refresh fails (SSH hiccup, slow `kubectl`), the screen keeps the previous data with a banner "Showing the last good read from HH:MM" instead of going blank. In "All hosts", each host falls back to its own last good read.
- **Lazy pages** — K8s Nodes (terminal), Host Logs, Observability, Change History, Cheat Sheet, PCAI Stack and GPU load on first open; the startup bundle is ~550 KB instead of ~1.2 MB. The screenshot library loads on first capture.

## Disabled (commented out, not deleted)
Agent Chat, Agent Teamwork, PCAI Assistant, Image Hardener, the agent/model **settings button**, the "HPE AI: model" pill, the dashboard "Launch AI Console" card and the settings modal (incl. the model picker). They are wrapped in `Disabled:` comments in `src/App.tsx` — un-comment those blocks to restore them.

---

## Backend endpoints added

| Endpoint | Purpose | File |
|---|---|---|
| `GET /api/k8s/extra[?vm=]` | Every other resource kind, with status and health; `kinds` says which APIs exist. | `server/k8s/resources.ts` |
| `GET /api/k8s/top[?vm=]` | Live node and pod CPU/memory (`kubectl top`); reports *why* when unavailable. | `server/k8s/top.ts` |
| `GET /api/gpu/overview[?vm=&probe=0]` | GPU nodes, GPU workloads with model detection, live nvidia-smi readings. | `server/k8s/gpu.ts` |
| `POST /api/gpu/raw` | One fixed nvidia-smi view inside one pod. | `server/k8s/gpu.ts` |
| `GET /api/history/facets` | Namespaces, kinds, writers, top objects and activity histogram for a window. | `server/history/router.ts` |
| `GET /api/history?actor=&name=` | New filters on the existing timeline. | `server/history/store.ts` |
| `GET /api/k8s/why[?vm=&kind=&namespace=&name=]` | Every current finding (cause, evidence, root cause, fix) and a per-object index for cards; with an object: its findings and non-negotiables. | `server/k8s/why.ts` |
| `GET /api/history/why?source=[&kind=&namespace=&name=]` | Current findings with ranked suspect changes from the last 7 days; with an object also its contracts, root-cause chain and meaningful labels/annotations. | `server/history/router.ts`, `server/history/suspects.ts` |

Changed data: pods now carry `displayStatus`, `health`, `lastReason`; workloads carry `status`, `health`; nodes carry `allocatable`, `capacity`, `pressure`, `schedulable`, `gpuProduct` (`server/k8s/workloads.ts`). kubectl errors shown to users are the readable line, not klog noise (`server/k8s/kubectl.ts`).

**In-cluster (Helm):** `templates/rbac.yaml` now grants read access to the new kinds (batch, autoscaling, policy, storage, PVs, quotas, CRDs, cert-manager, KServe, Istio, Kubeflow, Ray — Secrets are still not granted, so they show as n/a in-cluster). `rbac.allowGpuExec` (default `true`) grants `pods/exec` for the GPU page; set it `false` to keep Trinetra strictly read-only.

All of the above is **read-only** toward the cluster except the pre-existing actions (restart, scale, delete pod, container start/stop) and the terminal.

## Renamed to Trinetra — upgrading from before the rename
- **Environment variables** are `TRINETRA_*`. Old names are still read (once, with a notice saying what to rename) — `server/legacy-env.ts`.
- **Browser settings** (theme, source, LLM settings, chat history) move from the old keys to `trinetra_*` on first load — `src/lib/legacy.ts`.
- **CLI**: the command is `trinetra` (`bin/trinetra.cjs`); `~/.trinetra.json` replaces the old config file, which is moved automatically. The installers also unregister the old global command.
- **Cluster install**: `deploy/bundle/install.sh` finds a pre-rename release and **migrates** it: installs `trinetra` with the old release's settings and secrets, copies its data volume (inventory, KB, change and metrics history) via a backup in `out/`, verifies it, and only then removes the old release (`--keep-old` to keep it).
- The image runs as user `trinetra` (same UID 10001, so existing volumes stay readable); paths are `/home/trinetra`, `/etc/trinetra`.

Tests: `server/__tests__/why.test.ts` (the engine, from fixtures), `history-impact.test.ts` (labels/annotations, CRDs, impact sentences), `suspects.test.ts` (ranking), `legacy-env.test.ts`, `src/lib/__tests__/legacy.test.ts`, `sanitize.test.ts`. `server/__tests__/explore.test.ts` covers status derivation, resource summaries, `kubectl top` parsing, nvidia-smi parsing, model detection and history facets.
