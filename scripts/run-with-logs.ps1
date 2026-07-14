#requires -Version 5.1
<#
.SYNOPSIS
  Launch a WorkerKing target with its console output captured to a file so Claude
  can read it, backgrounded, tracking the PID for a clean stop.

.DESCRIPTION
  Mirrors Amethyst's runbook/tail-logs pattern, adapted to this pnpm/Node/Electron
  monorepo. Merged stdout+stderr is captured to tail-logs/<target>.log; the daemon
  additionally tees its own output to tail-logs/app-logs/daemon.log via the
  WORKERKING_LOG_FILE env var set below (so F5 debug sessions are visible too).

.PARAMETER Target
  daemon = the core daemon standalone (plain Node).
  app    = the full Electron app (electron-vite dev), which spawns the built daemon.

.EXAMPLE
  scripts/run-with-logs.ps1 -Target daemon
  scripts/run-with-logs.ps1 -Target app
#>
[CmdletBinding()]
param(
  [ValidateSet('daemon', 'app')]
  [string]$Target = 'daemon',
  [string]$ExtraArgs = '',
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$logDir = 'tail-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $logDir 'app-logs') | Out-Null

# Daemon tees its own stdout/stderr here (F5-visible too). Absolute path so a
# daemon spawned by the Electron app from any cwd still writes into this repo.
$env:WORKERKING_LOG_FILE = (Join-Path (Get-Location).Path 'tail-logs\app-logs\daemon.log')

# Always build the daemon: the 'daemon' target runs the built dist; the 'app'
# target spawns the *built* daemon (see CLAUDE.md gotcha). Includes deps (shared).
if (-not $NoBuild) {
  Write-Host 'Building @workerking/core (+ deps)...'
  pnpm --filter '...@workerking/core' run build
}

$log = Join-Path $logDir "$Target.log"
Remove-Item $log -ErrorAction SilentlyContinue

switch ($Target) {
  'daemon' {
    $inner = "node `"packages/core/dist/main.js`" $ExtraArgs > `"$log`" 2>&1"
  }
  'app' {
    $inner = "pnpm --filter `"@workerking/app`" run dev $ExtraArgs > `"$log`" 2>&1"
  }
}

# cmd wrapper: Start-Process can't merge stdout+stderr to one file, so redirect
# inside cmd. We track the wrapper PID and tree-kill it on stop.
$proc = Start-Process -FilePath cmd -ArgumentList '/c', $inner -PassThru -WindowStyle Hidden
$proc.Id | Out-File (Join-Path $logDir "$Target.pid") -Encoding ascii

Write-Host "Started '$Target' (pid $($proc.Id)). Capturing merged output -> $log"
Write-Host "Snapshot: scripts/tail-logs.ps1 -Target $Target   |   Stop: scripts/stop-logs.ps1"
