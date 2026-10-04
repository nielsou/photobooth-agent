import { readFile } from "node:fs/promises";

// GET /install.cmd (rewritten here by vercel.json)
// Serves installer/install.cmd as a download: GitHub raw serves it as text,
// which browsers display instead of saving. Contains no secret.
export async function GET() {
  const body = await readFile(new URL("../installer/install.cmd", import.meta.url));

  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="installer-photobooth.cmd"',
      "Cache-Control": "no-store",
    },
  });
}
