# Photobooth Agent

Windows agent that monitors each photobooth, plus a Vercel API and dashboard that
show the latest status of every booth.

```
booth (agent.ps1, every 30 s)
  ├─ writes C:\ProgramData\PhotoboothAgent\status.json
  └─ POST /api/heartbeat ──► Vercel ──► Redis (latest status per booth)
                                          ▲
dashboard (public/) ── GET /api/booths ───┘
```

This repository is public. **No secret is ever committed**: tokens live in Vercel
environment variables and, on each booth, in `C:\ProgramData\PhotoboothAgent\config.json`
(readable only by SYSTEM and Administrators).

## Layout

| Path | Role |
| --- | --- |
| `agent/agent.ps1` | Windows agent, runs as SYSTEM at startup, heartbeat every 30 s |
| `installer/install.ps1` | Installs/updates the agent, writes `config.json`, creates the startup task |
| `VERSION` | Agent version downloaded by the installer |
| `api/heartbeat.js` | `POST` — receives a booth's `status.json`; `GET` — checks a code (auth: `DASHBOARD_TOKEN`) |
| `api/booths.js` | `GET` — latest status of every booth; `DELETE ?id=` — forget a booth (auth: `DASHBOARD_TOKEN`) |
| `lib/` | Shared code for the API (auth, Redis storage) |
| `public/` | Static dashboard |

The booth ID is `$env:COMPUTERNAME`. A booth is shown offline after 90 s
(3 missed heartbeats).

## Vercel setup (once)

Already done for project `photobooth-agent` (team "Niels' projects"), kept here for reference.

1. Import `nielsou/photobooth-agent` in Vercel (framework preset: **Other**, no build command).
   Every push to `main` then redeploys automatically.
2. **Storage** → connect a Redis database to the project (currently `redis-lime-mountain`).
   This adds `REDIS_URL`. Data lives in the hash `photobooth:booths`.
3. **Settings → Environment Variables**, add `DASHBOARD_TOKEN` (Production, type
   Sensitive): the single password used for the dashboard **and** as the booths'
   installation code. Dashboard and heartbeat share a per-IP lockout (5 wrong codes,
   then 1 hour blocked).
4. Redeploy so the new variables are picked up.

See `.env.example` for the variable names (no values).

## Booth install / update

Double-click `installer\install.cmd` on the booth, or run in PowerShell (it elevates itself):

```powershell
.\install.ps1 -AgentToken "<dashboard password>"
```

`-ApiUrl` defaults to the production dashboard. Without `-AgentToken`, the installer
reuses the existing `config.json` or asks for the installation code (the dashboard
password). Every code is checked with the dashboard before being saved; a stored code
that is now refused is asked again. Leaving it empty keeps the agent local-only.

The agent logs to `C:\ProgramData\PhotoboothAgent\logs\agent.log`
(`Remote heartbeat sent` / `Remote heartbeat error: ...`), rotated at 5 MB.

On power-on (real Windows startup, or resume after a Fast Startup shutdown/sleep,
detected as a > 10 min gap between two loop turns), the agent removes print jobs
older than 2 hours from every queue, so leftovers from a previous event are not
printed at the next one. Recent jobs are kept. Restarting the agent alone (e.g. a
self-update) does not purge.

### Paper-out popup (Signature booths)

When the DNP printer reports paper end (1100), ribbon end (1200) or no prints left,
the agent writes `alert.json`; `popup.ps1`, started at every logon by the
"Photobooth Agent Popup" task in the user's session, shows a fullscreen,
always-on-top popup over dslrBooth ("Appelez votre référent événement" + QR code
to the procedure video). "OK" hides it for `snoozeMinutes`; it disappears once
the printer is fine again. The agent (SYSTEM) creates the task and downloads
`popup.ps1` itself when they are missing, and restarts the helper if needed.
Texts, link and snooze live in `api/booth-config.js`
per booth type (only Signature for now); the agent fetches them hourly (ETag/304).

Low paper (agent >= 1.44.0, alert `paperLow` with `whenLow: 9`): from 9 prints
left down to 1, with no printer error, no popup opens; the bottom-right badge
shows the count instead of the "!" and is updated as prints go out (the agent
rewrites `alert.json` with the same `since`, so the popup only refreshes).
Tapping it opens "Plus que N photos à imprimer" ("Contactez votre référent pour
procéder au changement du papier", or on Cinebooth 150, whose paper is not
reloaded, "vous pourrez toujours faire des photos numériques"). At 0 the usual
paper popup opens in full; any printer error takes precedence.

