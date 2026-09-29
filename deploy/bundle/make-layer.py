"""Write the Kalam application layer as a tarball that `crane mutate --append`
lays on top of node:22-alpine.

Built with tarfile rather than `tar` because owners and modes have to be exact
(uid 10001, executable bits) and the build machine may be Windows, whose
filesystem carries neither.

usage: make-layer.py <app-dir> <kubectl> <tini> <base-etc-dir> <out.tar>
"""
import io
import os
import sys
import tarfile
import time

UID = GID = 10001
MTIME = int(time.time())

app_dir, kubectl, tini, base_etc, out = sys.argv[1:6]


def dir_entry(tar, name, uid=0, gid=0, mode=0o755):
    ti = tarfile.TarInfo(name)
    ti.type = tarfile.DIRTYPE
    ti.mode, ti.uid, ti.gid, ti.mtime = mode, uid, gid, MTIME
    tar.addfile(ti)


def file_entry(tar, name, data, mode=0o644, uid=0, gid=0):
    ti = tarfile.TarInfo(name)
    ti.size, ti.mode, ti.uid, ti.gid, ti.mtime = len(data), mode, uid, gid, MTIME
    tar.addfile(ti, io.BytesIO(data))


def read(path):
    with open(path, 'rb') as f:
        return f.read()


with tarfile.open(out, 'w', format=tarfile.PAX_FORMAT) as tar:
    # Non-root user. The base's passwd/group are carried forward because a
    # layer replaces a file wholesale; appending is the only way to add a line.
    passwd = read(os.path.join(base_etc, 'passwd')).rstrip(b'\n')
    group = read(os.path.join(base_etc, 'group')).rstrip(b'\n')
    dir_entry(tar, 'etc')
    file_entry(tar, 'etc/passwd', passwd + b'\nkalam:x:10001:10001:kalam:/home/kalam:/sbin/nologin\n')
    file_entry(tar, 'etc/group', group + b'\nkalam:x:10001:\n')

    dir_entry(tar, 'home')
    dir_entry(tar, 'home/kalam', UID, GID, 0o750)
    # Everything the app writes lives here; the chart mounts a volume over it.
    dir_entry(tar, 'data', UID, GID, 0o770)

    dir_entry(tar, 'sbin')
    file_entry(tar, 'sbin/tini', read(tini), 0o755)
    dir_entry(tar, 'usr')
    dir_entry(tar, 'usr/local')
    dir_entry(tar, 'usr/local/bin')
    file_entry(tar, 'usr/local/bin/kubectl', read(kubectl), 0o755)

    # /app is root-owned and read-only to the app, except server/, which holds
    # the fallback state paths used when KALAM_*_PATH is not set.
    dir_entry(tar, 'app')
    for root, dirs, files in os.walk(app_dir):
        dirs.sort()
        rel = os.path.relpath(root, app_dir).replace(os.sep, '/')
        arc = 'app' if rel == '.' else f'app/{rel}'
        writable = arc == 'app/server' or arc.startswith('app/server/')
        uid = UID if writable else 0
        if arc != 'app':
            dir_entry(tar, arc, uid, uid)
        for name in sorted(files):
            data = read(os.path.join(root, name))
            # Keep any shipped executables (esbuild's binary) executable.
            mode = 0o755 if (data[:4] == b'\x7fELF' or data[:2] == b'#!') else 0o644
            file_entry(tar, f'{arc}/{name}', data, mode, uid, uid)

print(f'wrote {out} ({os.path.getsize(out) // (1024 * 1024)} MB)')
