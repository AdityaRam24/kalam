#!/usr/bin/env node

const { exec } = require('child_process');
const http = require('http');
const readline = require('readline');

// CLI Styling Colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
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
  bgYellow: '\x1b[43m',
  bgPurple: '\x1b[45m'
};

const BACKEND_URL = 'http://localhost:3001';

// Helper: Run Local Shell Command
function runCmd(command) {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: stdout || '',
        stderr: stderr || ''
      });
    });
  });
}

// Helper: HTTP GET Request
function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BACKEND_URL}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            reject(new Error(data || `HTTP Error ${res.statusCode}`));
          } else {
            resolve(JSON.parse(data));
          }
        } catch (e) {
          reject(new Error(`Failed to parse JSON response: ${e.message}`));
        }
      });
    }).on('error', (err) => {
      reject(new Error(`Server connection failed: ${err.message}`));
    });
  });
}

// Helper: HTTP POST Request
function postJSON(path, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = http.request(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            reject(new Error(data || `HTTP Error ${res.statusCode}`));
          } else {
            resolve(JSON.parse(data));
          }
        } catch (e) {
          reject(new Error(`Failed to parse JSON response: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Server connection failed: ${err.message}`));
    });

    req.write(postData);
    req.end();
  });
}

// Command: Help manual
function showHelp() {
  console.log(`
${colors.cyan}${colors.bold}╦╔═╔═╗╦  ╔═╗╔╦╗  ╔═╗╦  ╦
╠╩╗╠═╣║  ╠═╣║║║  ║  ║  ║
╩ ╩╩ ╩╩═╝╩ ╩╩ ╩  ╚═╝╩═╝╩${colors.reset}
${colors.gray}Kalam Local DevOps & Container Hardener CLI${colors.reset}

${colors.bold}USAGE:${colors.reset}
  kalam <command> [options]

${colors.bold}COMMANDS:${colors.reset}
  ${colors.green}status${colors.reset}              Check status of local Docker and Kubernetes daemons.
  ${colors.green}list <docker|k8s>${colors.reset}   List running containers or Kubernetes resources.
  ${colors.green}scan <container-id>${colors.reset} Scan a container image for vulnerabilities (CVEs).
  ${colors.green}fix <container-id>${colors.reset}  One-click upgrade of container to secure Alpine/slim base.
  ${colors.green}chat [message]${colors.reset}      Chat with Kalam DevOps Agent (starts prompt loop if message omitted).
  ${colors.green}help${colors.reset}                Show this manual.

${colors.bold}EXAMPLES:${colors.reset}
  kalam status
  kalam list docker
  kalam scan themachine-postgres-1
  kalam fix themachine-postgres-1
  kalam chat "explain what is wrong with my clickhouse container"
`);
}

// Command: Status check
async function showStatus() {
  console.log(`\n${colors.bold}🔍 Scanning system daemons...${colors.reset}\n`);
  try {
    const status = await getJSON('/api/status');
    const d = status.docker;
    const k = status.kubernetes;

    console.log(`${colors.bold}🐳 Docker Daemon:${colors.reset}`);
    console.log(`  State:    ${d.running ? `${colors.green}🟢 RUNNING${colors.reset}` : `${colors.red}🔴 STOPPED${colors.reset}`}`);
    if (d.installed) {
      console.log(`  Version:  ${d.version}`);
    } else {
      console.log(`  Status:   ${colors.yellow}⚠️ Not Installed${colors.reset}`);
    }

    console.log(`\n${colors.bold}☸️ Kubernetes Cluster:${colors.reset}`);
    console.log(`  State:    ${k.running ? `${colors.green}🟢 RUNNING${colors.reset}` : `${colors.red}🔴 STOPPED${colors.reset}`}`);
    if (k.installed) {
      console.log(`  Version:  ${k.version}`);
      console.log(`  Context:  ${k.context}`);
    } else {
      console.log(`  Status:   ${colors.yellow}⚠️ Not Installed${colors.reset}`);
    }
  } catch (err) {
    console.log(`${colors.yellow}⚠️ Could not connect to Kalam server. Querying local shells directly...${colors.reset}\n`);
    const docVer = await runCmd('docker --version');
    const kVer = await runCmd('kubectl version --client');

    console.log(`${colors.bold}🐳 Docker:${colors.reset} ${docVer.success ? `${colors.green}🟢 Active (${docVer.stdout.trim()})${colors.reset}` : `${colors.red}🔴 Not found${colors.reset}`}`);
    console.log(`${colors.bold}☸️ Kubernetes:${colors.reset} ${kVer.success ? `${colors.green}🟢 Active (${kVer.stdout.trim().split('\n')[0]})${colors.reset}` : `${colors.red}🔴 Not found${colors.reset}`}`);
  }
  console.log();
}

