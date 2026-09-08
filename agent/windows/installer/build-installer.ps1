<#
.SYNOPSIS
  Build RemoteTerminalAgentSetup-<version>.exe.

.DESCRIPTION
  Stages everything the installer ships — the three Rust executables, the Node
  agent and its production node_modules — and then packs it with NSIS.

  Staging at build time rather than at install time is deliberate: the
  installer runs npm never and reaches the network never, so it behaves the
  same on a locked-down machine as on a developer's.

  BUILD IT WITH THE NODE THE TARGET RUNS. node-pty is a native module compiled
  for one Node ABI. A mismatch still installs and still starts, and then gives
  every terminal a pipe instead of a PTY: no resize, no vim, no htop. This
  script checks what it staged and refuses to package a broken one.

.USAGE
  powershell -ExecutionPolicy Bypass -File build-installer.ps1
  powershell -ExecutionPolicy Bypass -File build-installer.ps1 -SkipCargo
  powershell -ExecutionPolicy Bypass -File build-installer.ps1 -Makensis "C:\...\makensis.exe"
#>

param(
  [switch]$SkipCargo,
  [string]$Makensis,
  [string]$OutDir
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$windowsDir = Split-Path -Parent $here
$agentDir = Split-Path -Parent $windowsDir
$repoDir = Split-Path -Parent $agentDir
$stage = Join-Path $here "stage"

function Find-Makensis {
  if ($Makensis) {
    if (-not (Test-Path $Makensis)) { throw "makensis not found at $Makensis" }
    return $Makensis
  }
  $onPath = (Get-Command makensis -ErrorAction SilentlyContinue).Source
  if ($onPath) { return $onPath }
  foreach ($candidate in @(
      (Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe"),
      (Join-Path $env:ProgramFiles "NSIS\makensis.exe"))) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw "NSIS was not found. Install it from https://nsis.sourceforge.io or pass -Makensis <path>."
}

# ------------------------------------------------------------------ node ---

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH. Install Node.js 18+ (https://nodejs.org)." }
$nodeMajor = [int](& $node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 18) { throw "Node.js 18+ is required to build; found $(& $node -v)." }

$version = & $node -p "require('$($agentDir -replace '\\','/')/package.json').version"
Write-Host "Building the Remote Terminal Agent installer $version"
Write-Host "  staging with $(& $node -v) ($node)"

# ------------------------------------------------------------------ rust ---

$release = Join-Path $windowsDir "target\release"
if (-not $SkipCargo) {
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo not found. Install Rust (https://rustup.rs) or pass -SkipCargo to use an existing build."
  }
  Write-Host "  cargo build --release"
  Push-Location $windowsDir
  try { & cargo build --release; if ($LASTEXITCODE -ne 0) { throw "cargo build failed." } }
  finally { Pop-Location }
}
foreach ($exe in @("remote-terminal-service.exe", "remote-terminal-tray.exe", "remote-terminal-shell.exe")) {
  if (-not (Test-Path (Join-Path $release $exe))) {
    throw "$exe is missing from $release. Run without -SkipCargo."
  }
}

# ----------------------------------------------------------------- stage ---

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item (Join-Path $release "remote-terminal-service.exe") $stage
Copy-Item (Join-Path $release "remote-terminal-tray.exe") $stage
# The shell launcher has to sit next to index.js: that is where the agent
# looks for it, and without it every terminal runs as LocalSystem.
Copy-Item (Join-Path $release "remote-terminal-shell.exe") $stage
Copy-Item (Join-Path $agentDir "index.js") $stage
Copy-Item (Join-Path $agentDir "package.json") $stage
Copy-Item (Join-Path $agentDir "config.example.json") $stage
if (Test-Path (Join-Path $agentDir "package-lock.json")) {
  Copy-Item (Join-Path $agentDir "package-lock.json") $stage
}
Copy-Item (Join-Path $agentDir "lib") (Join-Path $stage "lib") -Recurse

# The installer's own icon, shared with the desktop app so the family is
# recognisable in Add/Remove Programs.
$icon = Join-Path $repoDir "desktop\src-tauri\icons\icon.ico"
if (Test-Path $icon) {
  Copy-Item $icon (Join-Path $stage "icon.ico")
} else {
  # NSIS needs *some* icon; fall back to its own rather than failing the build.
  $nsisDir = Split-Path -Parent (Find-Makensis)
  Copy-Item (Join-Path $nsisDir "Contrib\Graphics\Icons\modern-install.ico") (Join-Path $stage "icon.ico")
}

Write-Host "  npm install --omit=dev"
Push-Location $stage
try {
  if (Test-Path (Join-Path $stage "package-lock.json")) {
    & npm ci --omit=dev --no-audit --no-fund --loglevel=error
  } else {
    & npm install --omit=dev --no-audit --no-fund --loglevel=error
  }
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
} finally { Pop-Location }

# What the .deb learned the hard way: verify the staged tree, not the one npm
# reported success on, and do it before anything is packaged.
& $node -e "require('$(($stage -replace '\\','/'))/node_modules/@homebridge/node-pty-prebuilt-multiarch')" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "node-pty does not load from the staged tree under $(& $node -v). The installer would ship terminals that cannot resize; not packaging it."
}
Write-Host "  node-pty loads from the staged tree"

# ------------------------------------------------------------------- nsis ---

$makensisExe = Find-Makensis
Write-Host "  $makensisExe"
$nsi = Join-Path $here "remote-terminal-agent.nsi"

Push-Location $here
try {
  & $makensisExe /V2 "/DVERSION=$version" "/DSTAGE=stage" $nsi
  if ($LASTEXITCODE -ne 0) { throw "makensis failed." }
} finally { Pop-Location }

$setup = Join-Path $here "RemoteTerminalAgentSetup-$version.exe"
if (-not (Test-Path $setup)) { throw "makensis reported success but $setup is missing." }

if ($OutDir) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Move-Item $setup (Join-Path $OutDir (Split-Path -Leaf $setup)) -Force
  $setup = Join-Path $OutDir (Split-Path -Leaf $setup)
}

$size = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host ""
Write-Host "Built $setup ($size MB)"
Write-Host ""
Write-Host "Install it by double-clicking, or silently:"
Write-Host "  $(Split-Path -Leaf $setup) /S"
Write-Host ""
Write-Host "A silent install takes no relay details, so follow it with:"
Write-Host "  `"C:\Program Files\Remote Terminal Agent\remote-terminal-service.exe`" install ``"
Write-Host "      -Server wss://relay.example.com --enroll-token <TOKEN>"
