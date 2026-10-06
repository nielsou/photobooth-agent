import { json } from "../lib/http.js";

// GET /api/version
// The commit of main deployed on Vercel (deployed on every push). The agents
// check it for self-updates instead of the GitHub API, which allows only 60
// unauthenticated requests per hour and per IP (often shared over 4G). Public:
// the repository and its commits are public anyway.
export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || null;
  return json({ sha, ref: process.env.VERCEL_GIT_COMMIT_REF || null }, sha ? 200 : 503);
}
