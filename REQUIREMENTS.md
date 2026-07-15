# Kalam: System & Software Requirements

This document outlines the prerequisite software, system tools, and environment configurations required to build, run, and interact with the **Kalam Agentic Cluster Console**.

---

## 💻 System Prerequisites

To run Kalam locally, you need the following system tools installed and running:

1. **Node.js & npm**
   - **Recommended Version**: Node.js `v18.x` or higher (tested on `v20+` / `v22+`).
   - **Package Manager**: `npm` (packaged with Node.js) or `yarn` / `pnpm`.

2. **Docker Desktop / Daemon**
   - **Daemon State**: Docker must be running to enable container management, listings, security scans, and auto-hardening features.
   - **Commands**: Kalam runs `docker ps`, `docker scout`, `docker pull`, `docker stop`, `docker rm`, and `docker run` directly via local subprocesses.

3. **Kubernetes (kubectl)**
   - **kubectl CLI**: Must be installed and configured on the system path.
   - **Active Cluster**: A running local Kubernetes cluster (such as Docker Desktop's built-in Kubernetes, Minikube, or Kind).
   - **Kubeconfig**: Your local context (`~/.kube/config`) must point to the active cluster.

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
