# Kalam: Agentic DevOps & Cluster Console

Kalam is an **Agentic DevOps Dashboard & Chatbot** that captures locally running Docker containers and Kubernetes clusters, auto-generates visual topology graphs (using Mermaid), and integrates a conversational AI agent to analyze cluster states and run approved maintenance operations.

---

## ⚡ Core Features

* **🎨 Auto-Generated Mermaid Graphs**: Instantly parses active Docker containers, host ports, Kubernetes nodes, deployments, services, namespaces, and pods, rendering them in a beautiful, reactive SVG map.
* **🐳 Docker Collection Manager**: View properties of all containers, execute standard commands (start, stop, restart, delete), and stream live stdout/stderr logs.
* **🛡️ Container Vulnerability Scanner & Hardener**: Scans container images for CVE vulnerabilities and offers a one-click automated patch/upgrade to minimal Alpine/slim base images.
* **☸️ Kubernetes Explorer**: Sectioned view of nodes, deployments, services, and pods. Restarts rollouts, deletes pods, and scales deployment replica counts.
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

## 🛠️ Command Line Interface (CLI)

Kalam comes with a terminal CLI. To view help and commands:
```bash
node bin/kalam.cjs help
```

### Supported Commands:
* `status` - Check if local Docker and Kubernetes daemons are running.
* `list <docker|k8s>` - Print active containers or pod namespaces.
* `scan <container-id>` - Scan container image layers for vulnerabilities.
* `fix <container-id>` - Rebuild and launch the container on a secure base image.
* `chat [message]` - Command line conversational agent prompt loop.
