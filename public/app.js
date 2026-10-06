"use strict";

const REFRESH_MS = 15000;
const TOKEN_KEY = "photobooth-dashboard-token";

const $ = (id) => document.getElementById(id);

let token = readToken();
let timer = null;
let boothTypes = [];
let brightnessRange = { min: 0, max: 100 };

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function writeToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable: keep token in memory only */ }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else node[key] = value;
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function badge(text, kind) {
  return el("span", { class: `badge ${kind}` }, text);
}

function formatAge(seconds) {
  if (seconds == null) return "jamais";
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86400)} j`;
}

function formatDate(iso) {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "—";
}

// Agents before 1.3.0 still report virtual printers.
const VIRTUAL_PRINTER = /OneNote|Print to PDF|XPS Document Writer|^Fax$/i;

// Spooler printer status flags (Get-Printer PrinterStatus) → label, severity.
const PRINTER_STATUS = {
  Error: ["Erreur", "bad"],
  PaperJam: ["Bourrage", "bad"],
  PaperOut: ["Plus de papier", "bad"],
  PaperProblem: ["Problème papier", "bad"],
  OutputBinFull: ["Bac de sortie plein", "bad"],
  NoToner: ["Plus d'encre", "bad"],
  DoorOpen: ["Capot ouvert", "bad"],
  UserIntervention: ["Intervention requise", "bad"],
  OutOfMemory: ["Mémoire pleine", "bad"],
  Offline: ["Hors ligne", "bad"],
  ServerOffline: ["Hors ligne", "bad"],
  NotAvailable: ["Indisponible", "bad"],
  Paused: ["En pause", "warn"],
  ManualFeed: ["Alimentation manuelle", "warn"],
  TonerLow: ["Encre faible", "warn"],
  DriverUpdateNeeded: ["Pilote à mettre à jour", "warn"],
  PendingDeletion: ["Suppression en cours", "warn"],
  WarmingUp: ["Préchauffage", "muted"],
  Initializing: ["Démarrage", "muted"],
  PowerSave: ["Veille", "muted"],
  Waiting: ["En attente", "muted"],
  Printing: ["Impression", "ok"],
  Processing: ["Impression", "ok"],
  Busy: ["Impression", "ok"],
  IoActive: ["Impression", "ok"],
};

// Win32_Printer.DetectedErrorState → label, severity.
const ERROR_STATE = {
  3: ["Papier faible", "warn"],
  4: ["Plus de papier", "bad"],
  5: ["Encre faible", "warn"],
  6: ["Plus d'encre", "bad"],
  7: ["Capot ouvert", "bad"],
  8: ["Bourrage", "bad"],
  9: ["Hors ligne", "bad"],
  10: ["Maintenance requise", "bad"],
  11: ["Bac de sortie plein", "bad"],
};

const JOB_STATUS = {
  Printing: "Impression", Spooling: "Envoi", Paused: "En pause", Error: "Erreur",
  Offline: "Hors ligne", PaperOut: "Plus de papier", Blocked: "Bloqué",
  UserIntervention: "Intervention requise", Deleting: "Suppression",
  Printed: "Imprimé", Complete: "Imprimé", Normal: "En attente",
};

// A job waiting longer than this means the queue is stuck.
const STUCK_JOB_SECONDS = 120;

function asList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

// Returns [[label, severity], ...] describing the printer's state.
function printerProblems(p) {
  if (p.connected === false) return [["Débranchée", "bad"]];

  const flags = String(p.status || "").split(",").map((f) => f.trim()).filter(Boolean);
  const states = [];

  if (p.workOffline && !flags.includes("Offline")) states.push(["Hors ligne", "bad"]);
  for (const flag of flags) if (PRINTER_STATUS[flag]) states.push(PRINTER_STATUS[flag]);
  if (ERROR_STATE[p.errorState]) states.push(ERROR_STATE[p.errorState]);
  const dnpState = dnpStatus(p.dnp?.statusCode);
  if (dnpState) states.push(dnpState);

  // Deduplicate labels (e.g. PaperOut flag + "no paper" error state).
  return states.filter(([label], i) => states.findIndex(([l]) => l === label) === i);
}

function isPrinterInTrouble(p) {
  return printerProblems(p).some(([, severity]) => severity === "bad")
    || (Number(p.oldestJobSeconds) || 0) > STUCK_JOB_SECONDS;
}

function queueView(p, key) {
  const count = Number(p.queueJobs) || 0;
  if (count === 0) return badge("File vide", "muted");

  const oldest = Number(p.oldestJobSeconds) || 0;
  const stuck = oldest > STUCK_JOB_SECONDS;
  const label = `${count} en file` + (stuck ? ` · bloquée ${formatDuration(oldest)}` : "");

  const jobs = asList(p.jobs).map((job) => {
    const flag = String(job.status || "").split(",")[0].trim();
    const pages = job.totalPages ? ` · ${job.pagesPrinted || 0}/${job.totalPages} p.` : "";
    return el("li", {}, `${job.document || "Sans nom"} — ${JOB_STATUS[flag] || flag || "?"}${pages}`);
  });

  if (jobs.length === 0) return badge(label, stuck ? "bad" : "warn");

  const details = el("details", { class: "jobs" },
    el("summary", {}, badge(label, stuck ? "bad" : "warn")),
    el("ul", {}, ...jobs),
  );
  details.dataset.key = key;
  return details;
}

// DNP "STATUS" code names, sent by the server (lib/printer-alerts.js).
let dnpCodes = {};

function dnpLabel(code) {
  return dnpCodes[code] || `Code ${code}`;
}

// 1 printing, 500/510/900 normal waiting states, >= 1000 errors.
function dnpStatus(code) {
  if (!Number.isInteger(code) || code === 0) return null;
  if (code === 1) return ["Impression", "ok"];
  if (code >= 1000) return [`${dnpLabel(code)} (${code})`, "bad"];
  return [dnpLabel(code), "muted"];
}

// Prints left on a DNP printer's media (agent >= 1.6.0, DNP over USB only).
const LOW_MEDIA = 50;

function mediaView(dnp) {
  if (!dnp) return null;

  const left = dnp.mediaRemaining;
  const details = [dnp.media && `Média ${dnp.media}`, ...asList(dnp.errors)].filter(Boolean).join(" · ");

  if (left === null || left === undefined) {
    // The printer is plugged in but did not answer the agent's query.
    if (asList(dnp.errors).length > 0) {
      return el("span", { class: "badge bad", title: details }, "Ne répond pas");
    }
    return el("span", { class: "badge muted", title: details || "Compteur DNP indisponible" }, "Tirages ?");
  }

  const kind = left === 0 ? "bad" : left < LOW_MEDIA ? "warn" : "ok";
  return el("span", { class: `badge ${kind}`, title: details }, `${left} tirage${left > 1 ? "s" : ""}`);
}

function printersCell(boothId, printers) {
  const list = asList(printers).filter((p) => !VIRTUAL_PRINTER.test(p.name || ""));

  if (list.length === 0) return el("span", { class: "hint" }, "Aucune");

  return el("ul", { class: "printers" }, ...list.map((p) => {
    const problems = printerProblems(p);
    const connection = p.connection === "usb" ? "USB" : p.connection === "network" ? "Réseau" : null;

    // Older agents (< 1.4.0) don't report connection/queue details.
    const ready = p.connected === true && !problems.some(([, s]) => s === "bad")
      && !problems.some(([label]) => label === "Impression");

    // Two lines on phones (state + name / connection + queue), one on desktop.
    return el("li", {},
      el("div", { class: "printer-line" },
        ...problems.map(([label, severity]) => badge(label, severity)),
        ready ? badge("Prête", "ok") : null,
        p.default ? el("span", { class: "star", title: "Imprimante par défaut de Windows" }, "★") : null,
        el("span", { class: "printer-name", title: p.name || "" }, p.name || "?"),
      ),
      el("div", { class: "printer-line" },
        connection ? el("span", { class: "hint" }, connection) : null,
        p.connected === false ? null : mediaView(p.dnp),
        p.connected === false ? null : queueView(p, `${boothId}|${p.name}`),
      ),
    );
  }));
}

// Type: chosen once in the dashboard, then read-only.
function typeCell(booth) {
  if (booth.type) return el("span", { class: "nowrap" }, booth.type);

  const select = el("select", {
    class: "type-select",
    title: "Type de booth (définitif)",
    onchange: () => setType(booth.boothId, select.value, select),
  },
    el("option", { value: "" }, "Sans type"),
    ...boothTypes.map((type) => el("option", { value: type }, type)),
  );
  return select;
}

async function setType(boothId, type, select) {
  if (!type) return;

  if (!confirm(`${boothId} est un « ${type} » ?

