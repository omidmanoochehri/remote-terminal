<#
.SYNOPSIS
  Install, pair, inspect or remove the Remote Terminal agent on Windows.

.DESCRIPTION
  The agent runs as a per-user logon Scheduled Task (hidden), so it starts
  automatically and survives logout/reboot.

  WHY A SCHEDULED TASK (not a Windows Service): the agent spawns INTERACTIVE
  terminals (ConPTY). A classic Windows Service runs in session 0 as SYSTEM
  and cannot attach a real interactive console for the logged-in user. A
  logon-triggered task runs inside the user's session, which is exactly what
  a PTY needs — and every terminal runs as that (non-admin) user.

.USAGE
  # first install: writes config.json, registers + starts the task, prints a pairing code
  powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Install -Server wss://relay.example.com -EnrollToken <TOKEN> [-Name "Office PC"]

  powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Pair       # new pairing code
  powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Status     # task + relay status
  powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Name "Home PC"
  powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall

  Configuration lives in agent\config.json (see config.example.json); the
  identity issued by the relay lives in agent\state.json. Node.js 18+ required.
#>

param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Pair,
  [string]$Name,
  [string]$Server,
  [string]$EnrollToken,
  [string]$TaskName = "RemoteTerminalAgent"
)

$ErrorActionPreference = "Stop"
$agentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexJs = Join-Path $agentDir "index.js"
$configJson = Join-Path $agentDir "config.json"
$stateJson = Join-Path $agentDir "state.json"

function Get-NodePath {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw "node.exe not found on PATH. Install Node.js 18+ first (https://nodejs.org)." }
  return $node
}

function Invoke-Agent([string[]]$AgentArgs) {
  $node = Get-NodePath
  & $node $indexJs @AgentArgs
}

function Write-Config {
  $cfg = @{}
  if (Test-Path $configJson) {
    try { $cfg = Get-Content $configJson -Raw | ConvertFrom-Json -AsHashtable } catch { $cfg = @{} }
  }
  if ($Server) { $cfg["server"] = $Server }
  if ($EnrollToken) { $cfg["enrollToken"] = $EnrollToken }
  if ($Name) { $cfg["name"] = $Name }
  if (-not $cfg.ContainsKey("logLevel")) { $cfg["logLevel"] = "info" }
  ($cfg | ConvertTo-Json -Depth 5) | Set-Content -Path $configJson -Encoding UTF8
  # Restrict the config (it holds the enrolment token) to the current user.
  try {
    $acl = Get-Acl $configJson
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl $configJson $acl
  } catch { Write-Warning "Could not restrict permissions on config.json: $_" }
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task '$TaskName' found."
  }
  Write-Host "Config and identity were kept (config.json, state.json). Remove the machine in the app to revoke its token."
  return
}

if ($Status) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host ("Task '{0}': {1} (last run {2}, result {3})" -f $TaskName, $task.State, $info.LastRunTime, $info.LastTaskResult)
  } else {
    Write-Host "Task '$TaskName' is not installed."
  }
  Invoke-Agent @("--status")
  return
}

if ($Pair) { Invoke-Agent @("--pair"); return }

if ($Name -and -not $Install) { Invoke-Agent @("--name", $Name); return }

if ($Install) {
  $node = Get-NodePath
  if ((-not (Test-Path $configJson)) -and (-not $Server -or -not $EnrollToken)) {
    throw "First install needs -Server <wss://relay> and -EnrollToken <token> (the relay's ENROLL_TOKEN)."
  }
  if ($Server -or $EnrollToken -or $Name) { Write-Config }

  if (-not (Test-Path (Join-Path $agentDir "node_modules"))) {
    Write-Host "Installing dependencies (npm install)..."
    Push-Location $agentDir
    try { & npm install --omit=dev --no-audit --no-fund --loglevel=error } finally { Pop-Location }
  }

  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$indexJs`"" -WorkingDirectory $agentDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Installed '$TaskName' -> $node `"$indexJs`" (starts at logon, runs as $env:USERNAME)."
  Start-ScheduledTask -TaskName $TaskName

  Write-Host -NoNewline "Waiting for the agent to enrol with the relay"
  $enrolled = $false
  for ($i = 0; $i -lt 30; $i++) {
    if ((Test-Path $stateJson) -and ((Get-Content $stateJson -Raw) -match '"agentId": "a_')) { $enrolled = $true; break }
    Write-Host -NoNewline "."; Start-Sleep -Seconds 1
  }
  Write-Host ""
  if (-not $enrolled) {
    Write-Warning "The agent has not enrolled yet. Check config.json and run: node index.js --doctor"
    return
  }
  Write-Host ""
  Write-Host "Remote Terminal Agent"
  Invoke-Agent @("--status")
  Write-Host ""
  Invoke-Agent @("--pair")
  Write-Host "Later: install-windows.ps1 -Pair (new code) | -Status | -Uninstall"
  return
}

Write-Host "Specify -Install, -Pair, -Status, -Name or -Uninstall. See the header of this script for details."