The install folder is writable only by SYSTEM and Administrators (the agent runs as
SYSTEM, so a user-writable script would be a privilege escalation).

## Releasing a new agent version

The agent updates itself: every 5 minutes it compares `VERSION` on `main` with its own,
downloads `agent/agent.ps1` from that exact commit, checks it parses, replaces itself and
restarts (no reboot, no installer). So for every agent change:

1. Bump `VERSION` (e.g. `1.4.0` → `1.5.0`) in the same commit as the agent change.
2. Push to `main`. Booths pick it up within `$UpdateCheckInterval` (5 min; set it to 15 s while testing) once Vercel has deployed (they read the deployed commit from `/api/version`, not from the rate-limited GitHub API); the dashboard shows each
   booth's agent version.

Anyone who can push to `main` controls the code run as SYSTEM on every booth: keep
push access restricted.

## Checks

Before pushing a dashboard change: `node scripts/check-dashboard.mjs` (renders the whole
dashboard in a fake DOM with realistic data and fails on any runtime error).

## API

```
POST /api/heartbeat
Authorization: Bearer <DASHBOARD_TOKEN>
Content-Type: application/json

{ "boothId": "BOOTH-01", "agentVersion": "1.2.0", "internet": true, "spooler": "Running", "printers": [...], "timestamp": "..." }
```

```
GET /api/booths
Authorization: Bearer <DASHBOARD_TOKEN>

{ "serverTime": "...", "offlineAfterSeconds": 90,
  "booths": [ { "boothId": "BOOTH-01", "receivedAt": "...", "ageSeconds": 12, "online": true, "status": { ... } } ] }
```

## Changing the password

Change `DASHBOARD_TOKEN` in Vercel and redeploy. The dashboard asks for the new one;
each booth must re-run the installer (it sees the old code is refused and asks again).

### Fonts

Fonts used by the booth templates live in a Google Drive folder shared "anyone with
the link" (id in `api/fonts.js`). `/api/fonts` lists it (sub-folders included,
`.ttf/.otf/.ttc/.zip`); the agent downloads what is missing straight from Google and
installs it for all users (`C:\Windows\Fonts` + HKLM registry), once per power-on
(boot or resume). Add a font to the folder and every booth gets it at its next start. Apps already running (e.g.
dslrBooth) only see new fonts after a restart.

A font file already in `C:\Windows\Fonts` is never overwritten (Windows keeps it
locked, and system fonts such as `gabriola.ttf` or `cour.ttf` belong to
TrustedInstaller): the same file is only registered, a different one is replaced only
when Windows lets it. A registry entry belonging to another file (e.g. the system's
`Palatino Linotype (TrueType)` = `pala.ttf`) is never taken over: ours gets its own
name. Each failure is reported with its reason (`fonts.errors`, dashboard tooltip) and
retried every hour (agent >= 1.39.0).

### Printer drivers

`lib/printer-alerts.js` (`PRINTER_DRIVERS`) lists the printer drivers each booth type
needs (Signature and Cinebooth Illimité: DNP DP-DS620). A booth missing one downloads the vendor zip from
Google Drive, and installs it with `pnputil` only if the zip's SHA-256 is the expected
one and its catalog is validly signed by the vendor; the dashboard shows the result.
To ship a new driver version, upload the zip and update its Drive id and SHA-256.
The Citizen CZ-01 driver (Cinebooth 150) is installed the same way. Citizen ships
an unsigned InstallShield setup, but the driver package inside it is signed by
CITIZEN SYSTEMS JAPAN: `public/drivers/citizen-cz01-1.0.1.1.zip` is that package
(extracted from `setup_x64.exe` -> MSI -> `Data1.cab`, with the MSI's x64 folder
layout), served by the dashboard itself.

