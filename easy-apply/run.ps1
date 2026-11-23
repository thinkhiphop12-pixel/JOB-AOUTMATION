# Easy Apply bot launcher (Windows). Run from PowerShell:
#   First time:  powershell -ExecutionPolicy Bypass -File run.ps1 --login
#   Test run:    powershell -ExecutionPolicy Bypass -File run.ps1 --dry-run --max 3
#   Real run:    powershell -ExecutionPolicy Bypass -File run.ps1
#   Easiest: double-click SETUP.cmd once. It installs, logs you in and schedules this script to run by itself.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if ($args -contains "--schedule") {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\run.ps1`""
  $days = "Monday","Tuesday","Wednesday","Thursday","Friday"
  $trigger = @("09:00","12:00","15:00","18:00") | ForEach-Object { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $_ }
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "Job bot" -Action $action -Trigger $trigger -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive) -Force | Out-Null
  Write-Host "Scheduled: weekdays 09:00, 12:00, 15:00 and 18:00 (up to 5 per site each run, 40 a day). Remove with: Unregister-ScheduledTask -TaskName 'Job bot' -Confirm:`$false"
  exit 0
}
# get the latest version (your changes live in my_settings.json, which updates never touch)
try { git -C $PSScriptRoot pull --ff-only --quiet 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { Write-Host "(Update skipped: config.json was edited here. Move your changes to my_settings.json.)" } } catch {}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Install Node.js first: https://nodejs.org (LTS), then run this again."; exit 1 }
if (-not (Test-Path "node_modules\playwright")) { npm install --no-fund --no-audit }
if (-not (Test-Path ".chromium-ok")) { npx --yes playwright@1.49.1 install chromium | Out-Null; New-Item ".chromium-ok" -ItemType File | Out-Null }
node bot.mjs @args
