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

# On power-on, print jobs older than this are leftovers from a previous event.
$PurgeJobsOlderThanHours = 2
$BootFile = "$AgentDir\last-boot.txt"

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
# DNP MEDIA COUNTER
# --------------------------------------------------

# DNP dye-sub printers (DS620, QW410, DS-RX1...) answer read-only "INFO"
# queries over USB with the DNP "ESC P" protocol (documented by Gutenprint's
# dnpds40 backend): INFO MQTY gives the number of prints left on the media.
# Queried at most every $DnpQueryInterval seconds and never while the printer
# has jobs, so we do not talk to it in the middle of a print.
$DnpQueryInterval = 60
$DnpReady = $false
$DnpCache = @()
$DnpNextQuery = Get-Date

try {
    Add-Type -ErrorAction Stop -TypeDefinition @"
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class DnpUsb {
    static Guid UsbPrintGuid = new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2");

    [StructLayout(LayoutKind.Sequential)]
    struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }

    [DllImport("setupapi.dll", SetLastError = true)]
    static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr enumerator, IntPtr hwnd, int flags);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid g, int index, ref SP_DEVICE_INTERFACE_DATA data);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, int size, out int required, IntPtr info);
    [DllImport("setupapi.dll")]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);

    // Present USB printer interfaces, e.g. \\?\usb#vid_1452&pid_9201#serial#{guid}
    public static List<string> DevicePaths() {
        var paths = new List<string>();
        IntPtr set = SetupDiGetClassDevs(ref UsbPrintGuid, IntPtr.Zero, IntPtr.Zero, 0x12);
        try {
            var data = new SP_DEVICE_INTERFACE_DATA();
            data.cbSize = Marshal.SizeOf(data);
            for (int i = 0; SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref UsbPrintGuid, i, ref data); i++) {
                int required;
                SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out required, IntPtr.Zero);
                IntPtr detail = Marshal.AllocHGlobal(required);
                try {
                    Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
                    if (SetupDiGetDeviceInterfaceDetail(set, ref data, detail, required, out required, IntPtr.Zero))
                        paths.Add(Marshal.PtrToStringUni(new IntPtr(detail.ToInt64() + 4)));
                } finally { Marshal.FreeHGlobal(detail); }
            }
        } finally { SetupDiDestroyDeviceInfoList(set); }
        return paths;
    }

    // Sends "ESC P" + arg1 (6) + arg2 (16) + arg3 (8), space padded, and returns
    // the answer payload (answer = 8 ASCII digits of length + payload).
    public static string Query(string path, string arg1, string arg2, int timeoutMs) {
        byte[] cmd = new byte[32];
        for (int i = 0; i < cmd.Length; i++) cmd[i] = 0x20;
        cmd[0] = 0x1b; cmd[1] = 0x50;
        Encoding.ASCII.GetBytes(arg1, 0, Math.Min(arg1.Length, 6), cmd, 2);
        Encoding.ASCII.GetBytes(arg2, 0, Math.Min(arg2.Length, 16), cmd, 8);

        SafeFileHandle h = CreateFile(path, 0xC0000000, 3, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
        if (h.IsInvalid) throw new IOException("cannot open printer (error " + Marshal.GetLastWin32Error() + ")");

        using (var fs = new FileStream(h, FileAccess.ReadWrite, 4096, true)) {
            fs.Write(cmd, 0, cmd.Length);
            fs.Flush();

            var buf = new byte[4096];
            int got = 0;
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline) {
                Task<int> t = fs.ReadAsync(buf, got, buf.Length - got);
                int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (left <= 0 || !t.Wait(left)) break;
                got += t.Result;
                if (got >= 8) {
                    int len;
                    if (int.TryParse(Encoding.ASCII.GetString(buf, 0, 8), out len) && got >= 8 + len)
                        return Encoding.ASCII.GetString(buf, 8, len);
                }
                if (t.Result == 0) System.Threading.Thread.Sleep(50);
            }
            throw new TimeoutException("no answer (" + got + " bytes: " + Encoding.ASCII.GetString(buf, 0, got) + ")");
        }
    }
}
"@
    $DnpReady = $true
}
catch {
    Write-Log "DNP support unavailable: $($_.Exception.Message)"
}

