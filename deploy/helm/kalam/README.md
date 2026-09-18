# Kalam Helm chart

Runs Kalam inside a cluster: the built UI and the API are served from one port,
the pod reads its own cluster through a ServiceAccount, and — if you give it a
key — reaches machines outside the cluster over SSH.

## Install

```bash
# 1. Build and push the image (the chart does not build it for you)
docker build -t <registry>/kalam:0.1.0 .
docker push  <registry>/kalam:0.1.0

# 2. Install
helm upgrade --install kalam deploy/helm/kalam \
  --namespace kalam --create-namespace \
  --set image.repository=<registry>/kalam \
  --set image.tag=0.1.0
```

Then either port-forward, or turn the ingress on:

```bash
kubectl -n kalam port-forward svc/kalam 8080:80    # http://localhost:8080
```

```bash
helm upgrade --install kalam deploy/helm/kalam -n kalam \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=kalam.pcaicoe.com
```

The ingress host is added to the API's own origin allowlist automatically. If
you front it with a different hostname, set `config.allowedHosts` too, or the
API refuses the browser's `Origin`.

## The four decisions that matter

| Value | Default | What it changes |
|---|---|---|
| `rbac.allowWrite` | `false` | `false` is read-only: dashboard, topology map, inspect drawer and history all work, and the action buttons return "forbidden". `true` grants pod delete plus deployment/statefulset restart and scale. |
| `rbac.clusterWide` | `true` | `true` reads all namespaces (ClusterRole). `false` restricts to the release namespace (Role). |
| `ssh.secretName` | `""` | Empty means cluster-only. Point it at a Secret holding a private key and Kalam can add and map VMs. |
| `persistence.enabled` | `false` | Off means the SSH inventory, learned KB and change history live in an `emptyDir` and **reset on restart**. Turn it on if you add hosts. |

### SSH to hosts outside the cluster

```bash
kubectl -n kalam create secret generic kalam-ssh \
  --from-file=id_rsa=$HOME/.ssh/id_rsa \
  --from-file=known_hosts=$HOME/.ssh/known_hosts

helm upgrade --install kalam deploy/helm/kalam -n kalam \
  --set ssh.secretName=kalam-ssh \
  --set ssh.knownHosts=known_hosts \
  --set persistence.enabled=true
```

### AI engine

The **pod** makes the model call, not your browser — so the endpoint must be
reachable from inside the cluster.

```bash
# In-cluster or on the PCAI network (OpenAI-compatible, e.g. MLIS / vLLM / Ollama)
--set llm.provider=local \
--set llm.localUrl=http://ollama.ai.svc.cluster.local:11434/v1 \
--set llm.localModel=qwen2.5-coder:7b

# Gemini (needs internet egress)
--set llm.provider=gemini --set llm.existingSecret=my-secret
```

Confirm it from the UI: **Settings → Test connection** runs a real completion
and names the exact failure (off-network, refused port, token rejected,
untrusted certificate, model not served).

### Host Logs (`/var/log`, services, journal)

The Host Logs tab works entirely over SSH, so it needs `ssh.secretName` and
hosts added on the Virtual Machines tab (with `persistence.enabled=true`, or
they are gone after a restart). Reading most of `/var/log` and restarting a
systemd service need root on the host — enable root access per VM in the UI.

`rbac.allowWrite` does **not** govern Host Logs: it controls Kubernetes writes,
while service start/restart goes over SSH. Those actions are confirmed in the
UI, refused by the server without confirmation, limited to `start`/`restart`,
and logged in the pod's output (`kubectl -n kalam logs deploy/kalam | grep hostlogs`).

Raise the download cap (default 50 MB) if you pull large log bundles:

```bash
--set 'config.extraEnv[0].name=KALAM_LOG_BUNDLE_MAX_MB' \
--set-string 'config.extraEnv[0].value=200'
```

## What the chart installs

ServiceAccount, ClusterRole/ClusterRoleBinding (or Role/RoleBinding), Service,
Deployment, and optionally Ingress, PVC and a Secret.

Secrets are never granted in RBAC — Kalam does not read secret contents.

## Validate before installing

```bash
helm lint deploy/helm/kalam
helm template kalam deploy/helm/kalam | kubectl apply --dry-run=server -f -
```
