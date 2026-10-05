"use strict";

const REFRESH_MS = 15000;
const TOKEN_KEY = "photobooth-dashboard-token";

const $ = (id) => document.getElementById(id);

let token = readToken();
let timer = null;
let boothTypes = [];

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

// The booth's main printer: the DNP when there is one, else the default
// printer, else the first connected one.
function mainPrinter(printers) {
  const list = asList(printers).filter((p) => !VIRTUAL_PRINTER.test(p.name || ""));
  return list.find((p) => p.dnp)
    || list.find((p) => p.default && p.connected !== false)
    || list.find((p) => p.connected === true)
    || list[0];
}

// Printer alert popups shown on the booth screen (agent >= 1.10.0).
const POPUP_LABELS = { paper: "Plus de papier", jam: "Bourrage", open: "Imprimante ouverte", error: "Problème d'imprimante" };

function printerSummary(printers, spooler, popupShown) {
  // Windows print service: when it is stopped, nothing prints at all.
  if (spooler && String(spooler).toLowerCase() !== "running") {
    return el("span", { title: `Service d'impression Windows : ${spooler}` }, badge("Spouleur arrêté", "bad"));
  }

  const p = mainPrinter(printers);
  if (!p) return el("span", { class: "hint" }, "Aucune");

  const states = printerProblems(p);
  if ((Number(p.oldestJobSeconds) || 0) > STUCK_JOB_SECONDS) states.push(["File bloquée", "bad"]);

  const all = states.map(([label]) => label).join(" · ");
  const pick = (severity) => states.find(([, s]) => s === severity);
  const [label, kind] = pick("bad") || pick("warn")
    || states.find(([l]) => l === "Impression")
    || (p.connected === true ? ["Prête", "ok"] : ["?", "muted"]);

  return el("span", { class: "network", title: `${p.name}${all ? " — " + all : ""}` },
    badge(label, kind),
    popupShown ? el("span", { class: "hint", title: "Popup affichée sur l'écran du booth" }, `popup « ${POPUP_LABELS[popupShown] || popupShown} » à l'écran`) : null,
  );
}

function boothRow(booth) {
  const s = booth.status || {};

  const forget = booth.online ? null :
    el("button", { type: "button", class: "small", onclick: () => forgetBooth(booth.boothId) }, "Retirer");

  return el("tr", { class: booth.online ? "" : "offline" },
    el("td", { class: "booth" }, booth.boothId),
    el("td", {}, typeCell(booth)),
    el("td", {}, booth.online ? badge("En ligne", "ok") : badge("Hors ligne", "bad")),
    el("td", {}, printerSummary(s.printers, s.spooler, s.printerAlert || (s.paperOutPopup ? "paper" : null))),
    el("td", { class: "nowrap", title: formatDate(booth.receivedAt) }, formatAge(booth.ageSeconds)),
    el("td", {}, networkCell(s)),
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
  if (tab === "config" && !configLoaded) loadConfig();
}

for (const button of document.querySelectorAll("#tabs button")) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}

function triggerLabels(alert) {
  const labels = asList(alert.codes).map((code) => {
    const known = DNP_STATUS[code];
    return `${known ? known[0] : "Code"} (${code})`;
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
  const snooze = alerts[0]?.snoozeMinutes;

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
      `Bouton OK : masque la popup ${snooze || 1} min. Elle disparaît seule quand l'imprimante est de nouveau prête.`),
  );
}

async function loadConfig() {
  try {
    const data = await api("/api/printer-alerts");
    $("config").replaceChildren(...asList(data.types).map(typeCard));
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