Ce choix ne pourra plus être modifié dans le dashboard.`)) {
    select.value = "";
    select.blur();
    return;
  }

  try {
    await api(`/api/booths?id=${encodeURIComponent(boothId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
  } catch (error) {
    showError(error.message);
  }
  refresh();
}

// Arduino boards seen as USB serial ports (agent >= 1.13.0). The COM number
// matters to the booth software; without its driver a board has no COM port.
// Smart Flash (Arduino) column. A plugged board says how the lights work:
// "Modulable" (Smart Flash on) or "Fixe" (always 100 %), as written in the
// booth's script when known; a wrong lights script turns it red.
function arduinoCell(boards, lights, smartFlash) {
  if (boards === undefined) return el("span", { class: "hint" }, "?");

  const list = asList(boards);
  if (list.length === 0) return el("span", { class: "hint", title: "Aucune carte Arduino vue par Windows" }, "Aucune");

  const scriptError = lightsError(lights, list);

  // Same layout as the printers: state badge first, then the port.
  const plugged = list.filter((board) => board.present);
  const shown = plugged.length ? plugged : list;

  return el("ul", { class: "printers" }, ...shown.map((board) => {
    const [label, kind] = !board.present ? ["Débranchée", "warn"]
      : board.driverMissing ? ["Pilote manquant", "bad"]
      : scriptError ? ["Erreur de script", "bad"]
      : lightsFixed(lights, smartFlash) ? ["Fixe", "ok"]
      : ["Modulable", "ok"];
    return el("li", { title: `${board.name || "?"} (${board.usbId || "?"})` },
      badge(label, kind),
      el("span", {}, board.com || board.name || "?"),
    );
  }));
}