// Command: List Resources
async function listResources(type) {
  if (!type || (type !== 'docker' && type !== 'k8s')) {
    console.log(`\n${colors.red}❌ Error: Please specify resource type. Use 'kalam list docker' or 'kalam list k8s'.${colors.reset}\n`);
    return;
  }

  console.log(`\n${colors.bold}Fetching ${type === 'docker' ? 'Docker Containers' : 'Kubernetes Pods'}...${colors.reset}\n`);

  try {
    if (type === 'docker') {
      const res = await getJSON('/api/docker/containers');
      if (res.length === 0) {
        console.log('No containers found.');
        return;
      }
      
      // Print Ascii Table
      console.log(`┌──────────────┬─────────────────────────┬──────────────────────┬─────────────┐`);
      console.log(`│ ${colors.bold}CONTAINER ID${colors.reset} │ ${colors.bold}NAME${colors.reset}                    │ ${colors.bold}IMAGE${colors.reset}                 │ ${colors.bold}STATUS${colors.reset}      │`);
      console.log(`├──────────────┼─────────────────────────┼──────────────────────┼─────────────┤`);
      res.forEach(c => {
        const id = c.id.slice(0, 12).padEnd(12);
        const name = c.name.slice(0, 23).padEnd(23);
        const img = c.image.slice(0, 20).padEnd(20);
        const stateColor = c.state === 'running' ? colors.green : colors.red;
        const state = `${stateColor}${c.state.toUpperCase().padEnd(11)}${colors.reset}`;
        console.log(`│ ${id} │ ${name} │ ${img} │ ${state} │`);
      });
      console.log(`└──────────────┴─────────────────────────┴──────────────────────┴─────────────┘`);
    } else {
      const res = await getJSON('/api/k8s/resources');
      const pods = res.pods || [];
      if (pods.length === 0) {
        console.log('No Kubernetes pods found.');
        return;
      }

      console.log(`┌──────────────────────┬────────────────────────────────┬─────────┬─────────────┐`);
      console.log(`│ ${colors.bold}NAMESPACE${colors.reset}            │ ${colors.bold}POD NAME${colors.reset}                       │ ${colors.bold}READY${colors.reset}   │ ${colors.bold}STATUS${colors.reset}      │`);
      console.log(`├──────────────────────┼────────────────────────────────┼─────────┼─────────────┤`);
      pods.forEach(p => {
        const ns = p.namespace.slice(0, 20).padEnd(20);
        const name = p.name.slice(0, 30).padEnd(30);
        const ready = p.ready.padEnd(7);
        const statusColor = p.status === 'Running' ? colors.green : colors.yellow;
        const status = `${statusColor}${p.status.padEnd(11)}${colors.reset}`;
        console.log(`│ ${ns} │ ${name} │ ${ready} │ ${status} │`);
      });
      console.log(`└──────────────────────┴────────────────────────────────┴─────────┴─────────────┘`);
    }
  } catch (err) {
    console.log(`${colors.red}❌ Failed to query resources: ${err.message}${colors.reset}\n`);
  }
}

