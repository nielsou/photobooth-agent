import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { getBoothTypes } from "../lib/store.js";

// Popups shown on the booth screen when its DNP printer reports a problem,
// per booth type. Guests see them; the event referent scans the QR code.
// The agent picks the first alert whose `codes` contain the DNP status code
// (`whenEmpty`: also when no prints are left, `otherErrors`: any code >= 1000).
// Procedure videos (YouTube channel Photobooth Paris, per assistance playlist).
const VIDEOS = {
  signaturePaper: "https://youtu.be/NmE4PZwt-yA", // Assistance Signature - 2 - Remplacement du papier photo et encre
  starboothPaper: "https://youtu.be/7_P5nb0iPJE", // Assistance Starbooth Pro - Comment changer le papier et l'encre
  jam: "https://youtu.be/FHIYNH55hVo", // Assistance Signature / Starbooth Pro - 4 - Comment réparer un bourrage papier
  // Not used yet (needs Citizen status reading): Cinebooth 150, Citizen
  // "Ça n'imprime plus : comment remplacer le papier et l'encre" https://youtu.be/qPPVA1Bxaco
};

const COMMON = {
  badge: "Impression en pause",
  detail: "Vous pouvez continuer à prendre des photos : elles s'imprimeront dès que le problème sera réglé.",
  qrCaption: "Référent : scannez pour la procédure",
  snoozeMinutes: 1,
};

// Same DNP alerts for every booth type, only the videos differ.
function dnpAlerts({ paperUrl, jamUrl }) {
  return [
    {
      ...COMMON,
      id: "paper",
      codes: [1100, 1200, 1400, 1500],
      whenEmpty: true,
      title: "Plus de papier photo",
      message: "Appelez votre référent événement pour remettre du papier.",
      detail: "Vous pouvez continuer à prendre des photos : elles s'imprimeront dès que le papier sera remis.",
      url: paperUrl,
    },
    {
      ...COMMON,
      id: "jam",
      codes: [1300],
      title: "Bourrage papier",
      message: "Appelez votre référent événement pour dégager le papier.",
      url: jamUrl,
    },
    {
      ...COMMON,
      id: "open",
      codes: [1000, 1010],
      title: "Imprimante ouverte",
      message: "Appelez votre référent événement pour refermer l'imprimante.",
      url: jamUrl,
    },
    {
      ...COMMON,
      id: "error",
      otherErrors: true,
      title: "Problème d'imprimante",
      message: "Appelez votre référent événement.",
      url: null,
    },
  ];
}

const PRINTER_ALERTS = {
  Signature: dnpAlerts({ paperUrl: VIDEOS.signaturePaper, jamUrl: VIDEOS.jam }),
  "Starbooth Pro": dnpAlerts({ paperUrl: VIDEOS.starboothPaper, jamUrl: VIDEOS.jam }),
};

async function qrPng(url) {
  if (!url) return null;
  const png = await QRCode.toBuffer(url, { width: 600, margin: 2, errorCorrectionLevel: "M" });
  return png.toString("base64");
}

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

  const body = { boothId, type, printerAlerts: alerts, paperOutPopup: paper };

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