// Smart Flash on/off (booth.smartFlash, server side): off, the lights script
// always sends FIXED_BRIGHTNESS (lights on a generator). Applied by the booth
// within about 1 min (agent >= 1.28.0).
function smartFlashSwitch(booth, onDone = refresh) {
  const s = booth.status || {};
  if (!s.lights && asList(s.arduino).length === 0) return null;

  const input = el("input", {
    type: "checkbox",
    onchange: () => setSmartFlash(booth.boothId, input.checked, onDone),
  });
  input.checked = booth.smartFlash !== false;

  const pending = lightsPending(booth);

  return el("label", {
    class: "switch",
    title: booth.smartFlash !== false
      ? "Smart Flash activé : lumières modulées pendant la session (MIN / MAX)"
      : "Smart Flash désactivé : MIN et MAX forcés à 100, lumières toujours à 100 (générateur)",
  },
    input,
    el("span", { class: "switch-track" }),
    el("span", {}, booth.smartFlash !== false ? "ON" : "OFF"),
    pending ? el("span", { class: "hint" }, "(en cours d'application)") : null,
  );
}

// Script on the booth not yet matching the dashboard (agent applies changes
// within about a minute). Off: MIN = MAX = 100; on: the saved MIN / MAX.
function lightsPending(booth) {
  const lights = (booth.status || {}).lights;
  if (!lights || !Number.isInteger(lights.min)) return false;
  const wanted = booth.smartFlash === false ? { min: 100, max: 100 } : booth.lightsSettings;
  if (!wanted) return booth.smartFlash !== false && lights.min === 100 && lights.max === 100;
  return lights.min !== wanted.min || lights.max !== wanted.max;
}

// Lights fixed at 100 (Smart Flash off, or MIN = MAX = 100 in the script).
function lightsFixed(lights, smartFlash) {
  if (lights && lights.smartFlash != null) return lights.smartFlash === false;
  if (lights && Number.isInteger(lights.min)) return lights.min === 100 && lights.max === 100;
  return smartFlash === false;
}

