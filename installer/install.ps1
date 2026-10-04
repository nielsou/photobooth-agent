$ErrorActionPreference = "Stop"

$InstallDir = "C:\ProgramData\PhotoboothAgent"
$RepoRawUrl = "https://raw.githubusercontent.com/nielsou/photobooth-agent/main"

Write-Host ""
Write-Host "========================================="
Write-Host "      PHOTOBOOTH AGENT INSTALLER"
Write-Host "========================================="
Write-Host ""

# --------------------------------------------------
# CREATE DIRECTORIES
# --------------------------------------------------

Write-Host "Creating installation directory..."

New-Item -ItemType Directory `
    -Path $InstallDir `
    -Force | Out-Null

New-Item -ItemType Directory `
    -Path "$InstallDir\logs" `
    -Force | Out-Null

# --------------------------------------------------
# DOWNLOAD VERSION
# --------------------------------------------------

Write-Host "Checking latest version..."

$RemoteVersion = Invoke-RestMethod `
    -Uri "$RepoRawUrl/VERSION" `
    -UseBasicParsing

$RemoteVersion = $RemoteVersion.Trim()

Write-Host "Latest version: $RemoteVersion"

# --------------------------------------------------
# DOWNLOAD AGENT
# --------------------------------------------------

Write-Host "Downloading agent..."

$TempAgent = "$env:TEMP\photobooth-agent.ps1"

Invoke-WebRequest `
    -Uri "$RepoRawUrl/agent/agent.ps1" `
    -OutFile $TempAgent `
    -UseBasicParsing

# --------------------------------------------------
# INSTALL
# --------------------------------------------------

Write-Host "Installing agent..."

Copy-Item `
    $TempAgent `
    "$InstallDir\agent.ps1" `
    -Force

Set-Content `
    -Path "$InstallDir\VERSION" `
    -Value $RemoteVersion

# --------------------------------------------------
# CREATE STARTUP TASK
# --------------------------------------------------

Write-Host "Creating startup task..."

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\agent.ps1`""

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

# --------------------------------------------------
# START AGENT
# --------------------------------------------------

Write-Host "Starting agent..."

Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\agent.ps1`"" `
    -Wait

# --------------------------------------------------
# CLEANUP
# --------------------------------------------------

Remove-Item $TempAgent -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "========================================="
Write-Host "       INSTALLATION COMPLETE"
Write-Host "========================================="
Write-Host ""
Write-Host "Booth: $env:COMPUTERNAME"
Write-Host "Version: $RemoteVersion"
Write-Host ""