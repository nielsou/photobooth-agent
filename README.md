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

The install folder is writable only by SYSTEM and Administrators (the agent runs as
SYSTEM, so a user-writable script would be a privilege escalation).

## Releasing a new agent version

The agent updates itself: every 5 minutes it compares `VERSION` on `main` with its own,
downloads `agent/agent.ps1` from that exact commit, checks it parses, replaces itself and
restarts (no reboot, no installer). So for every agent change:

1. Bump `VERSION` (e.g. `1.4.0` → `1.5.0`) in the same commit as the agent change.
2. Push to `main`. Booths pick it up within ~5 minutes; the dashboard shows each
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

### Printer drivers

`lib/printer-alerts.js` (`PRINTER_DRIVERS`) lists the printer drivers each booth type
needs (Signature and Cinebooth Illimité: DNP DP-DS620). A booth missing one downloads the vendor zip from
Google Drive, and installs it with `pnputil` only if the zip's SHA-256 is the expected
one and its catalog is validly signed by the vendor; the dashboard shows the result.
To ship a new driver version, upload the zip and update its Drive id and SHA-256.
The Citizen CZ-01 driver (Cinebooth 150) is an unsigned InstallShield setup and is
not installed automatically.

### Booth setup at power-on

Booth config (type, popups), printer drivers and fonts are applied once per power-on
(Windows startup, or resume after > 10 min off/asleep), right after the first
heartbeat. They are retried every 5 min only while the dashboard or Drive cannot be
reached. A booth without a type keeps checking its config hourly, so assigning its
type in the dashboard applies right away (popups, drivers).

### Welcome video

`START_SCREEN_VIDEO` (`lib/printer-alerts.js`): the "touch to start" video on Google
Drive, with its SHA-256. At power-on the agent puts it where the booth software
expects it: LumaBooth if installed (`Program Files\<Luma...>\content\VirtualAttendant\
Audio - American Female\photoboothparisvideo.mp4`), dslrBooth otherwise (each user's
`AppData\Roaming\dslrBooth\Assets\VirtualAttendant\photoboothparis-ONETOUCH 3.0.mp4`,
asset id `photoboothparis` used by event_generator). It is cached under
`C:\ProgramData\PhotoboothAgent\media`, so a software update wiping it is fixed at the
next power-on without downloading again. To change the video: upload it to Drive and
update its id, SHA-256 and size.

### Lights (Arduino)

`LIGHTS_SCRIPT` (`lib/printer-alerts.js`): the dslrBooth trigger script
(`DSLR_Tiggers.bat`, "PROJET LUMIERES" Drive folder) that sends `set_brightness N` to
the Arduino at each step of a session. event_generator points dslrBooth to
`C:\dslrBooth\PROJET_LUMIERES\DSLR_Tiggers.bat`; the agent writes it there at power-on
with the booth's actual Arduino COM port (template: COM6). At every heartbeat it reads
the port back from the file on disk and reports it (`lights.com`, `expected`, `ok`,
`missing`); the dashboard's "Smart Flash" column shows "Script OK", or "Erreur de script" with the board's badge turned red. If the
file was edited, deleted, or the Arduino moved to another COM port, the agent rewrites
it within 30 s. `DEVICE_DRIVERS` installs the CH341
USB-serial driver of the Arduino clones (WHQL) on every booth when missing.

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
restart for Windows Update while someone is logged on; sets the dslrBooth/LumaBooth
shortcuts of the Startup folders to "Maximized". The result is reported in `kiosk`
(with the automatic sign-in user, read only) and shown in the "Logiciel" column.
User passwords and automatic sign-in are not changed: that would need a password in
this public repository.

The Citizen CZ-01 driver (Cinebooth 150) is listed with `kind: "check"`: the agent
only reports whether it is installed, the dashboard shows "à installer à la main".

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

During the first minute after dslrBooth / LumaBooth starts, the popup helper maximizes
its window if it is left "windowed" (dslrBooth ignores the shortcut's "Maximized");
after that it leaves the window alone.
