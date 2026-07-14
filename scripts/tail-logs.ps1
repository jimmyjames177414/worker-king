#requires -Version 5.1
<#
.SYNOPSIS
  Snapshot (or bounded-follow) the captured WorkerKing logs so Claude can read
  what a running target is doing.

.DESCRIPTION
  Reads two source kinds, mirroring the Amethyst pattern:
    - tail-logs/<target>.log        merged console captured by run-with-logs.ps1
    - tail-logs/app-logs/*.log      the daemon's own file log (also written under F5)
  Snapshot is the default. -Follow is ALWAYS time-bounded so it can never block.

.EXAMPLE
  scripts/tail-logs.ps1                       # last 100 lines of every source
  scripts/tail-logs.ps1 -Target daemon -Errors
  scripts/tail-logs.ps1 -Follow -Timeout 5    # stream for 5s, then return
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'daemon', 'app')]
  [string]$Target = 'all',
  [int]$Lines = 100,
  [switch]$Follow,
  [int]$Timeout = 10,
  [switch]$Errors
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if ($Follow -and $Timeout -le 0) {
  throw '-Follow requires a positive -Timeout (seconds) so it never blocks.'
}

$errRe = 'error|exception|fail|critical|fatal|unhandled|warn'

# Build the source list. 'daemon' includes the daemon's own file log; 'app'
# includes only its captured console (its child daemon shows up under daemon).
$sources = @()
switch ($Target) {
  'all' {
    $sources += Get-ChildItem 'tail-logs' -Filter '*.log' -File -ErrorAction SilentlyContinue
    $sources += Get-ChildItem 'tail-logs/app-logs' -Filter '*.log' -File -ErrorAction SilentlyContinue
  }
  'daemon' {
    $sources += Get-ChildItem 'tail-logs' -Filter 'daemon.log' -File -ErrorAction SilentlyContinue
    $sources += Get-ChildItem 'tail-logs/app-logs' -Filter '*.log' -File -ErrorAction SilentlyContinue
  }
  'app' {
    $sources += Get-ChildItem 'tail-logs' -Filter 'app.log' -File -ErrorAction SilentlyContinue
  }
}

if (-not $sources) {
  Write-Host "No log files yet. Start one:  scripts/run-with-logs.ps1 -Target $Target"
  return
}

if ($Follow) {
  # Follow the most recently written source, bounded by a stopwatch.
  $file = ($sources | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
  Write-Host "== Following $file for ${Timeout}s (bounded) =="
  $job = Start-Job -ScriptBlock { param($f) Get-Content -LiteralPath $f -Wait -Tail 10 } -ArgumentList $file
  try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $Timeout) {
      Receive-Job $job | ForEach-Object { if (-not $Errors -or $_ -match $errRe) { $_ } }
      Start-Sleep -Milliseconds 250
    }
    Receive-Job $job | ForEach-Object { if (-not $Errors -or $_ -match $errRe) { $_ } }
  } finally {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
  }
  return
}

# Snapshot mode
foreach ($s in $sources) {
  Write-Host ''
  Write-Host "===== $($s.FullName) (last $Lines) ====="
  $content = Get-Content -LiteralPath $s.FullName -Tail $Lines -ErrorAction SilentlyContinue
  if ($Errors) { $content = $content | Where-Object { $_ -match $errRe } }
  $content
}