A printer plugged in **before** its driver was installed gets no print queue: Windows
already gave up on the device and does not retry by itself. Each printer driver
entry has the `hardwareId` of its INF (DP-DS620: `USBPRINT\Dai_Nippon_Printing_C84D`,
the only one in `DPDS620.inf`). The agent reports the USB printers Windows sees
(`printerDevices`: hardware IDs, USB port, problem code) and, per driver, whether its
printer is plugged in and has a queue (`printerSetup`). A matching printer without a
queue is repaired at most every 15 min: `pnputil /scan-devices`, then if still nothing
`Add-Printer` on its USB port (`printerRepair`). A plugged-in printer that matches no
driver (another DNP model) is shown as "non reconnue" with its hardware IDs. The
`hardwareId` lives server-side: fixing it needs no agent release.

Seen on PRO-31 (DS620): the USB device was there (`usbprint`, DNP queries answered)
but Windows had never created its `USBPRINT\...` node, so there was no USB port and
nothing to repair. When a driver entry also has the `usbId` of its USB device
(DP-DS620: `VID_1452&PID_8B01`) and no USBPRINT node matches, the agent restarts that
USB device once per agent run (`pnputil /restart-device`, the software equivalent of
unplugging it), then carries on with the repair above. Each such printer's USB node,
its children and every USBPRINT node Windows ever created are reported in
`printerSetup[].usb` (agent >= 1.40.0).

### Screens

A booth has one screen. The agent reports the screens Windows has connected
(`displays.monitors`: EDID maker, model, serial, and connection: HDMI, DisplayPort,
Indirect for a virtual one) and the display adapters (`displays.adapters`), re-read
every 5 min (agent >= 1.41.0). The dashboard shows a line only when something is off:
the same screen seen twice (HDMI + USB-C cables), several screens, or a virtual display
driver left by remote-control software. Each input of a screen has its own EDID: on
PRO-31 one Realtek "FHD" touchscreen showed up as RTK0156 on USB-C (DisplayPort) and
RTK1850 on HDMI, with different serials, so "same screen" means same maker and model.

### Booth setup at power-on

Booth config (type, popups), printer drivers and fonts are applied once per power-on
(Windows startup, or resume after > 10 min off/asleep), right after the first
heartbeat. They are retried every 5 min only while the dashboard or Drive cannot be
reached. A booth without a type keeps checking its config hourly, so assigning its
type in the dashboard applies right away (popups, drivers).

### Welcome video

`START_SCREEN_VIDEO` (`lib/printer-alerts.js`): the "touch to start" video on Google
Drive, with its SHA-256. At power-on the agent puts it where the booth software
expects it: LumaBooth if installed (`<install folder>\content\VirtualAttendant\<voice
pack>\photoboothparisvideo.mp4`), dslrBooth otherwise (each user's
`AppData\Roaming\dslrBooth\Assets\VirtualAttendant\photoboothparis-ONETOUCH 3.0.mp4`,
asset id `photoboothparis` used by event_generator). It is cached under
`C:\ProgramData\PhotoboothAgent\media`, so a software update wiping it is fixed at the
next power-on without downloading again. A copy refused because the file is in use
(the booth software already playing it) is retried every 15 minutes. To change the
video: upload it to Drive and update its id, SHA-256 and size.

Since 1.50.0 the LumaBooth folder comes from `Find-BoothExe`, not from the application's
name. Until then the agent looked for a folder whose name contained "Luma": on
CINEBOOTH-26 and -27, where the dslrBooth installer put LumaBooth in `Program
Files\dslrBooth`, it found none, fell back to the dslrBooth profile and copied the video
to `AppData\Roaming\dslrBooth\Assets`, which LumaBooth never reads. Those booths had no
welcome video at all and the dashboard showed the check **green**, because the copy did
succeed -- just in the wrong place. The agent now installs into the `Audio - American
Female` voice pack when it is there, into every installed pack when it is not (the event
chooses one), and reports the voice folder and the packs found
(`startScreenVideo.folder` / `.voices`). The dashboard also turns the check red when the
video was installed for an application the booth does not run.

### Lights (Arduino / Smart Flash)

The dslrBooth trigger script (`DSLR_Tiggers.bat`) is in `lib/lights-script.js` (it used
to come from the "PROJET LUMIERES" Drive folder). dslrBooth calls it at each step of a
session (`%1` = event, `%2` = countdown progress in percent) and it sends
`set_brightness N` to the Arduino: MIN at rest, rising from MIN to MAX during the
countdown, MAX for the capture. With `SMART_FLASH_ACTIVATED=FALSE` it always sends
`FIXED_BRIGHTNESS` (100), for lights on a generator.