// Command: Scan image vulnerabilities
async function scanContainer(target) {
  if (!target) {
    console.log(`\n${colors.red}❌ Error: Please specify a container ID or name. Usage: 'kalam scan <container-id>'${colors.reset}\n`);
    return;
  }

  try {
    // 1. Resolve container target to image name
    const containers = await getJSON('/api/docker/containers');
    const container = containers.find(c => c.id.startsWith(target) || c.name === target);
    
    if (!container) {
      console.log(`\n${colors.red}❌ Error: Could not find container '${target}'${colors.reset}\n`);
      return;
    }

    console.log(`\n${colors.bold}🛡️ Scanning container: ${colors.cyan}${container.name}${colors.reset} (Image: ${colors.yellow}${container.image}${colors.reset})...\n`);

    const scan = await postJSON('/api/docker/scan', { imageName: container.image });
    
    // Print stats
    const sum = scan.summary;
    console.log(`${colors.bold}Vulnerability Stats:${colors.reset}`);
    console.log(`  ${colors.bgRed}${colors.white}${colors.bold} CRITICAL ${colors.reset}  ${colors.red}${sum.critical}${colors.reset}`);
    console.log(`  ${colors.bgYellow}${colors.white}${colors.bold} HIGH     ${colors.reset}  ${colors.yellow}${sum.high}${colors.reset}`);
    console.log(`  ${colors.bgYellow}${colors.white}${colors.bold} MEDIUM   ${colors.reset}  ${colors.yellow}${sum.medium}${colors.reset}`);
    console.log(`  ${colors.gray}${colors.bold} LOW      ${colors.reset}  ${colors.gray}${sum.low}${colors.reset}`);
    console.log();

    if (scan.vulnerabilities.length > 0) {
      console.log(`${colors.bold}Vulnerability List:${colors.reset}`);
      scan.vulnerabilities.forEach(v => {
        const sevColor = v.severity === 'Critical' ? colors.red : v.severity === 'High' ? colors.yellow : colors.gray;
        console.log(`  • [${sevColor}${v.severity}${colors.reset}] ${colors.bold}${v.cve}${colors.reset} in ${colors.cyan}${v.package}${colors.reset}: ${v.desc}`);
      });
      console.log();
    }

    if (scan.fixAction) {
      console.log(`${colors.bold}${colors.green}⚡ Recommended Secure Hardening Fix:${colors.reset}`);
      console.log(`  Plan:   ${scan.recommendation}`);
      console.log(`  Target: Replace base image with ${colors.green}${scan.fixAction.targetImage}${colors.reset}`);
      console.log(`  Action: Run ${colors.bold}kalam fix ${container.name}${colors.reset} to auto-patch this container instantly!`);
    } else {
      console.log(`${colors.green}✅ No vulnerabilities found. Your image is secure!${colors.reset}`);
    }
    console.log();
  } catch (err) {
    console.log(`${colors.red}❌ Scan failed: ${err.message}${colors.reset}\n`);
  }
}

// Command: Auto-Fix container
async function fixContainer(target) {
  if (!target) {
    console.log(`\n${colors.red}❌ Error: Please specify a container ID or name. Usage: 'kalam fix <container-id>'${colors.reset}\n`);
    return;
  }

  try {
    // 1. Resolve container target
    const containers = await getJSON('/api/docker/containers');
    const container = containers.find(c => c.id.startsWith(target) || c.name === target);
    
    if (!container) {
      console.log(`\n${colors.red}❌ Error: Could not find container '${target}'${colors.reset}\n`);
      return;
    }

    console.log(`\n${colors.bold}🔍 Running pre-upgrade security analysis for ${colors.cyan}${container.name}${colors.reset}...`);
    const scan = await postJSON('/api/docker/scan', { imageName: container.image });

    if (!scan.fixAction) {
      console.log(`\n${colors.green}✅ Container ${container.name} is already using a secure base image. No fix needed!${colors.reset}\n`);
      return;
    }

    const secureImage = scan.fixAction.targetImage;
    console.log(`\n${colors.bold}${colors.magenta}⚡ Applying Secure Patch & Re-deploying...${colors.reset}`);
    console.log(`  - Target Image: ${colors.green}${secureImage}${colors.reset}`);
    console.log(`  - This will stop the active container, preserve its network bindings, and re-create it.`);
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(`\nDo you want to proceed? [y/N]: `, async (answer) => {
      rl.close();
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(`\n${colors.yellow}Upgrade aborted by user.${colors.reset}\n`);
        return;
      }

      console.log(`\n⏳ Pulling secure base and rebuilding container ports... (might take a minute)`);
      try {
        const fixResult = await postJSON('/api/docker/apply-fix', {
          containerId: container.id,
          targetImage: secureImage
        });

        console.log(`\n${colors.green}${colors.bold}🎉 SUCCESS: Container Hardened!${colors.reset}`);
        console.log(`  - Output: ${fixResult.message}`);
        console.log(`  - Command executed: ${colors.gray}${fixResult.cmdRun}${colors.reset}`);
        console.log(`  - New Container ID: ${colors.cyan}${fixResult.newContainerId}${colors.reset}\n`);
      } catch (err) {
        console.log(`\n${colors.red}❌ Re-deployment failed: ${err.message}${colors.reset}\n`);
      }
    });

  } catch (err) {
    console.log(`\n${colors.red}❌ Upgrade setup failed: ${err.message}${colors.reset}\n`);
  }
}

