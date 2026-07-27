# Kalam — Architecture & Activity Flow

Kalam is a single-pane operations console for HPE Private Cloud AI (PCAI) environments:
it monitors VMs over SSH, inspects Docker/Kubernetes workloads, diagnoses cluster
problems read-only, and answers PCAI questions through a RAG-grounded AI assistant.

---

## 1. System overview

```mermaid
flowchart LR
    subgraph B["Clients"]
        UI["React UI: Dashboard, VM Monitor, PCAI Assistant, Stack Visualizer"]
        CLI["kalam CLI (bin/kalam.cjs)"]
    end

    subgraph N["Node.js backend"]
        API["Express server (index.ts, port 3001)"]
        RAG["PCAI RAG engine"]
        VMS["VM / SSH module (vms.ts)"]
        LLM["LLM router (llm.ts, pcai/router.ts)"]
    end

    subgraph L["Local machine"]
        DOCKER["Docker CLI"]
        KUBECTL["kubectl"]
        SSHBIN["system ssh"]
    end

    subgraph R["Remote"]
        VM["VMs / K8s nodes"]
        GEMINI["Google Gemini API"]
        ANY["Any OpenAI-compatible endpoint (Ollama, vLLM, MLIS, OpenAI, Groq...)"]
    end

    UI -->|"fetch /api (JSON + SSE)"| API
    CLI -->|"same /api (auto-starts server)"| API
    API --> RAG
    API --> VMS
    API --> LLM
    API -->|child_process| DOCKER
    API -->|child_process| KUBECTL
    VMS -->|execFile| SSHBIN
    SSHBIN --> VM
    LLM --> GEMINI
    LLM --> ANY
```

The browser never runs commands itself — every privileged action goes through the
Express backend, which shells out via Node's `child_process` (the same mechanism as
Python's `subprocess`).

---

## 2. Activity flows

### 2.1 VM monitoring & workload discovery

```mermaid
sequenceDiagram
    participant U as User (browser)
    participant S as Express server
    participant V as Remote VM (ssh)

    U->>S: POST /api/vms (name, host, user, key)
    S->>S: validate + persist to vms.json
    U->>S: POST /api/vms/metrics
    S->>V: TCP probe, then ssh hostname/loadavg/free/df/nvidia-smi
    V-->>S: KEY:value lines
    S-->>U: reachable, load, mem, disk, gpu, uptime
    U->>S: POST /api/vms/discover
    S->>V: ssh docker ps + kubectl get pods + crictl ps
    V-->>S: sectioned output
    S-->>U: containers + pods + runtimes tables
```

### 2.2 Read-only cluster diagnosis (Diagnose button)

The diagnostic engine **only inspects — it never fixes**. Every command it runs is
`kubectl get / describe / logs / events`. Fix suggestions are returned as text for a
human to review.

```mermaid
sequenceDiagram
    participant U as User
    participant S as Express server
    participant V as VM with kubectl

    U->>S: POST /api/vms/diagnose
    S->>V: ssh kubectl get nodes/pods -o json + warning events
    V-->>S: cluster state (JSON)
    S->>S: rule engine flags NotReady, CrashLoopBackOff, OOMKilled, ImagePullBackOff, Pending, Evicted
    S->>V: ssh kubectl describe + logs --tail for top 5 problem pods
    V-->>S: evidence (events + log excerpts)
    S-->>U: findings with severity, likely cause, logs, suggested fixes (NOT executed)
```

Failure patterns → diagnosis mapping (in `server/vms.ts`):

| Pattern | Likely cause | Suggested (reported-only) fix |
|---|---|---|
| CrashLoopBackOff | app crashing on start (config/env/dependency) | fix root error, rollout restart / undo |
| OOMKilled / exit 137 | memory limit too low or leak | raise memory limit, check `kubectl top` |
| ImagePullBackOff | wrong image, missing pull secret, no registry access | verify image, create `regcred`, fix tag |
| CreateContainerConfigError | missing ConfigMap/Secret | create the referenced object |
| Pending | unschedulable: resources / taints / PVC | read FailedScheduling event, adjust |
| Evicted | node disk/memory pressure | free disk, delete evicted record |
| Node NotReady | kubelet/containerd down, pressure | `systemctl status kubelet`, journal |

### 2.3 PCAI Assistant (RAG chat)

```mermaid
sequenceDiagram
    participant U as User
    participant S as Express server
    participant E as Embeddings (Gemini or local)
    participant M as Chat model (any endpoint)

    U->>S: Train (POST /api/pcai/train)
    S->>S: crawl HPE PCAI docs, chunk text
    S->>E: embed chunks, persist knowledge base
    U->>S: POST /api/pcai/chat/stream (prompt, provider, model)
    S->>E: embed the question, cosine-match top chunks
    S->>M: system prompt + retrieved context + question
    M-->>S: token stream
    S-->>U: SSE deltas + source citations
    Note over S,U: If no model is reachable, Kalam streams the retrieved docs directly.
```

