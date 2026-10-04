# Photobooth Agent

Windows agent that monitors each photobooth, plus a Vercel API and dashboard that
show the latest status of every booth.

```
booth (agent.ps1, every 30 s)
  ├─ writes C:\ProgramData\PhotoboothAgent\status.json
  └─ POST /api/heartbeat ──► Vercel ──► Upstash Redis (latest status per booth)
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
| `api/heartbeat.js` | `POST` — receives a booth's `status.json` (auth: `AGENT_TOKEN`) |
| `api/booths.js` | `GET` — latest status of every booth; `DELETE ?id=` — forget a booth (auth: `DASHBOARD_TOKEN`) |
| `lib/` | Shared code for the API (auth, Redis storage) |
| `public/` | Static dashboard |

The booth ID is `$env:COMPUTERNAME`. A booth is shown offline after 90 s
(3 missed heartbeats).

## Vercel setup (once)

1. Import `nielsou/photobooth-agent` in Vercel (framework preset: **Other**, no build command).
   Every push to `main` then redeploys automatically.
2. **Storage → Upstash for Redis** (Marketplace) → create a database and connect it to the
   project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. **Settings → Environment Variables**, add (Production):
   - `AGENT_TOKEN` — long random string shared by the booths
   - `DASHBOARD_TOKEN` — long random string you type into the dashboard

   Generate a value in PowerShell:
   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
   ```
4. Redeploy so the new variables are picked up.

See `.env.example` for the variable names (no values).

## Booth install / update

Run in PowerShell on the booth (it elevates itself):

```powershell
.\install.ps1 -ApiUrl https://<project>.vercel.app -AgentToken <AGENT_TOKEN>
```

Without parameters, the installer reuses the existing `config.json`, or asks for the
URL and token. Leaving the URL empty keeps the agent local-only (status.json only).

The agent logs to `C:\ProgramData\PhotoboothAgent\logs\agent.log`
(`Remote heartbeat sent` / `Remote heartbeat error: ...`).

## API

```
POST /api/heartbeat
Authorization: Bearer <AGENT_TOKEN>
Content-Type: application/json

{ "boothId": "BOOTH-01", "agentVersion": "1.2.0", "internet": true, "spooler": "Running", "printers": [...], "timestamp": "..." }
```

```
GET /api/booths
Authorization: Bearer <DASHBOARD_TOKEN>

{ "serverTime": "...", "offlineAfterSeconds": 90,
  "booths": [ { "boothId": "BOOTH-01", "receivedAt": "...", "ageSeconds": 12, "online": true, "status": { ... } } ] }
```

## Rotating a token

- `AGENT_TOKEN`: change it in Vercel, redeploy, then re-run the installer on each booth with
  `-AgentToken <new value>`.
- `DASHBOARD_TOKEN`: change it in Vercel and redeploy; the dashboard asks for the new one.