// Command: Chat with DevOps Agent
async function handleChat(initialMessage) {
  // Read local settings if server isn't configured
  let provider = 'local';
  let localModel = 'qwen2.5-coder';
  
  try {
    const config = await getJSON('/api/status');
    // Just verifying server is alive
  } catch (err) {
    console.log(`${colors.red}❌ Error: Kalam backend server is not running on port 3001.${colors.reset}`);
    console.log(`Run ${colors.bold}npm run dev${colors.reset} to boot the backend first!\n`);
    return;
  }

  if (initialMessage) {
    // Single message mode
    process.stdout.write(`\n${colors.magenta}${colors.bold}Kalam Agent: ${colors.reset}⏳ Thinking...`);
    try {
      const response = await postJSON('/api/agent/chat', {
        message: initialMessage,
        provider: 'local',
        localUrl: 'http://localhost:11434/v1',
        localModel: 'qwen2.5-coder'
      });
      
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      console.log(`\n${colors.magenta}${colors.bold}Kalam Agent:${colors.reset}\n${response.message}\n`);
    } catch (err) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      console.log(`\n${colors.red}❌ Failed to get response: ${err.message}${colors.reset}\n`);
    }
  } else {
    // Interactive chat session loop
    console.log(`\n${colors.magenta}${colors.bold}====================================================${colors.reset}`);
    console.log(` ${colors.bold}💬 Welcome to Kalam DevOps Agent Shell Chat Loop${colors.reset}`);
    console.log(` ${colors.gray}Type your DevOps request (e.g. 'restart clickhouse container').${colors.reset}`);
    console.log(` ${colors.gray}Type 'exit' or 'quit' to terminate chat.${colors.reset}`);
    console.log(`${colors.magenta}${colors.bold}====================================================${colors.reset}\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${colors.bold}kalam> ${colors.reset}`
    });

    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log(`\n${colors.gray}Goodbye!${colors.reset}\n`);
        rl.close();
        return;
      }

      if (!input) {
        rl.prompt();
        return;
      }

      process.stdout.write(`${colors.gray}Thinking...${colors.reset}`);
      try {
        const response = await postJSON('/api/agent/chat', {
          message: input,
          provider: 'local',
          localUrl: 'http://localhost:11434/v1',
          localModel: 'qwen2.5-coder'
        });

        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        console.log(`\n${colors.magenta}${colors.bold}Kalam Agent:${colors.reset}\n${response.message}\n`);
      } catch (err) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        console.log(`\n${colors.red}❌ Error: ${err.message}${colors.reset}\n`);
      }
      rl.prompt();
    });
  }
}

// CLI Routing Entrypoint
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ? args[0].toLowerCase() : 'help';

  switch (cmd) {
    case 'help':
    case '-h':
    case '--help':
      showHelp();
      break;
    case 'status':
      await showStatus();
      break;
    case 'list':
    case 'ps':
      await listResources(args[1]);
      break;
    case 'scan':
      await scanContainer(args[1]);
      break;
    case 'fix':
      await fixContainer(args[1]);
      break;
    case 'chat':
      const msg = args.slice(1).join(' ');
      await handleChat(msg);
      break;
    default:
      console.log(`\n${colors.red}❌ Error: Unknown command '${cmd}'. Run 'kalam help' for usage.${colors.reset}\n`);
      break;
  }
}

main();
