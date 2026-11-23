# One-time setup for the job bot (double-click SETUP.cmd). Safe to run again at any time.
# 1) installs Node.js if missing  2) installs the bot  3) lets you log in once  4) a practice run
# 5) schedules it: weekdays 09:00, 12:00, 15:00, 18:00 + when you log in (missed runs catch up)  6) desktop shortcuts
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }

Step "1/6 Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Please install Node.js LTS from https://nodejs.org (click Next through the installer), then double-click SETUP.cmd again." -ForegroundColor Yellow
    Start-Process "https://nodejs.org"; exit 1
  }
}
Write-Host "Node.js $(node --version) OK"

Step "2/6 Installing the bot"
try { git -C $PSScriptRoot pull --ff-only --quiet 2>$null | Out-Null } catch {}
npm install --no-fund --no-audit --loglevel=error
npx --yes playwright@1.49.1 install chromium | Out-Null
New-Item ".chromium-ok" -ItemType File -Force | Out-Null
Write-Host "Installed."

Step "3/6 Log in to LinkedIn and Indeed (only the first time)"
if (-not (Test-Path ".browser-profile")) {
  Write-Host "A Chrome window will open. Log in to LinkedIn, come back here and press Enter. Then the same for Indeed."
  node bot.mjs --login
} else { Write-Host "Already logged in (to log in again later: node bot.mjs --login)." }

Step "4/6 Practice run (fills 2 forms, sends nothing)"
node bot.mjs --dry-run --max 2

Step "5/6 Scheduling: weekdays 09:00, 12:00, 15:00, 18:00 and when you log in"
$run = Join-Path $PSScriptRoot "run.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Minimized -ExecutionPolicy Bypass -File `"$run`"" -WorkingDirectory $PSScriptRoot
$days = "Monday","Tuesday","Wednesday","Thursday","Friday"
$triggers = @("09:00","12:00","15:00","18:00") | ForEach-Object { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $_ }
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; $logon.Delay = "PT5M"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName "Job bot" -Action $action -Trigger ($triggers + $logon) -Settings $settings -Principal $principal -Force | Out-Null
Unregister-ScheduledTask -TaskName "Easy Apply bot" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Scheduled."

Step "6/6 Desktop shortcuts"
$desk = [Environment]::GetFolderPath("Desktop"); $sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut("$desk\Job bot - dashboard.lnk"); $s.TargetPath = Join-Path $PSScriptRoot "data\dashboard.html"; $s.Save()
$s = $sh.CreateShortcut("$desk\Job bot - run now.lnk"); $s.TargetPath = "powershell.exe"; $s.Arguments = "-NoProfile -WindowStyle Minimized -Command Start-ScheduledTask -TaskName 'Job bot'"; $s.Save()
$s = $sh.CreateShortcut("$desk\Job bot - my settings.lnk"); $s.TargetPath = "notepad.exe"; $s.Arguments = "`"$(Join-Path $PSScriptRoot 'my_settings.json')`""; $s.Save()

Write-Host ""
Write-Host "ALL DONE. The bot now runs by itself every weekday (09:00, 12:00, 15:00, 18:00, and after you log in)." -ForegroundColor Green
Write-Host "Just keep the laptop on and logged in. Check the 'Job bot - dashboard' icon on your desktop."
Write-Host "To stop it: Unregister-ScheduledTask -TaskName 'Job bot' -Confirm:`$false"
Start-Process (Join-Path $PSScriptRoot "data\dashboard.html")
