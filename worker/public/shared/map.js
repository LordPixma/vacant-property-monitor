// Leaflet helpers. Leaflet is loaded as a classic script (window.L) from /vendor/leaflet.
import { bandColour, esc, label } from "./ui.js";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const UK_CENTRE = [54.2, -2.6];

export async function leaflet() {
  for (let i = 0; i < 100 && !window.L; i++) await new Promise((r) => setTimeout(r, 30));
  if (!window.L) throw new Error("Map library failed to load.");
  return window.L;
}

export async function createMap(el, { centre = UK_CENTRE, zoom = 6 } = {}) {
  const L = await leaflet();
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(centre, zoom);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
  return map;
}

export function propertyMarker(L, p, { href } = {}) {
  const m = L.circleMarker([p.latitude, p.longitude], {
    radius: p.priority_band === "critical" ? 9 : 7,
    color: "#fff",
    weight: 2,
    fillColor: bandColour(p.priority_band),
    fillOpacity: 0.95,
  });
  const link = href ? href(p) : null;
  m.bindPopup(
    `<strong>${esc(p.address_line1)}</strong><br>${esc(p.postcode)}<br>${esc(label(p.status))}${p.priority_band ? ` · ${esc(label(p.priority_band))} (${esc(p.priority_score ?? "")})` : ""}${
      link ? `<br><a href="${esc(link)}">Open</a>` : ""
    }`,
  );
  return m;
}

export function fitTo(map, points, maxZoom = 16) {
  const pts = points.filter((p) => p.latitude !== null && p.longitude !== null).map((p) => [p.latitude, p.longitude]);
  if (pts.length === 1) map.setView(pts[0], maxZoom);
  else if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom });
}
