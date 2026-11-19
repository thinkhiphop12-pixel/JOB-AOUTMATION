# Autoline: make your computer submit the ready applications EVERY weekday by itself.
# Run ONCE in PowerShell (no admin needed):
#   powershell -ExecutionPolicy Bypass -File $HOME\Autoline\job-hunt\install_daily.ps1
# What it does: every weekday at 09:30 (and 13:30 as a catch-up) it pulls the latest packages,
# opens one Chrome window, submits every fully-filled form, records the result, and closes.
# Your computer just needs to be on and you logged in. Remove it with:
#   Unregister-ScheduledTask -TaskName "Autoline daily apply" -Confirm:$false
$ErrorActionPreference = "Stop"
$script = Join-Path $HOME "Autoline\job-hunt\apply_local.ps1"
if (-not (Test-Path $script)) { throw "Run apply_local.ps1 once first so ~\Autoline exists." }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" --ready-only"
$days = @("Monday","Tuesday","Wednesday","Thursday","Friday")
$triggers = @(
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At "09:30"),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At "13:30")
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName "Autoline daily apply" -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Installed. Every weekday at 09:30 and 13:30 your computer submits the ready applications by itself."
Write-Host "Run it right now with:  Start-ScheduledTask -TaskName 'Autoline daily apply'"
