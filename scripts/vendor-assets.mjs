// Copies Leaflet from node_modules into worker/public/vendor so the app serves it itself
// (no third-party script CDN at runtime). Run after `npm install` in worker/.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../worker/node_modules/leaflet/dist");
const dest = join(here, "../worker/public/vendor/leaflet");
mkdirSync(dest, { recursive: true });
for (const f of ["leaflet.js", "leaflet.css", "images"]) cpSync(join(src, f), join(dest, f), { recursive: true });
cpSync(join(here, "../worker/node_modules/leaflet/LICENSE"), join(dest, "LICENSE"));
console.log("vendored leaflet ->", dest);