event_generator points dslrBooth to `C:dslrBoothPROJET_LUMIERESDSLR_Tiggers.bat`; the
agent writes it there with the booth's actual Arduino COM port, the Smart Flash
setting (on/off switch per booth, in the "Smart Flash" column and the Configuration
tab) and the booth's MIN / MAX brightness when set in the Configuration tab's "Smart
Flash" card, which also shows the values the booth reads in its script. The agent
checks the booth config every minute (304 when unchanged), so a switch applies within
about 1 min. At every heartbeat it reads the file back and rewrites it if it differs
(edited, deleted, Arduino on another port); the column shows "Script OK" or "Erreur de
script". `DEVICE_DRIVERS` installs the CH341 USB-serial driver of the Arduino clones
(WHQL) on every booth when missing.

### Booth software (dslrBooth / LumaBooth)

The agent reports each installed booth software (`software` in the status):
version (Windows uninstall entry), whether it is running, how it starts with
Windows (HKLM / user Run keys, common and user Startup folders, scheduled
tasks; a shortcut set to "Maximized" is flagged, Explorer's "Startup apps"
switch is honoured) and its window state. Versions and startup entries are read
at most hourly. The window state (`fullscreen`, `maximized`, `normal`,
`minimized`) comes from the popup helper, which runs in the user's session and
writes `C:\Users\Public\PhotoboothAgent\booth-window.json` every 15 s (the agent,
in session 0, cannot see windows). The dashboard's "Logiciel" column shows it;
a missing autostart is red, except on the mother station.

### Kiosk mode (booths only)

`/api/booth-config` sends `kiosk: true` for every booth type except the mother
station (`KIOSK_TYPES`). At power-on such a booth then: never sleeps, hibernates or
turns its screen off, asks no sign-in on wake-up (powercfg, AC and DC); turns the
screensaver off for every user, also as a user policy (hives of users who are not
logged on are loaded); turns notifications and Windows tips/suggestions off; does not
restart for Windows Update while someone is logged on; does not replay the "finish
setting up your PC" / privacy screens after a feature update (`DisablePrivacyExperience`
policy; the per-user SCOOBE switch does not cover them); sets display scaling to 100 %
for every user from their next sign-in (`LogPixels` 96 + `Win8DpiScaling`), only when
every screen's native mode (EDID) is at most 1920 px wide, since LumaBooth/dslrBooth
screens are designed for 1920x1080 at 100 % and a 4K screen at 100 % is unreadable;
sets the dslrBooth/LumaBooth shortcuts of the Startup folders to "Maximized". Since 1.48.0 it also makes sure there **is** such a shortcut (`Set-BoothAutostart`, step
`autostart`): a booth whose software is not in the Startup folder shows an empty desktop
at power-on and nobody notices until the event. The agent looks for LumaBooth, else
dslrBooth, checks every autostart it already knows (Run keys, Startup folders,
scheduled tasks) for an **enabled** entry pointing at that exe, and creates a maximized
shortcut when there is none, clearing its `StartupApproved` values so it cannot stay
unticked in the Task Manager.

Finding the exe takes 1.48.1 (`Get-BoothExePaths`): 1.48.0 guessed the path from the
application's name and reported "no booth software installed" on a booth that was running
LumaBooth 8.4 at that very moment. LumaBooth 8 is installed by the dslrBooth installer and
lives in `C:\Program Files\dslrBooth\LumaBooth.exe` -- folder and exe do not match. The
agent now takes, in this order, the path of the **running process**, the `InstallLocation`
/ `DisplayIcon` of the uninstall entries (per machine *and* per user), then `LumaBooth` and
`dslrBooth` under `Program Files`, `Program Files (x86)` and every profile's
`AppData\Local\Programs`. The application is identified by the exe's name, not its
folder's. An install inside a profile gets its shortcut in that user's own Startup folder,
since the all-users one would not start it. The result is reported in `kiosk.autostart`,
next to the automatic sign-in user, and shown in the "Logiciel" column.

