#Requires -Version 5.1

$ErrorActionPreference = "Stop"

# --------------------------------------------------
# REQUIRE ADMINISTRATOR
# --------------------------------------------------

$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)

if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {

    Write-Host "Administrator privileges required."
    Write-Host "Requesting elevation..."

    $Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""

    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList $Arguments `
        -Verb RunAs

    exit
}

# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

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

New-Item `
    -ItemType Directory `
    -Path $InstallDir `
    -Force | Out-Null

New-Item `
    -ItemType Directory `
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

schtasks.exe /Create `
    /TN "Photobooth Agent" `
    /SC ONSTART `
    /RU SYSTEM `
    /RL HIGHEST `
    /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\agent.ps1`"" `
    /F

if ($LASTEXITCODE -ne 0) {
    throw "Failed to create scheduled task. Exit code: $LASTEXITCODE"
}

Write-Host "Startup task created successfully."

# --------------------------------------------------
# START AGENT
# --------------------------------------------------

Write-Host "Starting agent..."

Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\agent.ps1`""

# --------------------------------------------------
# CLEANUP
# --------------------------------------------------

Remove-Item `
    $TempAgent `
    -Force `
    -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "========================================="
Write-Host "       INSTALLATION COMPLETE"
Write-Host "========================================="
Write-Host ""
Write-Host "Booth: $env:COMPUTERNAME"
Write-Host "Version: $RemoteVersion"
Write-Host ""