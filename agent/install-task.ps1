<#
.SYNOPSIS
  Install/uninstall the Remote Terminal agent as a per-user logon task so it
  starts automatically and survives logout/reboot.

.WHY A SCHEDULED TASK (not a Windows Service)
  The agent spawns an INTERACTIVE terminal (ConPTY). A classic Windows Service
  runs in session 0 as SYSTEM and cannot attach a real interactive console for
  the logged-in user. A logon-triggered Scheduled Task runs inside the user's
  session, which is exactly what a PTY needs.

.USAGE
  # install (runs node <agentDir>\index.js at logon, hidden):
  powershell -ExecutionPolicy Bypass -File install-task.ps1 -Install

  # remove:
  powershell -ExecutionPolicy Bypass -File install-task.ps1 -Uninstall

  Configure the agent via agent\config.json (see config.example.json) or the
  SERVER / ROOM / TOKEN environment variables before installing.
#>

param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$TaskName = "RemoteTerminalAgent"
)

$ErrorActionPreference = "Stop"
$agentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexJs = Join-Path $agentDir "index.js"

function Get-NodePath {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw "node.exe not found on PATH. Install Node.js first." }
  return $node
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task '$TaskName' found."
  }
  return
}

if ($Install) {
  $node = Get-NodePath
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$indexJs`"" -WorkingDirectory $agentDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Installed '$TaskName' -> $node `"$indexJs`" (starts at logon)."
  Write-Host "Start it now with: Start-ScheduledTask -TaskName $TaskName"
  return
}

Write-Host "Specify -Install or -Uninstall. See the header of this script for details."
