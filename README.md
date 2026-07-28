# Kalam: Agentic DevOps & Cluster Console

Kalam is an **Agentic DevOps Dashboard & Chatbot** that captures locally running Docker containers and Kubernetes clusters, auto-generates visual topology graphs (using Mermaid), and integrates a conversational AI agent to analyze cluster states and run approved maintenance operations.

---

## ⚡ Core Features

* **🎨 Auto-Generated Mermaid Graphs**: Instantly parses active Docker containers, host ports, Kubernetes nodes, deployments, services, namespaces, and pods, rendering them in a beautiful, reactive SVG map.
* **🐳 Docker Collection Manager**: View properties of all containers, execute standard commands (start, stop, restart, delete), and stream live stdout/stderr logs.
* **🛡️ Container Vulnerability Scanner & Hardener**: Scans container images for CVE vulnerabilities and offers a one-click automated patch/upgrade to minimal Alpine/slim base images.
* **☸️ Kubernetes Explorer**: Sectioned view of nodes, deployments, services, and pods. Restarts rollouts, deletes pods, and scales deployment replica counts.
* **📖 Kubectl Reference Guide & Tools**: A searchable catalog of ~90 commands where every entry is labelled by what it can do to your cluster (read-only / changes state / destructive), fills in its own `<placeholders>`, and — when it is read-only — runs against a connected VM with the output inline. Plus a validating command builder, eight diagnostic runbooks, and a practice quiz.
* **🕸️ Dependency Graph & Root-Cause Analysis**: Builds a typed graph of what depends on what (VMs → nodes → pods → services/PVCs, plus platform dependencies like SPIRE, CNI and CSI drivers) from one read-only SSH pass. Turns fourteen red pods into one cause with thirteen casualties, and answers "what breaks if I stop this?" before you stop it.
* **💬 Agentic Chat Console**: Injects active cluster details into the prompt context of Google Gemini (`gemini-3-flash-preview`) or Local LLMs (Ollama, LM Studio), draws customized mermaid charts dynamically, and recommends action triggers that execute upon user approval.

---

## 📋 System Requirements

Please refer to the [REQUIREMENTS.md](file:///c:/Users/Steve/Desktop/kalam/REQUIREMENTS.md) file for complete prerequisite details.

* **Node.js**: `v18.x` or higher
* **Docker Desktop**: Active/Running daemon
* **Kubernetes (kubectl)**: Connected local cluster context
* **Google Gemini API Key** or **Local LLM Server (Ollama)**

---

## 🚀 How to Setup & Run

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
| `/status` | Local Docker & Kubernetes health |
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

**Local DevOps**
* `kalam status` — check local Docker and Kubernetes daemons.
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
```
