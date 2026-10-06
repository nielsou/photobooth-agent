import { createHash } from "node:crypto";
import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { getBoothTypes } from "../lib/store.js";
import { DNP_CODES, PRINTER_ALERTS, PRINTER_DRIVERS, DEVICE_DRIVERS, START_SCREEN_VIDEO, LIGHTS_SCRIPT, KIOSK_TYPES, qrPng } from "../lib/printer-alerts.js";

// GET /api/booth-config?id=<boothId>
// Authorization: Bearer <DASHBOARD_TOKEN>
// Fetched by the agent about once an hour; answers 304 when unchanged
// (If-None-Match) so the booths' SIM data is spared.
export async function GET(request) {
  const boothId = new URL(request.url).searchParams.get("id") || "";

  let types;
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;

    if (!BOOTH_ID_PATTERN.test(boothId)) {
      return json({ error: "Missing or invalid id" }, 400);
    }

    types = await getBoothTypes();
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  const type = types[boothId] || null;
  const alerts = await Promise.all(
    (PRINTER_ALERTS[type] || []).map(async (alert) => ({ ...alert, qrPng: await qrPng(alert.url) })),
  );

  // Agents 1.9.x only know the paper-out popup.
  const paper = alerts.find((alert) => alert.id === "paper") || null;

  const body = { boothId, type, printerAlerts: alerts, paperOutPopup: paper, dnpCodes: DNP_CODES, drivers: [...DEVICE_DRIVERS, ...(PRINTER_DRIVERS[type] || [])], startScreenVideo: START_SCREEN_VIDEO, lightsScript: LIGHTS_SCRIPT, kiosk: KIOSK_TYPES.includes(type) };

  const text = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(text).digest("base64url").slice(0, 22)}"`;

  // Vercel may turn the ETag into a weak one (W/"...") when compressing.
  const ifNoneMatch = (request.headers.get("if-none-match") || "").replace(/^W\//, "");

  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(text, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ETag: etag,
    },
  });
}
