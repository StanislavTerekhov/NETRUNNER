#!/usr/bin/env bash
# NSC-ME phase 1, cold part. Run right after a reboot, before NETRUNNER or anything else touches the models.
#   bash tools/nsc/me-phase1-cold.sh
# 1. Memory state and uptime.
# 2. Cold check + measurement on part 2 of Coder-Next (not read since boot): mmap and ReadFile, 3 runs each on
#    different random experts. A pass counts as cold only if its median per-expert latency is >= 2 ms
#    (standby soft faults take ~0.35 ms, the SATA device ~3.3 ms).
# 3. Full Coder-Next load from cold, then a warm reload (phase 0 test, 1 rep).
set -u
cd "$(dirname "$0")/../.."
OUT="$USERPROFILE/NETRUNNER/nsc/me/phase1"
BIN="$OUT/bin"
DIR="$USERPROFILE/NETRUNNER/models/Qwen/Qwen3-Coder-Next-GGUF/Qwen3-Coder-Next-Q4_K_M"
F="$DIR/Qwen3-Coder-Next-Q4_K_M-00002-of-00004.gguf"
B=1720320
LOG="$OUT/cold.jsonl"
: > "$LOG"
powershell -NoProfile -Command '$b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime; $c=Get-Counter "\Memory\Available MBytes","\Memory\Standby Cache Normal Priority Bytes","\Memory\Standby Cache Reserve Bytes"; [ordered]@{boot=$b.ToString("s"); uptimeMin=[math]::Round(((Get-Date)-$b).TotalMinutes,1); sysMain=(Get-Service SysMain).Status.ToString(); llamaRunning=@(Get-Process llama-server -ErrorAction SilentlyContinue).Count; counters=($c.CounterSamples | % { "$($_.Path.Split("\")[-1])=$([math]::Round($_.CookedValue))" })} | ConvertTo-Json -Compress' | tee -a "$OUT/cold-state.json"
for r in 1 2 3; do
  "$BIN/diskbench.exe" rand-mmap "$F" $B 800 1 $((r * 101 + 5)) 2>/dev/null | tee -a "$LOG"
  "$BIN/diskbench.exe" rand-buf "$F" $B 800 1 $((r * 101 + 9)) | tee -a "$LOG"
done
NETRUNNER_LIVE=1 NSC_MODELS=coder-next NSC_REPS=1 npx vitest run test/nsc/me-phase0.live.test.ts --silent=false > "$OUT/cold-load.log" 2>&1
grep -E "SUMMARY|passed|failed" "$OUT/cold-load.log"
echo COLD DONE
