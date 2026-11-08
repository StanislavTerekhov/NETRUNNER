# OS-level offline audit. While a NETRUNNER run is in progress, samples every TCP connection owned by
# NETRUNNER.exe and all of its descendants (OpenCode, shells, test runners) and by the Ollama processes,
# and records every remote endpoint that is not loopback. Writes a JSON report and exits when the
# NETRUNNER process tree has been gone for 5 s (or after -MaxMinutes).
# Usage: powershell -File test\offline\audit.ps1 -Out test\output\offline-audit.json [-MaxMinutes 60]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxMinutes = 60
)
$ErrorActionPreference = 'SilentlyContinue'
$loopback = '^(127\.|::1$|0\.0\.0\.0$|::$)'
$samples = 0
$maxTree = 0
$seenNames = @{}
$external = @{}
$started = Get-Date
$goneSince = $null
$sawApp = $false

while (((Get-Date) - $started).TotalMinutes -lt $MaxMinutes) {
  $procs = Get-CimInstance Win32_Process
  $byParent = @{}
  foreach ($p in $procs) { $byParent[[int]$p.ParentProcessId] += @($p) }
  $roots = $procs | Where-Object { $_.Name -in @('NETRUNNER.exe', 'electron.exe') }
  $tree = @{}
  $queue = New-Object System.Collections.Queue
  foreach ($r in $roots) { $queue.Enqueue($r) }
  while ($queue.Count) {
    $p = $queue.Dequeue()
    if ($tree.ContainsKey([int]$p.ProcessId)) { continue }
    $tree[[int]$p.ProcessId] = $p.Name
    foreach ($c in $byParent[[int]$p.ProcessId]) { $queue.Enqueue($c) }
  }
  # Ollama is outside NETRUNNER's tree but does the inference: audit it too, labelled separately.
  foreach ($p in $procs | Where-Object { $_.Name -match '^(ollama|ollama app|llama-server)\.exe$' }) { $tree[[int]$p.ProcessId] = "[ollama] $($p.Name)" }

  if ($roots) { $sawApp = $true; $goneSince = $null } elseif ($sawApp) {
    if (-not $goneSince) { $goneSince = Get-Date } elseif (((Get-Date) - $goneSince).TotalSeconds -gt 5) { break }
  }
  $maxTree = [math]::Max($maxTree, $tree.Count)
  foreach ($n in $tree.Values) { $seenNames[$n] = $true }

  if ($tree.Count) {
    foreach ($c in Get-NetTCPConnection -OwningProcess ([int[]]$tree.Keys)) {
      if ($c.State -eq 'Listen' -or $c.State -eq 'Bound') { continue }
      if ($c.RemoteAddress -match $loopback) { continue }
      $key = "$($tree[[int]$c.OwningProcess]) -> $($c.RemoteAddress):$($c.RemotePort)"
      if (-not $external.ContainsKey($key)) { $external[$key] = (Get-Date).ToString('o') }
    }
  }
  $samples++
  Start-Sleep -Milliseconds 500
}

$report = [ordered]@{
  startedAt          = $started.ToString('o')
  finishedAt         = (Get-Date).ToString('o')
  samples            = $samples
  maxProcessesWatched = $maxTree
  processNamesSeen   = @($seenNames.Keys | Sort-Object)
  externalTcpConnections = @($external.GetEnumerator() | ForEach-Object { [ordered]@{ connection = $_.Key; firstSeen = $_.Value } })
}
$report | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Out
"offline audit: $samples samples, $($external.Count) external TCP endpoint(s) -> $Out"
