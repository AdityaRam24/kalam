# Kalam: Agentic DevOps & Cluster Console

Kalam is an **Agentic DevOps Dashboard & Chatbot** that captures containers and Kubernetes clusters — on this machine or on any host reachable over SSH — auto-generates visual topology graphs (using Mermaid), and integrates a conversational AI agent to analyze cluster states and run approved maintenance operations. It has no dependency on Docker: containers are read from whichever runtime a host actually has (Docker, containerd, nerdctl, podman).

---

## ⚡ Core Features

* **🎨 Auto-Generated Mermaid Graphs**: Instantly parses active containers, host ports, Kubernetes nodes, deployments, services, namespaces, and pods, rendering them in a beautiful, reactive SVG map. The map draws whatever exists — nodes and services alone are enough; it never waits for Docker.
* **🗺️ Cluster topology map with real relationships**: A left-to-right pipeline banded by namespace — Services → Workloads → Pods → Nodes. Edges come from Kubernetes itself (`ownerReferences` followed through the ReplicaSet, label selectors, `spec.nodeName`), not from guessing at names, and StatefulSets and DaemonSets are first-class so databases and queues are not left floating. Stages wrap into balanced grids instead of one endless column. `npm run topology:check` asserts the geometry — no overlaps, stages in distinct columns, namespaces banded — against a live cluster and exits non-zero if it fails.
* **📦 Container Manager (any runtime)**: View properties of all containers, execute standard commands (start, stop, restart, delete), and stream live stdout/stderr logs. Docker, containerd (`crictl`), nerdctl and podman are all discovered and merged into one list, each tagged with its runtime.
* **🛡️ Container Vulnerability Scanner & Hardener**: Scans container images for CVE vulnerabilities and offers a one-click automated patch/upgrade to minimal Alpine/slim base images.
* **☸️ Kubernetes Explorer**: Sectioned view of nodes, deployments, services, and pods. Restarts rollouts, deletes pods, and scales deployment replica counts.
* **📖 Kubectl Reference Guide & Tools**: A searchable catalog of ~90 commands where every entry is labelled by what it can do to your cluster (read-only / changes state / destructive), fills in its own `<placeholders>`, and — when it is read-only — runs against a connected VM with the output inline. Plus a validating command builder, eight diagnostic runbooks, and a practice quiz.
* **🕸️ Dependency Graph & Root-Cause Analysis**: Builds a typed graph of what depends on what (VMs → nodes → pods → services/PVCs, plus platform dependencies like SPIRE, CNI and CSI drivers) from one read-only SSH pass. Turns fourteen red pods into one cause with thirteen casualties, and answers "what breaks if I stop this?" before you stop it.
* **🕓 Cluster Change History**: Answers "what changed, when, and who did it" — the question Kubernetes itself cannot, since its events expire after about an hour. Kalam fingerprints the cluster (workloads, pods, nodes, networking, storage, config and RBAC), diffs each capture against the last, and keeps a durable changelog with field-level before→after values, the writer named from `managedFields`, and Deployment rollout revisions. Read-only, opt-in, and it never stores secret contents.
* **📜 Host Logs — the whole machine, not just the cluster**: Pick any VM from the SSH inventory and get one page that answers "what is wrong with this host?":
  * **System overview** — OS, kernel, uptime, CPU load, memory/swap, every filesystem (space and inodes), top processes, listening ports, recent reboots, and a health checklist that flags full disks, low memory, overload, failed or restarting systemd services and clock drift.
  * **Scan for issues** — a deterministic rule engine (no LLM needed) reads recent `/var/log` files, the systemd journal and `dmesg`, and groups what it finds: OOM kills, disk full, filesystem/I/O/hardware errors, NVIDIA Xid, kernel lockups, crashes, failed services, kubelet/containerd errors, certificate and clock problems, SSH brute force. Each finding has an **Explain** panel with the likely cause and read-only commands to run next.
  * **Fix a service in place** — **Status**, **Start** and **Restart** buttons on every systemd service, on failed-service health checks, and on log findings linked to the unit that logged them (e.g. *Restart kubelet.service* next to a PLEG error). Restarts are confirmed, validated and logged; there is deliberately no *stop*.
  * **Journal explorer** — every read-only `journalctl` option as a form: units, identifiers, priority ranges, boots (including the previous one), since/until, regex or text search, `FIELD=value` matches, 12 output modes, `-x`, follow mode, `--verify`, and one-click presets. The exact command is shown for copying.
  * **Browse and download** — the `/var/log` tree with a tail/grep viewer (compressed rotations too), and downloads of a single file, a selection, or all of `/var/log` as `.tar.gz`.
