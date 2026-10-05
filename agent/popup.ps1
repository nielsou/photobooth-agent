# Photobooth Agent - popup helper
#
# Runs in the logged-on user's session (the agent runs as SYSTEM in session 0
# and cannot show windows). Watches alert.json written by the agent and shows
# a fullscreen, always-on-top popup over dslrBooth while the printer is out of
# paper. "OK" hides it for snoozeMinutes; it goes away by itself once the agent
# removes alert.json. Started at logon by the "Photobooth Agent Popup" task.

param(
    [string]$AgentDir = "C:\ProgramData\PhotoboothAgent"
)

$ErrorActionPreference = "Continue"
$AlertFile = "$AgentDir\alert.json"

# One helper per session.
$CreatedNew = $false
$Mutex = New-Object System.Threading.Mutex($true, "Local\PhotoboothAgentPopup", [ref]$CreatedNew)
if (-not $CreatedNew) { exit }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

[xml]$Xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="#99000000"
        Topmost="True" WindowState="Maximized" ShowInTaskbar="False" ResizeMode="NoResize"
        FontFamily="Segoe UI" ShowActivated="True">
  <Border Background="White" CornerRadius="20" Padding="44,40" MaxWidth="1100"
          HorizontalAlignment="Center" VerticalAlignment="Center">
    <Grid>
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <StackPanel Grid.Column="0" Margin="0,0,44,0" VerticalAlignment="Center">
        <Border Background="#FAEEDA" CornerRadius="8" Padding="12,5" HorizontalAlignment="Left" Margin="0,0,0,18">
          <TextBlock x:Name="BadgeText" Foreground="#854F0B" FontSize="18"/>
        </Border>
        <TextBlock x:Name="TitleText" FontSize="40" FontWeight="SemiBold" Foreground="#1B1F24" Margin="0,0,0,12"/>
        <TextBlock x:Name="MessageText" FontSize="26" Foreground="#1B1F24" TextWrapping="Wrap" Margin="0,0,0,12"/>
        <TextBlock x:Name="DetailText" FontSize="20" Foreground="#5F5E5A" TextWrapping="Wrap" Margin="0,0,0,28"/>
        <Button x:Name="OkButton" Content="OK" FontSize="24" Padding="56,12" HorizontalAlignment="Left"
                Background="#2F5BEA" Foreground="White" BorderThickness="0" Cursor="Hand"/>
      </StackPanel>
      <StackPanel Grid.Column="1" VerticalAlignment="Center">
        <Image x:Name="QrImage" Width="240" Height="240" RenderOptions.BitmapScalingMode="NearestNeighbor"/>
        <TextBlock x:Name="QrCaptionText" FontSize="16" Foreground="#888780" TextAlignment="Center"
                   TextWrapping="Wrap" MaxWidth="240" Margin="0,10,0,0"/>
      </StackPanel>
    </Grid>
  </Border>
</Window>
"@

$Window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $Xaml))

$State = @{
    SnoozedUntil = [datetime]::MinValue
    SnoozeMinutes = 5
    ShownSince = $null
    ScriptTime = (Get-Item $PSCommandPath).LastWriteTimeUtc
}

function Show-Alert {
    param($Alert)

    $Window.FindName("BadgeText").Text = $Alert.badge
    $Window.FindName("TitleText").Text = $Alert.title
    $Window.FindName("MessageText").Text = $Alert.message
    $Window.FindName("DetailText").Text = $Alert.detail
    $Window.FindName("QrCaptionText").Text = $Alert.qrCaption

    $QrPath = "$AgentDir\$($Alert.qrFile)"
    if ($Alert.qrFile -and (Test-Path $QrPath)) {
        # OnLoad + IgnoreImageCache: read the file now and do not lock it.
        $Bitmap = New-Object Windows.Media.Imaging.BitmapImage
        $Bitmap.BeginInit()
        $Bitmap.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $Bitmap.CreateOptions = [Windows.Media.Imaging.BitmapCreateOptions]::IgnoreImageCache
        $Bitmap.UriSource = New-Object Uri $QrPath
        $Bitmap.EndInit()
        $Window.FindName("QrImage").Source = $Bitmap
    }

    if ($Alert.snoozeMinutes) { $State.SnoozeMinutes = [int]$Alert.snoozeMinutes }

    $Window.Show()
    $Window.Activate() | Out-Null
}

$Window.FindName("OkButton").Add_Click({
    $State.SnoozedUntil = (Get-Date).AddMinutes($State.SnoozeMinutes)
    $Window.Hide()
})

# Alt+F4 behaves like OK (a closed WPF window could not be shown again).
$Window.Add_Closing({
    $_.Cancel = $true
    $State.SnoozedUntil = (Get-Date).AddMinutes($State.SnoozeMinutes)
    $Window.Hide()
})

$Timer = New-Object Windows.Threading.DispatcherTimer
$Timer.Interval = [TimeSpan]::FromSeconds(3)
$Timer.Add_Tick({
    try {
        # Updated by the agent's self-update: restart on the new version.
        if ((Get-Item $PSCommandPath).LastWriteTimeUtc -ne $State.ScriptTime) {
            $Mutex.ReleaseMutex()
            Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -AgentDir `"$AgentDir`""
            $Window.Dispatcher.InvokeShutdown()
            return
        }

        $Alert = $null
        if (Test-Path $AlertFile) {
            $Alert = Get-Content -Path $AlertFile -Raw -ErrorAction Stop | ConvertFrom-Json
        }

        if (-not $Alert) {
            # Paper is back: hide and forget any snooze.
            $State.SnoozedUntil = [datetime]::MinValue
            if ($Window.IsVisible) { $Window.Hide() }
            return
        }

        if ($Window.IsVisible) {
            # Stay in front of dslrBooth, which may grab the foreground.
            $Window.Topmost = $false
            $Window.Topmost = $true
        }
        elseif ((Get-Date) -ge $State.SnoozedUntil) {
            Show-Alert -Alert $Alert
        }
    }
    catch {
        # Alert file being rewritten: try again on the next tick.
    }
})
$Timer.Start()

[Windows.Threading.Dispatcher]::Run()
