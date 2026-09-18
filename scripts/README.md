# Kalam — Linux scripts

Everything needed to set up and run Kalam on a Linux machine. These are the
POSIX equivalents of the `.bat` files in the repo root.

```bash
git clone <repo> && cd kalam
chmod +x scripts/*.sh          # once, if git didn't preserve the exec bit
./scripts/setup.sh             # install Node deps, create .env, build dist/
./scripts/start.sh             # run it → http://127.0.0.1:3001
```

| Script | What it does |
| --- | --- |
| `setup.sh` | One-time setup: prerequisite checks, `.env`, `npm install`, frontend build, optional CLI link. Flags: `--no-build`, `--link`, `--clean`. |
| `start.sh` | Production run. One process on one port — Express serves `dist/`, so **no Vite and no :5173**. Flags: `--rebuild`, `--lan`, `--force`, `--port N`, `--no-open`. |
| `dev.sh` | Development run with hot reload: API on 3001 + Vite on 5173. Flags: `--lan`, `--force`, `--port N`, `--client-port N`, `--no-open`. |
| `stop.sh` | Kills whatever is listening on the Kalam ports. Accepts explicit ports. |
| `doctor.sh` | Diagnoses connection failures (including `ECONNREFUSED 0.0.0.0:5173`) and prints the fix. `--fix` frees ports / reinstalls deps. |
| `install-cli.sh` | Registers the global `kalam` command via `npm link`. `--uninstall` reverses it. |
| `lib/common.sh` | Shared helpers — sourced, not run. |

Requirements: **Node.js 20+** (Vite 8 / TypeScript 6) and npm. `curl`, `lsof`
or `ss` are optional but make the health checks and port handling work.
`docker` / `kubectl` are only needed for the cluster features.

## Configuration

All scripts read `.env`, and a shell variable always overrides it:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | Backend / production port |
| `HOST` | `127.0.0.1` | Backend bind address |
| `CLIENT_PORT` | `5173` | Vite dev-server port |
| `CLIENT_HOST` | same as `HOST` | Vite bind address |
| `CLIENT_ALLOWED_HOSTS` | `.pcaicoe.com,.ext.hpe.com` | Hostnames the dev server accepts; a leading dot matches all subdomains, `true` allows any |
| `ALLOWED_HOSTS` | falls back to `CLIENT_ALLOWED_HOSTS` | Browser origins the **backend** accepts (CORS). Loopback is always allowed |
| `CLIENT_PUBLIC_HOST` | empty | Ingress hostname the browser uses — set it to route HMR back through the ingress |
| `CLIENT_HMR_PROTOCOL` | `wss` | HMR socket scheme; use `ws` for a plain-HTTP ingress. Only read when `CLIENT_PUBLIC_HOST` is set |
| `CLIENT_HMR_PORT` | `443` | Port the browser dials for HMR. Only read when `CLIENT_PUBLIC_HOST` is set |
| `GEMINI_API_KEY` | empty | Enables the Gemini agent (local LLMs work without it) |

```bash
PORT=8080 ./scripts/start.sh
./scripts/dev.sh --client-port 5200
```

The backend binds loopback by default on purpose: it can run `docker`,
`kubectl` and `ssh` commands, so exposing it needs the explicit `--lan`.

## `connect ECONNREFUSED 0.0.0.0:5173`

`ECONNREFUSED` means the TCP connection was actively rejected — nothing is
listening at that address and port. Run `./scripts/doctor.sh`; it checks each
cause below and tells you which one applies.

1. **Vite isn't running.** Port 5173 only exists while `./scripts/dev.sh` is up.
   `./scripts/start.sh` serves the built app from port 3001 alone — if you have
   a bookmark or script pointing at 5173, that's the mismatch.
2. **You dialed `0.0.0.0`.** That address means "listen on every interface"; as
   a *destination* it is not routable, and dialing it is what produces this
   exact message. Use `http://127.0.0.1:5173` on the machine itself, or
   `http://<machine-lan-ip>:5173` from elsewhere. `dev.sh` always prints a
   dialable URL rather than the bind address.
3. **Vite moved to another port.** By default Vite quietly takes 5174 when 5173
   is busy, so anything still aimed at 5173 gets refused. `vite.config.ts` now
   sets `strictPort: true` so it fails loudly, and `dev.sh` checks both ports
   before starting — `--force` clears them.
4. **Vite bound to loopback while you browsed from another machine.** Use
   `./scripts/dev.sh --lan` (binds `0.0.0.0`) and open the LAN IP it prints.
   Also open the port if a firewall is active:
   `sudo ufw allow 5173/tcp` — or `sudo firewall-cmd --add-port=5173/tcp`.
