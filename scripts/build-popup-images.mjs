// Rebuilds lib/popup-images.js from lib/popup-images/*.jpg (images shown on
// the printer popups). Usage: node scripts/build-popup-images.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../lib/popup-images/", import.meta.url);
const lines = readdirSync(dir)
  .filter((name) => /^[a-z0-9-]+\.jpg$/.test(name))
  .sort()
  .map((name) => `  "${name}": "${readFileSync(new URL(name, dir)).toString("base64")}",`);

writeFileSync(new URL("../lib/popup-images.js", import.meta.url), [
  "// Images shown on the printer popups (generated from lib/popup-images/*.jpg",
  "// by scripts/build-popup-images.mjs: do not edit by hand).",
  "export const POPUP_IMAGES = {",
  ...lines,
  "};",
  "",
].join("\n"));
console.log(`${lines.length} image(s)`);
