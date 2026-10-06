# Trinetra — Security Remediation Report

**Date:** 2026-10-05
**Branch:** `ingress-hosting` (commit `7b53759 security-hardening`)
**Scope:** server API, Helm/deploy, CLI, frontend, dependencies, git history

## Verification
- `tsc -p tsconfig.server.json` — clean
- `vitest run` — 540/540 pass
- `npm run build` — success
- Each fix re-tested at runtime against an isolated throwaway backend; no production data touched.

## Critical — fixed

### 1. Command injection — `POST /api/docker/scan` (`server/index.ts`)
`imageName` was interpolated into a shell string. Now validated against a strict
image-reference pattern and run via `execFile` (argv array, no shell).
Result: malicious input → `400 Invalid image name format`; valid tags work.

### 2. Command injection — `POST /api/docker/apply-fix` (`server/index.ts`)
`containerId`/`targetImage` were shell-interpolated and container env vars were
re-quoted into a `docker run` string. Now both inputs are validated, the name is
re-checked, and the rebuild uses `execFile` with each env/port value as its own
argv entry. Result: malicious input → `400`.

### 3. Unauthenticated network exposure by default
`deploy/bundle/install.sh`, `deploy/helm/trinetra/templates/networkpolicy.yaml`, `values.yaml`
Off-PCAI installs defaulted to a NodePort with nothing in front. Default is now
**ClusterIP** (reach via `kubectl port-forward`); `--nodeport`/`--host` are explicit
opt-ins. Added an opt-in `NetworkPolicy` to restrict the pod to the ingress path.
PCAI SSO path unchanged.

## High — fixed / mitigated

### 4. SSRF via caller-supplied model URLs (`server/llm.ts` + AI routes)
Central guard: cloud-metadata address always blocked; `TRINETRA_LLM_ALLOWED_HOSTS`
locks endpoints to an allowlist. Wired into `/api/llm/*`, `/api/agent/*`, `/api/pcai/*`.
Note: with no allowlist set, non-metadata internal hosts remain reachable (needed
for legitimate in-cluster endpoints) — set `TRINETRA_LLM_ALLOWED_HOSTS` to fully close.

### 5. DNS rebinding — no Host-header check (`server/cors.ts`, `server/index.ts`)
Host-header allowlist runs before any handler. Loopback, IP literals and configured
hosts pass; an attacker domain is rejected. `/healthz` exempt for probes.
Result: `Host: attacker.example` → `403`; `Host: 127.0.0.1` → `200`.

### 6. Argument injection via `keyPath` (`server/vms.ts`)
`keyPath` validated (POST/PUT/test) to exclude shell metacharacters, so the
generated `ssh -i …` string is safe. Normal POSIX/Windows paths accepted.

### 7. SSH host keys not verified — MITM (`server/ssh.ts`)
Added trust-on-first-use host-key pinning (SHA-256 `hostVerifier`). First connection
pins; later mismatch rejected. `TRINETRA_SSH_STRICT=off` escape hatch; host rebuild
needs the pin line cleared. Legacy KEX/host-key algorithms retained for appliance
compatibility.

## Medium / Low — fixed

| # | Issue | Fix |
|---|---|---|
| 8 | Shell-session IDs disclosed by `GET /api/vms/shell` | IDs removed from the listing (UI doesn't use them) |
| 9 | AI kill-switch missed `/api/pcai/learned` | GET/DELETE now gated by `TRINETRA_LLM_ENABLED=false` |
| 11 | Credential files world-readable | `vms.json` and `~/.trinetra.json` written `0600` |
| 12 | Symlink escape on `/var/log` reads | Reads refuse paths resolving outside `/var/log` |
| 10 | Shared Gemini key / proxy abuse | Mitigated by #3/#4/#5; full fix needs API auth |
| 13 | Mermaid `securityLevel: 'loose'` | Left as-is: only receives K8s-name data; chat pages disabled |

## Clean — no action
Dependencies (`npm audit` 0), offline tarballs (all 6 match lockfile sha512),
git history (no secrets committed), kubectl/journal/log-path quoting, K8s Secret
handling (contents never read), container hardening + digest-pinned image.

## Remaining structural gap
Items 8 and 10 (and the strongest form of 3) stem from the API having **no
authentication of its own** — in-cluster it relies on PCAI SSO at the gateway,
locally on loopback binding. The fixes above remove the injection/SSRF/rebinding
paths and cut default exposure; a first-party auth token on the API would be the
complete fix (larger change, touches frontend + CLI).
