$ErrorActionPreference = "Stop"

$InstallDir = "C:\ProgramData\PhotoboothAgent"
$RepoUrl = "https://github.com/nielsou/photobooth-agent.git"

Write-Host ""
Write-Host "========================================="
Write-Host "      PHOTOBOOTH AGENT INSTALLER"
Write-Host "========================================="
Write-Host ""

Write-Host "Creating installation directory..."
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

Write-Host "Downloading latest agent..."

$TempDir = Join-Path $env:TEMP "PhotoboothAgentInstall"

if (Test-Path $TempDir) {
    Remove-Item $TempDir -Recurse -Force
}

git clone $RepoUrl $TempDir

Write-Host "Installing agent..."

Copy-Item "$TempDir\agent\agent.ps1" "$InstallDir\agent.ps1" -Force

Write-Host "Creating log directory..."

New-Item -ItemType Directory -Path "$InstallDir\logs" -Force | Out-Null

Write-Host "Creating startup task..."

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -File `"$InstallDir\agent.ps1`""

$Trigger = New-ScheduledTaskTrigger -AtStartup

$Principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName "Photobooth Agent" `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Force | Out-Null

Write-Host ""
Write-Host "Installation complete."
Write-Host "Booth: $env:COMPUTERNAME"
Write-Host ""

Write-Host "Starting agent..."

Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-ExecutionPolicy Bypass -File `"$InstallDir\agent.ps1`"" `
    -Wait

Write-Host ""
Write-Host "========================================="
Write-Host "          INSTALLATION COMPLETE"
Write-Host "========================================="
Write-Host ""