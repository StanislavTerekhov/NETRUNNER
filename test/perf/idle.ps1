# Measures the idle cost of a NETRUNNER build: CPU time of all NETRUNNER processes and helper processes
# (nvidia-smi, powershell) spawned while the app sits on the editor with a workspace open.
# Usage: powershell -File test\perf\idle.ps1 -Exe release\1.0.0\win-unpacked\NETRUNNER.exe [-Seconds 60]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Seconds = 60
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$ud = Join-Path $root 'test\output\perf-user-data'
Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ud | Out-Null
$settings = @{ recentWorkspaces = @($root); lastWorkspace = $root } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $ud 'settings.json'), $settings, (New-Object Text.UTF8Encoding $false))

$env:NETRUNNER_USER_DATA = $ud
$app = Start-Process -FilePath (Resolve-Path $Exe).Path -PassThru
Start-Sleep -Seconds 15   # let startup work settle

function TreeCpu {
  $all = Get-CimInstance Win32_Process
  $ids = New-Object System.Collections.Generic.HashSet[int]
  [void]$ids.Add($app.Id)
  do {
    $added = $false
    foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } }
  } while ($added)
  $sum = 0.0; $mem = 0
  foreach ($id in $ids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { $sum += $p.TotalProcessorTime.TotalMilliseconds; $mem += $p.WorkingSet64 }
  }
  [pscustomobject]@{ CpuMs = $sum; Procs = $ids.Count; MemMB = [math]::Round($mem / 1MB) }
}

# Count helper launches via process creation polling (short-lived processes may be missed; this is a lower bound).
$seen = New-Object System.Collections.Generic.HashSet[int]
$helpers = @{}
$before = TreeCpu
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  foreach ($p in Get-CimInstance Win32_Process -Filter "Name='nvidia-smi.exe' OR Name='powershell.exe' OR Name='WMIC.exe'") {
    if ($seen.Add([int]$p.ProcessId)) { $helpers[$p.Name] = 1 + [int]$helpers[$p.Name] }
  }
  Start-Sleep -Milliseconds 250
}
$after = TreeCpu
$cpuMs = $after.CpuMs - $before.CpuMs

& taskkill /pid $app.Id /T /F | Out-Null
[pscustomobject]@{
  seconds          = $Seconds
  cpuMsTotal       = [math]::Round($cpuMs)
  avgCpuPctOneCore = [math]::Round($cpuMs / ($Seconds * 1000) * 100, 2)
  processesInTree  = $after.Procs
  workingSetMB     = $after.MemMB
  helperLaunches   = ($helpers.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '
} | ConvertTo-Json
