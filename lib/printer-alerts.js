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
// DNP "STATUS" codes, as listed by Gutenprint's DNP backend (dnpds40).
// Shared by the agents (popup "info" line), the booths table and the
// Configuration tab. 1 / 500 / 510 / 900 are normal states, >= 1000 errors.
export const DNP_CODES = {
  0: "En attente",
  1: "Impression",
  500: "Refroidissement de la tête",
  510: "Refroidissement du moteur papier",
  900: "Veille",
  1000: "Capot ouvert",
  1010: "Bac à chutes absent",
  1100: "Fin de papier",
  1200: "Fin de ruban",
  1300: "Bourrage papier",
  1400: "Erreur ruban",
  1500: "Mauvais papier (ne correspond pas au ruban)",
  1600: "Erreur de données",
  2000: "Erreur de tension de la tête",
  2100: "Erreur de position de la tête",
  2200: "Erreur du ventilateur d'alimentation",
  2300: "Erreur de coupe",
  2400: "Erreur du rouleau presseur",
  2500: "Température de la tête anormale",
  2600: "Température du média anormale",
  2610: "Température du moteur papier anormale",
  2700: "Erreur de tension du ruban",
  2800: "Erreur du module RFID",
  3000: "Erreur système",
};

// Printer drivers each booth type must have. The agent installs a missing one
// from the zip below, but only if its SHA-256 matches (a file replaced on the
// Drive is refused) and its catalog signature is valid. Drive folders:
// DNP 1p4v-jUk8CXSULBV1kEpMff6Ooj86VecR, Citizen 1zzFZRdhfa-oRdbwowTiKT_MqSf6H2YLH.
const DRIVE_DOWNLOAD = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

export const PRINTER_DRIVERS = {
  Signature: [
    {
      id: "dnp-ds620",
      printerDriverName: "DP-DS620",
      url: DRIVE_DOWNLOAD("1e3QB78t1WGswp88Ps0z2e3OIWCj_-7gB"), // Win_10_DP-DS620_Driver.zip, v1.0.5.2
      sha256: "68FF978FCC84B5E6F436DB8669C67DFF4AB770746E8A4EA8C97C501D833A54E5",
      inf: "Win_10_DP-DS620_Driver/10/DriverPackage/DPDS620.inf",
      signer: "Dai Nippon Printing",
    },
  ],
  // Cinebooth 150 (Citizen CZ-01): unsigned InstallShield setup, not automated yet.
};

// Welcome ("touch to start") video every booth must have, from Google Drive.
// The agent puts it where the booth software looks for it: LumaBooth if
// installed (Program Files<Luma...>contentVirtualAttendantAudio - American
// Femalephotoboothparisvideo.mp4), dslrBooth otherwise (user's AppDataRoaming// dslrBoothAssetsVirtualAttendantphotoboothparis-ONETOUCH 3.0.mp4, asset id
// "photoboothparis" used by event_generator). Refused unless the SHA-256 matches.
export const START_SCREEN_VIDEO = {
  url: DRIVE_DOWNLOAD("1NwpCRyVAqtmF4nWfQb0hO7_DREGmOHEI"), // photoboothparis.mp4 (1080p60, 79 s)
  sha256: "8FD8FDF98B6CDBC704879971161A48300FE1B4092A552CACCDB7BEE0158873F6",
  size: 36874579,
};

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
      // A warning is enough here, no procedure video.
      url: null,
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

