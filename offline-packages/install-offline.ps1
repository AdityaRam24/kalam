# Installs the SSH dependencies on a machine with no internet access.
#
# Why not `npm install *.tgz`: that rewrites package.json to point at "file:"
# paths, which then breaks on every other machine. These tarballs are the exact
# published artifacts (verified against package-lock.json integrity hashes), so
# extracting them into node_modules gives the same result a normal
# `npm install` would, without touching package.json or the lockfile.
#
# Usage (from anywhere):  powershell -ExecutionPolicy Bypass -File .\offline-packages\install-offline.ps1

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$nodeModules = Join-Path $root 'node_modules'

Write-Host "Project root : $root"
Write-Host "node_modules : $nodeModules"
Write-Host ""

if (-not (Test-Path (Join-Path $root 'package.json'))) {
  throw "No package.json in $root - put the offline-packages folder inside the trinetra project."
}
if (-not (Test-Path $nodeModules)) {
  throw "No node_modules in $root - the rest of the dependencies must already be installed there."
}

# name = folder created under node_modules (@types/ssh2 becomes a nested path)
$packages = @(
  @{ tgz = 'ssh2-1.17.0.tgz';         dest = 'ssh2';          name = 'ssh2' },
  @{ tgz = 'asn1-0.2.6.tgz';          dest = 'asn1';          name = 'asn1' },
  @{ tgz = 'safer-buffer-2.1.2.tgz';  dest = 'safer-buffer';  name = 'safer-buffer' },
  @{ tgz = 'bcrypt-pbkdf-1.0.2.tgz';  dest = 'bcrypt-pbkdf';  name = 'bcrypt-pbkdf' },
  @{ tgz = 'tweetnacl-0.14.5.tgz';    dest = 'tweetnacl';     name = 'tweetnacl' },
  @{ tgz = 'types-ssh2-1.15.5.tgz';   dest = '@types\ssh2';   name = '@types/ssh2' }
)

foreach ($p in $packages) {
  $tgz = Join-Path $here $p.tgz
  if (-not (Test-Path $tgz)) { throw "Missing tarball: $tgz" }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("trinetra-offline-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    tar -xzf $tgz -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "tar failed to extract $($p.tgz)" }

    # The top-level directory inside an npm tarball is NOT always "package":
    # ssh2 ships as "mscdex-ssh2-<sha>" and @types/ssh2 as "ssh2". Detect it.
    $roots = @(Get-ChildItem $tmp -Directory)
    if ($roots.Count -ne 1) { throw "Expected one directory inside $($p.tgz), found $($roots.Count)" }
    $extracted = $roots[0].FullName

    # Confirm we are moving the package we think we are.
    $meta = Get-Content (Join-Path $extracted 'package.json') -Raw | ConvertFrom-Json
    if ($meta.name -ne $p.name) { throw "$($p.tgz) contains '$($meta.name)', expected '$($p.name)'" }

    $target = Join-Path $nodeModules $p.dest
    $parent = Split-Path -Parent $target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }

    Move-Item $extracted $target
    Write-Host ("  installed  " + $p.dest.PadRight(16) + $meta.version)
  } finally {
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  }
}

Write-Host ""
Write-Host "Done. Verify with:  node -e ""require('ssh2'); console.log('ssh2 loads OK')"""
