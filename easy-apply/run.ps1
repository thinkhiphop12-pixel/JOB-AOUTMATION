# Easy Apply bot launcher (Windows). Run from PowerShell:
#   First time:  powershell -ExecutionPolicy Bypass -File run.ps1 --login
#   Test run:    powershell -ExecutionPolicy Bypass -File run.ps1 --dry-run --max 3
#   Real run:    powershell -ExecutionPolicy Bypass -File run.ps1
#   Every day:   powershell -ExecutionPolicy Bypass -File run.ps1 --schedule   (4 runs: 09:00, 12:00, 15:00, 18:00 weekdays; laptop on and logged in)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if ($args -contains "--schedule") {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\run.ps1`""
  $days = "Monday","Tuesday","Wednesday","Thursday","Friday"
  $trigger = @("09:00","12:00","15:00","18:00") | ForEach-Object { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $_ }
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "Easy Apply bot" -Action $action -Trigger $trigger -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive) -Force | Out-Null
  Write-Host "Scheduled: weekdays 09:00, 12:00, 15:00 and 18:00 (up to 10 per site each run). Remove with: Unregister-ScheduledTask -TaskName 'Easy Apply bot' -Confirm:`$false"
  exit 0
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Install Node.js first: https://nodejs.org (LTS), then run this again."; exit 1 }
if (-not (Test-Path "node_modules\playwright")) { npm install --no-fund --no-audit }
npx --yes playwright@1.49.1 install chromium | Out-Null
node bot.mjs @args
