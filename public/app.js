"use strict";

const REFRESH_MS = 15000;
const TOKEN_KEY = "photobooth-dashboard-token";

const $ = (id) => document.getElementById(id);

let token = readToken();
let timer = null;

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

// DNP "STATUS" codes (agent >= 1.6.1), as listed by Gutenprint's DNP backend.
const DNP_STATUS = {
  1: ["Impression", "ok"],
  500: ["Refroidissement", "muted"],
  510: ["Refroidissement", "muted"],
  900: ["Veille", "muted"],
  1000: ["Capot ouvert", "bad"],
  1010: ["Bac à chutes absent", "bad"],
  1100: ["Fin de papier", "bad"],
  1200: ["Fin de ruban", "bad"],
  1300: ["Bourrage", "bad"],
  1400: ["Erreur ruban", "bad"],
  1500: ["Mauvais papier", "bad"],
  1600: ["Erreur de données", "bad"],
};

function dnpStatus(code) {
  if (!Number.isInteger(code) || code === 0) return null;
  if (DNP_STATUS[code]) return DNP_STATUS[code];
  return code >= 1000 ? [`Panne imprimante (code ${code})`, "bad"] : null;
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

function boothRow(booth) {
  const s = booth.status || {};
  const spoolerOk = String(s.spooler || "").toLowerCase() === "running";

  const forget = booth.online ? null :
    el("button", { type: "button", class: "small", onclick: () => forgetBooth(booth.boothId) }, "Retirer");

  return el("tr", { class: booth.online ? "" : "offline" },
    el("td", { class: "booth" }, booth.boothId),
    el("td", {}, booth.online ? badge("En ligne", "ok") : badge("Hors ligne", "bad")),
    el("td", { class: "nowrap", title: formatDate(booth.receivedAt) }, formatAge(booth.ageSeconds)),
    el("td", {}, s.internet ? badge("OK", "ok") : badge("Coupé", "bad")),
    el("td", {}, badge(spoolerOk ? "OK" : s.spooler || "?", spoolerOk ? "ok" : "bad")),
    el("td", { class: "printers-cell" }, printersCell(booth.boothId, s.printers)),
    el("td", { class: "nowrap" }, s.agentVersion || "?"),
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
    headers: { Authorization: `Bearer ${token}` },
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
    const data = await api("/api/booths");
    const booths = data.booths || [];
    const online = booths.filter((b) => b.online).length;
    const troubled = booths
      .filter((b) => b.online)
      .flatMap((b) => asList(b.status?.printers))
      .filter((p) => !VIRTUAL_PRINTER.test(p.name || "") && isPrinterInTrouble(p)).length;

    $("login").hidden = true;
    $("logout").hidden = false;
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

$("logout").addEventListener("click", () => {
  token = "";
  writeToken("");
  showError("");
  showLogin();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token) refresh();
});

refresh();
