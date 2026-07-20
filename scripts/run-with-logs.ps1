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

.PARAMETER ExtraArgs
  Extra CLI arguments forwarded to the target, as an array (e.g. -ExtraArgs '--foo','bar').
  Each element is passed through as a literal argument — none of them may contain
  cmd.exe shell metacharacters (&|<>^), since they're interpolated into a `cmd /c`
  command line for output redirection.

.EXAMPLE
  scripts/run-with-logs.ps1 -Target daemon
  scripts/run-with-logs.ps1 -Target app
#>
[CmdletBinding()]
param(
  [ValidateSet('daemon', 'app')]
  [string]$Target = 'daemon',
  [string[]]$ExtraArgs = @(),
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# Reject shell metacharacters in each arg — they'd otherwise be interpreted by
# the `cmd /c` wrapper below (arg injection), not passed through literally.
foreach ($a in $ExtraArgs) {
  if ($a -match '[&|<>^]') {
    throw "ExtraArgs element '$a' contains a shell metacharacter (&|<>^), which is not allowed."
  }
}

$logDir = 'tail-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $logDir 'app-logs') | Out-Null

# If a previous run for this target is still tracked, stop it first — otherwise
# its PID file would be overwritten here, orphaning that earlier process tree.
$existingPidFile = Join-Path $logDir "$Target.pid"
if (Test-Path $existingPidFile) {
  $existingProcId = (Get-Content -LiteralPath $existingPidFile | Select-Object -First 1)
  if ($existingProcId) { $existingProcId = $existingProcId.Trim() }
  if ($existingProcId -and (Get-Process -Id $existingProcId -ErrorAction SilentlyContinue)) {
    Write-Host "A '$Target' runner (pid $existingProcId) is already tracked; stopping it first..."
    taskkill /PID $existingProcId /T /F 2>$null | Out-Null
  }
  Remove-Item -LiteralPath $existingPidFile -ErrorAction SilentlyContinue
}

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

# Each extra arg is individually double-quoted so it lands as one cmd.exe token
# rather than being re-split or reinterpreted.
$quotedExtraArgs = ($ExtraArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '

switch ($Target) {
  'daemon' {
    $inner = "node `"packages/core/dist/main.js`" $quotedExtraArgs > `"$log`" 2>&1"
  }
  'app' {
    $inner = "pnpm --filter `"@workerking/app`" run dev $quotedExtraArgs > `"$log`" 2>&1"
  }
}

# cmd wrapper: Start-Process can't merge stdout+stderr to one file, so redirect
# inside cmd. We track the wrapper PID and tree-kill it on stop.
$proc = Start-Process -FilePath cmd -ArgumentList '/c', $inner -PassThru -WindowStyle Hidden
$proc.Id | Out-File (Join-Path $logDir "$Target.pid") -Encoding ascii

Write-Host "Started '$Target' (pid $($proc.Id)). Capturing merged output -> $log"
Write-Host "Snapshot: scripts/tail-logs.ps1 -Target $Target   |   Stop: scripts/stop-logs.ps1"
