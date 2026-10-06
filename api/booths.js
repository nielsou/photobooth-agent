import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { BOOTH_TYPES, DNP_CODES, BRIGHTNESS_RANGE } from "../lib/printer-alerts.js";
import { listBoothStatuses, deleteBooth, getBoothTypes, assignBoothType, listDnpCodesSeen, getSmartFlashOff, setSmartFlash, getLightsSettings, setLightsSettings } from "../lib/store.js";

// The agent posts every 30 s; a booth is offline after 3 missed heartbeats.
const OFFLINE_AFTER_SECONDS = 90;


// GET /api/booths
// Authorization: Bearer <DASHBOARD_TOKEN>
export async function GET(request) {
  let records;
  let types;
  let codesSeen;
  let smartFlashOff;
  let lightsSettings;
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;

    [records, types, codesSeen, smartFlashOff, lightsSettings] = await Promise.all([listBoothStatuses(), getBoothTypes(), listDnpCodesSeen(), getSmartFlashOff(), getLightsSettings()]);
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
        smartFlash: !(record.boothId in smartFlashOff),
        lightsSettings: lightsSettings[record.boothId] || null,
        ageSeconds,
        online: ageSeconds !== null && ageSeconds <= OFFLINE_AFTER_SECONDS,
      };
    })
    // Booths switched on first, then by name.
    .sort((a, b) => (b.online - a.online) || a.boothId.localeCompare(b.boothId));

  return json({
    serverTime: new Date(now).toISOString(),
    offlineAfterSeconds: OFFLINE_AFTER_SECONDS,
    boothTypes: BOOTH_TYPES,
    brightnessRange: BRIGHTNESS_RANGE,
    dnpCodes: DNP_CODES,
    unknownCodesSeen: codesSeen.filter((entry) => !(entry.code in DNP_CODES)).map((entry) => entry.code),
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

// PATCH /api/booths?id=<boothId>  body: { "type": "Signature" }, { "smartFlash": false }
//   or { "lightsMin": 9, "lightsMax": 80 }
// Authorization: Bearer <DASHBOARD_TOKEN>
// Assigns a type to a booth that has none. Once set, it cannot be changed
// from the dashboard (fix mistakes directly in Redis). Smart Flash can be
// turned on and off any time (the booth applies it within 5 min).
export async function PATCH(request) {
  const boothId = new URL(request.url).searchParams.get("id") || "";

  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;

    if (!BOOTH_ID_PATTERN.test(boothId)) {
      return json({ error: "Missing or invalid id" }, 400);
    }

    const body = await request.json().catch(() => null);

    if (body && ("lightsMin" in body || "lightsMax" in body)) {
      const { lightsMin: min, lightsMax: max } = body;
      const valid = (n) => Number.isInteger(n) && n >= BRIGHTNESS_RANGE.min && n <= BRIGHTNESS_RANGE.max;
      if (!valid(min) || !valid(max) || min > max) {
        return json({ error: `MIN et MAX : nombres entiers de ${BRIGHTNESS_RANGE.min} à ${BRIGHTNESS_RANGE.max}, MIN ≤ MAX.` }, 400);
      }
      await setLightsSettings(boothId, min, max);
      return json({ ok: true, boothId, lightsMin: min, lightsMax: max });
    }

    if (typeof body?.smartFlash === "boolean") {
      await setSmartFlash(boothId, body.smartFlash);
      return json({ ok: true, boothId, smartFlash: body.smartFlash });
    }

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
