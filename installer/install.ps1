#Requires -Version 5.1

# Usage:
#   install.ps1 [-AgentToken <dashboard password>] [-ApiUrl https://<project>.vercel.app]
# Missing values are taken from an existing config.json; the token is otherwise
# prompted and ApiUrl defaults to the production dashboard.
# The token is a secret: never commit it, it only lives on the booth.

param(
    [string]$ApiUrl,
    [string]$AgentToken
)

$ErrorActionPreference = "Stop"

[Net.ServicePointManager]::SecurityProtocol = `
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --------------------------------------------------
# REQUIRE ADMINISTRATOR
# --------------------------------------------------

$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)

if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {

    Write-Host "Administrator privileges required."
    Write-Host "Requesting elevation..."

    $Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""

    if ($ApiUrl) { $Arguments += " -ApiUrl `"$ApiUrl`"" }
    if ($AgentToken) { $Arguments += " -AgentToken `"$AgentToken`"" }

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
$ConfigFile = "$InstallDir\config.json"
$TaskName = "Photobooth Agent"
$DefaultApiUrl = "https://photobooth-agent.vercel.app"
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

# The agent runs as SYSTEM and updates itself from this folder: only SYSTEM
# and Administrators may write here, other users can only read.
# (SIDs: S-1-5-18 SYSTEM, S-1-5-32-544 Administrators, S-1-5-32-545 Users)
Write-Host "Securing installation directory..."

icacls.exe $InstallDir /setowner "*S-1-5-32-544" /T /C /Q | Out-Null
icacls.exe $InstallDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" /Q | Out-Null

if ($LASTEXITCODE -ne 0) {
    throw "Failed to secure $InstallDir. Exit code: $LASTEXITCODE"
}

# Existing files go back to inheriting the folder ACL
# (config.json keeps its own, stricter ACL).
Get-ChildItem -Path $InstallDir -Force |
    Where-Object { $_.Name -ne "config.json" } |
    ForEach-Object { icacls.exe $_.FullName /reset /T /C /Q | Out-Null }

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

$TempPopup = "$env:TEMP\photobooth-agent-popup.ps1"

Invoke-WebRequest `
    -Uri "$RepoRawUrl/agent/popup.ps1" `
    -OutFile $TempPopup `
    -UseBasicParsing

# --------------------------------------------------
# INSTALL
# --------------------------------------------------

Write-Host "Installing agent..."

# Stop a running agent (it loops forever) so only one instance is left.
# (fails harmlessly on a first install, when the task does not exist yet)
try { schtasks.exe /End /TN $TaskName 2>&1 | Out-Null } catch { }

Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$InstallDir\agent.ps1*" -or $_.CommandLine -like "*$InstallDir\popup.ps1*" } |
    ForEach-Object {
        Write-Host "Stopping running agent process (PID $($_.ProcessId))..."
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Copy-Item `
    $TempAgent `
    "$InstallDir\agent.ps1" `
    -Force

Copy-Item `
    $TempPopup `
    "$InstallDir\popup.ps1" `
    -Force

Set-Content `
    -Path "$InstallDir\VERSION" `
    -Value $RemoteVersion

# --------------------------------------------------
# REMOTE HEARTBEAT CONFIG
# --------------------------------------------------

Write-Host "Configuring remote heartbeat..."

$ExistingConfig = $null

if (Test-Path $ConfigFile) {
    try {
        $ExistingConfig = Get-Content -Path $ConfigFile -Raw | ConvertFrom-Json
    }
    catch {
        Write-Host "Existing config.json is unreadable, it will be replaced."
    }
}

if (-not $ApiUrl -and $ExistingConfig) { $ApiUrl = $ExistingConfig.apiUrl }
if (-not $AgentToken -and $ExistingConfig) { $AgentToken = $ExistingConfig.agentToken }

if (-not $ApiUrl) { $ApiUrl = $DefaultApiUrl }

$ApiUrl = "$ApiUrl".Trim().TrimEnd("/")
$AgentToken = "$AgentToken" -replace '\s', ''

if ($ApiUrl -notmatch "^https://") {
    throw "ApiUrl must start with https:// (got '$ApiUrl')"
}

# Asks the dashboard whether the code is accepted:
# $true = valid, $false = rejected, $null = dashboard unreachable.
function Test-AgentToken {
    param([string]$Token)

    try {
        Invoke-RestMethod `
            -Uri "$ApiUrl/api/heartbeat" `
            -Headers @{ Authorization = "Bearer $Token" } `
            -TimeoutSec 15 `
            -UseBasicParsing | Out-Null

        return $true
    }
    catch {
        $Response = $_.Exception.Response

        if ($Response -and [int]$Response.StatusCode -eq 401) {
            return $false
        }

        Write-Host "WARNING: could not check the code with the dashboard: $($_.Exception.Message)"
        return $null
    }
}

if ($AgentToken -and (Test-AgentToken -Token $AgentToken) -eq $false) {
    Write-Host "Le code d'installation enregistre est refuse par le dashboard."
    $AgentToken = ""
}

$Attempts = 0

while (-not $AgentToken -and $Attempts -lt 3) {

    $Attempts++

    Write-Host ""
    Write-Host "Tape le code d'installation (le mot de passe du dashboard), puis Entree."
    Write-Host "(Laisser vide = surveillance locale uniquement, sans dashboard.)"

    $SecureToken = Read-Host "Code d'installation" -AsSecureString
    $Entered = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken))
    $Entered = "$Entered" -replace '\s', ''

    if (-not $Entered) {
        break
    }

    if ((Test-AgentToken -Token $Entered) -eq $false) {
        Write-Host "Code incorrect. Reessaie."
        continue
    }

    $AgentToken = $Entered
    Write-Host "Code d'installation accepte."
}

