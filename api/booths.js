import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { listBoothStatuses, deleteBooth, getBoothTypes, assignBoothType } from "../lib/store.js";

// The agent posts every 30 s; a booth is offline after 3 missed heartbeats.
const OFFLINE_AFTER_SECONDS = 90;

// Booth models, assigned in the dashboard as booths come in.
const BOOTH_TYPES = ["Station mère", "Signature", "Cinebooth 150", "Cinebooth Illimité"];

// GET /api/booths
// Authorization: Bearer <DASHBOARD_TOKEN>
export async function GET(request) {
  let records;
  let types;
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;

    [records, types] = await Promise.all([listBoothStatuses(), getBoothTypes()]);
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
        type: types[record.boothId] || null,
        ageSeconds,
        online: ageSeconds !== null && ageSeconds <= OFFLINE_AFTER_SECONDS,
      };
    })
    .sort((a, b) => a.boothId.localeCompare(b.boothId));

  return json({
    serverTime: new Date(now).toISOString(),
    offlineAfterSeconds: OFFLINE_AFTER_SECONDS,
    boothTypes: BOOTH_TYPES,
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

// PATCH /api/booths?id=<boothId>  body: { "type": "Signature" }
// Authorization: Bearer <DASHBOARD_TOKEN>
// Assigns a type to a booth that has none. Once set, it cannot be changed
// from the dashboard (fix mistakes directly in Redis).
export async function PATCH(request) {
  const boothId = new URL(request.url).searchParams.get("id") || "";

  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;

    if (!BOOTH_ID_PATTERN.test(boothId)) {
      return json({ error: "Missing or invalid id" }, 400);
    }

    const body = await request.json().catch(() => null);
    const type = body?.type;

    if (!BOOTH_TYPES.includes(type)) {
      return json({ error: "Unknown booth type", boothTypes: BOOTH_TYPES }, 400);
    }

    if (!(await assignBoothType(boothId, type))) {
      return json({ error: "Ce booth a déjà un type, il ne peut plus être modifié." }, 409);
    }

    return json({ ok: true, boothId, type });
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }
}
