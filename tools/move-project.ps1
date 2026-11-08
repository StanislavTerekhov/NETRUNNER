# Moves the NETRUNNER project out of OneDrive (node_modules and release builds no longer sync).
# Close NETRUNNER, your editor and the Claude Code session in this folder first. The old folder is kept: delete it
# yourself once the new one works.
#   powershell -ExecutionPolicy Bypass -File tools\move-project.ps1 [-To C:\dev\netrunner] [-DryRun]
param(
  [string]$To = 'C:\dev\netrunner',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$From = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$To = [IO.Path]::GetFullPath($To).TrimEnd('\')
if ($From -ieq $To) { throw "Already at $To" }
if ((Test-Path $To) -and (Get-ChildItem $To -Force | Select-Object -First 1)) { throw "$To exists and is not empty" }
if (Get-Process NETRUNNER -ErrorAction SilentlyContinue) { throw 'Close NETRUNNER first' }
function Step($what, [scriptblock]$do) { if ($DryRun) { "would: $what" } else { "-> $what"; & $do } }

# 1. Copy everything (node_modules included: no reinstall needed). Robocopy exit codes below 8 mean success.
Step "copy $From -> $To" {
  robocopy $From $To /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
}

# 2. The desktop shortcut points into the release folder of the project.
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'NETRUNNER.lnk'
if (Test-Path $lnk) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  if ($s.TargetPath -like "$From\*") {
    Step "shortcut -> $($s.TargetPath.Replace($From, $To))" {
      $s.TargetPath = $s.TargetPath.Replace($From, $To)
      $s.WorkingDirectory = $s.WorkingDirectory.Replace($From, $To)
      $s.IconLocation = $s.IconLocation.Replace($From, $To)
      $s.Save()
    }
  }
}

# 3. Claude Code keeps per-project notes in a folder named after the path.
$slug = { param($p) $p -replace '[:\\/]', '-' }
$memFrom = Join-Path $env:USERPROFILE ".claude\projects\$(& $slug $From)\memory"
$memTo = Join-Path $env:USERPROFILE ".claude\projects\$(& $slug $To)\memory"
if (Test-Path $memFrom) {
  Step "Claude Code project notes -> $memTo" {
    New-Item -ItemType Directory -Force $memTo | Out-Null
    Copy-Item (Join-Path $memFrom '*') $memTo -Recurse -Force
  }
}

# 4. NETRUNNER's own settings (recent / last project), if they mention the old path.
$settings = Join-Path $env:APPDATA 'NETRUNNER\settings.json'
if (Test-Path $settings) {
  $json = [IO.File]::ReadAllText($settings)
  $old = $From.Replace('\', '\\'); $new = $To.Replace('\', '\\')
  if ($json.Contains($old)) {
    Step 'NETRUNNER settings: project path updated' { [IO.File]::WriteAllText($settings, $json.Replace($old, $new)) }
  }
}

"done. Open $To, run 'npm test' there, then delete $From yourself (it is still in OneDrive)."
"The memory index of the project is per path: in NETRUNNER press INDEX once in the new folder (~30 s)."