* **🖥️ View any connected host, not just this machine**: A source picker in the header switches every cluster view — dashboard, topology map, Containers and Kubernetes tabs — between this machine, any VM or cluster node in the SSH inventory, or **All hosts** merged into one view. Containers, pods, services, nodes and deployments are read over one SSH round trip, and logs, restarts, scaling and pod deletion act on the host each object came from. When this machine has no runtime and no cluster of its own, Kalam points itself at the VMs automatically.
* **🛡️ Root access for connected hosts**: After a host is added or its credentials change, Kalam offers to elevate it — `sudo`, `su - root`, or a direct root login — probing first for what that host actually allows and verifying the choice (`id -un` must answer `root`) before saving it. This matters because containerd (`crictl`), kubelet config and service logs are root-only: an unprivileged login makes a busy machine look empty.
* **⌨️ Real remote terminal, and a root terminal**: A persistent login shell on a PTY per session, so `cd`, exported variables, `sudo` prompts, Ctrl+C, tab completion and full-screen tools all behave as they do in MobaXterm — instead of each command starting from scratch in a non-interactive shell. Every host has a **Root terminal** button beside the normal one, which elevates with `sudo -i` / `su -` whether or not elevation is configured for that host. A stored password is only ever sent in reply to a prompt that is actually waiting for one, so a passwordless-sudo host never has it typed into the root shell.
* **💬 Agentic Chat Console**: Injects active cluster details into the prompt context of Google Gemini (`gemini-3-flash-preview`), Local LLMs (Ollama, LM Studio) or any OpenAI-compatible endpoint (vLLM, HPE MLIS, OpenAI…), draws customized mermaid charts dynamically, and recommends action triggers that execute upon user approval. **Test connection** in Settings runs a real completion against the configured engine and says exactly what is wrong when it fails — off the VPN, wrong port, token rejected, untrusted certificate, model not served.

---

## 📋 System Requirements

