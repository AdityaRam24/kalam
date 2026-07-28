#!/usr/bin/env node

const { exec, spawn } = require('child_process');
const http = require('http');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');

// CLI Styling Colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3001;
const BACKEND_URL = `http://localhost:${PORT}`;
const CONFIG_PATH = path.join(os.homedir(), '.kalam.json');
const VERSION = require(path.join(PROJECT_ROOT, 'package.json')).version || '0.0.0';

// ---------------------------------------------------------------------------
// Settings: merge .env (secrets) + ~/.kalam.json (user's saved preferences) so
// the model/provider you pick in the REPL sticks across sessions.
// ---------------------------------------------------------------------------
function loadFileEnv() {
  const env = {};
  try {
    const raw = fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        env[m[1]] = v;
      }
    });
  } catch (_) { /* no .env, fine */ }
  return env;
}

function loadUserConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveUserConfig(patch) {
  const cfg = { ...loadUserConfig(), ...patch };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (_) { /* best effort */ }
  return cfg;
}

const fileEnv = loadFileEnv();
let userCfg = loadUserConfig();

// Live, mutable session settings (start from env + saved config).
const session = {
  geminiKey: process.env.GEMINI_API_KEY || fileEnv.GEMINI_API_KEY || userCfg.geminiKey || '',
  provider: process.env.KALAM_PROVIDER || userCfg.provider || (process.env.GEMINI_API_KEY || fileEnv.GEMINI_API_KEY ? 'gemini' : 'local'),
  localUrl: process.env.KALAM_LOCAL_URL || userCfg.localUrl || fileEnv.LOCAL_LLM_URL || 'http://localhost:11434/v1',
  localModel: process.env.KALAM_LOCAL_MODEL || userCfg.localModel || fileEnv.LOCAL_LLM_MODEL || 'qwen2.5-coder:7b',
  embedModel: userCfg.embedModel || 'nomic-embed-text',
  mode: userCfg.mode || 'auto', // auto | ask | diagnose | devops
};

function aiSettings() {
  return {
    apiKey: session.geminiKey,
    provider: session.provider,
    localUrl: session.localUrl,
    localModel: session.localModel,
    embedModel: session.embedModel,
  };
}

function engineLabel() {
  return session.provider === 'gemini' ? 'Gemini 3 Flash' : `${session.localModel} ${colors.gray}(local)${colors.reset}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function runCmd(command) {
  return new Promise((resolve) => {
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      resolve({ success: !error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function getJSON(p, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BACKEND_URL}${p}`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) reject(new Error(data || `HTTP ${res.statusCode}`));
          else resolve(JSON.parse(data));
        } catch (e) { reject(new Error(`Bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', (err) => reject(new Error(err.message)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
  });
}

function postJSON(p, payload, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(`${BACKEND_URL}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) reject(new Error((JSON.parse(data).error || data) || `HTTP ${res.statusCode}`));
          else resolve(JSON.parse(data));
        } catch (e) { reject(new Error(`Bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', (err) => reject(new Error(err.message)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

// Stream a Server-Sent-Events chat endpoint. Calls handlers as events arrive.
// The active request is tracked so Ctrl+C can cancel the answer without
// killing the whole REPL.
let activeStreamReq = null;
function cancelActiveStream() {
  if (activeStreamReq) { activeStreamReq.destroy(new Error('cancelled')); activeStreamReq = null; return true; }
  return false;
}
function streamChat(pathname, payload, { onSources, onDelta } = {}, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(`${BACKEND_URL}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'text/event-stream' }
    }, (res) => {
      if (res.statusCode >= 400) {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => reject(new Error(data || `HTTP ${res.statusCode}`)));
        return;
      }
      res.setEncoding('utf8');
      let buffer = '';
      let full = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const raw = t.slice(5).trim();
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'sources' && onSources) onSources(evt.sources || []);
            else if (evt.type === 'delta' && evt.text) { full += evt.text; if (onDelta) onDelta(evt.text); }
          } catch { /* ignore keepalive */ }
        }
      });
      res.on('end', () => { activeStreamReq = null; resolve(full); });
    });
    activeStreamReq = req;
    req.on('error', (err) => { activeStreamReq = null; reject(new Error(err.message)); });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Stream timed out')); });
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Auto-start the backend + knowledge base
// ---------------------------------------------------------------------------
let serverKnownUp = false; // once confirmed, skip re-checking on every command
async function isServerUp(timeoutMs = 1200) {
  try { await getJSON('/api/pcai/status', timeoutMs); serverKnownUp = true; return true; } catch { return false; }
}

async function ensureServer() {
  if (serverKnownUp || await isServerUp()) return true;
  process.stdout.write(`${colors.gray}Backend not running — starting it for you...${colors.reset}`);
  // Spawn tsx directly through the current Node binary — much faster than the
  // `npx` resolver, which adds 1-2s of lookup overhead on every cold start.
  const tsxCli = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let child;
  if (fs.existsSync(tsxCli)) {
    child = spawn(process.execPath, [tsxCli, 'server/index.ts'], {
      cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env }
    });
  } else {
    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    child = spawn(npxBin, ['tsx', 'server/index.ts'], {
      cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32', env: { ...process.env }
    });
  }
  child.unref();
  // Poll fast (every 250ms) so we attach the moment the server is ready,
  // instead of the old 1-second granularity.
  for (let i = 0; i < 100; i++) {
    await sleep(250);
    if (i % 4 === 3) process.stdout.write('.');
    if (await isServerUp(600)) {
      readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
      console.log(`${colors.green}✅ Backend is up.${colors.reset}`);
      return true;
    }
  }
  readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
  console.log(`${colors.red}❌ Could not start the backend automatically.${colors.reset}`);
  console.log(`   Open a terminal in the project folder and run: ${colors.bold}npm run server${colors.reset}\n`);
  return false;
}

