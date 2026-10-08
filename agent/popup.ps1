# Photobooth Agent - popup helper
#
# Runs in the logged-on user's session (the agent runs as SYSTEM in session 0
# and cannot show windows). Watches alert.json written by the agent and shows
# a fullscreen, always-on-top popup over dslrBooth while the printer has a
# problem. "OK" minimizes it to a floating "!" badge (tap to reopen); both go
# away by themselves once the agent removes alert.json. Started at logon by the "Photobooth Agent Popup" task.

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
        <TextBlock x:Name="DetailText" FontSize="20" Foreground="#5F5E5A" TextWrapping="Wrap" Margin="0,0,0,14"/>
        <TextBlock x:Name="InfoText" FontSize="15" Foreground="#888780" TextWrapping="Wrap" Margin="0,0,0,26"/>
        <Button x:Name="OkButton" Content="OK" FontSize="24" Padding="56,12" HorizontalAlignment="Left"
                Background="#2F5BEA" Foreground="White" BorderThickness="0" Cursor="Hand"/>
      </StackPanel>
      <StackPanel x:Name="QrPanel" Grid.Column="1" VerticalAlignment="Center">
        <Image x:Name="QrImage" Width="240" Height="240" RenderOptions.BitmapScalingMode="NearestNeighbor"/>
        <TextBlock x:Name="QrCaptionText" FontSize="16" Foreground="#888780" TextAlignment="Center"
                   TextWrapping="Wrap" MaxWidth="240" Margin="0,10,0,0"/>
      </StackPanel>
    </Grid>
  </Border>
</Window>
"@

$Window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $Xaml))

# Minimized form: a round "!" floating bottom-right, in front of dslrBooth.
# Tapping it opens the popup again.
[xml]$BadgeXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize" ShowActivated="False"
        Width="120" Height="120">
  <Button x:Name="ReopenButton" Cursor="Hand" AutomationProperties.Name="Show printer problem"
          RenderTransformOrigin="0.5,0.5">
    <Button.RenderTransform>
      <ScaleTransform x:Name="Pulse" ScaleX="0.86" ScaleY="0.86"/>
    </Button.RenderTransform>
    <Button.Triggers>
      <EventTrigger RoutedEvent="FrameworkElement.Loaded">
        <BeginStoryboard>
          <Storyboard RepeatBehavior="Forever" AutoReverse="True">
            <DoubleAnimation Storyboard.TargetName="Pulse" Storyboard.TargetProperty="ScaleX" To="1" Duration="0:0:0.75"/>
            <DoubleAnimation Storyboard.TargetName="Pulse" Storyboard.TargetProperty="ScaleY" To="1" Duration="0:0:0.75"/>
          </Storyboard>
        </BeginStoryboard>
      </EventTrigger>
    </Button.Triggers>
    <Button.Template>
      <ControlTemplate TargetType="Button">
        <Grid>
          <Ellipse Fill="#1B1F24"/>
          <Ellipse Fill="White" Margin="7"/>
          <Ellipse Fill="#F2A30F" Margin="12"/>
          <TextBlock Text="!" Foreground="#1B1F24" FontFamily="Segoe UI" FontSize="62" FontWeight="Black"
                     HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,-8,0,0"/>
        </Grid>
      </ControlTemplate>
    </Button.Template>
  </Button>
</Window>
"@

$Badge = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $BadgeXaml))

$State = @{
    ShownKey = $null
    Minimized = $false
    ScriptTime = (Get-Item $PSCommandPath).LastWriteTimeUtc
    # Booth software launches (process ids) already maximized once.
    MaximizedPids = @{}
}

function Show-Badge {
    $Area = [System.Windows.SystemParameters]::WorkArea
    $Badge.Left = $Area.Right - $Badge.Width - 28
    $Badge.Top = $Area.Bottom - $Badge.Height - 28
    $Badge.Show()
}

function Show-Alert {
    param($Alert)

    $Window.FindName("BadgeText").Text = $Alert.badge
    $Window.FindName("TitleText").Text = $Alert.title
    $Window.FindName("MessageText").Text = $Alert.message
    $Window.FindName("DetailText").Text = $Alert.detail
    $Window.FindName("QrCaptionText").Text = $Alert.qrCaption

    # Booth / printer / error code, read out by the client when calling support.
    $Info = $Window.FindName("InfoText")
    $Info.Text = "$($Alert.info)"
    $Info.Visibility = if ($Alert.info) { "Visible" } else { "Collapsed" }

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
        $Window.FindName("QrPanel").Visibility = "Visible"
    }
    else {
        # Alert without a procedure video (open cover, other printer errors).
        $Window.FindName("QrPanel").Visibility = "Collapsed"
    }

    $State.ShownKey = "$($Alert.id)|$($Alert.since)"
    $State.Minimized = $false

    $Badge.Hide()
    $Window.Show()
    $Window.Activate() | Out-Null
}