if ($ApiUrl -and $AgentToken) {

    [PSCustomObject]@{
        apiUrl     = $ApiUrl
        agentToken = $AgentToken
    } |
        ConvertTo-Json |
        Set-Content -Path $ConfigFile -Encoding UTF8

    # The token is a secret: only SYSTEM and Administrators may read it.
    icacls.exe $ConfigFile /inheritance:r /grant:r "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict access to $ConfigFile. Exit code: $LASTEXITCODE"
    }

    Write-Host "Heartbeat will be sent to $ApiUrl"
}
else {
    # Do not leave a rejected code behind: the agent would keep being refused.
    Remove-Item -Path $ConfigFile -Force -ErrorAction SilentlyContinue
    Write-Host "No dashboard configured: status will only be written locally."
}

# --------------------------------------------------
# CREATE STARTUP TASK
# --------------------------------------------------

Write-Host "Creating startup task..."

schtasks.exe /Create `
    /TN $TaskName `
    /SC ONSTART `
    /RU SYSTEM `
    /RL HIGHEST `
    /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\agent.ps1`"" `
    /F

if ($LASTEXITCODE -ne 0) {
    throw "Failed to create scheduled task. Exit code: $LASTEXITCODE"
}

Write-Host "Startup task created successfully."

# schtasks.exe defaults would kill the agent after 72 h and stop it on battery.
try {
    $Task = Get-ScheduledTask -TaskName $TaskName
    $Task.Settings.ExecutionTimeLimit = "PT0S"
    $Task.Settings.DisallowStartIfOnBatteries = $false
    $Task.Settings.StopIfGoingOnBatteries = $false
    $Task | Set-ScheduledTask | Out-Null

    Write-Host "Startup task settings updated (no time limit, runs on battery)."
}
catch {
    Write-Host "WARNING: could not update task settings: $($_.Exception.Message)"
}

# --------------------------------------------------
# START AGENT
# --------------------------------------------------

Write-Host "Starting agent..."

# Run through the task so the agent runs as SYSTEM, exactly like at boot.
try { schtasks.exe /Run /TN $TaskName 2>&1 | Out-Null } catch { }

if ($LASTEXITCODE -ne 0) {

    Write-Host "Could not start the task, starting the agent directly..."

    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\agent.ps1`""
}

# --------------------------------------------------
# POPUP HELPER (user session)
# --------------------------------------------------

# The agent runs as SYSTEM and cannot show windows: popup.ps1 runs in the
# logged-on user's session (any user, via the Users group) and shows the
# paper-out popup over dslrBooth.
Write-Host "Creating popup task..."

$PopupArguments = "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\popup.ps1`""

try {
    $PopupAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $PopupArguments
    $PopupTrigger = New-ScheduledTaskTrigger -AtLogOn
    $PopupPrincipal = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Limited
    $PopupSettings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask `
        -TaskName "$TaskName Popup" `
        -Action $PopupAction `
        -Trigger $PopupTrigger `
        -Principal $PopupPrincipal `
        -Settings $PopupSettings `
        -Force | Out-Null

    Write-Host "Popup task created (starts at every logon)."
}
catch {
    Write-Host "WARNING: could not create the popup task: $($_.Exception.Message)"
}

# Start it now for the current session (it only shows something on alert).
Start-Process -FilePath "powershell.exe" -ArgumentList $PopupArguments -WindowStyle Hidden

# --------------------------------------------------
# CLEANUP
# --------------------------------------------------

Remove-Item `
    $TempAgent, $TempPopup `
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