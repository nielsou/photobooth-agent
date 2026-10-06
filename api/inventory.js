import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { saveInventory, listInventories } from "../lib/store.js";

const MAX_BODY_BYTES = 512 * 1024;

// GET /api/inventory
// Authorization: Bearer <DASHBOARD_TOKEN>
// Installed programs and Windows apps of every booth (latest report).
export async function GET(request) {
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;
    return json({ inventories: await listInventories() });
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }
}

// POST /api/inventory
// Authorization: Bearer <DASHBOARD_TOKEN>
// Body: { boothId, programs: [...], apps: [...], provisioned: [...] }, sent by
// the agent once per power-on (too big for the 30 s heartbeat over 4G).
export async function POST(request) {
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return json({ error: "Payload too large" }, 413);
  }

  let inventory;
  try {
    inventory = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const boothId = typeof inventory?.boothId === "string" ? inventory.boothId.trim() : "";
  if (!BOOTH_ID_PATTERN.test(boothId)) {
    return json({ error: "Missing or invalid boothId" }, 400);
  }

  const receivedAt = new Date().toISOString();
  try {
    await saveInventory(boothId, { boothId, receivedAt, inventory });
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  return json({ ok: true, boothId, receivedAt });
}
