"""Cut a production node_modules down to what the server imports at runtime.

`dependencies` also lists the frontend libraries (react, mermaid, lucide...),
which are compiled into dist/ and never loaded by the server. Keeping only the
closure of the server's own imports takes the image from ~250 MB of
node_modules to ~50 MB.

usage: prune-deps.py <app-dir>   (app-dir holds package-lock.json + node_modules)
"""
import json
import os
import shutil
import sys

# Every bare import under server/ (excluding tests), plus tsx, which runs it.
ROOTS = ['express', 'cors', 'dotenv', 'ssh2', '@google/genai', 'tsx']

app = sys.argv[1]
lock = json.load(open(os.path.join(app, 'package-lock.json')))['packages']


def resolve(frm, name):
    """Node's lookup: nearest node_modules/<name> walking up from `frm`."""
    base = frm
    while True:
        cand = f'{base}/node_modules/{name}' if base else f'node_modules/{name}'
        if cand in lock:
            return cand
        if not base:
            return None
        i = base.rfind('/node_modules/')
        base = base[:i] if i >= 0 else ''


keep, stack = set(), [resolve('', r) for r in ROOTS]
missing = [r for r, p in zip(ROOTS, stack) if p is None]
if missing:
    sys.exit(f'prune-deps: not in package-lock.json: {missing}')
while stack:
    p = stack.pop()
    if not p or p in keep:
        continue
    keep.add(p)
    meta = lock[p]
    for group in ('dependencies', 'optionalDependencies', 'peerDependencies'):
        stack.extend(resolve(p, d) for d in meta.get(group, {}))

removed = 0
for p in sorted(lock):
    top = p.startswith('node_modules/') and '/node_modules/' not in p[len('node_modules/'):]
    if not top or p in keep:
        continue
    full = os.path.join(app, p)
    # Windows scanners briefly hold files open; a second pass finishes the job.
    for _ in range(3):
        shutil.rmtree(full, ignore_errors=True)
    if os.path.exists(full):
        sys.exit(f'prune-deps: could not remove {full}')
    removed += 1

nm = os.path.join(app, 'node_modules')
shutil.rmtree(os.path.join(nm, '.bin'), ignore_errors=True)
for s in os.listdir(nm):
    d = os.path.join(nm, s)
    if s.startswith('@') and os.path.isdir(d) and not os.listdir(d):
        os.rmdir(d)
print(f'prune-deps: kept {len(keep)} packages, removed {removed}')