async function setSmartFlash(boothId, activated, onDone) {
  try {
    await api(`/api/booths?id=${encodeURIComponent(boothId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ smartFlash: activated }),
    });
  } catch (error) {
    showError(error.message);
  }
  onDone();
}

// What is wrong with the lights script, or null.
function lightsError(lights, boards) {
  if (!lights) return null;
  if (lights.missing) return "script absent";

  let expected = lights.expected;
  if (expected === undefined) {
    const plugged = asList(boards).find((b) => b.present && b.com && !b.driverMissing);
    expected = plugged ? plugged.com : lights.com;
  }
  if (lights.com !== expected) return `script sur ${lights.com || "aucun port"}, carte sur ${expected}`;
  if (lights.ok === false) return "script modifié";
  return null;
}

function lightsNote(lights, boards) {
  if (!lights) return null;
  const error = lightsError(lights, boards);
  const title = `${lights.path}${lights.com ? ` (${lights.com})` : ""}${error ? ` : ${error}` : ""}`;
  return el("div", { class: "hint", title }, error ? "Erreur de script" : "Script OK");
}

// "Programmes" column: one line per thing the agent installs or checks,
// a green check when it is fine, a red cross when it is not.
function check(ok, text, title, ...extra) {
  // Mark and text never split over two lines; only the badge may wrap.
  return el("li", { class: "check", title: title || "" },
    el("span", { class: "check-label" },
      el("span", { class: `mark ${ok ? "ok" : "bad"}` }, ok ? "✓" : "✗"),
      " ",
      text),
    ...extra);
}

// dslrBooth / LumaBooth window right now (agent >= 1.20.0): fullscreen is
// expected during an event.
const WINDOW_STATES = {
  fullscreen: ["Plein écran", "ok"],
  maximized: ["Maximisé", "ok"],
  normal: ["Fenêtré", "warn"],
  minimized: ["Réduit", "warn"],
  hidden: ["Caché", "warn"],
};

function softwareChecks(software) {
  return asList(software).map((app) => {
    const [label, kind] = !app.running ? ["Fermé", "warn"] : WINDOW_STATES[app.window] || ["Ouvert", "ok"];
    const title = app.running
      ? `Lancé le ${formatDate(app.startedAt)}${app.window ? "" : " (état de la fenêtre inconnu : popup helper absent)"}`
      : `${app.app} n'est pas lancé`;
    return check(true, `${app.app} ${app.version || "?"}`, title, badge(label, kind));
  });
}

// Fonts from the shared Drive folder (agent >= 1.14.0).
function fontsCheck(fonts) {
  if (!fonts) return null;
  const missing = asList(fonts.missing);
  return missing.length === 0
    ? check(true, "Polices", `${fonts.expected} polices vérifiées le ${formatDate(fonts.checkedAt)}`)
    : check(false, `Polices : ${missing.length} manquante${missing.length > 1 ? "s" : ""}`, `Non installées : ${missing.join(", ")}`);
}

// Drivers the booth type needs (agent >= 1.15.0); "manual" ones (Citizen)
// are only checked (agent >= 1.22.0).
// The Arduino (CH341) driver is not listed: the Smart Flash badge already says
// "Pilote manquant" when it is missing.
function driverChecks(drivers) {
  return asList(drivers).filter((d) => !/arduino/i.test(d.name || "")).map((d) => d.installed
    ? check(true, `Pilote ${d.name}`)
    : d.manual
      ? check(false, `Pilote ${d.name} : à installer à la main`, "Pas installé automatiquement par l'agent")
      : check(false, `Pilote ${d.name} : ${d.error ? "erreur" : "manquant"}`, d.error || ""));
}

// Welcome video put where dslrBooth / LumaBooth expect it (agent >= 1.17.0).
function videoCheck(video) {
  if (!video) return null;
  const targets = asList(video.targets);
  if (targets.length === 0) return check(false, "Vidéo d'accueil : ni dslrBooth ni LumaBooth trouvé");
  const title = targets.map((t) => `${t.ok ? "OK" : "ERREUR"} ${t.path}${t.error ? " : " + t.error : ""}`).join("\n");
  return targets.every((t) => t.ok)
    ? check(true, `Vidéo d'accueil (${video.app})`, title)
    : check(false, `Vidéo d'accueil (${video.app}) : erreur`, title);
}

// Kiosk settings applied at power-on on booths (agent >= 1.22.0): no sleep,
// lock, screensaver, notifications; startup shortcut maximized.
const KIOSK_PARTS = { power: "veille et écran", updates: "redémarrages Windows Update", users: "écran de veille et notifications", shortcuts: "raccourci de démarrage" };

function kioskCheck(kiosk) {
  if (!kiosk) return null;
  const errors = asList(kiosk.errors);
  const title = [
    `Appliqué le ${formatDate(kiosk.appliedAt)}`,
    ...asList(kiosk.done).map((part) => `OK : ${KIOSK_PARTS[part] || part}`),
    ...errors.map((error) => `ERREUR ${error}`),
    kiosk.shortcutsFixed ? `${kiosk.shortcutsFixed} raccourci(s) passé(s) en maximisé` : null,
    kiosk.autoLogon ? `Ouverture de session automatique : ${kiosk.autoLogon}` : "Pas d'ouverture de session automatique configurée",
  ].filter(Boolean).join("\n");
  return check(errors.length === 0, errors.length ? "Mode kiosque : erreur" : "Mode kiosque", title);
}

