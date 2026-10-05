// Smoke test of public/app.js: loads the whole dashboard script in a fake DOM,
// renders the booths table and the Configuration tab with realistic data, and
// fails on any runtime error (e.g. a helper function that no longer exists).
// Usage: node scripts/check-dashboard.mjs
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.dataset = {};
    this.className = "";
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener() {}
  focus() {}
  blur() {}
}

const elements = {};
const document = {
  createElement: (tag) => new FakeElement(tag),
  getElementById: (id) => (elements[id] ||= new FakeElement()),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  activeElement: null,
  visibilityState: "visible",
};

const now = new Date().toISOString();
const printer = (extra) => ({
  name: "DP-DS620", default: true, connection: "usb", connected: true, status: "Normal",
  errorState: 0, queueJobs: 0, workOffline: false, manufacturer: "Dai Nippon Printing", ...extra,
});

const booths = {
  boothTypes: ["Station mère", "Signature"],
  dnpCodes: { 0: "En attente", 1: "Impression", 1100: "Fin de papier", 1300: "Bourrage papier" },
  unknownCodesSeen: [4242],
  booths: [
    {
      boothId: "ONLINE-FULL", type: "Signature", online: true, ageSeconds: 5, receivedAt: now,
      status: {
        agentVersion: "1.16.0", internet: true, spooler: "Running", printerAlert: "jam", paperOutPopup: true,
        network: { type: "wifi", name: "Salle", signal: 35, latencyMs: 220, packetLoss: 33, failedHeartbeats: 1 },
        arduino: [{ name: "USB-SERIAL CH340 (COM7)", com: "COM7", usbId: "VID_1A86&PID_7523", present: true, driverMissing: false }],
        fonts: { expected: 23, missing: ["Amarillo.ttf"], checkedAt: now },
        drivers: [{ name: "DP-DS620", installed: true }, { name: "Other", installed: false, error: "boom" }],
        dnpDevices: [{ statusCode: 1300, mediaRemaining: 12 }],
        printers: [
          printer({ dnp: { mediaRemaining: 12, statusCode: 1300, errors: [] }, queueJobs: 2, oldestJobSeconds: 300,
            jobs: [{ document: "a.jpg", status: "Printing", pagesPrinted: 0, totalPages: 1 }] }),
          printer({ name: "HP", default: false, connection: "network", status: "PaperOut", errorState: 4 }),
        ],
      },
    },
    { boothId: "OFFLINE-OLD", type: null, online: false, ageSeconds: 9000, receivedAt: now,
      status: { agentVersion: "1.2.0", internet: false, spooler: "Stopped", printers: [] } },
    { boothId: "NO-STATUS", online: false, ageSeconds: null, receivedAt: null, status: null },
  ],
};

const printerAlerts = {
  dnpCodes: booths.dnpCodes,
  codesSeen: [{ code: 4242, firstSeen: now, firstBooth: "X", lastSeen: now, lastBooth: "Y", count: 2 }],
  types: [
    { type: "Signature", note: "DNP", alerts: [
      { id: "paper", codes: [1100], whenEmpty: true, title: "Plus de papier", message: "m", detail: "d", url: "https://x", qrDataUrl: "data:," },
      { id: "error", otherErrors: true, title: "Problème", message: "m", detail: "d", url: null, qrDataUrl: null },
    ] },
    { type: "Station mère", note: "aucune", alerts: [] },
  ],
};

const fetch = async (path) => ({
  status: 200,
  ok: true,
  json: async () => (String(path).startsWith("/api/printer-alerts") ? printerAlerts : booths),
});

const globals = {
  document,
  Node: FakeElement,
  fetch,
  localStorage: { getItem: () => "token", setItem() {}, removeItem() {} },
  location: { hash: "", pathname: "/" },
  history: { replaceState() {} },
  confirm: () => false,
  setTimeout: () => 0,
  clearTimeout: () => {},
};

const run = new Function(...Object.keys(globals),
  `${source}\nreturn { refresh, loadConfig, boothRow, showTab };`);

const app = run(...Object.values(globals));

await app.refresh();
const rendered = document.getElementById("booths").children.length;
if (document.getElementById("error").textContent) throw new Error("booths: " + document.getElementById("error").textContent);
if (rendered !== booths.booths.length) throw new Error(`expected ${booths.booths.length} rows, got ${rendered}`);

await app.loadConfig();
if (document.getElementById("error").textContent) throw new Error("config: " + document.getElementById("error").textContent);
const cards = document.getElementById("config").children.length;
if (cards < 2) throw new Error(`expected config cards, got ${cards}`);

console.log(`dashboard OK: ${rendered} booth rows, ${cards} configuration cards`);
