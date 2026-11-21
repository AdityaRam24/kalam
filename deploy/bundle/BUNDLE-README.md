# Trinetra __VERSION__ — install bundle

Everything needed to run Trinetra on a Kubernetes cluster, in one archive:

```
trinetra-__VERSION__/
  install.sh / uninstall.sh      one-command install / removal
  install.bat / uninstall.bat    the same on Windows (double-click or run from cmd)
  pcai-import.bat                Windows: build the PCAI Import Framework chart
  images/trinetra-__VERSION__.tar       the container image (linux/amd64, docker-load compatible)
  chart/trinetra-__VERSION__.tgz        the Helm chart
  manifests/image-cache.yaml     per-node image cache (used only when no registry is given)
  bin/<os-arch>/                 helm, crane (and kubectl for Linux) — nothing to download
  SHA256SUMS
```

## Install

From any machine whose `kubectl` points at the cluster (Linux, macOS, or Git Bash on Windows):

```bash
tar -xzf trinetra-__VERSION__-bundle.tgz
cd trinetra-__VERSION__
./install.sh
```

That is the whole install. It prints the URL at the end. Re-running it upgrades in place with the same settings.

**On Windows**, use the `.bat` files. Run them from cmd or PowerShell, or double-click them:

```bat
tar -xzf trinetra-__VERSION__-bundle.tgz
cd trinetra-__VERSION__
install.bat                                  & rem same options as install.sh
pcai-import.bat                              & rem PCAI Import Framework chart (asks for the registry)
uninstall.bat                                & rem asks before removing when double-clicked
```

They run the same `install.sh` / `uninstall.sh` through Git Bash, so Git for Windows must be installed. Windows' own `bash.exe` (WSL) is never used. Every option below works with the `.bat` too, e.g. `install.bat --registry harbor.example.com/tools`.

What `./install.sh` works out for you:

| Step | Default behaviour | Override |
|---|---|---|
| Image | Pushes the bundled image into a small loopback registry on each node (`127.0.0.1:5959`), so **no registry is needed** | `--registry harbor.example.com/tools` pushes to your registry instead (add `--registry-user`/`--registry-password` for a private one; a pull secret is created) |
| Access on **PCAI** | Detects the `ezaf-gateway` and the platform domain, then publishes **https://trinetra.&lt;domain&gt;** behind platform SSO (Keycloak via oauth2-proxy), like every other PCAI app | `--domain`, `--no-sso` |
| Access elsewhere | NodePort on every node; node IPs are added to the API's origin allowlist | `--host trinetra.example.com` (Ingress), `--clusterip` |
| State | A 2Gi PVC if the cluster has a default StorageClass | `--storage-class`, `--persistence off` |
| Cluster rights | Read-only, all namespaces | `--allow-write` enables restart/scale/delete buttons |

A port-forward also always works, with no DNS or ingress:
`kubectl -n trinetra port-forward svc/trinetra 8080:80` → http://localhost:8080

### Common variations

```bash
# Your registry (recommended for multi-node production clusters)
./install.sh --registry harbor.example.com/tools \
             --registry-user robot$trinetra --registry-password '...'

# AI engine: an in-cluster OpenAI-compatible endpoint (MLIS / vLLM / Ollama)
./install.sh --llm-url http://my-llm.my-ns.svc.cluster.local:8000/v1 --llm-model my-model
# ...or Gemini (the pod needs internet egress)
./install.sh --gemini-key AIza...

# Reach VMs outside the cluster over SSH (then use ~/.ssh/id_rsa as the key
# path when adding a VM in the UI)
./install.sh --ssh-key ~/.ssh/id_rsa --known-hosts ~/.ssh/known_hosts

# Show what would be installed without changing anything
./install.sh --dry-run
```

`./install.sh --help` lists every option.

## PCAI "Import Framework" (UI install)

Each run of `install.sh` also writes `out/trinetra-__VERSION__-pcai-import.tgz`. This is the Helm chart with the image location already filled in. To manage Trinetra from the PCAI console instead of Helm:

```bash
./install.sh --registry <registry-your-PCAI-pulls-from> --package-only
```

On Windows: `pcai-import.bat --registry <registry-your-PCAI-pulls-from>`. Or double-click `pcai-import.bat` and it asks for the registry, user and password (the password is not echoed).

Then go to **PCAI → Tools & Frameworks → Import Framework**, upload `out/trinetra-__VERSION__-pcai-import.tgz`, and keep the default values. The chart carries the PCAI `ezua:` block: the platform substitutes `${DOMAIN_NAME}`, and the chart creates the Istio VirtualService and the SSO AuthorizationPolicy. It also labels the pod `hpe-ezua/type: vendor-service` / `hpe-ezua/app: trinetra`, so PCAI can find the framework's pods.

What to enter in the wizard:

| Field | Value |
|---|---|
| Framework Name / Version | `Trinetra` / `__VERSION__` |
| Helm chart | upload `out/trinetra-__VERSION__-pcai-import.tgz`. Do not upload `chart/trinetra-__VERSION__.tgz`: that chart has no image location (`image.repository: trinetra`) and its pod can never pull. |
| Release Name | lower case, e.g. `trinetra` |
| Namespace | any, e.g. `trinetra` |
| Wait | optional; with it, the import only succeeds once the pod is Ready |
| Debug | tick it: on failure the status then shows helm's own error |

If the import fails:

- **`cannot re-use a name that is still in use`**: Trinetra was already installed in that namespace with `install.sh`. Remove that install first (`./uninstall.sh`, *without* `--purge`), or pick another namespace.
- **Install times out / pod `ImagePullBackOff`**: the image is not where the chart says. A chart built without `--registry` pulls from the per-node cache (`127.0.0.1:5959`) that `install.sh` set up. It must still be running (`./uninstall.sh --purge` deletes it), and nodes added later do not have the image. Rebuild with `--registry` so every node can pull.
- **`ClusterRole "trinetra" ... invalid ownership metadata`**: charts built before 2026-11-21 named their ClusterRole after the release only, so a second install clashed with the first. Rebuild the import chart from this bundle. RBAC objects are now named `<release>-<namespace>`.
- **Imported, but `https://trinetra.<domain>` does not open while an `install.sh` install still exists**: both publish the same hostname and Istio routes to only one of them. Keep one.

## Verify

```bash
helm test trinetra -n trinetra      # service → /healthz, /api/llm/defaults, UI
```

In the UI, **Settings → Test connection** checks the AI engine from inside the pod.

## Uninstall

```bash
./uninstall.sh            # removes the release; keeps the PVC (VM inventory, KB, history)
./uninstall.sh --purge    # removes the PVC, secrets, namespace and the node image cache too
```

## Security notes

- Default RBAC is read-only. Secrets are never granted: Trinetra does not read secret contents.
- On PCAI, the UI sits behind platform SSO unless you pass `--no-sso`.
- The container runs as uid 10001 with a read-only root filesystem, no capabilities and no privilege escalation.
- The per-node image cache listens on loopback only (`127.0.0.1:5959`), so it can't be reached from outside the node.
- Verify the bundle contents with `sha256sum -c SHA256SUMS`.