// Apps and programs removed from booths at power-on (agent >= 1.25.0): only
// shown when something could not be removed.
function cleanupCheck(cleanup) {
  if (!cleanup) return null;
  const removed = asList(cleanup.removed);
  const errors = asList(cleanup.errors);
  if (errors.length === 0) return null;
  const title = [
    `Vérifié le ${formatDate(cleanup.at)}`,
    removed.length ? `Retiré : ${removed.join(", ")}` : "Rien à retirer",
    ...errors.map((error) => `ERREUR ${error}`),
  ].join("\n");
  const text = errors.length ? `Nettoyage : ${errors.length} erreur${errors.length > 1 ? "s" : ""}`
    : removed.length ? `Nettoyage (${removed.length} retiré${removed.length > 1 ? "s" : ""})` : "Nettoyage";
  return check(errors.length === 0, text, title);
}

// Programs the agent installs on booths when missing (agent >= 1.24.0).
function installChecks(installs) {
  return asList(installs).map((p) => p.installed
    ? check(true, p.name)
    : check(false, `${p.name} : installation en erreur`, p.error || ""));
}

function programsCell(s) {
  const items = [
    ...softwareChecks(s.software),
    check(Boolean(s.agentVersion), `Agent ${s.agentVersion || "?"}`),
    fontsCheck(s.fonts),
    ...driverChecks(s.drivers),
    videoCheck(s.startScreenVideo),
    kioskCheck(s.kiosk),
    cleanupCheck(s.cleanup),
    ...installChecks(s.installs),
  ].filter(Boolean);
  return el("ul", { class: "checks" }, ...items);
}

// Network used to reach the internet (agent >= 1.7.0).
const NETWORK_TYPES = { ethernet: "Câble", wifi: "Wi-Fi", cellular: "4G/5G", other: "Autre" };

// Link quality (agent >= 1.8.0): ping latency/loss to 1.1.1.1, Wi-Fi signal.
// Returns [severity, reasons].
function networkQuality(n) {
  const bad = [];
  const warn = [];
  const latency = n.latencyMs;
  const loss = n.packetLoss;

  if (Number.isFinite(loss) && loss >= 60) bad.push(`${loss} % de perte`);
  else if (Number.isFinite(loss) && loss > 0) warn.push(`${loss} % de perte`);

  if (Number.isFinite(latency) && latency >= 400) bad.push(`latence ${latency} ms`);
  else if (Number.isFinite(latency) && latency >= 150) warn.push(`latence ${latency} ms`);

  if (n.type === "wifi" && Number.isFinite(n.signal)) {
    if (n.signal < 25) bad.push(`signal ${n.signal} %`);
    else if (n.signal < 50) warn.push(`signal ${n.signal} %`);
  }

  if (n.failedHeartbeats > 0) warn.push(`${n.failedHeartbeats} envoi(s) raté(s)`);

  return bad.length ? ["bad", [...bad, ...warn]] : warn.length ? ["warn", warn] : ["ok", []];
}

function networkCell(s) {
  const n = s.network;

  if (!n) return s.internet === false ? badge("Pas d'internet", "bad") : el("span", { class: "hint" }, "?");

  const label = NETWORK_TYPES[n.type] || n.type;

  if (s.internet === false) return badge(`${label} · pas d'internet`, "bad");

  const [kind, reasons] = networkQuality(n);
  const text = Number.isFinite(n.latencyMs) ? `${label} · ${n.latencyMs} ms` : label;
  const title = [
    ...reasons,
    n.description,
    n.linkSpeed,
    n.signal != null ? `signal ${n.signal} %` : null,
    n.heartbeatMs != null ? `envoi dashboard ${n.heartbeatMs} ms` : null,
  ].filter(Boolean).join(" · ");

  return el("span", { class: "network", title },
    badge(text, kind),
    n.name ? el("span", { class: "hint" }, n.name) : null,
    reasons.length ? el("span", { class: "hint" }, reasons[0]) : null,
  );
}

// Printer alert popups shown on the booth screen (agent >= 1.10.0).
const POPUP_LABELS = { paper: "Plus de papier", jam: "Bourrage", open: "Imprimante ouverte", error: "Problème d'imprimante" };

// Booth-wide printing notes shown above the printers list: Windows print
// service stopped (nothing prints at all), popup currently on the booth screen.
function boothPrinterNotes(spooler, popupShown) {
  const notes = [];

  if (spooler && String(spooler).toLowerCase() !== "running") {
    notes.push(el("span", { title: `Service d'impression Windows : ${spooler}` }, badge("Spouleur arrêté", "bad")));
  }

  if (popupShown) {
    notes.push(el("span", { class: "hint", title: "Popup affichée sur l'écran du booth" },
      `popup « ${POPUP_LABELS[popupShown] || popupShown} » à l'écran`));
  }

  return notes.length ? el("div", { class: "printer-notes" }, ...notes) : null;
}