5. **An HTTP proxy is swallowing loopback traffic.** If `http_proxy` is set
   without `no_proxy` covering localhost, every local request goes to the proxy
   and is refused: `export no_proxy=localhost,127.0.0.1,::1`.
6. **IPv6/IPv4 mismatch.** On many distros `localhost` resolves to `::1` first
   while the server listens on IPv4. The API proxy now targets `127.0.0.1`
   explicitly; `doctor.sh` verifies your `/etc/hosts` mapping.

Fastest way out, in order:

```bash
./scripts/doctor.sh        # what's actually wrong
./scripts/stop.sh          # clear stuck listeners
./scripts/start.sh         # single port, 5173 not involved at all
./scripts/dev.sh --force   # or hot-reload mode with ports pre-cleaned
```

## Running as a service (optional)

```ini
# /etc/systemd/system/kalam.service
[Unit]
Description=Kalam
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/kalam
ExecStart=/opt/kalam/scripts/start.sh --no-open
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kalam
journalctl -u kalam -f
```

## Diagnosing a host that shows nothing

`npm run diagnose` runs the real discovery pipeline — the same commands, buffers
and parsers the server uses — and reports every stage. Use it whenever the
dashboard or topology map is emptier than the cluster is.

```bash
npm run diagnose -- --local                 # this machine (Kalam on a cluster node)
npm run diagnose -- <name-from-inventory>   # a host reached over SSH
npm run diagnose -- --host 10.1.2.3 --user ubuntu --key ~/.ssh/id_rsa
KALAM_SSH_PASSWORD=... npm run diagnose -- --host 10.1.2.3 --user ubuntu
```

Add `--root` to elevate, `--via <name>` for a jump host, `--json` to dump the
raw payload. It prints the kubeconfig context in use, whether that identity may
list pods, per-kind object counts with sizes and timings, the exact kubectl
error for anything that failed, and the resulting edge and canvas counts. It
exits non-zero when something is wrong.

The four failures it exists to name, all of which used to render as an empty
map with no explanation:

| What it prints | What it means |
| --- | --- |
| `The connection to the server localhost:8080 was refused` | no kubeconfig for the user Kalam runs as |
| `You must be logged in to the server (Unauthorized)` | credentials expired or wrong context |
| `Forbidden: pods is forbidden: User "system:serviceaccount:..."` | the identity may not list that kind |
| `sh: kubectl: command not found` | not on the non-interactive SSH `PATH` |
| `too-large` / `timed-out` / `cut-short` | the read exceeded a limit — raise `KALAM_KUBECTL_TIMEOUT_MS` |

## Checking the topology map

`npm run topology:check` computes the exact positions the topology canvas will
draw, prints them as an ASCII map, and asserts the properties that make it
readable: no card overlaps another, each stage keeps its own column range,
every namespace gets its own band and its cards stay inside it, no stage
collapses into a single column, and the aspect ratio is usable. It exits
non-zero on failure, so it can gate a release.

```bash
npm run topology:check                                             # live cluster (kubectl)
npm run topology:check -- http://localhost:3001/api/k8s/resources  # what the browser is served
npm run topology:check -- snapshot.json                            # a saved kubectl dump
```

A VM's topology is served by `POST /api/vms/discover`, not by a GET, so it
cannot be checked through the URL form directly. Save that host's payload first
and check the file:

```bash
curl -s -X POST http://localhost:3001/api/vms/discover   -H 'Content-Type: application/json' -d '{"name":"<vm>"}' > vm.json
npm run topology:check -- vm.json
```

## Checking a host's logs and health from the shell

Everything on the Host Logs tab is a `POST` against the running server, so the
same data can be pulled with `curl` — useful when the UI is unreachable or to
attach to a ticket. `<vm>` is a name from the SSH inventory.

```bash
API=http://localhost:3001; VM='{"name":"<vm>"}'
curl -s -X POST $API/api/logs/overview -H 'Content-Type: application/json' -d "$VM" > overview.json   # health checks, services, disks
curl -s -X POST $API/api/logs/scan     -H 'Content-Type: application/json' -d '{"name":"<vm>","hours":24}' > findings.json
curl -s -X POST $API/api/logs/journal  -H 'Content-Type: application/json' \
  -d '{"name":"<vm>","query":{"boot":"-1","priority":"err","lines":500}}'                            # errors from the previous boot
curl -s -X POST $API/api/logs/download -H 'Content-Type: application/json' -d "$VM" -o varlog.tar.gz  # all of /var/log
```

`/api/logs/service` with `"action":"restart"` changes the host and requires
`"confirm":true`; `"action":"status"` is read-only.
