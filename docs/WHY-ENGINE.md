# Why-Engine — How Trinetra Explains Failures

## How we do it

No LLM. Trinetra reads the cluster with plain `kubectl get` and runs it through a set of hand-written rules. Kubernetes already records most causes in structured fields: waiting reasons, exit codes, condition messages, event reasons. Each rule matches one known failure pattern in those fields. It then cross-checks the objects involved (does that Secret, Issuer or runtime actually exist?), names the real root cause, and fills in a fix template with the real object names. Change History is joined in by scoring recorded changes against each failure. The result is the same every time, it works offline, and every answer traces back to one rule and one piece of cluster data.

---

## Files

| File | Holds |
|---|---|
| `server/k8s/why.ts` | Failure rules, fixes, "non-negotiables" checks, cluster read, `/api/k8s/why` |
| `server/k8s/contracts.ts` | Meaning of labels/annotations that other components read; noise filters |
| `server/history/impact.ts` | "What this change does" rules for Change History |
| `server/history/suspects.ts` | Scoring of which change likely caused a failure |
| `server/history/diff.ts` (`RULES`) | Name, severity and sentence for each kind of field change |
| `server/history/router.ts` | `/api/history/why`: failures + suspect changes |
| `src/components/WhyPanel.tsx` | Drawer UI (also used by Change History) |

Tests: `server/__tests__/why.test.ts`, `history-impact.test.ts`, `suspects.test.ts`.

---

## Pipeline

1. **Read** (`STEPS`, `why.ts`): pods, services, endpoints, workloads, nodes, namespaces, warning events, certificates, issuers, cluster issuers, ingresses, ingress classes, InferenceServices, serving runtimes, PVCs, storage classes, HPAs, VirtualServices, gateways. For ConfigMaps, Secrets and ServiceAccounts it reads **names only**, never contents. At most 6 kubectl calls run at once, and results are cached for 15 s per source.
2. **Index** every object by kind/namespace/name, and record which kinds were actually readable.
3. **Analyse** each object with its kind's rules → **findings**.
4. **Roll up**: a workload's finding inherits its pods' cause; a Service's "no ready backends" names its pods' cause.
5. **Correlate** (Change History): rank recorded changes from the last 7 days against each finding.

A finding contains: the object, severity (`critical`/`warning`/`info`), category, title, why, evidence, fix, root cause, the objects it affects, the contract it breaks, the label/annotation meaning involved, and when it started.

---

## Rules

### Pods (`containerFinding`, `analyzePod`)
| Signal | Conclusion | Fix |
|---|---|---|
| Waiting `ImagePull*` / `ErrImage*` + message `unauthorized\|denied\|401\|403` | Registry refused credentials. If the referenced pull secret doesn't exist → **root cause: that Secret** | Create the pull secret / attach it to the pod or ServiceAccount |
| … message `not found\|manifest unknown` | Image or tag doesn't exist | Fix the reference or push the tag |
| … `x509\|certificate` | Node doesn't trust the registry CA | Install the CA on the nodes |
| … `toomanyrequests` | Registry rate limit | Authenticated pulls / mirror |
| … `timeout\|no such host\|connection refused` | Node can't reach the registry | Check DNS/proxy/firewall from the node |
| `CreateContainerConfigError` + `configmap/secret "x" not found` | **Root cause: ConfigMap/Secret x** missing | Create it, fix the reference, or mark it optional |
| … `couldn't find key k in ConfigMap x` | Key missing | Add the key |
| `OOMKilled` / exit 137 | Over its memory limit (the limit is quoted) | Raise the limit |
| Exit 0 + restarts | One-off command run as a long-running process | Use a Job / fix the command |
| Exit 126 / 127 | Command not executable / not found | Fix command/args |
| Exit 139 / 143 | Segfault / SIGTERM | Read previous logs |
| Warning `Unhealthy` Liveness + crashes | Liveness probe keeps killing it | Fix probe timing / add a startupProbe |
| `PodScheduled=False`: `Insufficient X` | No node has enough X | Lower requests / add capacity |
| … `untolerated taint` | Taint not tolerated (taints quoted) | Add a toleration |
| … `didn't match node affinity/selector` | No node has the selector labels | Label a node / fix the selector |
| … `unbound PersistentVolumeClaims` | **Root cause: that PVC** | See the PVC finding |
| … `volume node affinity conflict`, `Too many pods`, cordoned | as stated | as stated |
| Warning `FailedMount` with `"x" not found` | Volume source missing (**root cause**) | Create it |
| Running, `Ready=False`, Readiness `Unhealthy` | Gets no traffic | Check probe port/path |
| `status.reason=Evicted` | Node evicted it | Set requests/limits; free node pressure |
| Deletion requested > 5 min ago | Stuck terminating (finalizers listed) | Check the node / finalizer owner |
| Pending + a broken reference (contract) | Can't start: the reference is named | Create it / fix the reference |
| ≥ 5 restarts, otherwise healthy | Recurring crash | Previous logs |