function Get-DnpInfo {
    param([bool]$Busy)

    if (-not $script:DnpReady) { return @() }
    if ($Busy -or (Get-Date) -lt $script:DnpNextQuery) { return $script:DnpCache }

    $script:DnpNextQuery = (Get-Date).AddSeconds($DnpQueryInterval)
    $Result = @()

    # DNP (1452) and Citizen (1343): Citizen photo printers are DNP-built and
    # speak the same protocol (Gutenprint dnpds40 backend).
    foreach ($Path in @([DnpUsb]::DevicePaths() | Where-Object { $_ -match 'vid_(1452|1343)' })) {

        $Raw = [ordered]@{}
        $Errors = @()

        # name, arg1, arg2 ("STATUS" is a command of its own, not an INFO query)
        $Queries = @(
            @("MQTY", "INFO", "MQTY"),
            @("STATUS", "STATUS", ""),
            @("MEDIA", "INFO", "MEDIA"),
            @("SERIAL_NUMBER", "INFO", "SERIAL_NUMBER"),
            @("FVER", "INFO", "FVER")
        )

        foreach ($Query in $Queries) {
            try {
                # Answers are padded with CR, NUL and spaces.
                $Raw[$Query[0]] = ([DnpUsb]::Query($Path, $Query[1], $Query[2], 3000) -replace '[\x00\r\n]', '').Trim()
            }
            catch {
                $Inner = $_.Exception.InnerException
                $Errors += "$($Query[0]) : $(if ($Inner) { $Inner.Message } else { $_.Exception.Message })"

                # No answer to the first query: do not wait on the others.
                if ($Query[0] -eq "MQTY") { break }
            }
        }

        # MQTY answers e.g. "MQTY0017" = 17 prints left.
        $Remaining = $null
        if ("$($Raw['MQTY'])" -match '(\d+)$') {
            $Remaining = [int]$Matches[1]
        }

        # STATUS answers a code: 0 idle, 1 printing, 1000 cover open, 1100 paper end...
        $StatusCode = $null
        if ("$($Raw['STATUS'])" -match '^\d+$') {
            $StatusCode = [int]$Raw["STATUS"]
        }

        $Result += [PSCustomObject]@{
            device         = ($Path -replace '^.*?#(vid_[0-9a-f]{4}&pid_[0-9a-f]{4}).*$', '$1')
            vendor         = $(if ($Path -match 'vid_1343') { "Citizen" } else { "DNP" })
            mediaRemaining = $Remaining
            statusCode     = $StatusCode
            media          = $Raw["MEDIA"]
            serial         = $Raw["SERIAL_NUMBER"]
            firmware       = $Raw["FVER"]
            raw            = [PSCustomObject]$Raw
            errors         = $Errors
        }
    }

    $script:DnpCache = $Result
    return $Result
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

    # Network actually used to reach the internet (cable to the 4G router, Wi-Fi...)
    $Network = $null

    try {
        $Route = Find-NetRoute -RemoteIPAddress "8.8.8.8" -ErrorAction Stop | Select-Object -First 1
        $Adapter = Get-NetAdapter -InterfaceIndex $Route.InterfaceIndex -ErrorAction Stop
        $ConnectionProfile = Get-NetConnectionProfile -InterfaceIndex $Route.InterfaceIndex -ErrorAction SilentlyContinue |
            Select-Object -First 1

        $Media = "$($Adapter.PhysicalMediaType) $($Adapter.MediaType) $($Adapter.InterfaceDescription)"

        $Type = if ($Media -match '802\.11|Wireless LAN|Wi-?Fi') { "wifi" }
            elseif ($Media -match 'Wireless WAN|Mobile Broadband|WWAN') { "cellular" }
            elseif ($Media -match '802\.3|Ethernet') { "ethernet" }
            else { "other" }

        $Ssid = $null
        $Signal = $null

        if ($Type -eq "wifi") {
            # May be empty on recent Windows without location permission.
            $Wlan = netsh.exe wlan show interfaces 2>$null
            $SsidLine = $Wlan | Where-Object { $_ -match '^\s*SSID\s*:\s*(.+)$' } | Select-Object -First 1
            if ($SsidLine -match '^\s*SSID\s*:\s*(.+)$') { $Ssid = $Matches[1].Trim() }
            $SignalLine = $Wlan | Where-Object { $_ -match '^\s*Signal\s*:\s*(\d+)\s*%' } | Select-Object -First 1
            if ($SignalLine -match '(\d+)\s*%') { $Signal = [int]$Matches[1] }
        }

        # Quality of the internet link (for a 4G router, Windows only sees the
        # cable): 3 pings of 32 bytes give latency and packet loss.
        $Pings = @(Test-Connection -ComputerName "1.1.1.1" -Count 3 -ErrorAction SilentlyContinue)
        $LatencyMs = $null

        if ($Pings.Count -gt 0) {
            $LatencyMs = [int](($Pings | Measure-Object -Property ResponseTime -Average).Average)
        }

        $Network = [PSCustomObject]@{
            type             = $Type
            adapter          = $Adapter.Name
            description      = $Adapter.InterfaceDescription
            linkSpeed        = $Adapter.LinkSpeed
            name             = if ($Ssid) { $Ssid } else { $ConnectionProfile.Name }
            ssid             = $Ssid
            signal           = $Signal
            latencyMs        = $LatencyMs
            packetLoss       = [int](100 * (3 - $Pings.Count) / 3)
            heartbeatMs      = $LastHeartbeatMs
            failedHeartbeats = $FailedHeartbeats
        }
    }
    catch {
        Write-Log "Network detection error: $($_.Exception.Message)"
    }

    # Arduino boards (USB serial): genuine Arduino (2341, 2A03), CH340 clones
    # (1A86), FTDI (0403), CP210x (10C4), SparkFun (1B4F), Adafruit (239A).
    # The COM port number matters to the booth software. A board plugged in
    # without its driver has no COM port ("driverMissing").
    $Arduino = @()

    try {
        $Arduino = @(Get-PnpDevice -ErrorAction Stop |
            Where-Object {
                $_.InstanceId -match '^USB\\VID_(1A86|2341|2A03|0403|10C4|1B4F|239A)&' -and
                ($_.Class -eq "Ports" -or ($_.Present -and "$($_.Status)" -eq "Error"))
            } |
            ForEach-Object {
                $Com = $null
                if ("$($_.FriendlyName)" -match '\((COM\d+)\)') { $Com = $Matches[1] }

                [PSCustomObject]@{
                    name          = $_.FriendlyName
                    com           = $Com
                    usbId         = ($_.InstanceId -replace '^USB\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4}).*$', '$1')
                    present       = [bool]$_.Present
                    driverMissing = ($_.Class -ne "Ports")
                }
            })
    }
    catch {
        Write-Log "Arduino detection error: $($_.Exception.Message)"
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

            $Manufacturer = $null
            try {
                $Manufacturer = (Get-PrinterDriver -Name $Printer.DriverName -ErrorAction Stop).Manufacturer
            }
            catch { }

            $PrinterList += [PSCustomObject]@{
                name             = $Printer.Name
                default          = [bool]$Printer.Default
                driver           = $Printer.DriverName
                manufacturer     = $Manufacturer
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

    # DNP media counter, attached to the connected DNP queue(s)
    $DnpDevices = @()

    try {
        $DnpQueues = @($PrinterList | Where-Object { $_.manufacturer -match 'Dai Nippon|CITIZEN' -and $_.connected -ne $false })

        # Do not talk to the printer while a job is being sent to it. A job
        # stuck for > 2 min (paper end, cover open...) means nothing is being
        # sent, and that is exactly when we need the printer's error code.
        $Busy = [bool]($DnpQueues | Where-Object {
            ($_.queueJobs -gt 0 -and [int]$_.oldestJobSeconds -lt 120) -or
            ($_.queueJobs -eq 0 -and $_.status -match 'Printing|Busy|Processing|IoActive')
        })

        $DnpDevices = @(Get-DnpInfo -Busy $Busy)

        # One DNP plugged in (the usual case): it is the one behind the DNP queue(s).
        if ($DnpDevices.Count -eq 1) {
            foreach ($Queue in $DnpQueues) {
                $Queue | Add-Member -NotePropertyName dnp -NotePropertyValue $DnpDevices[0]
            }
        }
    }
    catch {
        Write-Log "DNP query error: $($_.Exception.Message)"
    }

    # USB printers seen by Windows (vid/pid), to identify new printer models.
    $UsbPrintDevices = @()
    if ($DnpReady) {
        try { $UsbPrintDevices = @([DnpUsb]::DevicePaths() | ForEach-Object { $_ -replace '^.*?#(vid_[0-9a-f]{4}&pid_[0-9a-f]{4}).*$', '$1' }) } catch { }
    }

    # Printer alert popup currently requested, and whether its helper runs
    $AlertShown = Test-Path "$AgentDir\alert.json"
    $AlertId = $null
    $HelperState = $null

    try {
        if ($AlertShown) { $AlertId = (Get-Content "$AgentDir\alert.json" -Raw | ConvertFrom-Json).id }

        $HelperState = if (Test-PopupHelperRunning) { "Running" }
            else { "$((Get-ScheduledTask -TaskName 'Photobooth Agent Popup' -ErrorAction SilentlyContinue).State)" }
    }
    catch { }

    # Status object
    return [PSCustomObject]@{
        boothId           = $BoothId
        agentVersion      = $AgentVersion
        computerName      = $env:COMPUTERNAME
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        internet          = $Internet
        network           = $Network
        arduino           = $Arduino
        fonts             = $FontsStatus
        drivers           = $DriversStatus
        startScreenVideo  = $StartScreenStatus
        lights            = $(Get-LightsState -Arduino $Arduino)
        kiosk             = $KioskStatus
        installs          = $InstallStatus
        software          = $(try { Get-BoothSoftware } catch { Write-Log "Software check error: $($_.Exception.Message)"; $null })
        spooler           = $SpoolerStatus
        printers          = $PrinterList
        dnpDevices        = $DnpDevices
        usbPrintDevices   = $UsbPrintDevices
        paperOutPopup     = $AlertShown
        printerAlert      = $AlertId
        popupHelper       = $HelperState
        heartbeat         = $true
        timestamp         = (Get-Date).ToUniversalTime().ToString("o")
    }
}

# --------------------------------------------------
# PRINT QUEUE PURGE ON POWER-ON
# --------------------------------------------------

# Removes jobs older than $PurgeJobsOlderThanHours from every print queue, so
# photos stuck from a previous event are not printed at the next one. Recent
# jobs are kept (e.g. a booth rebooted in the middle of an event).
function Clear-OldPrintJobs {
    param([string]$Reason)

    $Cutoff = (Get-Date).AddHours(-$PurgeJobsOlderThanHours)
    $Removed = 0

    foreach ($Printer in @(Get-Printer -ErrorAction Stop)) {

        $OldJobs = @(Get-PrintJob -PrinterName $Printer.Name -ErrorAction SilentlyContinue |
            Where-Object { $_.SubmittedTime -lt $Cutoff })

        foreach ($Job in $OldJobs) {
            try {
                $Job | Remove-PrintJob -ErrorAction Stop
                $Removed++
                Write-Log "Purged job '$($Job.DocumentName)' on '$($Printer.Name)' (submitted $($Job.SubmittedTime))"
            }
            catch {
                Write-Log "Could not purge job '$($Job.DocumentName)' on '$($Printer.Name)': $($_.Exception.Message)"
            }
        }
    }

    Write-Log "Print queue purge ($Reason): $Removed job(s) older than $PurgeJobsOlderThanHours h removed"
}

# True when Windows booted since the last time the agent ran. A restart of
# the agent alone (self-update, reinstall) keeps the same boot time.
function Test-NewBoot {

    $BootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")
    $Previous = $null

    if (Test-Path $BootFile) {
        $Previous = (Get-Content $BootFile -Raw).Trim()
    }

    Set-Content -Path $BootFile -Value $BootTime

    return $BootTime -ne $Previous
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
# PRINTER ALERT POPUPS
# --------------------------------------------------

# The dashboard tells each booth which popups to show when its DNP printer
# reports a problem (paper end, jam, open cover...; only Signature booths get
# them). Fetched every hour; the server answers 304 when nothing changed. The
# popup itself is shown by popup.ps1 in the user's session, which watches
# alert.json.
$AlertFile = "$AgentDir\alert.json"
$PopupConfigFile = "$AgentDir\popup-config.json"
$BoothConfigInterval = 3600
$BoothConfigEtag = $null
$PrinterAlerts = @()
$DnpCodeLabels = $null

# 1.9.x stored a single paper-out popup: read it as the "paper" alert.
function ConvertTo-PrinterAlerts {
    param($Config)

    if (-not $Config) { return @() }

    if ($Config.PSObject.Properties["printerAlerts"]) { return @($Config.printerAlerts) }

    if ($Config.PSObject.Properties["title"] -and -not $Config.PSObject.Properties["id"]) {
        $Config | Add-Member -NotePropertyName id -NotePropertyValue "paper" -Force
        $Config | Add-Member -NotePropertyName codes -NotePropertyValue @(1100, 1200) -Force
        $Config | Add-Member -NotePropertyName whenEmpty -NotePropertyValue $true -Force
        $Config | Add-Member -NotePropertyName qrFile -NotePropertyValue "paper-qr.png" -Force
        return @($Config)
    }

    return @()
}

if (Test-Path $PopupConfigFile) {
    try {
        $SavedConfig = Get-Content $PopupConfigFile -Raw | ConvertFrom-Json
        $PrinterAlerts = ConvertTo-PrinterAlerts $SavedConfig
        $DnpCodeLabels = $SavedConfig.dnpCodes
    }
    catch { }
}

function Update-BoothConfig {

    $Config = Get-AgentConfig
    if (-not $Config) { return }

    $Headers = @{ Authorization = "Bearer $($Config.agentToken)" }
    if ($script:BoothConfigEtag) { $Headers["If-None-Match"] = $script:BoothConfigEtag }

    try {
        $Response = Invoke-WebRequest `
            -Uri "$($Config.apiUrl.TrimEnd('/'))/api/booth-config?id=$BoothId" `
            -Headers $Headers `
            -TimeoutSec 15 `
            -UseBasicParsing `
            -ErrorAction Stop
    }
    catch {
        # Windows PowerShell reports "304 Not Modified" as an error.
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 304) { return }
        throw
    }

    $Body = $Response.Content | ConvertFrom-Json
    $Alerts = @($Body.printerAlerts | Where-Object { $_ })

    # One QR code image per alert, next to the config (readable by the helper).
    foreach ($Alert in $Alerts) {
        $QrFile = $null

        if ($Alert.qrPng) {
            $QrFile = "alert-qr-$($Alert.id).png"
            [IO.File]::WriteAllBytes("$AgentDir\$QrFile", [Convert]::FromBase64String($Alert.qrPng))
        }

        $Alert.PSObject.Properties.Remove("qrPng")
        $Alert | Add-Member -NotePropertyName qrFile -NotePropertyValue $QrFile -Force
    }

    if ($Alerts.Count -gt 0) {
        [PSCustomObject]@{ printerAlerts = $Alerts; dnpCodes = $Body.dnpCodes } | ConvertTo-Json -Depth 5 | Set-Content -Path $PopupConfigFile -Encoding UTF8
    }
    else {
        Remove-Item $PopupConfigFile -Force -ErrorAction SilentlyContinue
    }

    $script:PrinterAlerts = $Alerts
    $script:BoothType = $Body.type
    $script:StartScreenVideo = $Body.startScreenVideo
    $script:LightsScript = $Body.lightsScript
    $script:Kiosk = [bool]$Body.kiosk
    $script:InstallPrograms = @($Body.installPrograms | Where-Object { $_ })

    $Drivers = @($Body.drivers | Where-Object { $_ })
    if ($Drivers.Count -gt 0) {
        ConvertTo-Json -InputObject $Drivers -Depth 5 | Set-Content -Path $DriversConfigFile -Encoding UTF8
    }
    else {
        Remove-Item $DriversConfigFile -Force -ErrorAction SilentlyContinue
    }
    $script:DriversConfig = $Drivers
    $script:DnpCodeLabels = $Body.dnpCodes
    $script:BoothConfigEtag = $Response.Headers["ETag"]
    Write-Log "Booth config updated (type: $($Body.type), alerts: $(($Alerts | ForEach-Object { $_.id }) -join ', '))"
}

# The popup helper must run in the user's session (this agent runs in the
# invisible session 0). Running as SYSTEM, the agent sets it up itself, so
# booths installed before the popup existed need no reinstall.
$PopupTaskName = "Photobooth Agent Popup"

# The helper restarts itself after an update (outside the task), so look at
# the processes rather than at the task state.
function Test-PopupHelperRunning {
    return [bool](Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$AgentDir\popup.ps1*" })
}

function Start-PopupHelper {
    if (Test-PopupHelperRunning) { return }

    if (Get-ScheduledTask -TaskName $PopupTaskName -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName $PopupTaskName -ErrorAction Stop
        Write-Log "Popup helper started"
    }
}

function Install-PopupHelper {

    $Script = "$AgentDir\popup.ps1"

    if (-not (Test-Path $Script)) {
        $New = "$Script.new"

        Invoke-WebRequest `
            -Uri "https://raw.githubusercontent.com/$Repo/main/agent/popup.ps1" `
            -OutFile $New `
            -TimeoutSec 30 `
            -UseBasicParsing `
            -ErrorAction Stop

        $ParseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($New, [ref]$null, [ref]$ParseErrors) | Out-Null

        if ($ParseErrors) {
            Remove-Item $New -Force -ErrorAction SilentlyContinue
            throw "Downloaded popup.ps1 is invalid"
        }

        Move-Item -Path $New -Destination $Script -Force -ErrorAction Stop
        Write-Log "Popup helper downloaded"
    }

    if (-not (Get-ScheduledTask -TaskName $PopupTaskName -ErrorAction SilentlyContinue)) {

        # Same task as the installer creates: any member of Users, at logon.
        $Action = New-ScheduledTaskAction `
            -Execute "powershell.exe" `
            -Argument "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        $Principal = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Limited
        $Settings = New-ScheduledTaskSettingsSet `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -MultipleInstances IgnoreNew

        Register-ScheduledTask `
            -TaskName $PopupTaskName `
            -Action $Action `
            -Trigger $Trigger `
            -Principal $Principal `
            -Settings $Settings `
            -ErrorAction Stop | Out-Null

        Write-Log "Popup task created"
    }

    Start-PopupHelper
}

# The alert matching a DNP state: first alert listing its status code, or
# flagged whenEmpty (no prints left) or otherErrors (any code >= 1000).
function Find-PrinterAlert {
    param($DnpDevices)

    foreach ($Device in @($DnpDevices | Where-Object { $_ })) {

        $Code = $Device.statusCode
        $Empty = $Device.mediaRemaining -eq 0

        foreach ($Alert in $script:PrinterAlerts) {
            if ($null -ne $Code -and @($Alert.codes) -contains $Code) { return @{ Alert = $Alert; Device = $Device } }
        }

        foreach ($Alert in $script:PrinterAlerts) {
            if ($Empty -and $Alert.whenEmpty) { return @{ Alert = $Alert; Device = $Device } }
            if ($null -ne $Code -and $Code -ge 1000 -and $Alert.otherErrors) { return @{ Alert = $Alert; Device = $Device } }
        }
    }

    return $null
}

# Line shown on the popup so that when the client calls, support knows which
# booth, printer and error it is about.
function Get-AlertInfo {
    param($Status, $Device)

    $Queue = @($Status.printers | Where-Object { $_.dnp }) | Select-Object -First 1
    $Code = $Device.statusCode
    $Parts = @("Booth $BoothId")

    $Printer = if ($Device.firmware) { "$($Device.firmware)" } elseif ($Queue) { "$($Queue.name)" } else { $null }
    if ($Printer) { $Parts += $Printer }

    if ($null -ne $Code) {
        $Label = $null
        if ($script:DnpCodeLabels) { $Label = $script:DnpCodeLabels."$Code" }
        $Parts += if ($Label) { "code $Code ($Label)" } else { "code $Code" }
    }

    if ($null -ne $Device.mediaRemaining) { $Parts += "$($Device.mediaRemaining) tirages restants" }
    $Parts += (Get-Date -Format "dd/MM HH:mm")

    return "Pour l'assistance : " + ($Parts -join " - ")
}

# Writes alert.json while the printer has a problem (rewritten when the
# problem changes, e.g. jam -> open cover, or another error code), removes it
# once the printer is fine again.
function Update-PrinterAlert {
    param($Status)

    $Match = Find-PrinterAlert -DnpDevices $Status.dnpDevices
    $Current = $null

    if (Test-Path $AlertFile) {
        try { $Current = Get-Content $AlertFile -Raw | ConvertFrom-Json } catch { }
    }

    if ($Match) {
        $Alert = $Match.Alert
        $Code = $Match.Device.statusCode

        if (-not $Current -or $Current.id -ne $Alert.id -or "$($Current.errorCode)" -ne "$Code") {
            $Data = [ordered]@{ since = (Get-Date).ToUniversalTime().ToString("o"); errorCode = $Code }
            $Alert.PSObject.Properties | ForEach-Object { $Data[$_.Name] = $_.Value }
            $Data["info"] = Get-AlertInfo -Status $Status -Device $Match.Device
            [PSCustomObject]$Data | ConvertTo-Json -Depth 5 | Set-Content -Path $AlertFile -Encoding UTF8
            Write-Log "Printer alert popup: $($Alert.id) (code $Code)"

            # Make sure someone is there to display it.
            try { Start-PopupHelper } catch { Write-Log "Popup helper start error: $($_.Exception.Message)" }
        }
    }
    elseif ($Current -or (Test-Path $AlertFile)) {
        Remove-Item $AlertFile -Force -ErrorAction SilentlyContinue
        Write-Log "Printer alert popup removed"
    }
}

# --------------------------------------------------
# FONTS
# --------------------------------------------------

# Fonts every booth needs (templates), kept in a shared Google Drive folder.
# The dashboard lists it (/api/fonts); the agent downloads what is missing
# straight from Google and installs it for all users. Checked at startup
# (before dslrBooth starts, so it sees them) and every hour. Programs that are
# already running only see new fonts once restarted.
$FontsDir = "$env:WINDIR\Fonts"
$FontsRegPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
$FontsStatus = $null

Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue

# TrueType 00010000 / "true", OpenType "OTTO", collection "ttcf"; zip "PK".
function Test-FontHeader {
    param([string]$Path, [switch]$Zip)

    $Bytes = New-Object byte[] 4
    $Stream = [IO.File]::OpenRead($Path)
    try { [void]$Stream.Read($Bytes, 0, 4) } finally { $Stream.Dispose() }
    $Hex = ($Bytes | ForEach-Object { $_.ToString("x2") }) -join ""

    if ($Zip) { return $Hex.StartsWith("504b") }
    return $Hex -in @("00010000", "74727565", "4f54544f", "74746366")
}

function Install-FontFile {
    param([string]$Path, $Registered)

    $Name = [IO.Path]::GetFileName($Path)
    $Target = Join-Path $FontsDir $Name

    Copy-Item -Path $Path -Destination $Target -Force -ErrorAction Stop

    # Registry value name: the font's family name, as Windows does.
    $Family = $null
    try {
        $Collection = New-Object System.Drawing.Text.PrivateFontCollection
        $Collection.AddFontFile($Target)
        $Family = $Collection.Families[0].Name
        $Collection.Dispose()
    }
    catch { }

    if (-not $Family) { $Family = [IO.Path]::GetFileNameWithoutExtension($Name) }
    $Kind = if ($Name -match '\.otf$') { "OpenType" } else { "TrueType" }

    New-ItemProperty -Path $FontsRegPath -Name "$Family ($Kind)" -Value $Name -PropertyType String -Force -ErrorAction Stop | Out-Null
    [void]$Registered.Add($Name.ToLowerInvariant())
    Write-Log "Font installed: $Name ($Family)"
}

function Install-Fonts {

    $Config = Get-AgentConfig
    if (-not $Config) { return }

    $List = Invoke-RestMethod `
        -Uri "$($Config.apiUrl.TrimEnd('/'))/api/fonts" `
        -Headers @{ Authorization = "Bearer $($Config.agentToken)" } `
        -TimeoutSec 30 `
        -UseBasicParsing `
        -ErrorAction Stop

    if (-not (Test-Path $FontsRegPath)) { New-Item -Path $FontsRegPath -Force | Out-Null }

    # Font files already registered for all users (lower-case file names).
    $Registered = New-Object 'System.Collections.Generic.HashSet[string]'
    (Get-ItemProperty -Path $FontsRegPath -ErrorAction SilentlyContinue).PSObject.Properties |
        Where-Object { $_.Name -notlike "PS*" } |
        ForEach-Object { [void]$Registered.Add([IO.Path]::GetFileName("$($_.Value)").ToLowerInvariant()) }

    $Temp = "$AgentDir\fonts-download"
    New-Item -ItemType Directory -Path $Temp -Force | Out-Null

    $Missing = @()
    $Count = 0

    foreach ($Font in @($List.fonts)) {
        try {
            $IsZip = $Font.name -match '\.zip$'

            if (-not $IsZip) {
                $Count++
                $Name = $Font.name

                # Already installed (by us or by hand): nothing to do.
                if ((Test-Path (Join-Path $FontsDir $Name)) -and $Registered.Contains($Name.ToLowerInvariant())) { continue }
            }

            # Zips are only fetched once (remembered by their Drive id).
            if ($IsZip -and (Test-Path "$Temp\$($Font.id).done")) { continue }

            $File = Join-Path $Temp $Font.name
            Invoke-WebRequest -Uri $Font.url -OutFile $File -TimeoutSec 120 -UseBasicParsing -ErrorAction Stop

            if (-not (Test-FontHeader -Path $File -Zip:$IsZip)) {
                throw "not a font file (Google may have returned an error page)"
            }

            if ($IsZip) {
                $Unzipped = Join-Path $Temp $Font.id
                Expand-Archive -Path $File -DestinationPath $Unzipped -Force

                foreach ($Inner in Get-ChildItem -Path $Unzipped -Recurse -File | Where-Object { $_.Name -match '\.(ttf|otf|ttc)$' }) {
                    $Count++
                    if ((Test-Path (Join-Path $FontsDir $Inner.Name)) -and $Registered.Contains($Inner.Name.ToLowerInvariant())) { continue }
                    if (Test-FontHeader -Path $Inner.FullName) { Install-FontFile -Path $Inner.FullName -Registered $Registered }
                }

                Set-Content -Path "$Temp\$($Font.id).done" -Value $Font.name
                Remove-Item $Unzipped -Recurse -Force -ErrorAction SilentlyContinue
            }
            else {
                Install-FontFile -Path $File -Registered $Registered
            }

            Remove-Item $File -Force -ErrorAction SilentlyContinue
        }
        catch {
            $Missing += $Font.name
            Write-Log "Font error ($($Font.name)): $($_.Exception.Message)"
        }
    }

    $script:FontsStatus = [PSCustomObject]@{
        expected  = $Count
        missing   = $Missing
        checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
}

# --------------------------------------------------
# PRINTER DRIVERS
# --------------------------------------------------

# Printer drivers this booth type needs (from booth-config). A missing one is
# installed from its zip, only if the zip's SHA-256 is the expected one and
# the driver catalog signature is valid. Checked at startup and every hour.
$DriversConfigFile = "$AgentDir\drivers-config.json"
$DriversConfig = @()
$DriversStatus = @()

if (Test-Path $DriversConfigFile) {
    # Windows PowerShell 5.1 returns a top-level JSON array as one object:
    # enumerate it explicitly.
    try { $DriversConfig = @((Get-Content $DriversConfigFile -Raw | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { }
}

# Original .inf names of the driver packages in the Windows driver store.
function Get-StoreInfNames {
    $Names = New-Object 'System.Collections.Generic.HashSet[string]'

    foreach ($Line in @(& pnputil.exe /enum-drivers 2>$null)) {
        if ("$Line" -match '([\w.-]+\.inf)\s*$') { [void]$Names.Add($Matches[1].ToLowerInvariant()) }
    }

    return $Names
}

# Two kinds of drivers: "printer" (zip, e.g. DNP DS620: also registered with
# the spooler) and "device" (separate files, e.g. CH341 for the Arduino).
function Install-PrinterDrivers {

    $Results = @()
    $StoreInfs = $null

    foreach ($Driver in @($script:DriversConfig | Where-Object { $_ -and $_.id })) {

        $IsPrinter = $Driver.kind -ne "device" -and $Driver.printerDriverName
        $Name = if ($Driver.printerDriverName) { $Driver.printerDriverName } else { $Driver.name }
        $Result = [ordered]@{ name = $Name; installed = $false; error = $null }

        try {
            if ($IsPrinter) {
                $Installed = [bool](Get-PrinterDriver -Name $Driver.printerDriverName -ErrorAction SilentlyContinue)
            }
            else {
                if (-not $StoreInfs) { $StoreInfs = Get-StoreInfNames }
                $Installed = $StoreInfs.Contains("$($Driver.infName)".ToLowerInvariant())
            }

            if ($Installed) {
                $Result.installed = $true
                $Results += [PSCustomObject]$Result
                continue
            }

            # Driver the agent cannot install (e.g. Citizen CZ-01, unsigned
            # InstallShield setup): only reported, to be installed by hand.
            if ($Driver.kind -eq "check") {
                $Result.manual = $true
                $Results += [PSCustomObject]$Result
                continue
            }

            $Work = "$AgentDir\drivers\$($Driver.id)"
            Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Path $Work -Force | Out-Null

            Write-Log "Driver $Name missing: downloading"

            if ($Driver.files) {
                foreach ($File in @($Driver.files)) {
                    $Path = Join-Path $Work $File.name
                    Invoke-WebRequest -Uri $File.url -OutFile $Path -TimeoutSec 300 -UseBasicParsing -ErrorAction Stop

                    $Hash = (Get-FileHash -Path $Path -Algorithm SHA256).Hash
                    if ($Hash -ne $File.sha256) { throw "$($File.name) fingerprint mismatch ($Hash), refused" }
                }
            }
            else {
                $Zip = "$Work.zip"
                Invoke-WebRequest -Uri $Driver.url -OutFile $Zip -TimeoutSec 600 -UseBasicParsing -ErrorAction Stop

                $Hash = (Get-FileHash -Path $Zip -Algorithm SHA256).Hash
                if ($Hash -ne $Driver.sha256) { throw "zip fingerprint mismatch ($Hash), refused" }

                Expand-Archive -Path $Zip -DestinationPath $Work -Force
                Remove-Item $Zip -Force -ErrorAction SilentlyContinue
            }

            $Inf = Join-Path $Work $Driver.inf
            if (-not (Test-Path $Inf)) { throw "driver file not found: $($Driver.inf)" }

            # Every catalog of the package must be validly signed by the expected signer.
            $Signers = @()
            foreach ($Cat in Get-ChildItem -Path (Split-Path $Inf) -Filter *.cat -File) {
                $Signature = Get-AuthenticodeSignature -FilePath $Cat.FullName
                if ($Signature.Status -ne "Valid" -or $Signature.SignerCertificate.Subject -notmatch [regex]::Escape($Driver.signer)) {
                    throw "invalid signature on $($Cat.Name): $($Signature.Status) $($Signature.SignerCertificate.Subject)"
                }
                $Signers += $Signature.SignerCertificate
            }

            # Non-WHQL vendor drivers make Windows ask "install this device
            # software?", which nobody can answer from session 0 (pnputil then
            # fails with 0xE0000242). Trusting the vendor's verified signing
            # certificate, as "always trust" in that dialog would, avoids it.
            if ($Driver.trustPublisher) {
                $Store = New-Object Security.Cryptography.X509Certificates.X509Store("TrustedPublisher", "LocalMachine")
                $Store.Open("ReadWrite")
                try {
                    foreach ($Cert in $Signers) {
                        if (-not ($Store.Certificates | Where-Object { $_.Thumbprint -eq $Cert.Thumbprint })) {
                            $Store.Add($Cert)
                            Write-Log "Trusted publisher added: $($Cert.Subject.Split(',')[0]) ($($Cert.Thumbprint))"
                        }
                    }
                }
                finally {
                    $Store.Close()
                }
            }

            $Output = & pnputil.exe /add-driver "$Inf" /install 2>&1
            if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) {
                throw "pnputil failed ($LASTEXITCODE): $(($Output | Select-Object -Last 3) -join ' ')"
            }

            # Printer drivers must also be known to the spooler (the queue is
            # then created by Windows when the printer is plugged in).
            if ($IsPrinter) { Add-PrinterDriver -Name $Driver.printerDriverName -ErrorAction Stop }

            $Result.installed = $true
            Write-Log "Driver $Name installed"

            Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
        }
        catch {
            $Result.error = $_.Exception.Message
            Write-Log "Driver $Name error: $($_.Exception.Message)"
        }

        $Results += [PSCustomObject]$Result
    }

    $script:DriversStatus = $Results
}

# --------------------------------------------------
# WELCOME VIDEO
# --------------------------------------------------

# Welcome ("touch to start") video from booth-config, put where the booth
# software looks for it: LumaBooth if installed, dslrBooth otherwise. Kept in
# a local cache so a software update wiping the file is fixed at the next
# power-on without downloading it again. Refused unless the SHA-256 matches.
$StartScreenVideo = $null
$StartScreenStatus = $null
$UsersRoot = Split-Path $env:PUBLIC

function Get-StartScreenTargets {

    # LumaBooth: <Program Files>\<Luma...>\content\VirtualAttendant\Audio - American Female
    # Recent dslrBooth installers also use a "LumaBooth" folder (with
    # dslrBooth.exe in it): only a folder with LumaBooth.exe is LumaBooth.
    $Luma = @(
        foreach ($Root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ -and (Test-Path $_) }) {
            Get-ChildItem -Path $Root -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'luma' -and (Test-Path (Join-Path $_.FullName "LumaBooth.exe")) } |
                ForEach-Object { Join-Path $_.FullName "content\VirtualAttendant\Audio - American Female" } |
                Where-Object { Test-Path $_ }
        }
    )

    if ($Luma.Count -gt 0) {
        return @($Luma | ForEach-Object { [PSCustomObject]@{ app = "LumaBooth"; path = (Join-Path $_ "photoboothparisvideo.mp4") } })
    }

    # dslrBooth: each user profile that has dslrBooth assets. The asset id is
    # the part of the file name before the first "-": keep an existing
    # photoboothparis-*.mp4 name, otherwise use the usual one.
    return @(
        foreach ($UserDir in Get-ChildItem -Path $UsersRoot -Directory -ErrorAction SilentlyContinue) {
            $Assets = Join-Path $UserDir.FullName "AppData\Roaming\dslrBooth\Assets"
            if (-not (Test-Path $Assets)) { continue }

            $Folder = Join-Path $Assets "VirtualAttendant"
            $Existing = Get-ChildItem -Path $Folder -Filter "photoboothparis-*.mp4" -File -ErrorAction SilentlyContinue | Select-Object -First 1
            $Name = if ($Existing) { $Existing.Name } else { "photoboothparis-ONETOUCH 3.0.mp4" }

            [PSCustomObject]@{ app = "dslrBooth"; path = (Join-Path $Folder $Name) }
        }
    )
}

function Install-StartScreenVideo {

    $Video = $script:StartScreenVideo
    if (-not $Video -or -not $Video.url) { return }

    $Targets = @(Get-StartScreenTargets)
    $Results = @()

    if ($Targets.Count -gt 0) {

        $Cache = "$AgentDir\media\startscreen.mp4"
        New-Item -ItemType Directory -Path (Split-Path $Cache) -Force | Out-Null

        $CacheOk = (Test-Path $Cache) -and (Get-FileHash -Path $Cache -Algorithm SHA256).Hash -eq $Video.sha256

        if (-not $CacheOk) {
            Write-Log "Welcome video: downloading"
            Invoke-WebRequest -Uri $Video.url -OutFile "$Cache.new" -TimeoutSec 600 -UseBasicParsing -ErrorAction Stop

            $Hash = (Get-FileHash -Path "$Cache.new" -Algorithm SHA256).Hash
            if ($Hash -ne $Video.sha256) {
                Remove-Item "$Cache.new" -Force -ErrorAction SilentlyContinue
                throw "welcome video fingerprint mismatch ($Hash), refused"
            }

            Move-Item -Path "$Cache.new" -Destination $Cache -Force
        }

        foreach ($Target in $Targets) {
            $Result = [ordered]@{ app = $Target.app; path = $Target.path; ok = $false; error = $null }

            try {
                $Current = Get-Item -Path $Target.path -ErrorAction SilentlyContinue
                $UpToDate = $Current -and $Current.Length -eq $Video.size -and
                    (Get-FileHash -Path $Target.path -Algorithm SHA256).Hash -eq $Video.sha256

                if (-not $UpToDate) {
                    New-Item -ItemType Directory -Path (Split-Path $Target.path) -Force | Out-Null
                    Copy-Item -Path $Cache -Destination $Target.path -Force -ErrorAction Stop
                    Write-Log "Welcome video installed: $($Target.path)"
                }

                $Result.ok = $true
            }
            catch {
                # e.g. file in use because the booth software is playing it
                $Result.error = $_.Exception.Message
                Write-Log "Welcome video error ($($Target.path)): $($_.Exception.Message)"
            }

            $Results += [PSCustomObject]$Result
        }
    }

    $script:StartScreenStatus = [PSCustomObject]@{
        app     = if ($Targets.Count) { $Targets[0].app } else { $null }
        targets = $Results
    }
}

# --------------------------------------------------
# LIGHTS SCRIPT
# --------------------------------------------------

# dslrBooth "trigger application" (from booth-config) that drives the lights
# through the Arduino. Written to the path event_generator configures, with
# the booth's actual Arduino COM port instead of the template's, and rewritten
# as soon as the Arduino shows up on another COM port.
$LightsScript = $null
$LightsTemplate = $null
$LightsStatus = $null

# COM port of the Arduino: a plugged-in board first, otherwise the last one
# Windows remembers (unplugged right now).
function Get-ArduinoCom {
    param($Arduino)

    $Boards = @($Arduino | Where-Object { $_ -and $_.com -and -not $_.driverMissing })
    $Plugged = $Boards | Where-Object { $_.present } | Select-Object -First 1
    if ($Plugged) { return $Plugged.com }

    $Known = $Boards | Select-Object -First 1
    if ($Known) { return $Known.com }

    return $null
}

function Install-LightsScript {
    param($Arduino)

    $Config = $script:LightsScript
    if (-not $Config -or -not $Config.url) { return }

    if (-not $script:LightsTemplate) {
        $Cache = "$AgentDir\media\DSLR_Tiggers.bat"
        New-Item -ItemType Directory -Path (Split-Path $Cache) -Force | Out-Null

        if (-not (Test-Path $Cache) -or (Get-FileHash -Path $Cache -Algorithm SHA256).Hash -ne $Config.sha256) {
            Invoke-WebRequest -Uri $Config.url -OutFile "$Cache.new" -TimeoutSec 60 -UseBasicParsing -ErrorAction Stop

            $Hash = (Get-FileHash -Path "$Cache.new" -Algorithm SHA256).Hash
            if ($Hash -ne $Config.sha256) {
                Remove-Item "$Cache.new" -Force -ErrorAction SilentlyContinue
                throw "lights script fingerprint mismatch ($Hash), refused"
            }

            Move-Item -Path "$Cache.new" -Destination $Cache -Force
        }

        $script:LightsTemplate = [IO.File]::ReadAllText($Cache, (New-Object Text.UTF8Encoding $false))
    }

    $Com = Get-ArduinoCom -Arduino $Arduino
    $Content = $script:LightsTemplate

    # Keep the template's port when no Arduino was ever seen on this PC.
    if ($Com) {
        $Content = [regex]::Replace($Content, '(?im)^(\s*set\s+PORTNUMBER=)COM\d+', "`${1}$Com")
    }

    $Current = $null
    if (Test-Path $Config.path) { $Current = [IO.File]::ReadAllText($Config.path, (New-Object Text.UTF8Encoding $false)) }

    if ($Current -ne $Content) {
        New-Item -ItemType Directory -Path (Split-Path $Config.path) -Force | Out-Null
        [IO.File]::WriteAllText($Config.path, $Content, (New-Object Text.UTF8Encoding $false))
        Write-Log "Lights script written: $($Config.path) (port $(if ($Com) { $Com } else { 'from template' }))"
    }

    $script:LightsStatus = Get-LightsState -Arduino $Arduino
}

# What the lights script on disk really says, read again at every heartbeat
# (someone may have edited or deleted it): com is the port in the file,
# expected the Arduino's, ok when they match.
function Get-LightsState {
    param($Arduino)

    $Config = $script:LightsScript
    if (-not $Config -or -not $Config.path -or -not $script:LightsTemplate) { return $null }

    $Port = $null
    $Missing = -not (Test-Path $Config.path)
    if (-not $Missing) {
        try {
            $Text = [IO.File]::ReadAllText($Config.path)
            $Port = [regex]::Match($Text, '(?im)^\s*set\s+PORTNUMBER=(COM\d+)').Groups[1].Value
        }
        catch { }
    }

    $Expected = Get-ArduinoCom -Arduino $Arduino
    if (-not $Expected) {
        $Expected = [regex]::Match($script:LightsTemplate, '(?im)^\s*set\s+PORTNUMBER=(COM\d+)').Groups[1].Value
    }

    return [PSCustomObject]@{
        path        = $Config.path
        com         = $(if ($Port) { $Port } else { $null })
        expected    = $Expected
        missing     = $Missing
        ok          = (-not $Missing) -and $Port -and ($Port -eq $Expected)
        arduinoSeen = [bool](Get-ArduinoCom -Arduino $Arduino)
    }
}

# --------------------------------------------------
# BOOTH SOFTWARE
# --------------------------------------------------

# dslrBooth / LumaBooth: installed version, how it starts with Windows (Run
# keys, Startup folders, scheduled tasks; "maximized" for a shortcut set to
# open maximized) and its window right now. This agent runs in session 0 and
# cannot see windows: the popup helper, in the user's session, writes the
# window state to $BoothWindowFile every 15 s. Versions and startup entries
# are read at most hourly (cheap enough, but no need every 30 s).
$BoothApps = @("dslrBooth", "LumaBooth")
$BoothWindowFile = "$env:PUBLIC\PhotoboothAgent\booth-window.json"
$SoftwareCache = $null
$SoftwareCacheTime = [datetime]::MinValue

# Explorer's "Startup apps" switch: first byte odd = disabled.
function Test-StartupApproved {
    param([string]$Key, [string]$Name)

    $Value = (Get-ItemProperty -Path $Key -Name $Name -ErrorAction SilentlyContinue).$Name
    if (-not $Value) { return $true }
    return -not ($Value[0] -band 1)
}

function Get-AutostartEntries {
    $Entries = @()
    $Shell = New-Object -ComObject WScript.Shell
    $Approved = "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved"

    # Real users' profiles and, when loaded (logged on), their registry hive.
    $Profiles = @(Get-CimInstance Win32_UserProfile -Filter "Special=False" -ErrorAction SilentlyContinue | ForEach-Object {
        $Hive = "Registry::HKEY_USERS\$($_.SID)"
        [PSCustomObject]@{ user = (Split-Path $_.LocalPath -Leaf); path = $_.LocalPath; hive = $(if (Test-Path $Hive) { $Hive } else { $null }) }
    })

    $RunKeys = @(
        @{ key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; approved = "HKLM:\$Approved\Run"; scope = "all" },
        @{ key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"; approved = "HKLM:\$Approved\Run32"; scope = "all" }
    )
    foreach ($P in $Profiles | Where-Object { $_.hive }) {
        $RunKeys += @{ key = "$($P.hive)\Software\Microsoft\Windows\CurrentVersion\Run"; approved = "$($P.hive)\$Approved\Run"; scope = $P.user }
    }

    foreach ($Run in $RunKeys) {
        $Values = Get-ItemProperty -Path $Run.key -ErrorAction SilentlyContinue
        if (-not $Values) { continue }
        foreach ($V in $Values.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' }) {
            $Entries += [PSCustomObject]@{
                source = "run"; scope = $Run.scope; name = $V.Name; command = "$($V.Value)"
                maximized = $false; enabled = (Test-StartupApproved -Key $Run.approved -Name $V.Name)
            }
        }
    }

    $Folders = @(@{ path = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp"; approved = "HKLM:\$Approved\StartupFolder"; scope = "all" })
    foreach ($P in $Profiles) {
        $Folders += @{ path = "$($P.path)\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"; approved = $(if ($P.hive) { "$($P.hive)\$Approved\StartupFolder" }); scope = $P.user }
    }

    foreach ($Folder in $Folders) {
        foreach ($File in Get-ChildItem -Path $Folder.path -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' }) {
            $Command = $File.FullName
            $Maximized = $false

            if ($File.Extension -eq '.lnk') {
                try {
                    $Link = $Shell.CreateShortcut($File.FullName)
                    $Command = "$($Link.TargetPath) $($Link.Arguments)".Trim()
                    $Maximized = $Link.WindowStyle -eq 3
                }
                catch { }
            }
            elseif ($File.Extension -in @('.bat', '.cmd') -and $File.Length -lt 65536) {
                $Command = "$($File.FullName) : $((Get-Content $File.FullName -Raw -ErrorAction SilentlyContinue) -replace '\s+', ' ')"
            }

            $Entries += [PSCustomObject]@{
                source = "startup"; scope = $Folder.scope; name = $File.Name; command = $Command
                maximized = $Maximized; enabled = $(if ($Folder.approved) { Test-StartupApproved -Key $Folder.approved -Name $File.Name } else { $true })
            }
        }
    }

    foreach ($Task in Get-ScheduledTask -ErrorAction SilentlyContinue) {
        $Command = ($Task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)".Trim() }) -join " ; "
        if ($Command -notmatch ($BoothApps -join '|')) { continue }
        $Entries += [PSCustomObject]@{
            source = "task"; scope = $null; name = "$($Task.TaskPath)$($Task.TaskName)"; command = $Command
            maximized = $false; enabled = ($Task.State -ne 'Disabled')
        }
    }

    return $Entries
}

function Get-BoothSoftware {
    if (-not $script:SoftwareCache -or ((Get-Date) - $script:SoftwareCacheTime).TotalMinutes -ge 60) {
        $Uninstall = @(Get-ItemProperty -Path @(
            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
            "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
            "Registry::HKEY_USERS\*\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
        ) -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName })

        $Autostart = @()
        try { $Autostart = @(Get-AutostartEntries) } catch { Write-Log "Autostart check error: $($_.Exception.Message)" }

        $script:SoftwareCache = @{ uninstall = $Uninstall; autostart = $Autostart }
        $script:SoftwareCacheTime = Get-Date
    }

    $Windows = $null
    try {
        $W = Get-Content $BoothWindowFile -Raw -ErrorAction Stop | ConvertFrom-Json
        if (((Get-Date).ToUniversalTime() - ([datetime]$W.at).ToUniversalTime()).TotalSeconds -lt 120) { $Windows = @($W.windows) }
    }
    catch { }

    $Result = @()
    foreach ($App in $BoothApps) {
        $Entry = $script:SoftwareCache.uninstall | Where-Object { $_.DisplayName -match "^$App" } | Select-Object -First 1
        $Proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "^$App" } | Select-Object -First 1
        if (-not $Entry -and -not $Proc) { continue }

        $Version = if ($Entry) { "$($Entry.DisplayVersion)" } elseif ($Proc.Path) { (Get-Item $Proc.Path).VersionInfo.FileVersion }
        $Window = $Windows | Where-Object { $_.app -eq $App } | Select-Object -First 1

        $Result += [PSCustomObject]@{
            app         = $App
            version     = $Version
            running     = [bool]$Proc
            startedAt   = $(if ($Proc) { try { $Proc.StartTime.ToUniversalTime().ToString("o") } catch { $null } } else { $null })
            autostart   = @($script:SoftwareCache.autostart | Where-Object { "$($_.name) $($_.command)" -match $App })
            # fullscreen / maximized / normal / minimized; null when the popup helper cannot tell
            window      = $(if ($Window) { $Window.state } else { $null })
        }
    }

    return ,$Result
}

# --------------------------------------------------
# PROGRAMS TO INSTALL
# --------------------------------------------------

# Programs booth-config asks for (kiosk booths only, e.g. Notepad++): when no
# uninstall entry matches "detect", the official installer is downloaded,
# checked against its SHA-256 and run silently. Once per power-on.
$InstallPrograms = @()
$InstallStatus = $null

function Install-Programs {
    $Installed = @(Get-ItemProperty -Path @(
            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
            "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
        ) -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object { "$($_.DisplayName)" })

    $Results = @()
    foreach ($Program in @($script:InstallPrograms | Where-Object { $_ -and $_.id })) {
        $Result = [ordered]@{ name = $Program.name; installed = $false; error = $null }

        try {
            if ($Installed | Where-Object { $_ -match $Program.detect }) {
                $Result.installed = $true
                $Results += [PSCustomObject]$Result
                continue
            }

            $Dir = "$AgentDir\software"
            New-Item -ItemType Directory -Path $Dir -Force | Out-Null
            $Setup = Join-Path $Dir "$($Program.id).exe"

            Write-Log "$($Program.name) missing: downloading"
            Invoke-WebRequest -Uri $Program.url -OutFile $Setup -TimeoutSec 600 -UseBasicParsing -ErrorAction Stop

            $Hash = (Get-FileHash -Path $Setup -Algorithm SHA256).Hash
            if ($Hash -ne $Program.sha256) {
                Remove-Item $Setup -Force -ErrorAction SilentlyContinue
                throw "installer fingerprint mismatch ($Hash), refused"
            }

            # WaitForExit, not Start-Process -Wait (which also waits for any
            # program the installer leaves running).
            $Process = Start-Process -FilePath $Setup -ArgumentList $Program.args -PassThru -WindowStyle Hidden
            if (-not $Process.WaitForExit(300000)) { throw "installer still running after 5 min" }
            Remove-Item $Setup -Force -ErrorAction SilentlyContinue

            $Now = @(Get-ItemProperty -Path @(
                    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
                    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
                ) -ErrorAction SilentlyContinue | Where-Object { "$($_.DisplayName)" -match $Program.detect })
            if (-not $Now) { throw "installer exited with code $($Process.ExitCode) but $($Program.name) is not installed" }

            $Result.installed = $true
            Write-Log "$($Program.name) installed"
        }
        catch {
            $Result.error = $_.Exception.Message
            Write-Log "$($Program.name) install error: $($_.Exception.Message)"
        }

        $Results += [PSCustomObject]$Result
    }

    $script:InstallStatus = $Results
}

# --------------------------------------------------
# INVENTORY
# --------------------------------------------------

# Installed programs (uninstall entries) and Windows apps (Appx, installed and
# provisioned for new users), sent once per power-on to /api/inventory: too
# big for the 30 s heartbeat. Used to decide what to remove from the booths.
function Get-Inventory {
    $Programs = @(Get-ItemProperty -Path @(
            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
            "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
            "Registry::HKEY_USERS\*\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
        ) -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
        ForEach-Object {
            [PSCustomObject]@{
                name      = "$($_.DisplayName)"
                version   = "$($_.DisplayVersion)"
                publisher = "$($_.Publisher)"
                scope     = $(if ($_.PSPath -match 'HKEY_USERS') { "user" } else { "machine" })
            }
        } | Sort-Object name, version -Unique)

    $Apps = @()
    $Provisioned = @()
    $Errors = @()

    try { $Apps = @(Get-AppxPackage -AllUsers -ErrorAction Stop |
        Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage } |
        ForEach-Object {
            [PSCustomObject]@{
                name         = $_.Name
                version      = "$($_.Version)"
                signature    = "$($_.SignatureKind)"
                nonRemovable = [bool]$_.NonRemovable
            }
        } | Sort-Object name -Unique) }
    catch { $Errors += "apps: $($_.Exception.Message)" }

    try { $Provisioned = @(Get-AppxProvisionedPackage -Online -ErrorAction Stop | ForEach-Object { $_.DisplayName } | Sort-Object -Unique) }
    catch { $Errors += "provisioned: $($_.Exception.Message)" }

    return [PSCustomObject]@{
        boothId     = $BoothId
        at          = (Get-Date).ToUniversalTime().ToString("o")
        windows     = "$((Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption) $([Environment]::OSVersion.Version)"
        programs    = $Programs
        apps        = $Apps
        provisioned = $Provisioned
        errors      = $Errors
    }
}

function Send-Inventory {
    $Config = Get-AgentConfig
    if (-not $Config) { return }

    $Json = Get-Inventory | ConvertTo-Json -Depth 4 -Compress

    Invoke-RestMethod `
        -Uri "$($Config.apiUrl.TrimEnd('/'))/api/inventory" `
        -Method Post `
        -Headers @{ Authorization = "Bearer $($Config.agentToken)" } `
        -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($Json)) `
        -TimeoutSec 60 `
        -UseBasicParsing `
        -ErrorAction Stop | Out-Null

    Write-Log "Inventory sent ($([int]($Json.Length / 1024)) KB)"
}

# --------------------------------------------------
# KIOSK SETTINGS
# --------------------------------------------------

# Booths (not the mother station: booth-config says "kiosk") must never
# sleep, lock, show a screensaver, notifications or Windows tips, nor restart
# for updates while logged on, and their booth software must start maximized.
# Applied at power-on (idempotent), the result is reported in "kiosk".
$Kiosk = $false
$KioskStatus = $null

# Runs $Action on the registry hive (Registry::HKEY_USERS\...) of each real
# user profile, loading the hive of users who are not logged on.
function Invoke-OnUserHives {
    param([scriptblock]$Action)

    foreach ($P in Get-CimInstance Win32_UserProfile -Filter "Special=False" -ErrorAction SilentlyContinue) {
        $Hive = "Registry::HKEY_USERS\$($P.SID)"
        $Loaded = $false

        if (-not (Test-Path $Hive)) {
            $Dat = Join-Path $P.LocalPath "NTUSER.DAT"
            if (-not (Test-Path $Dat)) { continue }
            & reg.exe load "HKU\PhotoboothAgentTmp" "$Dat" 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { continue }
            $Hive = "Registry::HKEY_USERS\PhotoboothAgentTmp"
            $Loaded = $true
        }

        try { & $Action $Hive }
        finally {
            if ($Loaded) {
                [GC]::Collect(); [GC]::WaitForPendingFinalizers()
                & reg.exe unload "HKU\PhotoboothAgentTmp" 2>$null | Out-Null
            }
        }
    }
}

function Set-RegistryValue {
    param([string]$Path, [string]$Name, $Value, [string]$Type = "DWord")

    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

function Set-KioskSettings {
    $Errors = @()
    $Done = @()

    # Never sleep, hibernate or turn the screen off; no sign-in on wake-up.
    try {
        foreach ($Setting in @("standby-timeout", "hibernate-timeout", "monitor-timeout")) {
            foreach ($Power in @("ac", "dc")) {
                & powercfg.exe /change "$Setting-$Power" 0 | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "powercfg $Setting-$Power failed" }
            }
        }
        & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 | Out-Null
        & powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 | Out-Null
        & powercfg.exe /setactive SCHEME_CURRENT | Out-Null
        $Done += "power"
    }
    catch { $Errors += "power: $($_.Exception.Message)" }

    # No automatic restart for updates while someone is logged on.
    try {
        Set-RegistryValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Name "NoAutoRebootWithLoggedOnUsers" -Value 1
        $Done += "updates"
    }
    catch { $Errors += "updates: $($_.Exception.Message)" }

    # Per user: screensaver off (also as a policy, so it stays off),
    # notifications and Windows tips/suggestions off.
    try {
        Invoke-OnUserHives -Action {
            param($Hive)
            Set-RegistryValue -Path "$Hive\Control Panel\Desktop" -Name "ScreenSaveActive" -Value "0" -Type String
            Set-RegistryValue -Path "$Hive\Software\Policies\Microsoft\Windows\Control Panel\Desktop" -Name "ScreenSaveActive" -Value "0" -Type String
            Set-RegistryValue -Path "$Hive\Software\Policies\Microsoft\Windows\Control Panel\Desktop" -Name "ScreenSaverIsSecure" -Value "0" -Type String
            Set-RegistryValue -Path "$Hive\Software\Microsoft\Windows\CurrentVersion\PushNotifications" -Name "ToastEnabled" -Value 0
            $Cdm = "$Hive\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager"
            foreach ($Name in @("SoftLandingEnabled", "SystemPaneSuggestionsEnabled", "SubscribedContent-338389Enabled", "SubscribedContent-310093Enabled", "SubscribedContent-338388Enabled")) {
                Set-RegistryValue -Path $Cdm -Name $Name -Value 0
            }
            Set-RegistryValue -Path "$Hive\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement" -Name "ScoobeSystemSettingEnabled" -Value 0
        }
        $Done += "users"
    }
    catch { $Errors += "users: $($_.Exception.Message)" }

    # Booth software started maximized from the Startup folders.
    $Fixed = 0
    try {
        $Shell = New-Object -ComObject WScript.Shell
        $Folders = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp") +
            @(Get-CimInstance Win32_UserProfile -Filter "Special=False" -ErrorAction SilentlyContinue |
                ForEach-Object { "$($_.LocalPath)\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup" })

        foreach ($Link in Get-ChildItem -Path $Folders -Filter "*.lnk" -File -ErrorAction SilentlyContinue) {
            $Shortcut = $Shell.CreateShortcut($Link.FullName)
            if ("$($Link.Name) $($Shortcut.TargetPath)" -notmatch ($BoothApps -join '|')) { continue }
            if ($Shortcut.WindowStyle -eq 3) { continue }

            $Shortcut.WindowStyle = 3
            $Shortcut.Save()
            $Fixed++
            Write-Log "Startup shortcut set to maximized: $($Link.FullName)"
        }
        $Done += "shortcuts"
    }
    catch { $Errors += "shortcuts: $($_.Exception.Message)" }

    # Reported only: automatic sign-in at power-on.
    $Winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction SilentlyContinue
    $AutoLogon = if ("$($Winlogon.AutoAdminLogon)" -eq "1" -and $Winlogon.DefaultUserName) { "$($Winlogon.DefaultUserName)" } else { $null }

    # Show the new shortcut state on the dashboard right away.
    $script:SoftwareCache = $null

    $script:KioskStatus = [PSCustomObject]@{
        appliedAt         = (Get-Date).ToUniversalTime().ToString("o")
        done              = $Done
        errors            = $Errors
        shortcutsFixed    = $Fixed
        autoLogon         = $AutoLogon
    }
    Write-Log "Kiosk settings applied ($($Done -join ', '))$(if ($Errors) { " errors: $($Errors -join ' | ')" })"
}

# --------------------------------------------------
# SELF-UPDATE
# --------------------------------------------------

# Every $UpdateCheckInterval seconds, compare VERSION on GitHub main with ours.
# Files are fetched at the exact commit SHA so VERSION and agent.ps1 always
# come from the same push (raw.githubusercontent.com caches each URL for ~5 min).
$LastCheckedSha = $null
$NextUpdateCheck = Get-Date

# Heartbeat round-trip (ms) and consecutive failures, reported in "network".
$LastHeartbeatMs = $null
$FailedHeartbeats = 0

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

    # agent.ps1 and the popup helper ship together; both must download and
    # parse before either replaces a working file.
    $Files = @("agent.ps1", "popup.ps1")

    foreach ($File in $Files) {

        $New = "$AgentDir\$File.new"

        Invoke-WebRequest `
            -Uri "$RawUrl/agent/$File" `
            -OutFile $New `
            -TimeoutSec 30 `
            -UseBasicParsing `
            -ErrorAction Stop

        $ParseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($New, [ref]$null, [ref]$ParseErrors) | Out-Null

        if ($ParseErrors -or (Get-Item $New).Length -lt 1024) {
            $Files | ForEach-Object { Remove-Item "$AgentDir\$_.new" -Force -ErrorAction SilentlyContinue }
            throw "Downloaded $File is invalid, update skipped"
        }
    }

    foreach ($File in $Files) {
        Move-Item -Path "$AgentDir\$File.new" -Destination "$AgentDir\$File" -Force -ErrorAction Stop
    }

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

try {
    if (Test-NewBoot) {
        Clear-OldPrintJobs -Reason "Windows startup"
    }
}
catch {
    Write-Log "Startup purge error: $($_.Exception.Message)"
}

try {
    Install-PopupHelper
}
catch {
    Write-Log "Popup helper setup error: $($_.Exception.Message)"
}

# Booth setup (config, printer drivers, fonts) runs once per power-on, right
# after the first heartbeat, and is retried every 5 min only while the
# dashboard or Drive cannot be reached. A booth without a type in the
# dashboard keeps checking its config hourly, to pick it up once it is set.
$BoothType = $null
$SetupDone = @{ config = $false; drivers = $false; fonts = $false; video = $false; lights = $false; kiosk = $false; installs = $false; inventory = $false }
$NextLightsFix = Get-Date
$NextSetupTry = Get-Date
$NextUntypedCheck = Get-Date

# With Fast Startup, "Shut down" hibernates the system and this process just
# resumes later: a long gap between two loop turns means the PC was off/asleep.
$LastLoopTime = Get-Date

# --------------------------------------------------
# HEARTBEAT LOOP
# --------------------------------------------------

while ($true) {

    $Gap = ((Get-Date) - $LastLoopTime).TotalMinutes
    $LastLoopTime = Get-Date

    if ($Gap -gt 10) {
        $SetupDone = @{ config = $false; drivers = $false; fonts = $false; video = $false; lights = $false; kiosk = $false; installs = $false; inventory = $false }
        $NextSetupTry = Get-Date

        try {
            Clear-OldPrintJobs -Reason "resumed after $([int]$Gap) min off/asleep"
        }
        catch {
            Write-Log "Resume purge error: $($_.Exception.Message)"
        }
    }

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

        # Round-trip time and failures are reported with the next heartbeat.
        $Stopwatch = [Diagnostics.Stopwatch]::StartNew()

        try {

            $Result = Send-Heartbeat -Json $StatusJson

            if ($Result -eq "sent") {
                $LastHeartbeatMs = [int]$Stopwatch.ElapsedMilliseconds
                $FailedHeartbeats = 0
            }

            Write-Log "Remote heartbeat $Result"

        }
        catch {

            $FailedHeartbeats++
            Write-Log "Remote heartbeat error: $($_.Exception.Message)"

        }
    }

    if (-not ($SetupDone.config -and $SetupDone.drivers -and $SetupDone.fonts -and $SetupDone.video -and $SetupDone.lights -and $SetupDone.kiosk -and $SetupDone.installs -and $SetupDone.inventory) -and (Get-Date) -ge $NextSetupTry) {

        $NextSetupTry = (Get-Date).AddMinutes(5)

        if (-not $SetupDone.config) {
            try { Update-BoothConfig; $SetupDone.config = $true }
            catch { Write-Log "Booth config error: $($_.Exception.Message)" }
        }

        # Per-driver / per-font problems are reported, not retried in a loop:
        # only an unreachable dashboard or Drive (exception) is retried.
        if ($SetupDone.config -and -not $SetupDone.drivers) {
            try { Install-PrinterDrivers; $SetupDone.drivers = $true }
            catch { Write-Log "Drivers error: $($_.Exception.Message)" }
        }

        if (-not $SetupDone.fonts) {
            try { Install-Fonts; $SetupDone.fonts = $true }
            catch { Write-Log "Fonts error: $($_.Exception.Message)" }
        }

        if ($SetupDone.config -and -not $SetupDone.video) {
            try { Install-StartScreenVideo; $SetupDone.video = $true }
            catch { Write-Log "Welcome video error: $($_.Exception.Message)" }
        }

        # Local settings only: never retried, whatever happens.
        if ($SetupDone.config -and -not $SetupDone.kiosk) {
            if ($Kiosk) {
                try { Set-KioskSettings }
                catch { Write-Log "Kiosk settings error: $($_.Exception.Message)" }
            }
            $SetupDone.kiosk = $true
        }

        # Per-program problems are reported, not retried.
        if ($SetupDone.config -and -not $SetupDone.installs) {
            try { Install-Programs; $SetupDone.installs = $true }
            catch { Write-Log "Programs install error: $($_.Exception.Message)" }
        }

        # After the kiosk step and installs, so that the list is up to date.
        if ($SetupDone.config -and $SetupDone.kiosk -and $SetupDone.installs -and -not $SetupDone.inventory) {
            try { Send-Inventory; $SetupDone.inventory = $true }
            catch { Write-Log "Inventory error: $($_.Exception.Message)" }
        }

        if ($SetupDone.config -and -not $SetupDone.lights) {
            try { Install-LightsScript -Arduino $Status.arduino; $SetupDone.lights = $true }
            catch { Write-Log "Lights script error: $($_.Exception.Message)" }
        }

        if ($SetupDone.config -and $SetupDone.drivers -and $SetupDone.fonts -and $SetupDone.video -and $SetupDone.lights -and $SetupDone.kiosk -and $SetupDone.installs -and $SetupDone.inventory) {
            Write-Log "Booth setup done (type: $BoothType)"
            $NextUntypedCheck = (Get-Date).AddSeconds($BoothConfigInterval)
        }
    }

    if ($SetupDone.config -and -not $BoothType -and (Get-Date) -ge $NextUntypedCheck) {

        $NextUntypedCheck = (Get-Date).AddSeconds($BoothConfigInterval)

        try {
            Update-BoothConfig
            if ($BoothType) { Install-PrinterDrivers }
        }
        catch {
            Write-Log "Booth config error: $($_.Exception.Message)"
        }
    }

    # Lights script edited, deleted or Arduino moved to another port: rewrite it
    # (at most once a minute if the write keeps failing).
    if ($SetupDone.lights -and $Status -and $Status.lights -and -not $Status.lights.ok -and (Get-Date) -ge $NextLightsFix) {
        $NextLightsFix = (Get-Date).AddMinutes(1)
        try { Install-LightsScript -Arduino $Status.arduino }
        catch { Write-Log "Lights script error: $($_.Exception.Message)" }
    }

    try {
        if ($Status) { Update-PrinterAlert -Status $Status }
    }
    catch {
        Write-Log "Paper alert error: $($_.Exception.Message)"
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