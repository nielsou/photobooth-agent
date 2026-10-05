// Booth types and the printer alert popups each one shows. Shared by
// /api/booth-config (what the agents apply) and /api/printer-alerts (what the
// dashboard's Configuration tab displays), so both always agree.
import QRCode from "qrcode";

// Booth models, assigned in the dashboard as booths come in.
export const BOOTH_TYPES = ["Station mère", "Signature", "Starbooth Pro", "Cinebooth 150", "Cinebooth Illimité"];

// What the Configuration tab says about each type's printer.
export const TYPE_NOTES = {
  "Station mère": "Pas d'imprimante photo surveillée : aucune popup.",
  Signature: "Imprimante DNP (DS620).",
  "Starbooth Pro": "Imprimante DNP à confirmer : les popups ne marchent qu'avec une DNP.",
  "Cinebooth 150": "Imprimante Citizen : popups pas encore disponibles (lecture de l'état des Citizen à développer).",
  "Cinebooth Illimité": "Aucune popup configurée.",
};

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

export const PRINTER_ALERTS = {
  Signature: dnpAlerts({ paperUrl: VIDEOS.signaturePaper, jamUrl: VIDEOS.jam }),
  "Starbooth Pro": dnpAlerts({ paperUrl: VIDEOS.starboothPaper, jamUrl: VIDEOS.jam }),
};

export async function qrPng(url) {
  if (!url) return null;
  const png = await QRCode.toBuffer(url, { width: 600, margin: 2, errorCorrectionLevel: "M" });
  return png.toString("base64");
}

