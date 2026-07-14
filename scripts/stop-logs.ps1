#requires -Version 5.1
<#
.SYNOPSIS
  Stop every log runner started by run-with-logs.ps1 (tree kill) and clean up its
  PID file. Captured .log files are left intact for post-mortem snapshotting.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$pidFiles = Get-ChildItem 'tail-logs' -Filter '*.pid' -File -ErrorAction SilentlyContinue
if (-not $pidFiles) {
  Write-Host 'No log runners tracked (no tail-logs/*.pid). Nothing to stop.'
  return
}

foreach ($pf in $pidFiles) {
  # NB: never name this $pid — that is an automatic variable (this shell's PID).
  $procId = (Get-Content -LiteralPath $pf.FullName | Select-Object -First 1)
  if ($procId) { $procId = $procId.Trim() }
  if ($procId) {
    Write-Host "Stopping '$($pf.BaseName)' (pid $procId) and its child tree..."
    # /T kills the whole tree (cmd wrapper -> node/electron/renderers + daemon).
    taskkill /PID $procId /T /F 2>$null | Out-Null
  }
  Remove-Item -LiteralPath $pf.FullName -ErrorAction SilentlyContinue
}

Write-Host 'Stopped. Captured .log files kept for post-mortem (scripts/tail-logs.ps1).'
