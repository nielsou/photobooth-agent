$ErrorActionPreference = "Continue"

$AgentDir = "C:\ProgramData\PhotoboothAgent"
$LogDir = "$AgentDir\logs"
$LogFile = "$LogDir\agent.log"
$StatusFile = "$AgentDir\status.json"
$ConfigFile = "$AgentDir\config.json"

$BoothId = $env:COMPUTERNAME
$HeartbeatInterval = 30

# Windows PowerShell 5.1 may default to TLS 1.0, which Vercel rejects.
[Net.ServicePointManager]::SecurityProtocol = `
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --------------------------------------------------
# VERSION
# --------------------------------------------------

$VersionFile = "$AgentDir\VERSION"

if (Test-Path $VersionFile) {
    $AgentVersion = (Get-Content $VersionFile -Raw).Trim()
}
else {
    $AgentVersion = "UNKNOWN"
}

# --------------------------------------------------
# LOGGING
# --------------------------------------------------

function Write-Log {
    param([string]$Message)

    $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"

    Add-Content -Path $LogFile -Value $Line
}

# --------------------------------------------------
# COLLECT STATUS
# --------------------------------------------------

function Get-AgentStatus {

    # Internet
    $Internet = $false

    try {
        $Internet = Test-NetConnection `
            "www.google.com" `
            -Port 443 `
            -InformationLevel Quiet `
            -WarningAction SilentlyContinue
    }
    catch {
        $Internet = $false
    }

    # Spooler
    $SpoolerStatus = "Unknown"

    try {
        $Spooler = Get-Service -Name "Spooler"
        $SpoolerStatus = $Spooler.Status.ToString()
    }
    catch {
        $SpoolerStatus = "Unknown"
    }

    # Printers
    $PrinterList = @()

    try {

        # Skip virtual printers (PDF, XPS, OneNote, Fax): they have no physical port.
        $Printers = Get-CimInstance Win32_Printer |
            Where-Object {
                $_.PortName -notmatch '^(nul|PORTPROMPT|SHRFAX|FILE):$' -and
                $_.DriverName -notmatch 'OneNote|Print To PDF|XPS Document Writer|Fax'
            }

        foreach ($Printer in $Printers) {

            $PrinterQueue = 0

            try {

                $Jobs = Get-CimInstance Win32_PrintJob |
                    Where-Object {
                        $_.Name -like "$($Printer.Name),*"
                    }

                $PrinterQueue = @($Jobs).Count

            }
            catch {
                $PrinterQueue = 0
            }

            $PrinterList += [PSCustomObject]@{
                name         = $Printer.Name
                default      = [bool]$Printer.Default
                status       = $Printer.Status
                printerState = $Printer.PrinterState
                workOffline  = [bool]$Printer.WorkOffline
                queueJobs    = $PrinterQueue
            }
        }

    }
    catch {
        Write-Log "Printer detection error: $($_.Exception.Message)"
    }

    # Status object
    return [PSCustomObject]@{
        boothId           = $BoothId
        agentVersion      = $AgentVersion
        computerName      = $env:COMPUTERNAME
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        internet          = $Internet
        spooler           = $SpoolerStatus
        printers          = $PrinterList
        heartbeat         = $true
        timestamp         = (Get-Date).ToUniversalTime().ToString("o")
    }
}

# --------------------------------------------------
# REMOTE HEARTBEAT
# --------------------------------------------------

# config.json is written by the installer and never committed:
# { "apiUrl": "https://<project>.vercel.app", "agentToken": "<AGENT_TOKEN>" }
function Get-AgentConfig {

    if (-not (Test-Path $ConfigFile)) {
        return $null
    }

    $Config = Get-Content -Path $ConfigFile -Raw -ErrorAction Stop |
        ConvertFrom-Json -ErrorAction Stop

    if (-not $Config.apiUrl -or -not $Config.agentToken) {
        return $null
    }

    return $Config
}

function Send-Heartbeat {
    param([string]$Json)

    $Config = Get-AgentConfig

    if (-not $Config) {
        return "skipped (no config.json)"
    }

    $Uri = "$($Config.apiUrl.TrimEnd('/'))/api/heartbeat"

    Invoke-RestMethod `
        -Uri $Uri `
        -Method Post `
        -Headers @{ Authorization = "Bearer $($Config.agentToken)" } `
        -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($Json)) `
        -TimeoutSec 15 `
        -UseBasicParsing `
        -ErrorAction Stop | Out-Null

    return "sent"
}

# --------------------------------------------------
# START
# --------------------------------------------------

Write-Log "========================================"
Write-Log "Photobooth Agent started"
Write-Log "Agent version: $AgentVersion"
Write-Log "Booth ID: $BoothId"
Write-Log "Heartbeat interval: $HeartbeatInterval seconds"

# --------------------------------------------------
# HEARTBEAT LOOP
# --------------------------------------------------

while ($true) {

    try {

        $Status = Get-AgentStatus

        $StatusJson = $Status | ConvertTo-Json -Depth 10

        $StatusJson | Set-Content -Path $StatusFile -Encoding UTF8

        Write-Log "Heartbeat OK"

    }
    catch {

        Write-Log "Heartbeat error: $($_.Exception.Message)"
        $StatusJson = $null

    }

    if ($StatusJson) {

        try {

            $Result = Send-Heartbeat -Json $StatusJson

            Write-Log "Remote heartbeat $Result"

        }
        catch {

            Write-Log "Remote heartbeat error: $($_.Exception.Message)"

        }
    }

    Start-Sleep -Seconds $HeartbeatInterval
}