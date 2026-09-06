<#
.SYNOPSIS
  Install, pair, inspect or remove the Remote Terminal agent on Windows.

.DESCRIPTION
  The agent runs as a Windows service (RemoteTerminalAgent), supervised by
  remote-terminal-service.exe, with remote-terminal-tray.exe showing its state
  in the notification area of whoever is signed in.

  WHY A SERVICE. A service starts at boot, before anyone signs in, and keeps
  running after they sign out — which is what "reach this machine from my
  phone" has to mean. The cost is that terminals then run as LocalSystem, so
  anyone who can pair a phone has administrative access to this machine,
  exactly as with an SSH server. Use -Account to run as a named user instead;
  its terminals then have that user's rights and nothing more.

  Upgrading from 0.8 or earlier removes the old per-user scheduled task, whose
  agent only ran while that user was signed in.

.USAGE
  # first install (elevated): copies files, installs the service, prints a code
  powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Install `
      -Server wss://relay.example.com -EnrollToken <TOKEN> [-Name "Office PC"]

  install-windows.ps1 -Pair        # a new pairing code
  install-windows.ps1 -Status      # service state + what the agent reports
  install-windows.ps1 -Name "Home PC"
  install-windows.ps1 -Uninstall [-Purge]

  Configuration lives in %ProgramData%\RemoteTerminal\config.json and the
  identity in state.json beside it; both are readable by SYSTEM and
  administrators only. Node.js 18+ is required.
#>

param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Pair,
  [switch]$Purge,
  [switch]$NoTray,
  [string]$Name,
  [string]$Server,
  [string]$EnrollToken,
  [string]$Account,
  [string]$Password,
  [string]$InstallDir = (Join-Path $env:ProgramFiles "Remote Terminal Agent"),
  [string]$DataDir = (Join-Path $env:ProgramData "RemoteTerminal")
)

$ErrorActionPreference = "Stop"
$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceExeName = "remote-terminal-service.exe"
$trayExeName = "remote-terminal-tray.exe"
$serviceExe = Join-Path $InstallDir $serviceExeName
$trayExe = Join-Path $InstallDir $trayExeName
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValue = "RemoteTerminalTray"
$legacyTask = "RemoteTerminalAgent"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Require-Admin {
  if (-not (Test-Admin)) {
    throw "This needs an elevated prompt (right-click PowerShell -> Run as administrator)."
  }
}

function Get-NodePath {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw "node.exe not found on PATH. Install Node.js 18+ first (https://nodejs.org)." }
  $major = & $node -p "process.versions.node.split('.')[0]"
  if ([int]$major -lt 18) { throw "Node.js 18+ is required; found $(& $node -v)." }
  return $node
}

# The two executables, from a release build if one is present, else built now.
function Resolve-Binaries {
  $release = Join-Path $srcDir "windows\target\release"
  if ((Test-Path (Join-Path $release $serviceExeName)) -and (Test-Path (Join-Path $release $trayExeName))) {
    return $release
  }
  $prebuilt = Join-Path $srcDir "windows\bin"
  if ((Test-Path (Join-Path $prebuilt $serviceExeName)) -and (Test-Path (Join-Path $prebuilt $trayExeName))) {
    return $prebuilt
  }
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "$serviceExeName was not found in windows\target\release or windows\bin, and cargo is not installed to build it. Install Rust (https://rustup.rs) or copy a release build in."
  }
  Write-Host "Building the service and tray (cargo build --release)..."
  Push-Location (Join-Path $srcDir "windows")
  try { & cargo build --release; if ($LASTEXITCODE -ne 0) { throw "cargo build failed." } }
  finally { Pop-Location }
  return $release
}

function Invoke-Service([string[]]$ServiceArgs) {
  if (-not (Test-Path $serviceExe)) { throw "The agent is not installed ($serviceExe is missing). Run with -Install first." }
  & $serviceExe @ServiceArgs
}

function Remove-LegacyTask {
  if (Get-ScheduledTask -TaskName $legacyTask -ErrorAction SilentlyContinue) {
    Write-Host "Removing the old logon task '$legacyTask' (the service replaces it)."
    Stop-ScheduledTask -TaskName $legacyTask -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $legacyTask -Confirm:$false
  }
}

# The old layout kept config.json and state.json next to index.js, where any
# local user could read the enrolment token. Move them under ProgramData.
function Move-LegacyState {
  foreach ($file in @("config.json", "state.json")) {
    $old = Join-Path $srcDir $file
    $new = Join-Path $DataDir $file
    if ((Test-Path $old) -and -not (Test-Path $new)) {
      Write-Host "Moving $file to $DataDir (it holds credentials; the old location did not protect them)."
      Move-Item $old $new
    }
  }
}

# --------------------------------------------------------------------------

if ($Uninstall) {
  Require-Admin
  Remove-LegacyTask
  if (Test-Path $serviceExe) { Invoke-Service @("uninstall") } else { Write-Host "No service binary found; nothing to deregister." }
  Remove-ItemProperty -Path $runKey -Name $runValue -ErrorAction SilentlyContinue
  Get-Process -Name "remote-terminal-tray" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed $InstallDir."
  }
  if ($Purge) {
    if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force }
    Write-Host "Removed $DataDir (configuration, identity and logs)."
  } else {
    Write-Host "Kept $DataDir (configuration, identity and logs). Use -Purge to delete it."
  }
  Write-Host "Remember to remove the machine in the app so its token is revoked."
  return
}

if ($Status) { Invoke-Service @("status"); return }
if ($Pair)   { Invoke-Service @("status"); return }

if ($Name -and -not $Install) {
  Require-Admin
  $node = Get-NodePath
  $env:CONFIG = Join-Path $DataDir "config.json"
  $env:DATA_DIR = $DataDir
  & $node (Join-Path $InstallDir "index.js") --name $Name
  Invoke-Service @("restart")
  return
}

if ($Install) {
  Require-Admin
  $node = Get-NodePath
  if ((-not (Test-Path (Join-Path $DataDir "config.json"))) -and (-not $Server -or -not $EnrollToken)) {
    throw "First install needs -Server <wss://relay> and -EnrollToken <token> (the relay's ENROLL_TOKEN)."
  }
  $binDir = Resolve-Binaries

  Remove-LegacyTask
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Move-LegacyState

  Write-Host "Installing to $InstallDir"
  # The service is stopped first: an exe that is running cannot be replaced.
  if (Test-Path $serviceExe) { & $serviceExe stop 2>$null | Out-Null }
  Get-Process -Name "remote-terminal-tray" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  Copy-Item (Join-Path $binDir $serviceExeName) $InstallDir -Force
  Copy-Item (Join-Path $binDir $trayExeName) $InstallDir -Force
  Copy-Item (Join-Path $srcDir "index.js") $InstallDir -Force
  Copy-Item (Join-Path $srcDir "package.json") $InstallDir -Force
  Copy-Item (Join-Path $srcDir "config.example.json") $InstallDir -Force
  if (Test-Path (Join-Path $srcDir "package-lock.json")) {
    Copy-Item (Join-Path $srcDir "package-lock.json") $InstallDir -Force
  }
  $libTarget = Join-Path $InstallDir "lib"
  if (Test-Path $libTarget) { Remove-Item $libTarget -Recurse -Force }
  Copy-Item (Join-Path $srcDir "lib") $libTarget -Recurse -Force

  Write-Host "Installing dependencies (npm install --omit=dev)..."
  Push-Location $InstallDir
  try {
    if (Test-Path (Join-Path $InstallDir "package-lock.json")) {
      & npm ci --omit=dev --no-audit --no-fund --loglevel=error
    } else {
      & npm install --omit=dev --no-audit --no-fund --loglevel=error
    }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  } finally { Pop-Location }

  # A native module that does not load costs the PTY, and with it resize and
  # every full-screen program. Say so now rather than let it be discovered.
  & $node -e "require('$($InstallDir -replace '\\','\\')\\node_modules\\@homebridge\\node-pty-prebuilt-multiarch')" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "node-pty does not load under $(& $node -v); terminals will fall back to pipes (no resize, no full-screen programs)."
  }

  $installArgs = @("install", "--node", $node, "--agent", (Join-Path $InstallDir "index.js"), "--data", $DataDir)
  if ($Server)      { $installArgs += @("--server", $Server) }
  if ($EnrollToken) { $installArgs += @("--enroll-token", $EnrollToken) }
  if ($Name)        { $installArgs += @("--name", $Name) }
  if ($Account)     { $installArgs += @("--account", $Account) }
  if ($Password)    { $installArgs += @("--password", $Password) }
  & $serviceExe @installArgs
  if ($LASTEXITCODE -ne 0) { throw "The service installer failed (exit $LASTEXITCODE)." }

  if (-not $NoTray) {
    Set-ItemProperty -Path $runKey -Name $runValue -Value "`"$trayExe`""
    Start-Process $trayExe
    Write-Host "`nTray icon installed for $env:USERNAME (starts at sign-in)."
    Write-Host "For other users, add this to their startup: $trayExe"
  }

  Write-Host "`nLater:"
  Write-Host "  install-windows.ps1 -Status        service state and a pairing code"
  Write-Host "  install-windows.ps1 -Uninstall     remove it"
  Write-Host "  $serviceExeName status | start | stop | restart"
  Write-Host "  Log: $(Join-Path $DataDir 'logs\agent.log')"
  return
}

Write-Host "Specify -Install, -Pair, -Status, -Name or -Uninstall. See the header of this script for details."
