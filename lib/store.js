// Latest status per booth, kept in a single Redis hash (field = boothId).
// Talks to Upstash Redis over its REST API, so no npm dependency is needed.
// Works with the env var names set by the Vercel Marketplace integration
// (KV_REST_API_*) or by Upstash directly (UPSTASH_REDIS_REST_*).

const BOOTHS_KEY = "photobooth:booths";

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Server misconfigured: Redis REST URL/token env vars are not set");
  }

  return { url: url.replace(/\/+$/, ""), token };
}

async function redis(command) {
  const { url, token } = redisConfig();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(`Redis ${command[0]} failed: ${data.error || response.status}`);
  }

  return data.result;
}

export async function saveBoothStatus(boothId, record) {
  await redis(["HSET", BOOTHS_KEY, boothId, JSON.stringify(record)]);
}

export async function listBoothStatuses() {
  // HGETALL returns a flat [field1, value1, field2, value2, ...] array.
  const flat = (await redis(["HGETALL", BOOTHS_KEY])) || [];
  const booths = [];

  for (let i = 0; i < flat.length; i += 2) {
    try {
      booths.push(JSON.parse(flat[i + 1]));
    } catch {
      booths.push({ boothId: flat[i], status: null, receivedAt: null });
    }
  }

  return booths;
}

export async function deleteBooth(boothId) {
  return (await redis(["HDEL", BOOTHS_KEY, boothId])) === 1;
}
