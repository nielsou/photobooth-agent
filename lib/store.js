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