function boothRow(booth) {
  const s = booth.status || {};

  const forget = booth.online ? null :
    el("button", { type: "button", class: "small", onclick: () => forgetBooth(booth.boothId) }, "Retirer");

  // State and network in one cell: online, the network used and its quality
  // ("Câble · 27 ms"); offline, "Hors ligne". Offline, everything else is the
  // last known status, shown grey.
  let state;
  if (booth.online) {
    state = s.network || s.internet === false ? networkCell(s) : badge("En ligne", "ok");
  } else {
    state = badge("Hors ligne", "bad");
    state.classList.add("keep");
  }

  return el("tr", {
    class: booth.online ? "" : "offline",
    title: booth.online ? "" : `Hors ligne : dernières infos reçues le ${formatDate(booth.receivedAt)}`,
  },
    el("td", { class: "booth" }, booth.boothId),
    el("td", {}, typeCell(booth)),
    el("td", { class: "nowrap", title: formatDate(booth.receivedAt) },
      state,
      el("div", { class: "hint" }, formatAge(booth.ageSeconds))),
    el("td", {}, arduinoCell(s.arduino, s.lights, booth.smartFlash), lightsNote(s.lights, s.arduino)),
    el("td", { class: "printers-cell" },
      boothPrinterNotes(s.spooler, s.printerAlert || (s.paperOutPopup ? "paper" : null)),
      printersCell(booth.boothId, s.printers)),
    el("td", {}, programsCell(s)),
    el("td", {}, forget),
  );
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function showLogin() {
  clearTimeout(timer);
  $("login").hidden = false;
  $("logout").hidden = true;
  $("tabs").hidden = true;
  $("view-config").hidden = true;
  $("booths").replaceChildren();
  $("fleet").hidden = true;
  $("empty").hidden = true;
  $("summary").textContent = "";
  $("updated").textContent = "";
  $("token").focus();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (response.status === 401) {
    token = "";
    writeToken("");
    showLogin();
    throw new Error("Mot de passe incorrect.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erreur HTTP ${response.status}`);
  return data;
}

async function refresh() {
  clearTimeout(timer);
  if (!token) return showLogin();

  try {
    // Do not rebuild the table while a type list is open.
    if (document.activeElement?.classList.contains("type-select")) {
      timer = setTimeout(refresh, REFRESH_MS);
      return;
    }

    const data = await api("/api/booths");
    boothTypes = data.boothTypes || [];
    brightnessRange = data.brightnessRange || brightnessRange;
    dnpCodes = data.dnpCodes || dnpCodes;
    flagUnknownCodes(asList(data.unknownCodesSeen));
    const booths = data.booths || [];
    const online = booths.filter((b) => b.online).length;
    const troubled = booths
      .filter((b) => b.online)
      .flatMap((b) => asList(b.status?.printers))
      .filter((p) => !VIRTUAL_PRINTER.test(p.name || "") && isPrinterInTrouble(p)).length;

    $("login").hidden = true;
    $("logout").hidden = false;
    if ($("tabs").hidden) {
      $("tabs").hidden = false;
      showTab(currentTab);
    }
    showError("");
    $("summary").textContent = `${online}/${booths.length} en ligne`
      + (troubled ? ` · ${troubled} imprimante${troubled > 1 ? "s" : ""} en défaut` : "");
    $("updated").textContent = `MAJ ${new Date().toLocaleTimeString()}`;
    $("empty").hidden = booths.length > 0;
    $("fleet").hidden = booths.length === 0;
    // Keep expanded print queues open across refreshes.
    const open = new Set([...document.querySelectorAll("details.jobs[open]")].map((d) => d.dataset.key));
    $("booths").replaceChildren(...booths.map(boothRow));
    for (const d of document.querySelectorAll("details.jobs")) d.open = open.has(d.dataset.key);
  } catch (error) {
    showError(error.message);
  }

  if (token) timer = setTimeout(refresh, REFRESH_MS);
}

async function forgetBooth(boothId) {
  if (!confirm(`Retirer ${boothId} du dashboard ? Il réapparaîtra à son prochain heartbeat.`)) return;
  try {
    await api(`/api/booths?id=${encodeURIComponent(boothId)}`, { method: "DELETE" });
  } catch (error) {
    showError(error.message);
  }
  refresh();
}

$("login").addEventListener("submit", (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  writeToken(token);
  $("token").value = "";
  refresh();
});

// Tabs: booths table / read-only popup configuration.
let currentTab = location.hash === "#config" ? "config" : "booths";
let configLoaded = false;

function showTab(tab) {
  currentTab = tab;
  $("view-booths").hidden = tab !== "booths";
  $("view-config").hidden = tab !== "config";
  for (const button of document.querySelectorAll("#tabs button")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  try { history.replaceState(null, "", tab === "config" ? "#config" : location.pathname); } catch { /* ignore */ }
  if (tab === "config") loadConfig();
}

for (const button of document.querySelectorAll("#tabs button")) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}

function triggerLabels(alert) {
  const labels = asList(alert.codes).map((code) => {
    return `${dnpLabel(code)} (${code})`;
  });
  if (alert.whenEmpty) labels.push("0 tirage restant");
  if (alert.otherErrors) labels.push("Toute autre erreur (code ≥ 1000)");
  return labels;
}

function alertRow(alert) {
  return el("tr", {},
    el("td", {}, el("ul", { class: "triggers" }, ...triggerLabels(alert).map((label) => el("li", {}, label)))),
    el("td", {},
      el("div", { class: "popup-title" }, alert.title),
      el("div", {}, alert.message),
      el("div", { class: "hint" }, alert.detail),
    ),
    el("td", { class: "qr-cell" },
      alert.url
        ? el("a", { href: alert.url, target: "_blank", rel: "noopener noreferrer", title: alert.url },
            el("img", { src: alert.qrDataUrl, alt: `QR code vers ${alert.url}`, width: 88, height: 88 }),
            el("div", {}, "Voir la vidéo"))
        : el("span", { class: "hint" }, "Pas de QR code"),
    ),
  );
}

function typeCard(entry) {
  const alerts = asList(entry.alerts);

  return el("article", { class: "config-card" },
    el("h2", {}, entry.type),
    entry.note ? el("p", { class: "hint" }, entry.note) : null,
    alerts.length === 0 ? null : el("div", { class: "table-wrap" },
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Déclenchée par"), el("th", {}, "Popup à l'écran"), el("th", {}, "QR code"))),
        el("tbody", {}, ...alerts.map(alertRow)),
      ),
    ),
    alerts.length === 0 ? null : el("p", { class: "hint" },
      "Bouton OK : réduit la popup en pastille « ! » en bas à droite de l'écran ; un appui dessus la rouvre. Un nouveau problème rouvre la popup. Tout disparaît seul quand l'imprimante est de nouveau prête."),
  );
}

function flagUnknownCodes(codes) {
  const button = document.querySelector('#tabs button[data-tab="config"]');
  if (!button) return;
  const n = codes.length;
  button.textContent = n ? `Configuration · ${n} code${n > 1 ? "s" : ""} inconnu${n > 1 ? "s" : ""}` : "Configuration";
  button.classList.toggle("warn", n > 0);
}

// Every DNP code ever reported by a booth; unknown ones need identifying.
function codesCard(codesSeen) {
  const weekAgo = Date.now() - 7 * 86400000;
  const rows = asList(codesSeen).map((entry) => {
    const known = entry.code in dnpCodes;
    const isNew = Date.parse(entry.firstSeen) > weekAgo;
    return el("tr", {},
      el("td", { class: "nowrap" }, String(entry.code)),
      el("td", {},
        known ? dnpLabel(entry.code) : badge("Inconnu — à identifier", "warn"),
        isNew ? el("span", { class: "hint" }, " · nouveau") : null,
      ),
      el("td", { class: "nowrap" }, formatDate(entry.firstSeen), el("div", { class: "hint" }, entry.firstBooth)),
      el("td", { class: "nowrap" }, formatDate(entry.lastSeen), el("div", { class: "hint" }, entry.lastBooth)),
      el("td", { class: "nowrap" }, String(entry.count)),
    );
  });

  return el("article", { class: "config-card" },
    el("h2", {}, "Codes reçus des imprimantes"),
    el("p", { class: "hint" }, "Chaque code d'état DNP remonté par un booth, depuis la mise en place du suivi. Un code inconnu n'est pas dans la liste de référence : il déclenche la popup « Problème d'imprimante » s'il est ≥ 1000."),
    rows.length === 0 ? el("p", { class: "hint" }, "Aucun code reçu pour l'instant.") : el("div", { class: "table-wrap" },
      el("table", {},
        el("thead", {}, el("tr", {},
          el("th", {}, "Code"), el("th", {}, "Signification"), el("th", {}, "Premier relevé"),
          el("th", {}, "Dernier relevé"), el("th", {}, "Relevés"))),
        el("tbody", {}, ...rows),
      ),
    ),
  );
}

// Smart Flash settings per booth (Configuration tab): on/off, MIN and MAX
// brightness. "Dans le script" is what the booth reads in its lights script
// (agent >= 1.29.0); a change is applied by the booth within about 1 min.
const DEFAULT_LIGHTS = { min: 9, max: 80 };

function smartFlashRow(booth) {
  const s = booth.status || {};
  const lights = s.lights || {};
  const wanted = booth.lightsSettings || {};
  const current = {
    min: Number.isInteger(wanted.min) ? wanted.min : Number.isInteger(lights.min) ? lights.min : DEFAULT_LIGHTS.min,
    max: Number.isInteger(wanted.max) ? wanted.max : Number.isInteger(lights.max) ? lights.max : DEFAULT_LIGHTS.max,
  };

  const range = brightnessRange;
  const minInput = el("input", { type: "number", class: "num-input", min: range.min, max: range.max, step: 1 });
  const maxInput = el("input", { type: "number", class: "num-input", min: range.min, max: range.max, step: 1 });
  minInput.value = String(current.min);
  maxInput.value = String(current.max);
  const off = booth.smartFlash === false;
  if (off) {
    // Off: the booth uses 100 / 100; the saved values come back when on.
    minInput.disabled = true;
    maxInput.disabled = true;
    minInput.title = maxInput.title = "Smart Flash désactivé : 100 / 100 sur le booth";
  }

  const save = el("button", {
    type: "button",
    class: "small",
    disabled: off,
    onclick: () => saveLightsSettings(booth.boothId, minInput, maxInput, save),
  }, "Enregistrer");

  const inScript = Number.isInteger(lights.min) ? `MIN ${lights.min} · MAX ${lights.max}` : "pas encore remonté";
  const pending = lightsPending(booth);

  return el("tr", {},
    el("td", { class: "booth" }, booth.boothId, booth.online ? null : el("div", { class: "hint" }, "hors ligne")),
    el("td", {}, smartFlashSwitch(booth, loadConfig)),
    el("td", {}, minInput),
    el("td", {}, maxInput),
    el("td", {}, save),
    el("td", { class: "nowrap" }, el("span", { class: "hint" }, inScript),
      pending ? el("div", { class: "hint" }, "en cours d'application") : null),
  );
}

async function saveLightsSettings(boothId, minInput, maxInput, button) {
  const min = Number(minInput.value);
  const max = Number(maxInput.value);
  const range = brightnessRange;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < range.min || max > range.max || min > max) {
    showError(`MIN et MAX : nombres entiers de ${range.min} à ${range.max}, MIN ≤ MAX.`);
    return;
  }

  button.disabled = true;
  try {
    await api(`/api/booths?id=${encodeURIComponent(boothId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lightsMin: min, lightsMax: max }),
    });
    showError("");
  } catch (error) {
    showError(error.message);
  }
  button.disabled = false;
  loadConfig();
}

function smartFlashCard(booths) {
  const rows = asList(booths)
    .filter((booth) => booth.status && (booth.status.lights || asList(booth.status.arduino).length))
    .map(smartFlashRow);

  return el("article", { class: "config-card" },
    el("h2", {}, "Smart Flash"),
    el("p", { class: "hint" },
      "Lumières pilotées par la carte Arduino : MIN au repos, montée de MIN à MAX pendant le compte à rebours, MAX pour la photo. Modifie MIN ou MAX puis Enregistrer : le booth réécrit son script en 1 min environ, « Dans le script » montre ce qu'il lit vraiment."),
    rows.length === 0 ? el("p", { class: "hint" }, "Aucun booth avec une carte Smart Flash.") : el("div", { class: "table-wrap" },
      el("table", {},
        el("thead", {}, el("tr", {},
          el("th", {}, "Booth"), el("th", {}, "Smart Flash"), el("th", {}, "MIN"), el("th", {}, "MAX"),
          el("th", {}, ""), el("th", {}, "Dans le script"))),
        el("tbody", {}, ...rows),
      ),
    ),
  );
}

async function loadConfig() {
  try {
    const [data, boothsData] = await Promise.all([api("/api/printer-alerts"), api("/api/booths")]);
    dnpCodes = data.dnpCodes || dnpCodes;
    brightnessRange = boothsData.brightnessRange || brightnessRange;
    $("config").replaceChildren(smartFlashCard(boothsData.booths), codesCard(data.codesSeen), ...asList(data.types).map(typeCard));
    configLoaded = true;
  } catch (error) {
    showError(error.message);
  }
}

$("logout").addEventListener("click", () => {
  configLoaded = false;
  $("config").replaceChildren();
  token = "";
  writeToken("");
  showError("");
  showLogin();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token) refresh();
});

refresh();
