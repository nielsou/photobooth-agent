import { checkBearer } from "./auth.js";
import { json } from "./http.js";
import { getAuthFailures, recordAuthFailure } from "./store.js";

// The dashboard password is human-chosen: slow down guessing.
const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 60 * 60;

function clientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return (request.headers.get("x-real-ip") || forwarded.split(",")[0] || "unknown").trim();
}

// Checks "Authorization: Bearer <DASHBOARD_TOKEN>" with a per-IP lockout.
// Returns an error Response, or null when the request is authorized.
export async function authorizeDashboard(request) {
  const ip = clientIp(request);

  if ((await getAuthFailures(ip)) >= MAX_FAILURES) {
    return json({ error: "Trop de tentatives, réessaie dans 1 heure." }, 429);
  }

  const auth = checkBearer(request, "DASHBOARD_TOKEN");
  if (auth.ok) return null;

  if (auth.status === 401) await recordAuthFailure(ip, LOCKOUT_SECONDS);
  return json({ error: auth.error }, auth.status);
}
