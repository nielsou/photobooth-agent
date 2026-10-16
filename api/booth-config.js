import { createHash } from "node:crypto";
import { POPUP_IMAGES } from "../lib/popup-images.js";
import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { getBoothTypes, getSmartFlashOff, getLightsSettings, getRenames } from "../lib/store.js";
import { DNP_CODES, PRINTER_ALERTS, PRINTER_DRIVERS, DEVICE_DRIVERS, START_SCREEN_VIDEO, lightsScriptFor, KIOSK_TYPES, INSTALL_PROGRAMS, REMOVE_APPS, REMOVE_PROGRAMS, CAMERA_ALERTS, qrPng } from "../lib/printer-alerts.js";

// GET /api/booth-config?id=<boothId>
// Authorization: Bearer <DASHBOARD_TOKEN>
// Fetched by the agent about once an hour; answers 304 when unchanged
// (If-None-Match) so the booths' SIM data is spared.
export async function GET(request) {
  const boothId = new URL(request.url).searchParams.get("id") || "";

  let types;
  let smartFlashOff;
  let lightsSettings;
  let renames;
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;

    if (!BOOTH_ID_PATTERN.test(boothId)) {
      return json({ error: "Missing or invalid id" }, 400);
    }

    [types, smartFlashOff, lightsSettings, renames] = await Promise.all([getBoothTypes(), getSmartFlashOff(), getLightsSettings(), getRenames()]);
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  const type = types[boothId] || null;
  const alerts = await Promise.all(
    (PRINTER_ALERTS[type] || []).map(async (alert) => ({ ...alert, qrPng: await qrPng(alert.url) })),
  );

  // Camera not detected popup, per booth type (not the mother station).
  const cameraAlert = CAMERA_ALERTS[type] ? { ...CAMERA_ALERTS[type], qrPng: await qrPng(CAMERA_ALERTS[type].url) } : null;

  // Images of the popups' slideshows, sent once with the config (agent >= 1.34.0).
  const popupImages = {};
  for (const alert of alerts) {
    for (const slide of alert.slides || []) {
      if (POPUP_IMAGES[slide.image]) popupImages[slide.image] = POPUP_IMAGES[slide.image];
    }
  }

  // Agents 1.9.x only know the paper-out popup.
  const paper = alerts.find((alert) => alert.id === "paper") || null;

  const body = { boothId, type, printerAlerts: alerts, paperOutPopup: paper, dnpCodes: DNP_CODES, drivers: [...DEVICE_DRIVERS, ...(PRINTER_DRIVERS[type] || [])], startScreenVideo: START_SCREEN_VIDEO, lightsScript: lightsScriptFor(!(boothId in smartFlashOff), lightsSettings[boothId]), kiosk: KIOSK_TYPES.includes(type), installPrograms: KIOSK_TYPES.includes(type) ? INSTALL_PROGRAMS : [], removeApps: KIOSK_TYPES.includes(type) ? REMOVE_APPS : [], removePrograms: KIOSK_TYPES.includes(type) ? REMOVE_PROGRAMS : [], rename: renames[boothId]?.name || null, popupImages, cameraAlert };

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
