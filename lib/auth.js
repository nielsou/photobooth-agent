import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

// Checks "Authorization: Bearer <token>" against the secret held in the
// given environment variable. Fails closed when the variable is not set.
export function checkBearer(request, envName) {
  const expected = process.env[envName];

  if (!expected) {
    return { ok: false, status: 500, error: `Server misconfigured: ${envName} is not set` };
  }

  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match || !timingSafeEqual(digest(match[1].trim()), digest(expected))) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}