async function ensureKnowledgeBase(prefetchedStatus) {
  try {
    const st = prefetchedStatus || await getJSON('/api/pcai/status');
    if (st.ready && st.chunks > 0) return true;
  } catch { /* fall through */ }
  process.stdout.write(`${colors.gray}First run: building the PCAI knowledge base (offline seed)...${colors.reset}`);
  try {
    await postJSON('/api/pcai/ingest', { crawl: false, ...aiSettings() });
    readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
    console.log(`${colors.green}✅ Knowledge base ready.${colors.reset} ${colors.gray}(run '/train' to also crawl live HPE docs)${colors.reset}`);
    return true;
  } catch (e) {
    console.log(`\n${colors.red}❌ Failed to build knowledge base: ${e.message}${colors.reset}\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// Format a single completed markdown line with ANSI colors.
function formatLine(line) {
  const heading = line.match(/^(#{1,4})\s+(.*)$/);
  if (heading) return `${colors.bold}${colors.magenta}${inlineFmt(heading[2])}${colors.reset}`;
  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (bullet) return `${bullet[1]}${colors.green}•${colors.reset} ${inlineFmt(bullet[2])}`;
  const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (numbered) return `${numbered[1]}${colors.green}${colors.bold}${numbered[2]}.${colors.reset} ${inlineFmt(numbered[3])}`;
  return inlineFmt(line);
}
function inlineFmt(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, `${colors.bold}$1${colors.reset}`)
    .replace(/`([^`]+)`/g, `${colors.cyan}$1${colors.reset}`)
    .replace(/\[\[(\d+)\]\]/g, `${colors.green}[$1]${colors.reset}`);
}

// A line-buffered streaming renderer: flushes formatted lines as newlines
// arrive (responsive + polished), colors code blocks, and captures [ACTION] JSON.
function makeStreamRenderer() {
  let lineBuf = '';
  let inCode = false;
  const actions = [];
  const flush = (line) => {
    const fence = line.trim().match(/^```(\w*)/);
    if (fence) {
      inCode = !inCode;
      process.stdout.write(`${colors.gray}${line}${colors.reset}\n`);
      return;
    }
    if (inCode) { process.stdout.write(`${colors.cyan}${line}${colors.reset}\n`); return; }
    const actMatch = line.match(/\[ACTION:\s*(\{.*\})\s*\]/);
    if (actMatch) {
      try { actions.push(JSON.parse(actMatch[1])); } catch { /* ignore */ }
      return; // don't print raw action JSON
    }
    process.stdout.write(`${formatLine(line)}\n`);
  };
  // Long prose lines shouldn't sit invisible until their newline arrives:
  // once a partial line clearly isn't a heading/bullet/action, stream it live
  // and finish it in place when the newline shows up.
  let partialPrinted = 0;
  const isPlainProse = (s) => partialPrinted > 0 ||
    (s.length > 60 && !/^\s*([#>*-]|\d+\.|```)/.test(s) && !s.includes('[ACTION'));
  return {
    push(text) {
      lineBuf += text;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        if (partialPrinted > 0) {
          // Line already partially on screen — print the remainder + newline.
          process.stdout.write(inlineFmt(line.slice(partialPrinted)) + '\n');
          partialPrinted = 0;
        } else {
          flush(line);
        }
        lineBuf = lineBuf.slice(idx + 1);
      }
      if (!inCode && isPlainProse(lineBuf)) {
        process.stdout.write(inlineFmt(lineBuf.slice(partialPrinted)));
        partialPrinted = lineBuf.length;
      }
    },
    end() {
      if (partialPrinted > 0) { process.stdout.write(inlineFmt(lineBuf.slice(partialPrinted)) + '\n'); }
      else if (lineBuf) { flush(lineBuf); }
      lineBuf = '';
      return actions;
    },
  };
}

function startSpinner(label) {
  // Only animate in a real terminal; when piped/redirected, print once so logs
  // don't fill with thousands of spinner frames.
  if (!process.stdout.isTTY) {
    process.stdout.write(`${colors.gray}${label}${colors.reset}\n`);
    return null;
  }
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${colors.cyan}${frames[i++ % frames.length]}${colors.reset} ${colors.gray}${label}${colors.reset}`);
  }, 90);
  return id;
}
function stopSpinner(id) {
  if (id === null) return;
  clearInterval(id);
  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

// ---------------------------------------------------------------------------
// Intent routing (auto mode picks PCAI ask / diagnose / DevOps agent).
// ---------------------------------------------------------------------------
const DEVOPS_RE = /\b(docker|container|kubernetes|k8s|kubectl|pod|pods|deployment|deploy|namespace|scale|restart|replica|replicas|cluster|node|nodes|image|images|compose|helm|rollout|crashloop|my container|my pod)\b/i;
const ERROR_RE = /\b(error|exception|failed|failure|traceback|stack ?trace|panic|crashloopbackoff|oomkilled|denied|refused|timeout|timed out|cannot|unable|fatal|err:)\b/i;

function classifyIntent(text) {
  if (/^solve:/i.test(text)) return 'diagnose';
  if (DEVOPS_RE.test(text)) return 'devops';
  if (ERROR_RE.test(text) || text.split('\n').length > 3) return 'diagnose';
  return 'ask';
}

function resolveIntent(text) {
  if (session.mode === 'ask') return 'ask';
  if (session.mode === 'diagnose') return 'diagnose';
  if (session.mode === 'devops') return 'devops';
  return classifyIntent(text);
}

// Core: send a message, stream the answer, render it. Returns { text, sources, actions, intent }.
async function ask(text, history) {
  const intent = resolveIntent(text);
  const clean = text.replace(/^solve:/i, '').trim();
  const renderer = makeStreamRenderer();
  let sources = [];
  let printedHeader = false;
  const spin = startSpinner(intent === 'devops' ? 'Inspecting your cluster…' : intent === 'diagnose' ? 'Diagnosing…' : 'Searching HPE docs…');

  const header = () => {
    if (printedHeader) return;
    printedHeader = true;
    stopSpinner(spin);
    const tag = intent === 'devops' ? 'Kalam · DevOps' : intent === 'diagnose' ? 'Kalam · Diagnosis' : 'Kalam · PCAI';
    console.log(`${colors.green}${colors.bold}⏺ ${tag}${colors.reset}`);
  };

  const onDelta = (t) => { header(); renderer.push(t); };
  const onSources = (s) => { sources = s; };

  try {
    let full;
    if (intent === 'devops') {
      full = await streamChat('/api/agent/chat/stream', { prompt: clean, chatHistory: history, ...aiSettings() }, { onDelta });
    } else {
      full = await streamChat('/api/pcai/chat/stream', { prompt: clean, mode: intent, chatHistory: history, ...aiSettings() }, { onSources, onDelta });
    }
    header(); // in case nothing streamed
    const actions = renderer.end();
    if (sources.length) {
      console.log(`\n${colors.gray}${colors.bold}Sources:${colors.reset}`);
      sources.slice(0, 6).forEach((s) => console.log(`${colors.gray}  ${colors.green}[${s.ref}]${colors.gray} ${s.title}${colors.reset}\n      ${colors.dim}${s.url}${colors.reset}`));
    }
    return { text: full, sources, actions, intent };
  } catch (err) {
    stopSpinner(spin);
    console.log(`${colors.red}❌ ${err.message}${colors.reset}`);
    return { text: '', sources: [], actions: [], intent };
  }
}

// ---------------------------------------------------------------------------
// Model discovery + picker
// ---------------------------------------------------------------------------
async function fetchModels() {
  const q = encodeURIComponent(session.localUrl);
  return getJSON(`/api/llm/models?localUrl=${q}`, 8000);
}

async function printModels() {
  if (!(await ensureServer())) return null;
  try {
    const data = await fetchModels();
    if (!data.endpointUp) {
      console.log(`\n${colors.yellow}⚠️  No local model server reachable at ${session.localUrl}.${colors.reset}`);
      console.log(`   Start Ollama (${colors.bold}ollama serve${colors.reset}) or set your endpoint, then try again.\n`);
      return null;
    }
    const chat = data.chatModels || [];
    const embed = data.embedModels || [];
    console.log(`\n${colors.bold}🧩 Installed models${colors.reset} ${colors.gray}(${data.source} @ ${session.localUrl})${colors.reset}\n`);
    console.log(`${colors.gray}  Chat / reasoning:${colors.reset}`);
    chat.forEach((m, i) => {
      const current = m.name === session.localModel ? `${colors.green} ← current${colors.reset}` : '';
      const meta = [m.paramSize, m.sizeLabel, m.kind === 'vision' ? 'vision' : ''].filter(Boolean).join(', ');
      console.log(`   ${colors.bold}${String(i + 1).padStart(2)}${colors.reset}  ${colors.cyan}${m.name.padEnd(26)}${colors.reset} ${colors.gray}${meta}${colors.reset}${current}`);
    });
    if (embed.length) {
      console.log(`\n${colors.gray}  Embedding (for RAG):${colors.reset}`);
      embed.forEach((m) => {
        const current = m.name.startsWith(session.embedModel) ? `${colors.green} ← current${colors.reset}` : '';
        console.log(`       ${colors.magenta}${m.name.padEnd(26)}${colors.reset} ${colors.gray}${m.sizeLabel}${colors.reset}${current}`);
      });
    }
    console.log();
    return data;
  } catch (e) {
    console.log(`\n${colors.red}❌ Could not list models: ${e.message}${colors.reset}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suggested-action execution (agentic)
// ---------------------------------------------------------------------------
async function runAction(action) {
  try {
    let url = '', body = {};
    if (action.type && action.type.startsWith('docker_')) {
      url = '/api/docker/action';
      body = { action: action.type.replace('docker_', ''), containerId: action.id };
    } else if (action.type && action.type.startsWith('k8s_')) {
      url = '/api/k8s/action';
      body = { action: action.type.replace('k8s_', ''), name: action.name, namespace: action.namespace, replicas: action.replicas };
    } else {
      console.log(`${colors.red}Unknown action type: ${action.type}${colors.reset}`);
      return;
    }
    process.stdout.write(`${colors.gray}Running: ${action.label || action.type}…${colors.reset}`);
    const res = await postJSON(url, body);
    readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
    console.log(`${colors.green}✅ ${res.message || 'Done.'}${colors.reset}${res.output ? ` ${colors.gray}${res.output}${colors.reset}` : ''}`);
  } catch (e) {
    console.log(`\n${colors.red}❌ Action failed: ${e.message}${colors.reset}`);
  }
}

// ---------------------------------------------------------------------------
// The interactive REPL (the "Claude Code" experience)
// ---------------------------------------------------------------------------
function printBanner(kb) {
  console.log(`
${colors.green}${colors.bold}╦╔═╔═╗╦  ╔═╗╔╦╗${colors.reset}   ${colors.gray}v${VERSION}${colors.reset}
${colors.green}${colors.bold}╠╩╗╠═╣║  ╠═╣║║║${colors.reset}   ${colors.gray}HPE Private Cloud AI · Agentic DevOps${colors.reset}
${colors.green}${colors.bold}╩ ╩╩ ╩╩═╝╩ ╩╩ ╩${colors.reset}
${colors.gray}  Engine ${colors.reset}${engineLabel()}   ${colors.gray}Mode ${colors.reset}${colors.bold}${session.mode}${colors.reset}   ${colors.gray}KB ${colors.reset}${kb && kb.ready ? `${colors.green}${kb.chunks} chunks · ${kb.embedProvider !== 'none' ? 'vector' : 'lexical'}${colors.reset}` : `${colors.yellow}not trained${colors.reset}`}
${colors.gray}  Just type to ask. ${colors.reset}${colors.bold}/help${colors.reset}${colors.gray} for commands · ${colors.reset}${colors.bold}/model${colors.reset}${colors.gray} to switch model · ${colors.reset}${colors.bold}/exit${colors.reset}${colors.gray} to quit.${colors.reset}
`);
}

function replHelp() {
  console.log(`
${colors.bold}Commands${colors.reset} ${colors.gray}(everything else is sent to the assistant)${colors.reset}
  ${colors.green}/model${colors.reset}            Pick which installed model to use (interactive)
  ${colors.green}/models${colors.reset}           List installed Ollama / local models
  ${colors.green}/provider${colors.reset} <p>     Switch engine: ${colors.bold}gemini${colors.reset} or ${colors.bold}local${colors.reset}
  ${colors.green}/mode${colors.reset} <m>         Routing: ${colors.bold}auto${colors.reset} · ask · diagnose · devops
  ${colors.green}/train${colors.reset} [--offline] Build / refresh the HPE knowledge base
  ${colors.green}/kb${colors.reset}               Knowledge-base status
  ${colors.green}/learn${colors.reset} <file>     Teach the KB a runbook / log / diagram / doc
  ${colors.green}/learned${colors.reset}          List learned docs + auto-captured solved cases
  ${colors.green}/vms${colors.reset}              VM inventory with live SSH status
  ${colors.green}/vm${colors.reset} <sub> <name>  diagnose · discover · peers · graph · impact (read-only)
  ${colors.green}/status${colors.reset}           Local Docker & Kubernetes health
  ${colors.green}/run${colors.reset} <n>          Execute suggested action #n from the last reply
  ${colors.green}/key${colors.reset} <api-key>    Set your Gemini API key (and switch to Gemini)
  ${colors.green}/clear${colors.reset}            Clear the screen & conversation memory
  ${colors.green}/help${colors.reset}             Show this
  ${colors.green}/exit${colors.reset}             Quit
  ${colors.green}!<command>${colors.reset}        Run a shell command on this machine (e.g. ${colors.bold}!kubectl get pods -A${colors.reset})
${colors.gray}Tips: prefix a line with ${colors.reset}${colors.bold}solve:${colors.reset}${colors.gray} to force error diagnosis. Paste a stack trace and I'll diagnose it.${colors.reset}
`);
}

async function startRepl(initialMode) {
  if (!(await ensureServer())) return;
  if (initialMode) { session.mode = initialMode; }
  // One status fetch covers both the KB check and the banner (was 3 round trips).
  let kb = await getJSON('/api/pcai/status').catch(() => null);
  if (!kb || !kb.ready || !(kb.chunks > 0)) {
    await ensureKnowledgeBase(kb);
    kb = await getJSON('/api/pcai/status').catch(() => null);
  }

  printBanner(kb);

  const history = [];       // {role, content}
  let lastActions = [];     // suggested actions from the last reply
  let pendingModels = null; // when awaiting a /model numeric selection

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${colors.green}${colors.bold}kalam ›${colors.reset} ` });
  const reprompt = () => { console.log(); rl.prompt(); };

  // Local shell escape: lines starting with "!" run on THIS machine with live
  // output (like Claude Code's ! prefix). Ctrl+C kills the running command.
  let activeShell = null;
  const runShell = (cmd) => {
    console.log(`${colors.gray}$ ${cmd}${colors.reset}`);
    const child = spawn(cmd, { shell: true, cwd: process.cwd(), env: process.env });
    activeShell = child;
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(`${colors.red}${d}${colors.reset}`));
    child.on('close', (code) => {
      activeShell = null;
      if (code !== 0 && code !== null) console.log(`${colors.yellow}↳ exit code ${code}${colors.reset}`);
      reprompt();
    });
    child.on('error', (e) => {
      activeShell = null;
      console.log(`${colors.red}❌ ${e.message}${colors.reset}`);
      reprompt();
    });
  };

  // First Ctrl+C kills a running ! command or cancels a streaming answer;
  // when idle it exits as usual.
  rl.on('SIGINT', () => {
    if (activeShell) {
      activeShell.kill('SIGTERM');
      console.log(`\n${colors.yellow}⏹ Command killed.${colors.reset}`);
    } else if (cancelActiveStream()) {
      console.log(`\n${colors.yellow}⏹ Answer cancelled.${colors.reset}`);
      reprompt();
    } else {
      console.log(`\n${colors.gray}Goodbye! 👋${colors.reset}\n`);
      rl.close();
    }
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const raw = line.trim();

    // Awaiting a model-picker selection?
    if (pendingModels) {
      const models = pendingModels; pendingModels = null;
      const n = parseInt(raw, 10);
      if (!raw) { console.log(`${colors.gray}Kept ${session.localModel}.${colors.reset}`); }
      else if (n >= 1 && n <= models.length) {
        session.localModel = models[n - 1].name;
        session.provider = 'local';
        saveUserConfig({ localModel: session.localModel, provider: 'local' });
        console.log(`${colors.green}✅ Now using ${colors.bold}${session.localModel}${colors.reset}${colors.green} (local).${colors.reset}`);
      } else {
        console.log(`${colors.yellow}Invalid choice — kept ${session.localModel}.${colors.reset}`);
      }
      return reprompt();
    }

    if (!raw) { rl.prompt(); return; }

    // "!" shell escape — run the command locally, stream its output
    if (raw.startsWith('!')) {
      const cmd = raw.slice(1).trim();
      if (!cmd) { console.log(`${colors.yellow}Usage: !<command>   e.g. !kubectl get pods -A${colors.reset}`); return reprompt(); }
      return runShell(cmd);
    }

    // Slash commands
    if (raw.startsWith('/')) {
      const [cmd, ...rest] = raw.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
      switch (cmd.toLowerCase()) {
        case 'exit': case 'quit': case 'q':
          console.log(`\n${colors.gray}Goodbye! 👋${colors.reset}\n`); rl.close(); return;
        case 'help': case 'h': replHelp(); return reprompt();
        case 'clear': case 'cls':
          console.clear(); history.length = 0; lastActions = []; printBanner(kb); rl.prompt(); return;
        case 'models': await printModels(); return reprompt();
        case 'model': {
          const data = await printModels();
          if (data && (data.chatModels || []).length) {
            pendingModels = data.chatModels;
            process.stdout.write(`${colors.bold}Pick a model by number${colors.reset} ${colors.gray}(Enter to keep current):${colors.reset} `);
            return; // wait for numeric line
          }
          return reprompt();
        }
        case 'provider': {
          const p = arg.toLowerCase();
          if (p === 'gemini' || p === 'local') {
            session.provider = p; saveUserConfig({ provider: p });
            console.log(`${colors.green}✅ Provider → ${colors.bold}${p}${colors.reset}${colors.green}. Engine: ${colors.reset}${engineLabel()}`);
            if (p === 'gemini' && !session.geminiKey) console.log(`${colors.yellow}   No Gemini key set — use ${colors.bold}/key <api-key>${colors.reset}${colors.yellow} or it'll return retrieved docs only.${colors.reset}`);
          } else console.log(`${colors.yellow}Usage: /provider gemini|local${colors.reset}`);
          return reprompt();
        }
        case 'mode': {
          const m = arg.toLowerCase();
          if (['auto', 'ask', 'diagnose', 'devops'].includes(m)) {
            session.mode = m; saveUserConfig({ mode: m });
            console.log(`${colors.green}✅ Mode → ${colors.bold}${m}${colors.reset}`);
          } else console.log(`${colors.yellow}Usage: /mode auto|ask|diagnose|devops${colors.reset}`);
          return reprompt();
        }
        case 'key': {
          if (!arg) { console.log(`${colors.yellow}Usage: /key <gemini-api-key>${colors.reset}`); return reprompt(); }
          session.geminiKey = arg; session.provider = 'gemini';
          saveUserConfig({ geminiKey: arg, provider: 'gemini' });
          console.log(`${colors.green}✅ Gemini key saved to ${CONFIG_PATH} and switched to Gemini.${colors.reset}`);
          return reprompt();
        }
        case 'train': await trainKB(/--offline|-o/.test(arg)); return reprompt();
        case 'kb': await showKB(); return reprompt();
        case 'learn': await learnFiles(arg ? arg.split(/\s+/) : []); return reprompt();
        case 'learned': await showLearned(); return reprompt();
        case 'vms': await listVmsCli(); return reprompt();
        case 'vm': {
          const [sub, vmName, ...subRest] = arg.split(/\s+/);
          if (sub === 'diagnose' || sub === 'diag') await vmDiagnose(vmName);
          else if (sub === 'discover') await vmDiscover(vmName);
          else if (sub === 'peers') await vmPeers(vmName);
          else if (sub === 'graph') await vmGraph(vmName);
          else if (sub === 'impact' || sub === 'blast') await vmImpact(vmName, subRest[0]);
          else if (sub === 'ssh') console.log(`${colors.yellow}Interactive SSH doesn't fit inside the REPL — run: ${colors.bold}kalam vm ssh ${vmName || '<name>'}${colors.reset}${colors.yellow} in its own terminal.${colors.reset}`);
          else await listVmsCli();
          return reprompt();
        }
        case 'status': await showStatus(); return reprompt();
        case 'run': {
          const n = parseInt(arg, 10);
          if (!lastActions.length) console.log(`${colors.gray}No suggested actions from the last reply.${colors.reset}`);
          else if (n >= 1 && n <= lastActions.length) await runAction(lastActions[n - 1]);
          else console.log(`${colors.yellow}Usage: /run <1-${lastActions.length}>${colors.reset}`);
          return reprompt();
        }
        default:
          console.log(`${colors.yellow}Unknown command /${cmd}. Try /help.${colors.reset}`);
          return reprompt();
      }
    }

    // Normal chat turn
    history.push({ role: 'user', content: raw });
    const { text, actions } = await ask(raw, history.slice(-6, -1));
    if (text) history.push({ role: 'agent', content: text });
    lastActions = actions || [];
    if (lastActions.length) {
      console.log(`\n${colors.yellow}${colors.bold}⚡ Suggested actions:${colors.reset}`);
      lastActions.forEach((a, i) => console.log(`   ${colors.bold}${i + 1}${colors.reset}. ${a.label || a.type} ${colors.gray}— /run ${i + 1}${colors.reset}`));
    }
    reprompt();
  });

  rl.on('close', () => {
    // Let a running ! command finish printing before the process exits.
    if (activeShell) activeShell.on('close', () => process.exit(0));
    else process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Non-interactive subcommands
// ---------------------------------------------------------------------------
async function singleShot(text, forcedMode) {
  if (!text || !text.trim()) {
    console.log(`\n${colors.red}❌ Provide text.${colors.reset}\n`); return;
  }
  if (!(await ensureServer())) return;
  // ensureServer's health check already fetched /api/pcai/status; reuse the
  // cheap path — only rebuild if the KB is actually empty.
  const st = await getJSON('/api/pcai/status', 3000).catch(() => null);
  if (!st || !st.ready || !(st.chunks > 0)) {
    if (!(await ensureKnowledgeBase(st))) return;
  }
  const prevMode = session.mode;
  if (forcedMode) session.mode = forcedMode;
  await ask(text, []);
  session.mode = prevMode;
  console.log();
}

async function trainKB(offline) {
  if (!(await ensureServer())) return;
  console.log(`\n${colors.bold}📚 ${offline ? 'Building offline knowledge base' : 'Training: crawling live HPE docs + seed knowledge'}...${colors.reset}`);
  console.log(`${colors.gray}(this can take a minute if crawling)${colors.reset}`);
  const spin = startSpinner('Ingesting');
  try {
    const res = await postJSON('/api/pcai/ingest', { crawl: !offline, maxPages: 80, ...aiSettings() }, 600000);
    stopSpinner(spin);
    console.log(`${colors.green}✅ Knowledge base built.${colors.reset}`);
    console.log(`   Chunks indexed: ${colors.bold}${res.chunks}${colors.reset}`);
    console.log(`   Crawled pages:  ${colors.bold}${res.crawledPages}${colors.reset}`);
    console.log(`   Retrieval:      ${colors.bold}${res.embedded ? `vector (${res.embedModel})` : 'lexical'}${colors.reset}`);
  } catch (err) {
    stopSpinner(spin);
    console.log(`\n${colors.red}❌ Training failed: ${err.message}${colors.reset}`);
  }
}

async function showKB() {
  if (!(await ensureServer())) return;
  try {
    const st = await getJSON('/api/pcai/status');
    console.log(`\n${colors.bold}🧠 PCAI Knowledge Base${colors.reset}`);
    console.log(`  Ready:      ${st.ready ? `${colors.green}yes${colors.reset}` : `${colors.yellow}no (run /train)${colors.reset}`}`);
    console.log(`  Chunks:     ${st.chunks}`);
    console.log(`  Retrieval:  ${st.embedProvider !== 'none' ? `${colors.green}vector${colors.reset} (${st.embedModel})` : 'lexical'}`);
    console.log(`  Sources:    ${st.sources.length}`);
    console.log(`  Updated:    ${st.updatedAt || 'never'}`);
  } catch (err) {
    console.log(`\n${colors.red}❌ ${err.message}${colors.reset}`);
  }
}

async function showStatus() {
  console.log(`\n${colors.bold}🔍 Scanning system daemons...${colors.reset}`);
  try {
    const status = await getJSON('/api/status');
    const d = status.docker, k = status.kubernetes;
    console.log(`${colors.bold}🐳 Docker:${colors.reset}     ${d.running ? `${colors.green}🟢 running${colors.reset}` : `${colors.red}🔴 stopped${colors.reset}`}  ${colors.gray}${d.installed ? d.version : 'not installed'}${colors.reset}`);
    console.log(`${colors.bold}☸️  Kubernetes:${colors.reset} ${k.running ? `${colors.green}🟢 running${colors.reset}` : `${colors.red}🔴 stopped${colors.reset}`}  ${colors.gray}${k.installed ? `${k.version.split('\n')[0]} · ${k.context}` : 'not installed'}${colors.reset}`);
  } catch (err) {
    console.log(`${colors.yellow}⚠️ Server offline. Querying local shells directly...${colors.reset}`);
    const docVer = await runCmd('docker --version');
    const kVer = await runCmd('kubectl version --client');
    console.log(`${colors.bold}🐳 Docker:${colors.reset} ${docVer.success ? `${colors.green}${docVer.stdout.trim()}${colors.reset}` : `${colors.red}not found${colors.reset}`}`);
    console.log(`${colors.bold}☸️  Kubernetes:${colors.reset} ${kVer.success ? `${colors.green}${kVer.stdout.trim().split('\n')[0]}${colors.reset}` : `${colors.red}not found${colors.reset}`}`);
  }
}

async function listResources(type) {
  if (!type || (type !== 'docker' && type !== 'k8s')) {
    console.log(`\n${colors.red}❌ Use 'kalam list docker' or 'kalam list k8s'.${colors.reset}\n`); return;
  }
  if (!(await ensureServer())) return;
  console.log(`\n${colors.bold}Fetching ${type === 'docker' ? 'Docker Containers' : 'Kubernetes Pods'}...${colors.reset}\n`);
  try {
    if (type === 'docker') {
      const res = await getJSON('/api/docker/containers');
      if (!res.length) { console.log('No containers found.'); return; }
      res.forEach((c) => {
        const sc = c.state === 'running' ? colors.green : colors.red;
        console.log(`  ${colors.gray}${c.id.slice(0, 12)}${colors.reset}  ${colors.bold}${c.name.padEnd(24)}${colors.reset} ${c.image.padEnd(22)} ${sc}${c.state}${colors.reset}`);
      });
    } else {
      const res = await getJSON('/api/k8s/resources');
      const pods = res.pods || [];
      if (!pods.length) { console.log('No Kubernetes pods found.'); return; }
      pods.forEach((p) => {
        const c = p.status === 'Running' ? colors.green : colors.yellow;
        console.log(`  ${p.namespace.padEnd(20)} ${colors.bold}${p.name.padEnd(32)}${colors.reset} ${p.ready.padEnd(7)} ${c}${p.status}${colors.reset}`);
      });
    }
  } catch (err) {
    console.log(`${colors.red}❌ Failed: ${err.message}${colors.reset}`);
  }
  console.log();
}

async function scanContainer(target) {
  if (!target) { console.log(`\n${colors.red}❌ Usage: kalam scan <container-id>${colors.reset}\n`); return; }
  if (!(await ensureServer())) return;
  try {
    const containers = await getJSON('/api/docker/containers');
    const container = containers.find((c) => c.id.startsWith(target) || c.name === target);
    if (!container) { console.log(`\n${colors.red}❌ Container '${target}' not found${colors.reset}\n`); return; }
    console.log(`\n${colors.bold}🛡️ Scanning ${colors.cyan}${container.name}${colors.reset} (${colors.yellow}${container.image}${colors.reset})...\n`);
    const scan = await postJSON('/api/docker/scan', { imageName: container.image });
    const s = scan.summary;
    console.log(`  ${colors.red}Critical: ${s.critical}${colors.reset}  ${colors.yellow}High: ${s.high}  Medium: ${s.medium}${colors.reset}  ${colors.gray}Low: ${s.low}${colors.reset}\n`);
    (scan.vulnerabilities || []).forEach((v) => {
      const sc = v.severity === 'Critical' ? colors.red : v.severity === 'High' ? colors.yellow : colors.gray;
      console.log(`  • [${sc}${v.severity}${colors.reset}] ${colors.bold}${v.cve}${colors.reset} in ${colors.cyan}${v.package}${colors.reset}: ${v.desc}`);
    });
    if (scan.fixAction) {
      console.log(`\n${colors.green}${colors.bold}⚡ Fix:${colors.reset} ${scan.recommendation}`);
      console.log(`  Run ${colors.bold}kalam fix ${container.name}${colors.reset} to auto-patch.\n`);
    } else {
      console.log(`\n${colors.green}✅ No fix needed.${colors.reset}\n`);
    }
  } catch (err) {
    console.log(`${colors.red}❌ Scan failed: ${err.message}${colors.reset}`);
  }
}

async function fixContainer(target) {
  if (!target) { console.log(`\n${colors.red}❌ Usage: kalam fix <container-id>${colors.reset}\n`); return; }
  if (!(await ensureServer())) return;
  try {
    const containers = await getJSON('/api/docker/containers');
    const container = containers.find((c) => c.id.startsWith(target) || c.name === target);
    if (!container) { console.log(`\n${colors.red}❌ Container '${target}' not found${colors.reset}\n`); return; }
    const scan = await postJSON('/api/docker/scan', { imageName: container.image });
    if (!scan.fixAction) { console.log(`\n${colors.green}✅ ${container.name} already secure.${colors.reset}\n`); return; }
    const secureImage = scan.fixAction.targetImage;
    console.log(`\n${colors.magenta}${colors.bold}⚡ Will re-create ${container.name} on ${colors.green}${secureImage}${colors.reset}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Proceed? [y/N]: `, async (answer) => {
      rl.close();
      if (!['y', 'yes'].includes(answer.toLowerCase())) { console.log(`\n${colors.yellow}Aborted.${colors.reset}\n`); return; }
      console.log(`\n⏳ Rebuilding...`);
      try {
        const r = await postJSON('/api/docker/apply-fix', { containerId: container.id, targetImage: secureImage });
        console.log(`\n${colors.green}${colors.bold}🎉 Hardened!${colors.reset} ${r.message}`);
        console.log(`  New ID: ${colors.cyan}${r.newContainerId}${colors.reset}\n`);
      } catch (err) { console.log(`\n${colors.red}❌ ${err.message}${colors.reset}\n`); }
    });
  } catch (err) {
    console.log(`\n${colors.red}❌ ${err.message}${colors.reset}\n`);
  }
}

// ---------------------------------------------------------------------------
// Knowledge-base learning: feed any file (runbook, log, diagram, postmortem)
// into the assistant's memory. `kalam learn file1 file2` or pipe via stdin.
// ---------------------------------------------------------------------------
async function learnFiles(files) {
  if (!(await ensureServer())) return;
  const docs = [];
  if (files.length) {
    for (const f of files) {
      try {
        const text = fs.readFileSync(f, 'utf8');
        docs.push({ title: path.basename(f), text });
      } catch (e) {
        console.log(`${colors.red}❌ Cannot read ${f}: ${e.message}${colors.reset}`);
      }
    }
  } else {
    const piped = await readStdin();
    if (piped) docs.push({ title: `pasted-${new Date().toISOString().slice(0, 10)}`, text: piped });
  }
  if (!docs.length) {
    console.log(`\n${colors.yellow}Usage: kalam learn <file...>   (or pipe text: cat runbook.md | kalam learn)${colors.reset}\n`);
    return;
  }
  for (const d of docs) {
    const spin = startSpinner(`Learning ${d.title}…`);
    try {
      const res = await postJSON('/api/pcai/learn', { title: d.title, text: d.text, ...aiSettings() }, 120000);
      stopSpinner(spin);
      console.log(`${colors.green}✅ Learned ${colors.bold}${d.title}${colors.reset}${colors.green} — ${res.chunksAdded} chunk(s), type: ${res.kind}${res.embedded ? ', vector-indexed' : ''}.${colors.reset}`);
    } catch (e) {
      stopSpinner(spin);
      console.log(`${colors.red}❌ ${d.title}: ${e.message}${colors.reset}`);
    }
  }
  console.log(`${colors.gray}The assistant will use this knowledge in every future answer. See 'kalam learned' for the list.${colors.reset}`);
}

async function showLearned() {
  if (!(await ensureServer())) return;
  try {
    const res = await getJSON('/api/pcai/learned');
    console.log(`\n${colors.bold}📚 Learned documents${colors.reset} ${colors.gray}(${res.count} — uploads + auto-captured solved cases)${colors.reset}`);
    (res.docs || []).slice(0, 30).forEach((d) => {
      console.log(`  ${colors.cyan}${d.kind.padEnd(8)}${colors.reset} ${d.title.slice(0, 60).padEnd(62)} ${colors.gray}${(d.addedAt || '').slice(0, 10)}${colors.reset}`);
    });
    if (!res.count) console.log(`  ${colors.gray}Nothing yet — try: kalam learn my-runbook.md${colors.reset}`);
  } catch (e) {
    console.log(`${colors.red}❌ ${e.message}${colors.reset}`);
  }
}

// ---------------------------------------------------------------------------
// VM / SSH commands (same inventory as the UI's VM Monitor)
// ---------------------------------------------------------------------------
async function listVmsCli() {
  if (!(await ensureServer())) return;
  const { vms } = await getJSON('/api/vms');
  if (!vms || !vms.length) {
    console.log(`\n${colors.gray}No VMs in the inventory. Add one in the UI (VM Monitor) or via the API.${colors.reset}\n`);
    return;
  }
  console.log(`\n${colors.bold}🖥️  VM inventory${colors.reset}`);
  const results = await Promise.all(vms.map((v) =>
    postJSON('/api/vms/metrics', { name: v.name }, 30000).catch(() => ({ reachable: false, error: 'probe failed' }))
  ));
  vms.forEach((v, i) => {
    const m = results[i];
    const dot = m.reachable && !m.error ? `${colors.green}●${colors.reset}` : `${colors.red}●${colors.reset}`;
    const via = v.via ? ` ${colors.gray}(via ${v.via})${colors.reset}` : '';
    const info = m.error ? `${colors.red}${m.error}${colors.reset}` : `${colors.gray}load ${m.load || '—'} · mem ${m.mem || '—'} · up ${m.up || '—'}${colors.reset}`;
    console.log(`  ${dot} ${colors.bold}${v.name.padEnd(16)}${colors.reset} ${colors.cyan}${v.user}@${v.host}:${v.port}${colors.reset}${via}  ${info}`);
  });
  console.log(`\n${colors.gray}Commands: kalam vm ssh <name> · kalam vm diagnose <name> · kalam vm discover <name> · kalam vm peers <name>${colors.reset}\n`);
}

async function vmSsh(name) {
  if (!name) { console.log(`\n${colors.yellow}Usage: kalam vm ssh <name>${colors.reset}\n`); return; }
  if (!(await ensureServer())) return;
  try {
    const { command } = await getJSON(`/api/vms/ssh-command/${encodeURIComponent(name)}`);
    console.log(`${colors.gray}Connecting: ${command}${colors.reset}`);
    const child = spawn(command, { stdio: 'inherit', shell: true });
    child.on('exit', (code) => process.exit(code || 0));
  } catch (e) {
    console.log(`${colors.red}❌ ${e.message}${colors.reset}`);
  }
}

async function vmDiagnose(name) {
  if (!name) { console.log(`\n${colors.yellow}Usage: kalam vm diagnose <name>${colors.reset}\n`); return; }
  if (!(await ensureServer())) return;
  const spin = startSpinner(`Inspecting nodes, pods, logs and events on ${name} (read-only)…`);
  try {
    const d = await postJSON('/api/vms/diagnose', { name }, 180000);
    stopSpinner(spin);
    if (d.error) { console.log(`${colors.red}❌ ${d.error}${colors.reset}`); return; }
    console.log(`\n${colors.bold}🩺 Diagnosis · ${name}${colors.reset}  ${colors.gray}(read-only — nothing was executed)${colors.reset}`);
    console.log((d.findings || []).length ? '' : `${colors.green}✅ ${d.summary}${colors.reset}`);

    // Root-cause analysis over the dependency graph: which of these to fix first.
    const causes = (d.causes && d.causes.rootCauses) || [];
    if (causes.length && (d.findings || []).length > 1) {
      console.log(`${colors.bold}🎯 Start here${colors.reset} ${colors.gray}${d.causes.summary}${colors.reset}`);
      causes.slice(0, 3).forEach((c) => {
        const label = (c.component && c.component.title) || `${c.namespace ? `${c.namespace}/` : ''}${c.name}`;
        const scope = c.explains.length ? `explains ${c.explains.length} downstream failure(s)` : `${c.atRisk} healthy dependent(s) at risk`;
        console.log(`   ${colors.green}▸${colors.reset} ${colors.bold}${label}${colors.reset} ${colors.gray}[${c.confidence} confidence] — ${scope}${colors.reset}`);
      });
    }

    (d.findings || []).forEach((f, i) => {
      const sev = f.severity === 'critical' ? `${colors.red}CRITICAL${colors.reset}` : `${colors.yellow}WARNING ${colors.reset}`;
      const tag = f.rootCause
        ? ` ${colors.green}[root cause${f.explains ? ` · explains ${f.explains}` : ''}]${colors.reset}`
        : f.causedBy ? ` ${colors.gray}[downstream of ${f.causedBy}]${colors.reset}` : '';
      console.log(`\n ${colors.bold}${i + 1}.${colors.reset} [${sev}] ${colors.bold}${f.reason}${colors.reset} — ${f.kind} ${f.namespace ? `${f.namespace}/` : ''}${f.name}${tag}`);
      console.log(`    ${f.detail}`);
      if (f.logExcerpt) {
        console.log(`    ${colors.gray}Log tail:${colors.reset}`);
        f.logExcerpt.split('\n').slice(-6).forEach((l) => console.log(`      ${colors.cyan}${l.slice(0, 160)}${colors.reset}`));
      }
      (f.suggestedFixes || []).forEach((s) => console.log(`    ${colors.green}fix →${colors.reset} ${s}`));
    });
    if (d.findings && d.findings.length) console.log(`\n${colors.gray}${d.summary}${colors.reset}`);
    console.log();
  } catch (e) {
    stopSpinner(spin);
    console.log(`${colors.red}❌ ${e.message}${colors.reset}`);
  }
}

async function vmDiscover(name) {
  if (!name) { console.log(`\n${colors.yellow}Usage: kalam vm discover <name>${colors.reset}\n`); return; }
  if (!(await ensureServer())) return;
  const spin = startSpinner(`Enumerating workloads and services on ${name}…`);
  try {
    const d = await postJSON('/api/vms/discover', { name }, 120000);
    stopSpinner(spin);
    if (d.error) { console.log(`${colors.red}❌ ${d.error}${colors.reset}`); return; }
    console.log(`\n${colors.bold}📦 Workloads on ${name}${colors.reset}  ${colors.gray}runtimes: ${(d.engines || []).join(', ') || 'none'}${colors.reset}`);
    (d.containers || []).forEach((c) => console.log(`  🐳 ${c.name.padEnd(28)} ${c.state === 'running' ? colors.green : colors.red}${c.state}${colors.reset} ${colors.gray}${c.image}${colors.reset}`));
    (d.pods || []).forEach((p) => console.log(`  ☸️  ${(p.namespace + '/' + p.name).slice(0, 52).padEnd(54)} ${p.status === 'Running' ? colors.green : colors.yellow}${p.status}${colors.reset} ${colors.gray}${p.ready}${colors.reset}`));
    (d.services || []).forEach((s) => console.log(`  ⚡ svc ${(s.namespace + '/' + s.name).slice(0, 48).padEnd(50)} ${colors.gray}${s.type} ${s.ports}${colors.reset}`));
    if (d.systemServices && d.systemServices.length) {
      console.log(`  ${colors.gray}systemd: ${d.systemServices.slice(0, 12).map((s) => s.unit).join(', ')}${d.systemServices.length > 12 ? '…' : ''}${colors.reset}`);
    }
    console.log();
  } catch (e) {
    stopSpinner(spin);
    console.log(`${colors.red}❌ ${e.message}${colors.reset}`);
  }
}

// Build the dependency graph for a host and show what it found — including the
// ranked root causes, which is the whole point of having a graph.
async function vmGraph(name) {
  if (!name) { console.log(`\n${colors.yellow}Usage: kalam vm graph <name>${colors.reset}\n`); return; }
  if (!(await ensureServer())) return;
  const spin = startSpinner(`Building the dependency graph for ${name} (read-only)…`);
  try {
    const d = await postJSON('/api/graph/build', { name }, 120000);
    stopSpinner(spin);
    if (!d.ok) { console.log(`${colors.red}❌ ${d.error || 'Graph build failed'}${colors.reset}`); return; }

    const s = d.stats;
    const kinds = Object.entries(s.byKind).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c} ${k}`).join(', ');
    console.log(`\n${colors.bold}🕸️  Dependency graph · ${name}${colors.reset}  ${colors.gray}${s.nodes} nodes / ${s.edges} edges${colors.reset}`);
    console.log(`   ${colors.gray}${kinds}${colors.reset}`);
    const health = Object.entries(s.byHealth).map(([h, c]) =>
      `${h === 'failed' ? colors.red : h === 'degraded' ? colors.yellow : h === 'healthy' ? colors.green : colors.gray}${c} ${h}${colors.reset}`
    ).join(colors.gray + ' · ' + colors.reset);
    console.log(`   ${health}`);

    const causes = (d.causes && d.causes.rootCauses) || [];
    console.log(`\n${colors.bold}Root causes${colors.reset} ${colors.gray}${d.causes.summary}${colors.reset}`);
    if (!causes.length) console.log(`   ${colors.green}Nothing unhealthy.${colors.reset}`);
    causes.forEach((c, i) => {
      const label = (c.component && c.component.title) || `${c.namespace ? `${c.namespace}/` : ''}${c.name}`;
      console.log(`\n ${colors.bold}${i + 1}.${colors.reset} ${colors.bold}${label}${colors.reset} ${colors.gray}[${c.confidence}] ${c.reason || c.health}${colors.reset}`);
      console.log(`    ${c.explanation}`);
      console.log(`    ${colors.gray}id: ${c.id}${colors.reset}`);
    });
    console.log(`\n${colors.gray}Next: kalam vm impact ${name} <id>  — what breaks if that stops.${colors.reset}\n`);
  } catch (e) {
    stopSpinner(spin);
    console.log(`${colors.red}❌ ${e.message}${colors.reset}`);
  }
}

// "What breaks if I restart this?" — the blast radius of one graph node.
async function vmImpact(name, id) {
  if (!name || !id) { console.log(`\n${colors.yellow}Usage: kalam vm impact <name> <node-id>${colors.reset}\n${colors.gray}Get ids from: kalam vm graph <name>${colors.reset}\n`); return; }
  if (!(await ensureServer())) return;
  const spin = startSpinner(`Tracing what depends on ${id}…`);
  try {
    const d = await postJSON('/api/graph/blast', { name, id }, 120000);
    stopSpinner(spin);
    if (!d.ok) { console.log(`${colors.red}❌ ${d.error || 'Blast radius failed'}${colors.reset}`); return; }

    console.log(`\n${colors.bold}💥 Blast radius · ${d.origin.name}${colors.reset} ${colors.gray}(${d.origin.kind}, ${d.origin.health})${colors.reset}`);
    console.log(`   ${d.summary}`);
    if (d.componentImpact) console.log(`   ${colors.gray}${d.componentImpact}${colors.reset}`);

    if (d.alreadyBroken.length) {
      console.log(`\n${colors.red}Already unhealthy downstream (${d.alreadyBroken.length}):${colors.reset}`);
      d.alreadyBroken.slice(0, 20).forEach((n) =>
        console.log(`   ${colors.red}✗${colors.reset} ${(n.namespace ? `${n.namespace}/` : '') + n.name} ${colors.gray}${n.kind} · ${n.reason || n.health} · ${n.distance} hop(s)${colors.reset}`));
    }
    if (d.atRisk.length) {
      console.log(`\n${colors.yellow}Healthy but at risk (${d.atRisk.length}):${colors.reset}`);
      d.atRisk.slice(0, 20).forEach((n) =>
        console.log(`   ${colors.yellow}!${colors.reset} ${(n.namespace ? `${n.namespace}/` : '') + n.name} ${colors.gray}${n.kind} · ${n.distance} hop(s)${colors.reset}`));
    }
    console.log();
  } catch (e) {
    stopSpinner(spin);
    console.log(`${colors.red}❌ ${e.message}${colors.reset}`);
  }
}

async function vmPeers(name) {
  if (!name) { console.log(`\n${colors.yellow}Usage: kalam vm peers <name>${colors.reset}\n`); return; }
  if (!(await ensureServer())) return;
  const spin = startSpinner(`Scanning for peer VMs visible from ${name}…`);
  try {
    const d = await postJSON('/api/vms/neighbors', { name }, 60000);
    stopSpinner(spin);
    if (d.error) { console.log(`${colors.red}❌ ${d.error}${colors.reset}`); return; }
    const peers = d.neighbors || [];
    console.log(`\n${colors.bold}🔭 Peer VMs visible from ${name}${colors.reset} ${colors.gray}(${peers.length})${colors.reset}`);
    peers.forEach((n) => console.log(`  ${colors.cyan}${n.ip.padEnd(16)}${colors.reset} ${(n.hostname || '—').padEnd(28)} ${colors.gray}${n.source}${colors.reset}`));
    if (peers.length) console.log(`${colors.gray}Add them in the UI (VM Monitor → Find peer VMs) to SSH via ${name} as a jump host.${colors.reset}`);
    console.log();
  } catch (e) {
    stopSpinner(spin);
    console.log(`${colors.red}❌ ${e.message}${colors.reset}`);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.trim()));
    setTimeout(() => resolve(data.trim()), 3000);
  });
}

function showHelp() {
  console.log(`
${colors.green}${colors.bold}╦╔═╔═╗╦  ╔═╗╔╦╗
╠╩╗╠═╣║  ╠═╣║║║
╩ ╩╩ ╩╩═╝╩ ╩╩ ╩${colors.reset}
${colors.gray}Kalam — HPE PCAI Assistant + Agentic DevOps CLI  ·  v${VERSION}${colors.reset}

${colors.bold}JUST RUN IT:${colors.reset}
  ${colors.green}kalam${colors.reset}                 Launch the interactive assistant (streaming, like Claude Code).

${colors.bold}ONE-SHOT:${colors.reset}
  ${colors.green}ask <question>${colors.reset}       Ask anything about HPE Private Cloud AI (streamed).
  ${colors.green}solve <error>${colors.reset}        Diagnose a PCAI error/log (also reads piped stdin).
  ${colors.green}chat [message]${colors.reset}       DevOps agent — live Docker/K8s aware.

${colors.bold}MODELS & KB:${colors.reset}
  ${colors.green}models${colors.reset}               List installed Ollama / local models.
  ${colors.green}model${colors.reset}                Pick the default model interactively.
  ${colors.green}train [--offline]${colors.reset}    Build/refresh the HPE knowledge base.
  ${colors.green}kb${colors.reset}                   Knowledge-base status.
  ${colors.green}learn <file...>${colors.reset}      Teach the KB runbooks, logs, diagrams, postmortems.
  ${colors.green}learned${colors.reset}              List learned docs + auto-captured solved cases.

${colors.bold}VMs (SSH):${colors.reset}
  ${colors.green}vms${colors.reset}                  Inventory with live status (shared with the UI).
  ${colors.green}vm ssh <name>${colors.reset}        Open an interactive SSH session (hops via jump host).
  ${colors.green}vm diagnose <name>${colors.reset}   Read-only kubectl diagnosis with suggested fixes.
  ${colors.green}vm discover <name>${colors.reset}   Containers, pods, K8s + system services, ports.
  ${colors.green}vm peers <name>${colors.reset}      Find other VMs visible from this host.
  ${colors.green}vm graph <name>${colors.reset}      Dependency graph + ranked root causes (read-only).
  ${colors.green}vm impact <name> <id>${colors.reset} Blast radius: what breaks if that resource stops.

${colors.bold}LOCAL DEVOPS:${colors.reset}
  ${colors.green}status${colors.reset}               Docker & Kubernetes health.
  ${colors.green}list <docker|k8s>${colors.reset}    List containers or pods.
  ${colors.green}scan <container-id>${colors.reset}  Scan a container image for CVEs.
  ${colors.green}fix <container-id>${colors.reset}   Upgrade a container to a secure base image.

${colors.bold}EXAMPLES:${colors.reset}
  ${colors.gray}kalam${colors.reset}
  ${colors.gray}kalam ask "how do I connect an external S3 bucket to the lakehouse?"${colors.reset}
  ${colors.gray}kubectl logs mypod | kalam solve${colors.reset}
  ${colors.gray}kalam model${colors.reset}

${colors.gray}Local by default (Ollama). Add GEMINI_API_KEY to .env or run '/key' for Gemini.${colors.reset}
`);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ? args[0].toLowerCase() : '';
  const rest = args.slice(1);

  switch (cmd) {
    case '': await startRepl(); break; // bare `kalam` → interactive
    case 'help': case '-h': case '--help': showHelp(); break;

    case 'ask': case 'pcai-ask': {
      let text = rest.join(' ').trim();
      if (!text) text = await readStdin();
      await singleShot(text, 'ask');
      break;
    }
    case 'solve': case 'diagnose': case 'fixit': {
      let text = rest.join(' ').trim();
      if (!text) text = await readStdin();
      await singleShot(text, 'diagnose');
      break;
    }
    case 'pcai': await startRepl('auto'); break;
    case 'chat': {
      const msg = rest.join(' ').trim();
      if (msg) await singleShot(msg, 'devops');
      else await startRepl('devops');
      break;
    }

    case 'models': await printModels(); break;
    case 'model': {
      const data = await printModels();
      if (data && (data.chatModels || []).length) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${colors.bold}Pick a model by number${colors.reset} ${colors.gray}(Enter to keep current):${colors.reset} `, (answer) => {
          rl.close();
          const n = parseInt(answer.trim(), 10);
          const models = data.chatModels;
          if (n >= 1 && n <= models.length) {
            session.localModel = models[n - 1].name;
            saveUserConfig({ localModel: session.localModel, provider: 'local' });
            console.log(`${colors.green}✅ Default model → ${colors.bold}${session.localModel}${colors.reset}${colors.green} (saved).${colors.reset}\n`);
          } else {
            console.log(`${colors.gray}Kept ${session.localModel}.${colors.reset}\n`);
          }
        });
      }
      break;
    }
    case 'train': await trainKB(rest.includes('--offline') || rest.includes('-o')); console.log(); break;
    case 'kb': await showKB(); console.log(); break;
    case 'learn': await learnFiles(rest); break;
    case 'learned': await showLearned(); console.log(); break;
    case 'vms': await listVmsCli(); break;
    case 'vm': {
      const sub = (rest[0] || '').toLowerCase();
      const vmName = rest[1];
      if (sub === 'ssh') await vmSsh(vmName);
      else if (sub === 'diagnose' || sub === 'diag') await vmDiagnose(vmName);
      else if (sub === 'discover') await vmDiscover(vmName);
      else if (sub === 'peers' || sub === 'neighbors') await vmPeers(vmName);
      else if (sub === 'graph') await vmGraph(vmName);
      else if (sub === 'impact' || sub === 'blast') await vmImpact(vmName, rest[2]);
      else if (sub === 'list' || sub === '') await listVmsCli();
      else console.log(`\n${colors.yellow}Usage: kalam vm <list|ssh|diagnose|discover|peers|graph|impact> [name]${colors.reset}\n`);
      break;
    }
    case 'status': await showStatus(); console.log(); break;
    case 'list': case 'ps': await listResources(rest[0]); break;
    case 'scan': await scanContainer(rest[0]); break;
    case 'fix': await fixContainer(rest[0]); break;

    default:
      // Treat unknown input as a question: `kalam what is MLIS?`
      await singleShot(args.join(' '), null);
      break;
  }
}

main();
