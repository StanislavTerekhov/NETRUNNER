# Offline acceptance: run with the network adapter / Wi-Fi switched OFF.
# 1. proves there is no network, 2. runs the UI acceptance with a real chat model, 3. writes a report.
#   powershell -ExecutionPolicy Bypass -File tools\offline-check.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $env:USERPROFILE 'NETRUNNER\forge\runs\offline-check'
New-Item -ItemType Directory -Force $out | Out-Null
$log = Join-Path $out 'offline.log'
"started $(Get-Date -Format s)" | Out-File -Encoding utf8 $log

# The check is only meaningful without a network: refuse to run otherwise.
$adapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up'
$dns = $null; try { $dns = Resolve-DnsName example.com -QuickTimeout -ErrorAction Stop } catch {}
$tcp = Test-NetConnection 1.1.1.1 -Port 443 -WarningAction SilentlyContinue -InformationLevel Quiet
"adapters up: $(@($adapters).Count) ($(@($adapters).Name -join ', ')); dns: $([bool]$dns); tcp 1.1.1.1:443: $tcp" | Tee-Object -Append -FilePath $log
if ($dns -or $tcp) {
  'The network is still reachable: switch the adapter / Wi-Fi off and run this again.' | Tee-Object -Append -FilePath $log
  exit 2
}

Set-Location $root
$env:NETRUNNER_SMOKE_CHAT_MODEL = 'unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-IQ3_XXS.gguf'
npm run test:smoke 2>&1 | Out-File -Encoding utf8 -Append $log
"smoke exit: $LASTEXITCODE" | Tee-Object -Append -FilePath $log
Copy-Item (Join-Path $root 'test\output\smoke-report.json') $out -ErrorAction SilentlyContinue
"finished $(Get-Date -Format s). Switch the network back on." | Tee-Object -Append -FilePath $log
