import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { saveBoothStatus, recordDnpCodes } from "../lib/store.js";

const MAX_BODY_BYTES = 64 * 1024;

// Booths use the same password as the dashboard (one code for humans), so
// the heartbeat gets the same per-IP lockout against guessing.

// GET /api/heartbeat
// Authorization: Bearer <DASHBOARD_TOKEN>
// Lets the installer check the code it was given before saving it.
export async function GET(request) {
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  return json({ ok: true });
}

// POST /api/heartbeat
// Authorization: Bearer <DASHBOARD_TOKEN>
// Body: the agent's status.json
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

  let status;
  try {
    // PowerShell 5.1 likes to prepend a BOM.
    status = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return json({ error: "Body must be a JSON object" }, 400);
  }

  const boothId = typeof status.boothId === "string" ? status.boothId.trim() : "";

  if (!BOOTH_ID_PATTERN.test(boothId)) {
    return json({ error: "Missing or invalid boothId" }, 400);
  }

  const receivedAt = new Date().toISOString();

  try {
    await saveBoothStatus(boothId, { boothId, receivedAt, status });
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  // Keep track of every DNP status code ever reported (best effort).
  const codes = [...new Set(
    (Array.isArray(status.dnpDevices) ? status.dnpDevices : [])
      .map((device) => device?.statusCode)
      .filter((code) => Number.isInteger(code)),
  )];

  if (codes.length) {
    try {
      await recordDnpCodes(boothId, codes, receivedAt);
    } catch (error) {
      console.error(error);
    }
  }

  return json({ ok: true, boothId, receivedAt });
}
