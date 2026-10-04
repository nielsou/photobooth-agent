$ErrorActionPreference = "Continue"

$AgentDir = "C:\ProgramData\PhotoboothAgent"
$LogFile  = "$AgentDir\logs\agent.log"

$BoothId = $env:COMPUTERNAME
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

function Write-Log {
    param([string]$Message)

    $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Add-Content -Path $LogFile -Value $Line
}

Write-Log "========================================"
Write-Log "Photobooth Agent started"
Write-Log "Booth ID: $BoothId"
Write-Log "Computer name: $env:COMPUTERNAME"
Write-Log "PowerShell: $($PSVersionTable.PSVersion)"

# Check Internet connectivity
$Internet = Test-NetConnection "www.google.com" -Port 443 -InformationLevel Quiet

if ($Internet) {
    Write-Log "Internet: ONLINE"
}
else {
    Write-Log "Internet: OFFLINE"
}

Write-Log "Agent finished"