Please refer to the [REQUIREMENTS.md](file:///c:/Users/Steve/Desktop/kalam/REQUIREMENTS.md) file for complete prerequisite details.

* **Node.js**: `v20.x` or higher (Vite 8 / TypeScript 6)
* **Optional — a container runtime on this machine**: Docker, containerd (`crictl`), nerdctl or podman. Not needed at all if your workloads live on VMs.
* **Optional — kubectl**: only to read a cluster from *this* machine; VM clusters are read over SSH.
* **Google Gemini API Key**, **Local LLM Server (Ollama)** or an **OpenAI-compatible endpoint** (e.g. HPE MLIS — this machine must be on its network)

---

## 🚀 How to Setup & Run

### In a Kubernetes cluster — use the Helm chart in [`deploy/helm/kalam`](deploy/helm/kalam/README.md)

```bash
docker build -t <registry>/kalam:0.1.0 .   &&   docker push <registry>/kalam:0.1.0
helm upgrade --install kalam deploy/helm/kalam -n kalam --create-namespace   --set image.repository=<registry>/kalam --set image.tag=0.1.0
```

Read-only by default (`rbac.allowWrite=false`) and cluster-only until you give
it an SSH key. See the chart README for the four values that matter.

### On Linux / macOS — use the scripts in [`scripts/`](scripts/README.md)

```bash
chmod +x scripts/*.sh    # once, if the exec bit didn't survive the clone
./scripts/setup.sh       # prerequisites + .env + npm install + frontend build
./scripts/start.sh       # run it → http://127.0.0.1:3001  (single port)
./scripts/dev.sh         # or hot-reload mode → http://127.0.0.1:5173
./scripts/doctor.sh      # diagnose connection errors (e.g. ECONNREFUSED :5173)
./scripts/stop.sh        # free the ports
```

On Windows, the equivalents are `setup.bat`, `start.bat` and `install-cli.bat`.

### 1. Install Project Dependencies
Run npm install in the project root:
```bash
npm install
```

### 2. Configure Settings
Open the application, click on the **Sliders (Gear)** icon in the top header, and configure:
* **LLM Provider**: Choose "Google Gemini" or "Local LLM".
* **For Google Gemini**: Supply your API key (saved in browser memory).
* **For Local LLM**: Input your endpoint URL (e.g., `http://localhost:11434/v1` for Ollama) and your model name (e.g., `qwen2.5-coder` or `llama3`).

Alternatively, copy `.env` configuration file and provide your `GEMINI_API_KEY`:
```bash
cp .env.example .env  # Or edit `.env` directly
```

### Optional: record cluster changes continuously

The Change History tab compares captures of the cluster, so it needs something
to take them. Press **Capture now** whenever you like, or record continuously by
setting these before starting the server:

```bash
KALAM_HISTORY=1                  # opt in — nothing polls your cluster otherwise
KALAM_HISTORY_INTERVAL_SEC=300   # how often to capture (default 5 minutes)
KALAM_HISTORY_SOURCES=local      # or: all — this machine plus every inventory VM
KALAM_HISTORY_RETENTION_DAYS=30  # how far back the changelog is kept
```

Captures only ever run `kubectl get`. They are stored in `server/history/data/`
(gitignored) as compact fingerprints — never full manifests, never Secret or
ConfigMap contents, and inline env values are hashed rather than written down.

### 3. Run in Development Mode
Start both frontend Vite client and Express server concurrently:
```bash
npm run dev
```
Open your browser and navigate to **[http://localhost:5173](http://localhost:5173)** to start managing your cluster!

---

## 🧠 HPE Private Cloud AI (PCAI) Assistant

Kalam includes a dedicated **PCAI Assistant** panel — a retrieval-grounded chatbot that knows HPE Private Cloud AI end to end (AI Essentials / MLDE / MLDM / MLIS, the data lakehouse, NVIDIA AI Enterprise & NIM, HPE GreenLake management, and the Kubernetes platform PCAI runs on).

It is a **RAG (Retrieval-Augmented Generation)** system, not a memorized model: it ingests real HPE documentation into a local knowledge base, retrieves the most relevant docs for every question, and answers **grounded in those sources with inline `[[n]]` citations** — so it doesn't hallucinate HPE-specific details.

**Using it**
1. Open the **PCAI Assistant** tab (sidebar → AI Intelligence).
2. Click **Train / Build Knowledge Base** to ingest. This crawls the public HPE docs (HPE Developer Portal, `docs.ai-solutions.ext.hpe.com`, MLDE docs) and merges them with a curated offline seed of PCAI facts + common errors. Re-run any time to refresh ("train yourself").
3. **Ask** mode — ask anything about PCAI. **Diagnose Error** mode — paste an error, log, or stack trace and get likely root cause + ordered fix steps (kubectl / GreenLake / AI Essentials).

**How it works**
* Embeddings + chat use whichever engine you configured in Settings — **Google Gemini** or a **Local LLM (Ollama / LM Studio)** — switchable. With no engine configured it still works via **lexical search** and returns the raw retrieved docs.
* Knowledge base is stored at `server/pcai/kb.json` (git-ignored, rebuildable). Backend lives in `server/pcai/`; endpoints: `GET /api/pcai/status`, `POST /api/pcai/ingest`, `POST /api/pcai/chat`.

> Note: This assistant is an independent tool and is **not affiliated with or endorsed by HPE**. It cites public HPE documentation for reference.

## 🛠️ Command Line Interface (CLI)

Kalam ships a global `kalam` command — a streaming, Claude-Code-style terminal assistant for HPE Private Cloud AI plus agentic Docker/Kubernetes ops.

### Install the `kalam` command

Install it once so you can type `kalam` from anywhere:

```bash
npm run cli:install     # runs `npm link`
```

Platform shortcuts:
* **Windows** — double-click `install-cli.bat` (run as Administrator if `npm link` is blocked).
* **macOS / Linux** — `npm link` (use `sudo npm link` if permission is denied).

Then open a **new** terminal so the updated `PATH` is picked up, and run:

```bash
kalam help
```

> Not ready to install globally? Every command works via `node bin/kalam.cjs <command>` or `npm run cli -- <command>` from the project root.

### No setup required

Commands that need AI **auto-start the backend server for you** — you don't have to run `npm run dev` first. On first use, Kalam also builds an offline PCAI knowledge base automatically.

For fully composed (LLM-written) answers, either put a `GEMINI_API_KEY` in `.env`, or run a local LLM (Ollama / LM Studio). With **neither** configured it still works via lexical search and returns the exact retrieved HPE docs.

### Interactive assistant (recommended)

Just run `kalam` with no arguments to launch the streaming REPL:

```bash
kalam
```

Type naturally — Kalam auto-routes each message to the right engine (PCAI answer, error diagnosis, or the DevOps agent). Inside the REPL you have these **slash commands**:

| Command | What it does |
| --- | --- |
| `/model` | Pick which installed local model to use (interactive) |
| `/models` | List installed Ollama / local models |
| `/provider <gemini\|local>` | Switch the engine |
| `/mode <auto\|ask\|diagnose\|devops>` | Force how messages are routed (default `auto`) |
| `/train [--offline]` | Build / refresh the HPE knowledge base |
| `/kb` | Knowledge-base status |
| `/status` | Local container runtime & Kubernetes health |
| `/run <n>` | Execute suggested action #n from the last reply |
| `/key <api-key>` | Save your Gemini API key and switch to Gemini |
| `/clear` | Clear the screen & conversation memory |
| `/help` | Show the command list |
| `/exit` | Quit |

> Tip: prefix any line with `solve:` to force error diagnosis, or just paste a stack trace.

### One-shot commands

Run a single task without entering the REPL:

**HPE PCAI brain**
* `kalam ask "<question>"` — ask anything about HPE Private Cloud AI (streamed, with citations).
* `kalam solve "<error/log>"` — diagnose a PCAI error and get an ordered fix. Also reads piped input:
  ```bash
  kubectl logs mypod | kalam solve
  ```
* `kalam pcai` — open the interactive PCAI assistant shell.
* `kalam train [--offline]` — build/refresh the knowledge base (crawls live HPE docs unless `--offline`).
* `kalam kb` — show knowledge-base status.

**Models**
* `kalam models` — list installed Ollama / local models.
* `kalam model` — pick the default local model interactively.

**Remote VMs (SSH, read-only)**
* `kalam vms` — inventory with live status.
* `kalam vm ssh <name>` — interactive session (hops through a jump host if configured).
* `kalam vm diagnose <name>` — read-only kubectl diagnosis; findings are ordered causes-first, with collateral marked as "downstream of …".
* `kalam vm discover <name>` — containers, pods, K8s + system services, listening ports.
* `kalam vm graph <name>` — build the dependency graph and rank the root causes.
* `kalam vm impact <name> <id>` — blast radius: what is already broken downstream of a resource, and what is healthy but at risk.
* `kalam vm peers <name>` — find other VMs visible from this host.

**Host logs, health & services (on a VM)**
* `kalam vm health <name>` — health checks (disks, inodes, memory, load, failed/restarting services, clock) plus failed services.
* `kalam vm logs <name> [--hours 24] [--all]` — scan `/var/log`, the journal and `dmesg`; grouped findings with explanations, checks to run, and the service to restart when one is linked.
* `kalam vm journal <name> [options]` — `journalctl` on the host with the same flags: `-u -t -k -p err..warning -b -1 -S -U -g` (regex) / `--text`, `FIELD=value`, `-o -n -r -x --utc --no-hostname`, and `-f` to follow.
* `kalam vm service <name> <unit> [status|start|restart] [--yes]` — service state, `systemctl status` and its journal; start/restart ask for confirmation (or take `--yes`). There is no `stop`.

**Change history (read-only)**
* `kalam history [--source <local|vm>] [--since 24h]` — the cluster changelog: what changed, when, and who did it.
* `kalam history capture [--source <name>]` — take a capture now; the one after it can show changes.
* `kalam vm history <name>` — the same timeline for a VM's cluster.

**Local DevOps**
* `kalam status` — check which container runtimes and Kubernetes are available on this machine.
* `kalam list <docker|k8s>` — print active containers or Kubernetes pods (`kalam ps` also works).
* `kalam scan <container-id>` — scan a container image for CVEs.
* `kalam fix <container-id>` — rebuild the container on a secure base image (asks for confirmation).
* `kalam chat [message]` — cluster-aware DevOps agent; pass a message for one-shot, or omit it for a prompt loop.

> Anything unrecognized is treated as a question, e.g. `kalam what is MLIS?`.

Your chosen provider, model, mode, and Gemini key persist across sessions in `~/.kalam.json`.

### Examples

```bash
kalam                                                    # launch the interactive assistant
kalam ask "how do I connect an external S3 bucket to the lakehouse?"
kubectl logs mypod | kalam solve                         # diagnose from a live log
kalam scan my-nginx                                       # CVE scan a container
kalam list k8s                                            # list Kubernetes pods
kalam model                                               # switch local model
kalam vm logs node1 --hours 24                            # what went wrong on this host today
kalam vm journal node1 -b -1 -p err -n 200                # errors from the previous boot
kalam vm journal node1 -u kubelet -f                      # follow kubelet's journal
kalam vm service node1 kubelet restart                    # confirm, restart, show state + journal
```