function Hide-All {
    $State.ShownKey = $null
    $State.Minimized = $false
    if ($Window.IsVisible) { $Window.Hide() }
    if ($Badge.IsVisible) { $Badge.Hide() }
}

# OK: minimize to the "!" badge until the problem is solved.
function Minimize-Alert {
    $State.Minimized = $true
    $Window.Hide()
    Show-Badge
}

# dslrBooth / LumaBooth window state for the dashboard: the agent runs in
# session 0 and cannot see this session's windows, so tell it (every 3 s).
# Once per launch of the booth software, if its window opens "windowed" during
# its first minute, it is maximized (it ignores the shortcut's "Maximized").
# Never again for that launch: the operator must be able to resize it.
$BoothWindowFile = "$env:PUBLIC\PhotoboothAgent\booth-window.json"

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class BoothWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public int Flags; }
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    public static void Maximize(IntPtr h) { ShowWindow(h, 3); }
    public static string State(IntPtr h) {
        if (h == IntPtr.Zero || !IsWindowVisible(h)) return "hidden";
        if (IsIconic(h)) return "minimized";
        RECT r; GetWindowRect(h, out r);
        MONITORINFO mi = new MONITORINFO(); mi.Size = Marshal.SizeOf(mi);
        GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
        bool caption = (GetWindowLong(h, -16) & 0x00C00000) == 0x00C00000;
        if (!caption && r.L <= mi.Monitor.L && r.T <= mi.Monitor.T && r.R >= mi.Monitor.R && r.B >= mi.Monitor.B) return "fullscreen";
        if (IsZoomed(h)) return "maximized";
        return "normal";
    }
}
"@

function Save-BoothWindow {
    $Apps = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match '^(dslrBooth|LumaBooth)' -and $_.MainWindowHandle -ne 0 } |
        ForEach-Object {
            $WindowState = [BoothWindow]::State($_.MainWindowHandle)

            $Age = try { ((Get-Date) - $_.StartTime).TotalSeconds } catch { 999 }
            if ($WindowState -eq "normal" -and $Age -lt 60 -and -not $State.MaximizedPids.ContainsKey($_.Id)) {
                $State.MaximizedPids[$_.Id] = $true
                [BoothWindow]::Maximize($_.MainWindowHandle)
                $WindowState = [BoothWindow]::State($_.MainWindowHandle)
            }

            [PSCustomObject]@{
                app   = $(if ($_.ProcessName -match '^dslrBooth') { "dslrBooth" } else { "LumaBooth" })
                state = $WindowState
            }
        })

    New-Item -ItemType Directory -Path (Split-Path $BoothWindowFile) -Force | Out-Null
    [PSCustomObject]@{ at = (Get-Date).ToUniversalTime().ToString("o"); user = $env:USERNAME; windows = $Apps } |
        ConvertTo-Json -Depth 3 | Set-Content -Path $BoothWindowFile -Encoding UTF8
}

$WindowTimer = New-Object Windows.Threading.DispatcherTimer
$WindowTimer.Interval = [TimeSpan]::FromSeconds(3)
$WindowTimer.Add_Tick({ try { Save-BoothWindow } catch { } })
$WindowTimer.Start()
try { Save-BoothWindow } catch { }

$Window.FindName("OkButton").Add_Click({ Minimize-Alert })

# Alt+F4 behaves like OK (a closed WPF window could not be shown again).
$Window.Add_Closing({ $_.Cancel = $true; Minimize-Alert })
$Badge.Add_Closing({ $_.Cancel = $true })

$Badge.FindName("ReopenButton").Add_Click({
    $State.Minimized = $false
    $Badge.Hide()
    $Window.Show()
    $Window.Activate() | Out-Null
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

        # Printer is fine again: popup and badge go away.
        if (-not $Alert) {
            Hide-All
            return
        }

        # A new problem (e.g. paper end -> jam): full popup, even if minimized.
        if ("$($Alert.id)|$($Alert.since)" -ne $State.ShownKey) {
            Show-Alert -Alert $Alert
            return
        }

        # Stay in front of dslrBooth, which may grab the foreground.
        if ($State.Minimized) {
            if (-not $Badge.IsVisible) { Show-Badge }
            $Badge.Topmost = $false
            $Badge.Topmost = $true
        }
        elseif ($Window.IsVisible) {
            $Window.Topmost = $false
            $Window.Topmost = $true
        }
    }
    catch {
        # Alert file being rewritten: try again on the next tick.
    }
})
$Timer.Start()

[Windows.Threading.Dispatcher]::Run()