Since 1.49.0 the agent also repoints the automatic sign-in when the booth account has
been **renamed** (`Find-BoothAccount`). Winlogon stores the user name, so a rename leaves
it on a name that no longer exists: Windows then tries to sign in as nobody and shows the
sign-in screen, with `AutoAdminLogon` still at 1 and nothing saying why. CINEBOOTH-26 hit
this on 2026-11-10: converting its Microsoft account to a local one renamed `djdam` to
`admin` in passing, and `DefaultUserName` stayed on `djdam`. The profile folder keeps its
old name, so the account to take over is the one holding the booth settings (`booth`),
else the only local administrator. **Only ever one candidate**: on anything ambiguous the
agent changes nothing and `noPasswordWhy` says so. That booth kept starting by itself
meanwhile only because its single account has no password at all -- which is exactly what
the agent is for, but it was not the agent doing it.

Since 1.45.0 the agent also leaves the booth account **without any password**
(`Clear-AutoLogonPassword`, step `password`). The automatic sign-in's password is kept
in an LSA secret, which goes stale as soon as the account's password changes or a PIN
is added: Windows then shows its sign-in screen again with `AutoAdminLogon` still at 1,
and nothing says why — CINEBOOTH-26 stopped on a password this way on 2026-11-09. An
account with no password has no secret that can go stale. The agent blanks the password
of the account named in `DefaultUserName`, sets `AutoAdminLogon` to 1, writes an empty
`DefaultPassword` (read before the LSA secret, so it replaces a stale one; it discloses
nothing, the account has no password) and removes `AutoLogonCount`, which would make the
sign-in one-shot. Local accounts only, never on a domain-joined PC nor on a Microsoft
account, and never on the mother station, which is not a kiosk type. Windows still
refuses a blank password over the network (`LimitBlankPasswordUse`, on by default): it
only opens the console. Reported as `autoLogon.noPassword`, green in the dashboard.

1.45.0 abstained silently when one of those checks stopped it, and the dashboard could
not say which: since 1.46.0 the reason is reported in `autoLogon.noPasswordWhy` and
shown ("mot de passe gardé"). Also 1.46.0: `Get-LocalUser` is missing on some builds
and leaves `PrincipalSource` empty on others, so the account is confirmed through
`Win32_UserAccount` as well, and the password is blanked through ADSI where the
`LocalAccounts` module is absent.

When the booth account cannot be left without a password, the machine's accounts are
reported in `accounts` (agent >= 1.47.0, read only, nothing changed): name, full name,
`source` (Local or MicrosoftAccount), whether it is an administrator, its profile path,
its last use, and `booth` for the profile that holds the booth software settings. It
answers the question that blocks the decision: is there already a local account the
automatic sign-in could use, instead of converting the Microsoft account? CINEBOOTH-26
shows two users on its sign-in screen, both named Damien L.

### Chrome kept up to date (booths only)

A booth is off most of the time, so Google's own scheduled update rarely gets its turn
and Chrome drifts versions behind until its remote desktop host stops connecting —
CINEBOOTH-26 lost Chrome Remote Desktop this way on 2026-11-09, and a manual Chrome
update fixed it. At each power-on (agent >= 1.46.0, `Update-Chrome`, kiosk booths only)
the agent wakes Google's own updater: `GoogleUpdater` (`--wake-all`) when present,
otherwise the historical `GoogleUpdate.exe` (`/ua`) whose path is in the registry.
Nothing is downloaded by the agent and nothing restarts; Chrome applies the new version
by itself. A Google Update policy explicitly set to 0 (`UpdateDefault`, or Chrome's own
app id) blocks every update, so the agent puts it back to 1 — forcing updates means
lifting that. Reported in `chromeUpdate` (version, previous version when it changed,
which updater, policies lifted) and shown in the "Programmes" column.

What matters is that Windows opens the session by itself after a power cut, which a
user without a password does as well as automatic sign-in. So the agent watches each
power-on (boot, or resume after > 10 min off): a desktop (explorer.exe) within 3 min
means no password was typed, none after 10 min means Windows waits at its sign-in
screen (`autoLogon.unattended`, kept in `logon-check.json`, agent >= 1.42.0). An agent
installed or updated after power-on can only confirm it from the boot time, never
deny it (after a Fast Startup resume the boot time is old). The dashboard shows
"Session auto (sans mot de passe)" in green, or a red "mot de passe demandé".

That check confirms, it never denies: someone typing the password within the 3 min
counts as unattended. CINEBOOTH-26 read `unattended: true, 58 s` on the very power-on
where it had asked for a password. Only `noPassword` above says it cannot happen.

