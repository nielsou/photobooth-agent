import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { getBoothTypes } from "../lib/store.js";

// Popup shown on the booth screen when its DNP printer runs out of paper or
// ribbon, per booth type. Guests see it, the event referent scans the QR code.
const PAPER_OUT_POPUPS = {
  Signature: {
    url: "https://youtu.be/NmE4PZwt-yA",
    badge: "Impression en pause",
    title: "Plus de papier photo",
    message: "Appelez votre référent événement pour remettre du papier.",
    detail: "Vous pouvez continuer à prendre des photos : elles s'imprimeront dès que le papier sera remis.",
    qrCaption: "Référent : scannez pour la procédure",
    snoozeMinutes: 1,
  },
};

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
  const popup = PAPER_OUT_POPUPS[type] || null;

  const body = {
    boothId,
    type,
    paperOutPopup: popup && {
      ...popup,
      qrPng: (await QRCode.toBuffer(popup.url, { width: 600, margin: 2, errorCorrectionLevel: "M" })).toString("base64"),
    },
  };

  const text = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(text).digest("base64url").slice(0, 22)}"`;

  if (request.headers.get("if-none-match") === etag) {
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
