# Kalam: System & Software Requirements

This document outlines the prerequisite software, system tools, and environment configurations required to build, run, and interact with the **Kalam Agentic Cluster Console**.

---

## 💻 System Prerequisites

To run Kalam locally, you need the following system tools installed and running:

1. **Node.js & npm**
   - **Recommended Version**: Node.js `v18.x` or higher (tested on `v20+` / `v22+`).
   - **Package Manager**: `npm` (packaged with Node.js) or `yarn` / `pnpm`.

2. **Container runtime — optional**
   - Kalam does **not** depend on Docker. It discovers containers from whichever runtime a machine has: Docker, containerd (via `crictl`), nerdctl or podman, and merges them into one list tagged by runtime.
   - A machine with no runtime at all is a normal case: add your VMs on the Virtual Machines tab and the dashboard, topology map and container views read them over SSH ("All hosts" merges every VM into one view).
   - Docker-only extras: image security scans and auto-hardening use `docker scout` / `docker pull` / `docker run` and need a Docker daemon on the machine running Kalam.
   - Every local probe has a timeout, so an installed-but-stopped Docker Desktop cannot stall the dashboard.

3. **Kubernetes (kubectl) — optional on this machine**
   - **kubectl CLI**: needed only to read a cluster from *this* machine. Clusters on VMs are read over SSH using the VM's own `kubectl`.
   - **Kubeconfig**: if you do use a local cluster, `~/.kube/config` must point to it (Docker Desktop's Kubernetes, Minikube, Kind, or a real cluster).

---

## 📁 Where Kalam writes state

Three files/directories are written at runtime. Each path is overridable, which
is what lets the container image stay read-only and keep its state on a mounted
volume — without this, every host added on the Virtual Machines tab is lost on
restart.

| Variable | Default | Holds |
| --- | --- | --- |
| `KALAM_VMS_PATH` | `server/vms.json` | the SSH inventory (hosts, users, credentials) |
| `KALAM_LEARNED_PATH` | `server/pcai/learned.json` | the learned knowledge base |
| `KALAM_HISTORY_DIR` | `server/history/data` | change-history snapshots and changelog |

All three are git-ignored at their defaults. The Helm chart sets them to a
volume automatically when `persistence.enabled=true`.

## ⏱️ Reading a large cluster

| Variable | Default | Effect |
| --- | --- | --- |
| `KALAM_KUBECTL_TIMEOUT_MS` | `120000` | Ceiling on a bulk cluster read. `kubectl` gets its own `--request-timeout` derived from this and set below it, so a slow or unreachable API server returns a readable error instead of being killed. Raise it if a very large cluster reports `timed-out`. |

This is deliberately separate from the 8-second probe timeout used for
`docker`/`kubectl` version checks. That short bound exists because a stopped
Docker Desktop on Windows blocks forever with no error of its own; applying it
to a bulk cluster read is what once made a large cluster report itself empty.

---

## 🔑 AI LLM Provider Configuration

Kalam requires one of the following to activate its agentic DevOps Chatbot:

* **Google Gemini API Key**:
  - Get a key from Google AI Studio.
  - Set it as `GEMINI_API_KEY` in your `.env` file or input it in the UI settings panel.
* **Local LLM Endpoint (e.g. Ollama or LM Studio)**:
  - An active local completion server running on your machine (e.g. `http://localhost:11434/v1` for Ollama).
  - A suitable downloaded model (e.g., `qwen2.5-coder` or `llama3`).

---

## 📦 Project Dependencies

These dependencies are managed automatically via `npm install` (stored in `package.json`):

### Frontend Stack
* **React 19**: Modern UI rendering.
* **Vite 8**: Ultra-fast frontend development server & build tool.
* **TypeScript**: Strong typing for client components.
* **Mermaid.js**: Dynamically renders topological relationship diagrams.
* **Lucide React**: Clean dashboard vector icons.

### Backend Stack
* **Express 5**: Handles REST API requests from the frontend client and CLI.
* **tsx**: Runs TypeScript backend scripts directly in development.
* **@google/genai**: Official SDK for Google Gemini interaction.
* **cors & dotenv**: Handle cross-origin requests and environment configurations.
