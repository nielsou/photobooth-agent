// Booth types and the printer alert popups each one shows. Shared by
// /api/booth-config (what the agents apply) and /api/printer-alerts (what the
// dashboard's Configuration tab displays), so both always agree.
import QRCode from "qrcode";

// Booth models, assigned in the dashboard as booths come in.
export const BOOTH_TYPES = ["Station mère", "Signature", "Cinebooth 150", "Cinebooth Illimité"];

// Types whose PCs are booths run in kiosk mode (no sleep, lock, screensaver,
// notifications; booth software started maximized). Never the mother station.
export const KIOSK_TYPES = BOOTH_TYPES.filter((type) => type !== "Station mère");

// What the Configuration tab says about each type's printer.
export const TYPE_NOTES = {
  "Station mère": "Pas d'imprimante photo surveillée : aucune popup.",
  Signature: "Imprimante DNP (DS620).",
  "Cinebooth 150": "Imprimante Citizen CZ-01 : tirages restants et état lus, popups à activer après test des codes d'erreur.",
  "Cinebooth Illimité": "Imprimante DNP (DS620).",
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

const DNP_DS620_DRIVER = {
  id: "dnp-ds620",
  printerDriverName: "DP-DS620",
  url: DRIVE_DOWNLOAD("1e3QB78t1WGswp88Ps0z2e3OIWCj_-7gB"), // Win_10_DP-DS620_Driver.zip, v1.0.5.2
  sha256: "68FF978FCC84B5E6F436DB8669C67DFF4AB770746E8A4EA8C97C501D833A54E5",
  inf: "Win_10_DP-DS620_Driver/10/DriverPackage/DPDS620.inf",
  signer: "Dai Nippon Printing",
  kind: "printer",
  trustPublisher: true,
};

export const PRINTER_DRIVERS = {
  Signature: [DNP_DS620_DRIVER],
  "Cinebooth Illimité": [DNP_DS620_DRIVER],
  // Citizen CZ-01: unsigned InstallShield setup, not installed by the agent;
  // "check" only reports whether it is there (agent >= 1.22.0).
  "Cinebooth 150": [{ id: "citizen-cz01", printerDriverName: "CITIZEN CZ-01", kind: "check" }],
};

// Drivers every booth needs whatever its type: the CH340/CH341 USB-serial
// chip of the Arduino clones (WHQL, Microsoft-signed). Individual files from
// the "PROJET LUMIERES" Drive folder, each checked against its SHA-256.
const ch341 = (name, id, sha256) => ({ name, url: DRIVE_DOWNLOAD(id), sha256 });

export const DEVICE_DRIVERS = [
  {
    id: "wch-ch341",
    name: "CH341 (Arduino)",
    infName: "ch341ser.inf",
    inf: "CH341SER.INF",
    signer: "Microsoft Windows Hardware Compatibility Publisher",
    files: [
      ch341("CH341SER.INF", "14uyspJJoNgmOWQ_3t2icy8oyRXw5hxIh", "11B026414C2AF50CED5DCE6B5749F20E1432D7DCDEB19F4B7BD8DC14D272DF4B"),
      ch341("CH341SER.CAT", "1Wq8dqFIE1je9wz8NCIn7bNKl3BGqfA9W", "65C95FAEE9777E4C2E658F7DCEFB8F6EF484D37473F169A04F5E5AB67D895F1E"),
      ch341("CH341S64.SYS", "1aryxkXj35l0ax7WzcLavPFUCgljqGgKF", "69BD224BCC87792A95CCEF7DD2092D1AC1EBBF98B9D5A847EE2AEB424CD5CE7B"),
      ch341("CH341SER.SYS", "1EanXwMqpcsmx7UI5Af-46jZg1yBHganN", "593A5169E2F1E78505BE588E3D57F76003D7E318117D0932BA138308BFC8801C"),
      ch341("CH341PT.DLL", "1ITRYCqMqbTTLj01kg89s_PRYPBu__pxw", "7A905A8FC29D43623C1A7EEC32CF37392B6C0DEC002022229AD09AA15B1602D4"),
      ch341("CH341S98.SYS", "12U4m6nO21EUi1O30QJD5Fm3Eofq-Y3sZ", "195FF2B65CB62830FD13DB530F618C078A99B1634056A41C21C494E9B55D383D"),
      ch341("CH341SER.VXD", "1OIpvW2a1FHiLl90qk1z4wJ84m-vnHAcV", "2A946F316EDD7E1185DEEAFDC2DE52B2D2843198BE098A724233C12F9CCD0DAE"),
    ],
  },
];

// dslrBooth "trigger application" driving the lights through the Arduino
// (sends "set_brightness N" to its COM port at each step of a session).
// event_generator points dslrBooth to this path. The agent writes it with the
// booth's actual Arduino COM port instead of the template's COM6.
export const LIGHTS_SCRIPT = {
  url: DRIVE_DOWNLOAD("1fQDPPOFf6AzsYKJVUHgT3saORvhEUYaA"), // Event logger/DSLR_Tiggers.bat
  sha256: "FA6B38E9328C10CD5DE0712C83D833D0C5567A19D5B8055C69F5FB7B9B15DA03",
  path: String.raw`C:\dslrBooth\PROJET_LUMIERES\DSLR_Tiggers.bat`,
};

// Programs installed on the booths (kiosk types) when missing: official
// installer, refused unless its SHA-256 matches, run silently. `detect` is
// matched against the Windows uninstall entries (DisplayName).
export const INSTALL_PROGRAMS = [
  {
    id: "notepad-plus-plus",
    name: "Notepad++",
    detect: "^Notepad\\+\\+",
    url: "https://github.com/notepad-plus-plus/notepad-plus-plus/releases/download/v8.9.8.1/npp.8.9.8.1.Installer.x64.exe",
    sha256: "26F3BCCED788FADBAC4E7E577B430EA2CE6060CF3BCAD993EF4612ECD7D743DA",
    args: "/S",
  },
];

// Removed from the booths (kiosk types) at every power-on, in case a Windows
// update brings them back. Windows apps (Appx names): removed for every user
// and from the provisioned packages (future users).
export const REMOVE_APPS = [
  // Xbox
  "Microsoft.GamingApp", "Microsoft.XboxGamingOverlay", "Microsoft.Xbox.TCUI", "Microsoft.XboxIdentityProvider",
  "Microsoft.XboxSpeechToTextOverlay", "Microsoft.Edge.GameAssist",
  // Office / Teams / OneDrive
  "Microsoft.MicrosoftOfficeHub", "Microsoft.OutlookForWindows", "Microsoft.M365Companions", "Microsoft.Office.ActionsServer",
  "Microsoft.OfficePushNotificationUtility", "MSTeams", "Microsoft.OneDriveSync",
  // News, weather, search, widgets / Start experiences
  "Microsoft.BingNews", "Microsoft.BingWeather", "Microsoft.BingSearch", "Microsoft.StartExperiencesApp",
  "MicrosoftWindows.Client.WebExperience",
  // Family, voice recorder, Feedback Hub, Copilot, Mobile Plans
  "MicrosoftCorporationII.MicrosoftFamily", "Microsoft.WindowsSoundRecorder", "Microsoft.WindowsFeedbackHub",
  "Microsoft.Copilot", "Microsoft.OneConnect",
  // Other apps with no use on a booth
  "Clipchamp.Clipchamp", "Microsoft.MicrosoftSolitaireCollection", "Microsoft.ZuneMusic", "Microsoft.YourPhone",
  "MicrosoftWindows.CrossDevice", "Microsoft.Todos", "Microsoft.PowerAutomateDesktop", "Microsoft.GetHelp",
  "Microsoft.MicrosoftStickyNotes", "Microsoft.MicrosoftJournal", "Microsoft.Whiteboard", "Microsoft.Windows.DevHome",
  "Microsoft.Messaging", "Microsoft.WindowsAlarms", "Microsoft.Paint", "Microsoft.WindowsCalculator",
];

// Classic programs removed from the booths: `detect` matches the uninstall
// entry's DisplayName. "user" ones are installed per user (OneDrive) and are
// uninstalled from the user's session; `extraArgs` makes the uninstaller silent.
export const REMOVE_PROGRAMS = [
  { name: "Copilot", detect: "^Copilot$", publisher: "Microsoft", extraArgs: "--force-uninstall" },
  { name: "OneDrive", detect: "^Microsoft OneDrive$", publisher: "Microsoft", user: true },
];

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
  // DNP booths other than Signature (YouTube playlist "starbooth-pro").
  cineboothIllimitePaper: "https://youtu.be/7_P5nb0iPJE", // Comment changer le papier et l'encre
  jam: "https://youtu.be/FHIYNH55hVo", // Assistance Signature / starbooth-pro - 4 - Comment réparer un bourrage papier
  // Not used yet (Citizen error codes to be tested): Cinebooth 150, Citizen
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
  "Cinebooth Illimité": dnpAlerts({ paperUrl: VIDEOS.cineboothIllimitePaper, jamUrl: VIDEOS.jam }),
};

export async function qrPng(url) {
  if (!url) return null;
  const png = await QRCode.toBuffer(url, { width: 600, margin: 2, errorCorrectionLevel: "M" });
  return png.toString("base64");
}

