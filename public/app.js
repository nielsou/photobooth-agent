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

function printersTable(printers) {
  const list = Array.isArray(printers) ? printers : printers ? [printers] : [];
  if (list.length === 0) return el("p", { class: "hint" }, "Aucune imprimante détectée.");

  const rows = list.map((p) => {
    // Win32_Printer.Status is often "Unknown" for perfectly healthy printers.
    const status = String(p.status || "Unknown");
    const kind = status === "OK" ? "ok" : status === "Unknown" ? "muted" : "warn";
    const queue = Number(p.queueJobs) || 0;
    return el("tr", {},
      el("td", {}, p.name || "?", p.default ? " ★" : ""),
      el("td", {}, badge(status, kind)),
      el("td", { class: "num" }, queue > 0 ? badge(String(queue), "warn") : "0"),
    );
  });

  return el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Imprimante"), el("th", {}, "État"), el("th", { class: "num" }, "File"))),
    el("tbody", {}, ...rows),
  );
}

function boothCard(booth) {
  const s = booth.status || {};
  const spoolerOk = String(s.spooler || "").toLowerCase() === "running";

  const forget = booth.online ? null : el("div", { class: "card-foot" },
    el("button", { type: "button", onclick: () => forgetBooth(booth.boothId) }, "Retirer du dashboard"));

  return el("article", { class: `card ${booth.online ? "" : "offline"}` },
    el("div", { class: "card-head" },
      el("h2", {}, booth.boothId),
      booth.online ? badge("En ligne", "ok") : badge("Hors ligne", "bad"),
    ),
    el("dl", {},
      el("dt", {}, "Dernier heartbeat"), el("dd", { title: formatDate(booth.receivedAt) }, formatAge(booth.ageSeconds)),
      el("dt", {}, "Internet"), el("dd", {}, s.internet ? badge("OK", "ok") : badge("Pas d'accès", "bad")),
      el("dt", {}, "Spouleur"), el("dd", {}, badge(s.spooler || "?", spoolerOk ? "ok" : "bad")),
      el("dt", {}, "Agent"), el("dd", {}, s.agentVersion || "?"),
      el("dt", {}, "PowerShell"), el("dd", {}, s.powershellVersion || "?"),
      el("dt", {}, "Horloge booth"), el("dd", {}, formatDate(s.timestamp)),
    ),
    printersTable(s.printers),
    forget,
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
    throw new Error("Token invalide.");
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

    $("login").hidden = true;
    $("logout").hidden = false;
    showError("");
    $("summary").textContent = `${online}/${booths.length} en ligne`;
    $("updated").textContent = `MAJ ${new Date().toLocaleTimeString()}`;
    $("empty").hidden = booths.length > 0;
    $("booths").replaceChildren(...booths.map(boothCard));
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
