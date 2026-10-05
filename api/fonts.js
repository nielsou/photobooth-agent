import { authorizeDashboard } from "../lib/dashboard-auth.js";
import { json } from "../lib/http.js";

// Google Drive folder holding the fonts every booth must have. Shared as
// "anyone with the link" (read only), so it can be listed without any key.
const FONTS_FOLDER_ID = "1-KYNgkRXRVs4M2mDtlFHlxhUk-eA-gU1";
const FONT_FILE = /\.(ttf|otf|ttc|zip)$/i;
const MAX_FOLDERS = 20;

const decode = (text) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

// Lists a public folder through Drive's embedded folder view (no API key).
async function listFolder(folderId) {
  const response = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`);

  if (!response.ok) {
    throw new Error(`Drive folder not readable (HTTP ${response.status}): is it shared "anyone with the link"?`);
  }

  const html = await response.text();
  const entries = [];
  const entry = /<a href="([^"]+)"[^>]*>[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;

  for (const match of html.matchAll(entry)) {
    const href = decode(match[1]);
    const name = decode(match[2]);
    const folder = href.match(/\/folders\/([\w-]+)/);
    const file = href.match(/\/file\/d\/([\w-]+)/) || href.match(/[?&]id=([\w-]+)/);

    if (folder) entries.push({ type: "folder", id: folder[1], name });
    else if (file) entries.push({ type: "file", id: file[1], name });
  }

  return entries;
}

// GET /api/fonts
// Authorization: Bearer <DASHBOARD_TOKEN>
// Font files (and zips of fonts) of the Drive folder, sub-folders included.
// Booths download them straight from Google (public files).
export async function GET(request) {
  try {
    const denied = await authorizeDashboard(request);
    if (denied) return denied;
  } catch (error) {
    console.error(error);
    return json({ error: "Storage unavailable" }, 503);
  }

  try {
    const fonts = [];
    const queue = [FONTS_FOLDER_ID];
    let visited = 0;

    while (queue.length && visited < MAX_FOLDERS) {
      visited++;

      for (const entry of await listFolder(queue.shift())) {
        if (entry.type === "folder") queue.push(entry.id);
        else if (FONT_FILE.test(entry.name)) {
          fonts.push({
            id: entry.id,
            name: entry.name,
            url: `https://drive.usercontent.google.com/download?id=${entry.id}&export=download&confirm=t`,
          });
        }
      }
    }

    fonts.sort((a, b) => a.name.localeCompare(b.name));
    return json({ folderId: FONTS_FOLDER_ID, fonts });
  } catch (error) {
    console.error(error);
    return json({ error: error.message }, 502);
  }
}
