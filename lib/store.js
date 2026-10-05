import { createClient } from "redis";

// Latest status per booth, kept in a single Redis hash (field = boothId).
// REDIS_URL is set by the Vercel Marketplace "Redis" integration.

const BOOTHS_KEY = "photobooth:booths";

let clientPromise = null;

// One connection per function instance, reused across invocations.
function getClient() {
  if (!process.env.REDIS_URL) {
    throw new Error("Server misconfigured: REDIS_URL is not set");
  }

  if (!clientPromise) {
    const client = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 5000, reconnectStrategy: false },
    });

    client.on("error", (error) => {
      console.error("Redis error:", error.message);
      clientPromise = null;
    });

    clientPromise = client.connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }

  return clientPromise;
}

export async function saveBoothStatus(boothId, record) {
  const client = await getClient();
  await client.hSet(BOOTHS_KEY, boothId, JSON.stringify(record));
}

export async function listBoothStatuses() {
  const client = await getClient();
  const entries = await client.hGetAll(BOOTHS_KEY);

  return Object.entries(entries).map(([boothId, value]) => {
    try {
      return JSON.parse(value);
    } catch {
      return { boothId, status: null, receivedAt: null };
    }
  });
}

export async function deleteBooth(boothId) {
  const client = await getClient();
  return (await client.hDel(BOOTHS_KEY, boothId)) === 1;
}

// Booth model chosen in the dashboard (field = boothId). Kept apart from the
// status so heartbeats never overwrite it.
const BOOTH_TYPES_KEY = "photobooth:booth-types";

export async function getBoothTypes() {
  const client = await getClient();
  return client.hGetAll(BOOTH_TYPES_KEY);
}

// Sets the type only if the booth has none yet; returns false otherwise.
export async function assignBoothType(boothId, type) {
  const client = await getClient();
  return Boolean(await client.hSetNX(BOOTH_TYPES_KEY, boothId, type));
}

// Every DNP status code ever received (field = code): first/last time and
// booth, number of heartbeats reporting it. Spots codes we never saw before.
const DNP_CODES_SEEN_KEY = "photobooth:dnp-codes-seen";

export async function recordDnpCodes(boothId, codes, at) {
  const client = await getClient();

  for (const code of codes) {
    const field = String(code);
    const previous = await client.hGet(DNP_CODES_SEEN_KEY, field);
    let entry = null;
    try { entry = previous && JSON.parse(previous); } catch { entry = null; }

    entry = entry
      ? { ...entry, lastSeen: at, lastBooth: boothId, count: (entry.count || 0) + 1 }
      : { code, firstSeen: at, firstBooth: boothId, lastSeen: at, lastBooth: boothId, count: 1 };

    await client.hSet(DNP_CODES_SEEN_KEY, field, JSON.stringify(entry));
  }
}

export async function listDnpCodesSeen() {
  const client = await getClient();
  return Object.values(await client.hGetAll(DNP_CODES_SEEN_KEY))
    .map((value) => { try { return JSON.parse(value); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.code - b.code);
}

// Failed dashboard logins per IP, expiring after the lockout window.
const AUTH_FAIL_PREFIX = "photobooth:authfail:";

export async function getAuthFailures(ip) {
  const client = await getClient();
  return Number(await client.get(AUTH_FAIL_PREFIX + ip)) || 0;
}

export async function recordAuthFailure(ip, windowSeconds) {
  const client = await getClient();
  const key = AUTH_FAIL_PREFIX + ip;

  if ((await client.incr(key)) === 1) {
    await client.expire(key, windowSeconds);
  }
}