LumaBooth starting windowed comes from the event config, not from Windows: the
event generator's `default-config.json` (`captureSettings.isStartInFullscreenEnabled`,
copied as `false` from the old dslrBooth `.lcfg`) is `true` since 2026-11-02.

A driver listed with `kind: "check"` is only reported (installed or not), the
dashboard then shows "à installer à la main". None is listed that way any more.

### Inventory

At power-on (after the kiosk step) the agent sends the installed programs
(uninstall entries), Windows apps (Appx, all users) and provisioned apps to
`POST /api/inventory` (stored per booth, `GET /api/inventory` to read them): too big
for the 30 s heartbeat. Used to decide what to remove from the booths.

### Programs installed on booths

`INSTALL_PROGRAMS` (`lib/printer-alerts.js`), sent to kiosk booths only: when no
uninstall entry matches `detect`, the agent downloads the official installer, refuses
it unless its SHA-256 matches, runs it silently and checks the result (dashboard,
"Logiciel" column). Currently Notepad++ (GitHub release, digest from the release
assets). To upgrade, change the URL and SHA-256.

### Apps removed from booths

`REMOVE_APPS` / `REMOVE_PROGRAMS` (`lib/printer-alerts.js`), sent to kiosk booths only:
at every power-on the agent removes those Windows apps for every user and from the
provisioned packages, and uninstalls those programs (per-user ones such as OneDrive
from the user's session, through a one-shot scheduled task). Result in `cleanup`,
shown in the "Programmes" column. TeamViewer (older booths) is removed too. Kept on purpose: Edge, Store, codecs, Photos, Camera,
Notepad, Terminal, Snipping Tool, Quick Assist, Chrome Remote Desktop.

Once per launch of dslrBooth / LumaBooth, if its window opens "windowed" during its
first minute, the popup helper maximizes it (dslrBooth ignores the shortcut's
"Maximized"); never again for that launch, so the operator can resize it.

### Renaming a computer

Configuration tab, "Noms des ordinateurs": the new name (1 to 15 letters, digits or
hyphens, unique in the fleet) is sent by `/api/booth-config` (`rename`). The agent runs
`Rename-Computer` within about a minute (cancelling it in the dashboard before the
restart puts the current name back); Windows uses the new name from the next restart,
which the agent never forces. The agent then sends `previousBoothId` with its heartbeat
and the server moves the booth's type, Smart Flash, MIN / MAX and inventory to the new
name and drops the old entry (`migrateBooth`).

### Popup slideshows

An alert can carry `slides` ([{ image, caption }]): the popup shows them in turn, one
every 2.5 s, above the QR code (DS620 paper popups: how to load the paper). Images are
JPEGs in `lib/popup-images/`, embedded by `node scripts/build-popup-images.mjs` into
`lib/popup-images.js`; booth-config sends the ones the booth needs (`popupImages`) and
the agent saves them as `popup-<name>.jpg` next to its config.

An alert can also carry a `clip` ({ name, path, sha256, caption }): a short silent
video loop served by the dashboard (`public/popup-clips/`), downloaded once by the
agent (SHA-256 checked) and played in the popup instead of the slides, which remain
the fallback. DS620 paper popups: `ds620-load.mp4`, the procedure video from 2:00 to
2:15 sped up x1.5 (ffmpeg, 480 px, no audio, ~170 KB); Citizen paper popups: `citizen-load.mp4`, the supplier's CZ-01 tutorial from 0:44 to 0:57.

### Camera

The booth camera must be on (booth opened) before dslrBooth starts. The agent takes
the camera dslrBooth last connected ("Camera Connected: <name>" in its log, remembered
in `camera.json`) and checks every 30 s whether Windows sees it (`Get-PnpDevice
-PresentOnly`, classes Camera / Image / WPD). The dashboard's Caméra column shows
"Absente" in red when it is not there. On booths, after two checks in a row (~1 min)
and only while dslrBooth / LumaBooth runs, a red ("critical") popup takes over the
printer ones (`CAMERA_ALERTS` per type): Cinebooths, "Appareil photo éteint" with a
clip of how to open the booth and press ON; Signature, "Appareil photo non détecté",
call the technician. No popup at all (printer or camera) while the booth software is
not running.
