$ErrorActionPreference = "Continue"

$AgentDir = "C:\ProgramData\PhotoboothAgent"
$LogDir = "$AgentDir\logs"
$LogFile = "$LogDir\agent.log"
$StatusFile = "$AgentDir\status.json"
$ConfigFile = "$AgentDir\config.json"

$BoothId = $env:COMPUTERNAME
$HeartbeatInterval = 30

$Repo = "nielsou/photobooth-agent"
$UpdateCheckInterval = 300

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

        # Physical presence: the spooler keeps saying "Normal" for an unplugged
        # USB printer, but its PnP device (USBPRINT\...&USB001 for USB,
        # SWD\PRINTENUM\WSD-... for WSD network printers) is no longer present.
        $PnpPrinters = @()

        try {
            $PnpPrinters = @(Get-PnpDevice -Class Printer -ErrorAction Stop)
        }
        catch {
            Write-Log "PnP detection error: $($_.Exception.Message)"
        }

        foreach ($Printer in $Printers) {

            $Port = "$($Printer.PortName)"

            if ($Port -match '^USB\d+$') {
                $Connection = "usb"
                $Device = $PnpPrinters | Where-Object { $_.InstanceId -like "USBPRINT\*&$Port" }
            }
            elseif ($Port -like "WSD-*") {
                $Connection = "network"
                $Device = $PnpPrinters | Where-Object { $_.InstanceId -eq "SWD\PRINTENUM\$Port" }
            }
            else {
                $Connection = if ($Printer.Network -or $Port -match '^(IP_|TCP|http)') { "network" } else { "other" }
                $Device = $null
            }

            # $null when presence cannot be determined (e.g. TCP/IP port)
            $Connected = $null
            if ($Device) {
                $Connected = [bool](@($Device) | Where-Object { $_.Present })
            }
            elseif ($Connection -eq "usb" -or $Port -like "WSD-*") {
                $Connected = $false
            }

            # Spooler status (Normal, Printing, Offline, PaperOut, PaperJam, Error...)
            $SpoolerState = "Unknown"
            $Jobs = @()

            try {
                $SpoolerState = (Get-Printer -Name $Printer.Name -ErrorAction Stop).PrinterStatus.ToString()
                $Jobs = @(Get-PrintJob -PrinterName $Printer.Name -ErrorAction Stop | Sort-Object SubmittedTime)
            }
            catch {
                Write-Log "Print queue error ($($Printer.Name)): $($_.Exception.Message)"
            }

            $OldestJobSeconds = $null
            if ($Jobs.Count -gt 0) {
                $OldestJobSeconds = [int]((Get-Date) - $Jobs[0].SubmittedTime).TotalSeconds
            }

            $JobList = @(
                $Jobs | Select-Object -First 10 | ForEach-Object {
                    [PSCustomObject]@{
                        document     = $_.DocumentName
                        status       = $_.JobStatus.ToString()
                        pagesPrinted = $_.PagesPrinted
                        totalPages   = $_.TotalPages
                        submittedAt  = $_.SubmittedTime.ToUniversalTime().ToString("o")
                    }
                }
            )

            $PrinterList += [PSCustomObject]@{
                name             = $Printer.Name
                default          = [bool]$Printer.Default
                driver           = $Printer.DriverName
                port             = $Port
                connection       = $Connection
                connected        = $Connected
                workOffline      = [bool]$Printer.WorkOffline
                status           = $SpoolerState
                errorState       = [int]$Printer.DetectedErrorState
                queueJobs        = $Jobs.Count
                oldestJobSeconds = $OldestJobSeconds
                jobs             = $JobList
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
# SELF-UPDATE
# --------------------------------------------------

# Every $UpdateCheckInterval seconds, compare VERSION on GitHub main with ours.
# Files are fetched at the exact commit SHA so VERSION and agent.ps1 always
# come from the same push (raw.githubusercontent.com caches each URL for ~5 min).
$LastCheckedSha = $null
$NextUpdateCheck = Get-Date

function Update-Agent {

    $Sha = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/$Repo/commits/main" `
        -Headers @{ Accept = "application/vnd.github.sha" } `
        -TimeoutSec 15 `
        -UseBasicParsing `
        -ErrorAction Stop

    $Sha = "$Sha".Trim()

    if ($Sha -notmatch '^[0-9a-f]{40}$') {
        throw "Unexpected commit SHA '$Sha'"
    }

    if ($Sha -eq $script:LastCheckedSha) {
        return
    }

    $RawUrl = "https://raw.githubusercontent.com/$Repo/$Sha"

    $RemoteVersion = "$(Invoke-RestMethod -Uri "$RawUrl/VERSION" -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop)".Trim()

    $Remote = $null
    $Local = $null

    if (-not [version]::TryParse($RemoteVersion, [ref]$Remote)) {
        throw "Invalid remote version '$RemoteVersion'"
    }

    if (-not [version]::TryParse($AgentVersion, [ref]$Local)) {
        $Local = [version]"0.0"
    }

    $script:LastCheckedSha = $Sha

    if ($Remote -le $Local) {
        return
    }

    Write-Log "Update available: $AgentVersion -> $RemoteVersion ($($Sha.Substring(0, 7)))"

    $NewAgent = "$AgentDir\agent.ps1.new"

    Invoke-WebRequest `
        -Uri "$RawUrl/agent/agent.ps1" `
        -OutFile $NewAgent `
        -TimeoutSec 30 `
        -UseBasicParsing `
        -ErrorAction Stop

    # Never replace a working agent with one that does not even parse.
    $ParseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($NewAgent, [ref]$null, [ref]$ParseErrors) | Out-Null

    if ($ParseErrors -or (Get-Item $NewAgent).Length -lt 1024) {
        Remove-Item $NewAgent -Force -ErrorAction SilentlyContinue
        throw "Downloaded agent is invalid, update skipped"
    }

    Move-Item -Path $NewAgent -Destination "$AgentDir\agent.ps1" -Force -ErrorAction Stop
    Set-Content -Path $VersionFile -Value $RemoteVersion -ErrorAction Stop

    Write-Log "Updated to $RemoteVersion, restarting agent"

    # The new process inherits our SYSTEM identity; no reboot needed.
    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentDir\agent.ps1`"" `
        -WindowStyle Hidden

    exit 0
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

    # Keep the log under ~5 MB (previous content kept in agent.log.1).
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) {
        Move-Item -Path $LogFile -Destination "$LogFile.1" -Force -ErrorAction SilentlyContinue
    }

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

    if ((Get-Date) -ge $NextUpdateCheck) {

        $NextUpdateCheck = (Get-Date).AddSeconds($UpdateCheckInterval)

        try {
            Update-Agent
        }
        catch {
            Write-Log "Update check error: $($_.Exception.Message)"
        }
    }

    Start-Sleep -Seconds $HeartbeatInterval
}