### 2.4 Model flexibility — any endpoint works

The chat provider is pluggable at three levels (Settings → AI Engine):

1. **Gemini** — Google API key (`.env` or UI).
2. **Local** — Ollama / LM Studio, with automatic model discovery and one-click pulls.
3. **Custom** — *any* OpenAI-compatible `/v1` endpoint: vLLM, HPE MLIS deployments,
   OpenAI, Groq, OpenRouter, Together, etc. Supply base URL + model + optional Bearer
   token. "Detect models" lists what the endpoint serves (authenticated `/models` call).

All non-Gemini traffic uses the standard OpenAI `chat/completions` protocol with
streaming, so a new provider needs zero code changes.

---

## 3. Why this tech stack

**TypeScript end-to-end (React + Node/Express), not Python/Flask:**

- **The product is UI-heavy.** The core value is the interactive single pane: React
  Flow / Cytoscape / Mermaid graph views, live-streaming chat, dashboards. That
  ecosystem is JavaScript-native; a Python backend would still need this exact
  frontend, adding a second language for no gain.
- **Node has the same OS powers as Python.** `child_process` (exec/execFile/spawn)
  covers everything `subprocess` does: running `kubectl`, `docker`, and `ssh`. All
  remote work shells out to the system `ssh` binary with argument arrays (no shell
  interpolation of user input) — no heavy SSH library needed.
- **One toolchain.** One `npm install`, shared types between client and server, one
  build (`tsc && vite build`), one runtime to install on a client machine. Flask +
  gunicorn/uvicorn would mean two runtimes, two dependency managers, and hand-kept
  JSON contracts.
- **Type safety across the wire.** API request/response shapes are TypeScript
  interfaces used by both sides; mismatches fail at compile time.
- **Streaming is first-class.** SSE token streaming from LLMs to the browser is a
  few lines in Express + `fetch` readers.
- **Simple deployment.** In production, Express also serves the built frontend from
  `dist/`, so the whole app is a single Node process on one port (3001) — which is
  what `start.bat` launches.

**Key choices inside the stack:**

| Choice | Why |
|---|---|
| Vite | instant dev server + fast production builds; `/api` proxy in dev |
| Express 5 | minimal, battle-tested HTTP layer; routers per domain (pcai, llm, vms) |
| system `ssh` via `execFile` | zero native deps, uses the user's keys/agent, args never shell-interpolated |
| SSE (not WebSockets) | one-directional streams (chat tokens, pull progress) — simpler, proxy-friendly |
| JSON file persistence (`vms.json`, KB store) | no database to install for a portable single-node tool |
| OpenAI-compatible protocol for all non-Gemini models | one client implementation covers every local and hosted provider |

---

## 4. Deployment / handoff flow

```mermaid
flowchart LR
    A["export_all.bat: zip without node_modules / .git / .env"] --> B["copy zip to client machine"]
    B --> C["setup.bat: install Node, npm install, create .env, link CLI"]
    C --> D["start.bat: build frontend, start server on 3001, open browser"]
```

---

## 5. The `kalam` CLI

`bin/kalam.cjs` (registered globally by `npm link` / `setup.bat`) is a thin client of
the same Express API — it owns no logic of its own, so the UI and CLI always behave
identically.

```mermaid
flowchart LR
    T["Terminal: kalam ask / solve / chat / train / status"] --> CLI["bin/kalam.cjs"]
    CLI -->|"backend up?"| API["Express server :3001"]
    CLI -.->|"if down: spawn node + tsx directly, poll every 250ms"| API
    API --> ANSWER["SSE stream rendered live with ANSI markdown"]
```

Key behaviors:

- **Auto-start** — if the backend isn't running, the CLI spawns it via the local
  `tsx` binary through the current Node process (no `npx` resolver overhead) and
  polls readiness every 250 ms; once confirmed up, health checks are skipped for
  the rest of the session.
- **Interactive REPL** (`kalam` with no args) — streaming answers, slash commands
  (`/model`, `/provider`, `/mode`, `/train`, `/status`, `/run <n>`), intent routing
  (auto-detects ask vs. diagnose vs. DevOps from the message), and conversation
  memory. Prose streams token-by-token; headings, bullets, and code blocks are
  colored as lines complete.
- **Ctrl+C cancels, not kills** — during a streaming answer the first Ctrl+C aborts
  just that answer and returns to the prompt; when idle it exits.
- **One-shot + pipes** — `kalam ask "..."`, `kubectl logs pod | kalam solve`,
  `kalam list docker|k8s`, `kalam scan/fix <container>`.
- **Settings persistence** — provider/model/mode choices are saved to `~/.kalam.json`
  and merged with `.env` on startup, so the model you pick sticks across sessions.
