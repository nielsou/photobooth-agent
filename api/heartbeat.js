import { checkBearer } from "../lib/auth.js";
import { json, BOOTH_ID_PATTERN } from "../lib/http.js";
import { saveBoothStatus } from "../lib/store.js";

const MAX_BODY_BYTES = 64 * 1024;

// GET /api/heartbeat
// Authorization: Bearer <AGENT_TOKEN>
// Lets the installer check the code it was given before saving it.
export function GET(request) {
  const auth = checkBearer(request, "AGENT_TOKEN");
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  return json({ ok: true });
}

// POST /api/heartbeat
// Authorization: Bearer <AGENT_TOKEN>
// Body: the agent's status.json
export async function POST(request) {
  const auth = checkBearer(request, "AGENT_TOKEN");
  if (!auth.ok) return json({ error: auth.error }, auth.status);

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

  return json({ ok: true, boothId, receivedAt });
}
