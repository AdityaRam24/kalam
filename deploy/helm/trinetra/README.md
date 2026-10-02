# Trinetra Helm chart

Runs Trinetra inside a cluster: the built UI and the API are served from one port,
the pod reads its own cluster through a ServiceAccount, and — if you give it a
key — reaches machines outside the cluster over SSH.

## Install: use the bundle

The easy path is the self-contained bundle. It holds the image, this chart,
helm/crane binaries and an installer that does every step:

```bash
deploy/bundle/build-bundle.sh                 # → deploy/bundle/dist/trinetra-0.1.0-bundle.tgz (no Docker needed)

tar -xzf trinetra-0.1.0-bundle.tgz && cd trinetra-0.1.0
./install.sh                                  # image → cluster, PCAI/ingress/NodePort, PVC, helm install, helm test
```

See the bundle's README (`deploy/bundle/BUNDLE-README.md`) for the options. The
rest of this page covers using the chart directly.

## Install with helm directly

The image has to be somewhere your nodes can pull from:

```bash
crane push trinetra-0.1.0.tar <registry>/trinetra:0.1.0   # the tarball from the bundle's images/
# or: docker build -t <registry>/trinetra:0.1.0 . && docker push <registry>/trinetra:0.1.0

helm upgrade --install trinetra deploy/helm/trinetra \
  --namespace trinetra --create-namespace \
  --set image.repository=<registry>/trinetra
```

Then reach it:

```bash
kubectl -n trinetra port-forward svc/trinetra 8080:80    # http://localhost:8080
helm test trinetra -n trinetra
```

## HPE Private Cloud AI

PCAI publishes applications on its Istio gateway (`istio-system/ezaf-gateway`)
and puts platform SSO in front of them. The chart's `ezua:` block follows the
PCAI Import Framework contract:

```yaml
ezua:
  virtualService:
    endpoint: "trinetra.${DOMAIN_NAME}"          # substituted by PCAI on import
    istioGateway: "istio-system/ezaf-gateway"
  authorizationPolicy:                        # SSO via oauth2-proxy
    enabled: true
```

- **Import Framework (UI):** upload the chart .tgz (`install.sh --package-only`
  writes one with the image location filled in). PCAI fills in `${DOMAIN_NAME}`.
- **helm CLI:** set the endpoint yourself: `--set ezua.virtualService.endpoint=trinetra.<domain>`.
  `install.sh` detects the domain from the gateway.

The VirtualService and AuthorizationPolicy render only when the Istio APIs exist
and the endpoint is a real hostname. On a non-PCAI cluster, or with the
placeholder still in place, they are skipped rather than failing the install.
The endpoint is added to the API's origin allowlist automatically.

## Other clusters: Ingress or NodePort

```bash
--set ingress.enabled=true --set ingress.className=nginx --set ingress.host=trinetra.example.com
# or
--set service.type=NodePort --set service.nodePort=30080 --set config.allowedHosts=<node-ip>,<node-ip>
```

The API checks the browser's `Origin`. The ingress host and PCAI endpoint are
allowed automatically; for any other name (such as node IPs) set `config.allowedHosts`.

## The decisions that matter

| Value | Default | What it changes |
|---|---|---|
| `rbac.allowWrite` | `false` | `false` is read-only: dashboard, topology map, inspect drawer and history all work, and the action buttons return "forbidden". `true` grants pod delete plus deployment/statefulset restart and scale. |
| `rbac.clusterWide` | `true` | `true` reads all namespaces (ClusterRole). `false` restricts to the release namespace (Role). |
| `ssh.secretName` | `""` | Empty means cluster-only. Point it at a Secret holding a private key and Trinetra can add and map VMs. Use `~/.ssh/id_rsa` as the key path in the UI. |
| `persistence.enabled` | `false` | Off means the SSH inventory, KB, history and metrics live in an `emptyDir` and **reset on restart**. `install.sh` turns it on when there is a default StorageClass. |
| `ezua.authorizationPolicy.enabled` | `true` | PCAI only: platform SSO in front of the UI/API. |

### SSH to hosts outside the cluster

```bash
kubectl -n trinetra create secret generic trinetra-ssh \
  --from-file=id_rsa=$HOME/.ssh/id_rsa \
  --from-file=known_hosts=$HOME/.ssh/known_hosts

helm upgrade --install trinetra deploy/helm/trinetra -n trinetra --reuse-values \
  --set ssh.secretName=trinetra-ssh \
  --set ssh.knownHosts=known_hosts \
  --set persistence.enabled=true
```

### AI engine

The **pod** makes the model call, not your browser, so the endpoint must be
reachable from inside the cluster. `llm.*` sets what a fresh browser starts
with; each user can still change it under Settings.

```bash
# In-cluster or on the PCAI network (OpenAI-compatible, e.g. MLIS / vLLM / Ollama)
--set llm.provider=local \
--set llm.localUrl=http://ollama.ai.svc.cluster.local:11434/v1 \
--set llm.localModel=qwen2.5-coder:7b

# Gemini (needs internet egress)
--set llm.provider=gemini --set llm.existingSecret=my-secret   # key GEMINI_API_KEY
```

Confirm it from the UI: **Settings → Test connection** runs a real completion
and names the exact failure (off-network, refused port, token rejected,
untrusted certificate, model not served).

### Host Logs, history and metrics

The Host Logs tab works entirely over SSH, so it needs `ssh.secretName` and
hosts added on the Virtual Machines tab (with `persistence.enabled=true`, or
they are gone after a restart). Reading most of `/var/log` and restarting a
systemd service need root on the host — enable root access per VM in the UI.

`rbac.allowWrite` does **not** govern Host Logs: it controls Kubernetes writes,
while service start/restart goes over SSH. Those actions are confirmed in the
UI, refused by the server without confirmation, limited to `start`/`restart`,
and logged in the pod's output (`kubectl -n trinetra logs deploy/trinetra | grep hostlogs`).

```bash
--set config.history.enabled=true     # periodic cluster fingerprints for the History view
--set config.metrics.enabled=true     # CPU/mem/disk sampling of inventory VMs
--set 'config.extraEnv[0].name=TRINETRA_LOG_BUNDLE_MAX_MB' --set-string 'config.extraEnv[0].value=200'
```

## What the chart installs

ServiceAccount, ClusterRole/ClusterRoleBinding (or Role/RoleBinding), Service,
Deployment, a `helm test` pod, and optionally a PVC, Secret, Ingress, and on
PCAI an Istio VirtualService and AuthorizationPolicy.

Secrets are never granted in RBAC: Trinetra does not read secret contents. The pod
runs as uid 10001 with a read-only root filesystem and no capabilities.

## Validate before installing

```bash
helm lint deploy/helm/trinetra --strict
helm template trinetra deploy/helm/trinetra | kubectl apply --dry-run=server -f -
```
