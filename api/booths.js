import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { listBoothStatuses, deleteBooth } from "../lib/store.js";

// The agent posts every 30 s; a booth is offline after 3 missed heartbeats.
const OFFLINE_AFTER_SECONDS = 90;

// GET /api/booths
// Authorization: Bearer <DASHBOARD_TOKEN>
export async function GET(request) {
  let records;
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;

    records = await listBoothStatuses();
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  const now = Date.now();

  const booths = records
    .map((record) => {
      const lastSeen = record.receivedAt ? Date.parse(record.receivedAt) : NaN;
      const ageSeconds = Number.isFinite(lastSeen) ? Math.max(0, Math.round((now - lastSeen) / 1000)) : null;

      return {
        ...record,
        ageSeconds,
        online: ageSeconds !== null && ageSeconds <= OFFLINE_AFTER_SECONDS,
      };
    })
    .sort((a, b) => a.boothId.localeCompare(b.boothId));

  return json({
    serverTime: new Date(now).toISOString(),
    offlineAfterSeconds: OFFLINE_AFTER_SECONDS,
    booths,
  });
}

// DELETE /api/booths?id=<boothId>  (forget a decommissioned booth)
// Authorization: Bearer <DASHBOARD_TOKEN>
export async function DELETE(request) {
  const boothId = new URL(request.url).searchParams.get("id") || "";

  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;

    if (!BOOTH_ID_PATTERN.test(boothId)) {
      return json({ error: "Missing or invalid id" }, 400);
    }

    const deleted = await deleteBooth(boothId);
    return json({ ok: true, deleted }, deleted ? 200 : 404);
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }
}