### Workloads (`analyzeWorkload`)
| Signal | Conclusion |
|---|---|
| `ReplicaFailure` + `exceeded quota` | Namespace quota rejects pods |
| `ReplicaFailure` (other) | Admission/PodSecurity rejects pods (message quoted) |
| `ProgressDeadlineExceeded` | Rollout stuck; fix includes `rollout undo` |
| ready < desired and its pods have findings | "x/y ready — *pod cause*", with the pod's root cause |
| ready < desired, no pods exist, no error reported | Controller makes no pods |

### Services (`analyzeService`, `serviceContracts`)
| Signal | Conclusion |
|---|---|
| Selector matches no pod in the namespace | No backends; lists pods that differ by **one** label (`app=web-v2`, wants `app=web`) |
| Selector matches, 0 ready endpoints | No ready backends — the pods' cause is included |
| Named `targetPort` not declared on the pods | Traffic dropped |

### cert-manager (`analyzeCertificate`, `analyzeIssuer`)
| Signal | Conclusion |
|---|---|
| `issuerRef` names no existing Issuer/ClusterIssuer | **Root cause: the issuer.** If the other kind exists under that name → "set `issuerRef.kind`" |
| Issuer exists, not Ready | **Root cause: the issuer** (its message quoted) |
| Certificate `Ready≠True` (issuer OK) | cert-manager's message; check CertificateRequests/Orders/Challenges |
| `notAfter` passed / ≤ 14 days | Expired / expiring |
| Issuer not Ready | Lists the certificates it breaks; CA secret as root cause when the message says so |

### Ingress / Istio (`ingressContracts`, `analyzeVirtualService`)
| Signal | Conclusion |
|---|---|
| Backend Service missing, or has no such port | 503/404 for those paths |
| Ingress class doesn't exist | No controller serves it |
| `cert-manager.io/cluster-issuer` / `issuer` names a missing or not-Ready issuer | TLS never issued |
| TLS secret missing (no cert-manager annotation) | Controller's default certificate is served |
| VirtualService gateway doesn't exist | Routes not served externally |
| Destination host has no Service | Istio 503 |

### KServe (`isvcContracts`, `analyzeIsvc`)
| Signal | Conclusion |
|---|---|
| Named runtime missing | Predictor never created |
| No enabled runtime auto-selects the model format | Predictor never created |
| `pvc://` model PVC missing / not Bound | Storage initializer fails |
| `deploymentMode` not Serverless/RawDeployment/ModelMesh | Never deployed |
| `Ready≠True` | Predictor pod's cause if there is one, else KServe's false conditions |

### Storage, nodes, HPA (`analyzePvc`, `analyzeNode`, `analyzeHpa`)
| Signal | Conclusion |
|---|---|
| PVC Pending, StorageClass missing | **Root cause: the StorageClass** |
| PVC Pending, no class named, 0 or 2+ defaults | No/ambiguous default class |
| `WaitForFirstConsumer`, no events | Expected — `info` |
| `ProvisioningFailed` | Provisioner message |
| PVC `Lost` | Volume gone |
| Node `Ready≠True` / `*Pressure=True` | NotReady / pressure, with eviction warning |
| HPA target missing / `ScalingActive=False` | Scales nothing / metrics missing |

---

## Non-negotiables (drawer checklist)

`contractsFor(kind, ns, name)` lists every dependency of an object as **holds / broken / cannot tell**:

- **Pod / workload:** every ConfigMap/Secret/PVC it references (env, envFrom, volumes, projected), ServiceAccount, pull secrets, nodeSelector matches a node, `sidecar.istio.io/inject=false` in an injected namespace, and which Services' selectors its pod labels satisfy.
- **Service:** selector matches pods; named target ports exist.
- **Certificate:** issuer exists; issuer Ready.
- **Ingress:** class exists, backends/ports exist, cert-manager annotations point at a Ready issuer, TLS secret.
- **InferenceService:** runtime/format, model PVC, deploymentMode.

`metadataContracts(obj)` lists the object's labels/annotations (including pod-template ones) that appear in `contracts.ts`, each with *read by / meaning / if wrong*.

**Cannot tell:** if a kind wasn't readable (e.g. Secrets are never granted in-cluster), its checks report `unknown`. The engine never reports a missing object it couldn't look for.

---

## Change History rules

- **Tracked fields** (`fingerprint.ts`): spec fields per kind, plus `label.<key>` / `annotation.<key>` / `podAnnotation.<key>`, the pod waiting reason, and Ready for cert-manager and KServe objects. Keys matched by `isNoisyLabel` / `isNoisyAnnotation` are dropped.
- **Naming and severity** (`diff.ts` `RULES`): the longest matching field path wins. A label/annotation key listed in `contracts.ts` → `warning`, otherwise `info`.
- **Upgrade guard:** a snapshot records `features` (`meta`, `podWaiting`). Those fields are compared only when both snapshots have them, so an upgrade doesn't report every label as "added".
- **Impact** (`impactOf`), computed from the same snapshot at capture time:
  - pod-template labels vs Service selectors (lost / gained Services)
  - Service selector vs workloads (no backends / now routes to…)
  - deleted ConfigMap/Secret/PVC/Service/Issuer/Gateway/ServingRuntime → who still uses it
  - new references to objects that don't exist (ConfigMap/Secret/PVC, ServiceAccount, issuer, runtime)
  - issuer turned not-Ready → dependent certificates
  - `istio-injection` change; a node label removed that a workload selects
  - default StorageClass removed; model `storageUri` change → cold start
  - one line per meaningful label/annotation key (from `contracts.ts`)

  Existence is only claimed when that kind's section was read in the snapshot. At most 6 lines per change.

---

## Suspect scoring (`suspects.ts`)

`score = relation × relevance × timing`. Changes scoring below `0.12` are dropped; the top 3 are kept, each with its reason sentence.

| Relation (changed object vs failing one) | Weight |
|---|---|
| Is the root cause / is the object itself | 1.0 |
| Owns the pod (Deployment via ReplicaSet) | 0.95 |
| Its impact note names the object | 0.9 |
| Node the pod runs on | 0.6 |
| Same namespace (not a pod) | 0.3 |
| Cluster-scoped deletion / warning | 0.15 |

**Relevance:** `RELEVANCE[findingCategory][changeKind]`, default `0.3`. For example, an `image` change against an `image` failure scores `1`, and a `scaled` change against a `crash` scores `0.2`.

**Timing:**
- If the failure's start (`since`) is known: a change at or before `since + 2 min` scores `exp(−gap / 6 h)` (minimum 0.1). A change after that scores `0.1` and is labelled "after it started failing (a fix attempt?)".
- If `since` is unknown: `exp(−age / 24 h)` (minimum 0.05).

---

## Limits

- Only known patterns are covered. Anything else falls back to the raw event text and `kubectl describe`.
- Some rules regex-match message wording from Kubernetes, cert-manager and container runtimes. If that wording changes, the rule degrades to the generic answer, not a wrong one.
- It explains platform causes, not application bugs. It doesn't read logs.
- Suspects are correlation, not proof. Each reason sentence says why it was picked.

---

## Adding a rule

1. **New failure:** add a check to the matching `analyze…` function in `why.ts`. It should return a `Finding` with `rootCause` set when the cause is another object, and `fix` filled with real names.
2. **New contract:** add it to the kind's `…Contracts` function. Use `refStatus()`, which returns `unknown` when that kind wasn't read.
3. **New meaningful label/annotation:** add one entry to `EXACT` or `PREFIX` in `contracts.ts`. The map, drawer and Change History all pick it up.
4. **New impact sentence:** add it to `impactOf` in `impact.ts`, guarded by `exists()`.
5. Add a fixture test in `server/__tests__/why.test.ts` or `history-impact.test.ts`.
