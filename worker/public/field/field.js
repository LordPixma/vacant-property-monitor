import { ApiError, get, onUnauthorized, post } from "../shared/api.js";
import { createMap, fitTo, leaflet, propertyMarker } from "../shared/map.js";
import { $, $$, ago, bandBadge, bandColour, date, dist, formData, html, label, loading, mount, onAction, options, raw, statusBadge, toast } from "../shared/ui.js";
import { idFor, kvGet, kvSet, outboxAdd, outboxAll, outboxDelete, outboxPut, uuid } from "./store.js";
import { onSyncChange, syncNow } from "./sync.js";

const root = document.getElementById("root");
const S = { me: null, meta: null, position: null };
let cleanup = null;

// ---------------------------------------------------------------- platform

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/field/sw.js", { scope: "/field/" }).catch((e) => console.warn("SW registration failed", e));
  navigator.serviceWorker.addEventListener("message", (e) => e.data?.type === "sync-now" && runSync());
}

async function requestBackgroundSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    await reg?.sync?.register("vw-outbox");
  } catch {
    /* not supported: the online event and timer cover it */
  }
}

window.addEventListener("online", () => runSync());
window.addEventListener("offline", () => renderSyncBar());
setInterval(() => navigator.onLine && runSync(), 60_000);
onUnauthorized(() => {
  if (S.me) {
    S.me = null;
    renderLogin("Your session has ended. Sign in to keep syncing; nothing you saved has been lost.");
  }
});

/** GPS fix; resolves null rather than rejecting, because the forms work without one. */
function locate({ timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        S.position = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
        resolve(S.position);
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}

function haversine(a, b) {
  const R = 6371000;
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

async function downscale(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    // Re-encoding drops EXIF, including the camera's GPS tag.
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
  } catch {
    return file;
  }
}

// ---------------------------------------------------------------- data (online with offline fallback)

async function loadMeta() {
  try {
    S.meta = await get("/meta");
    await kvSet("meta", S.meta);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    S.meta = await kvGet("meta");
    if (!S.meta) throw new Error("Connect to the internet once to set up the app.");
  }
}

/** The open-case list, refreshed on each sync, so "near me" works offline. */
async function refreshCache() {
  const r = await get("/properties?open=1&limit=1000&sort=priority");
  await kvSet("properties", { saved_at: Date.now(), items: r.items });
  const tasks = await get("/tasks?mine=1&status=active");
  await kvSet("tasks", { saved_at: Date.now(), items: tasks.items });
}

async function cachedProperties() {
  return (await kvGet("properties")) ?? { saved_at: null, items: [] };
}

async function runSync() {
  if (!S.me) return;
  const r = await syncNow();
  if (r.stopped === "signed-out") return;
  if (navigator.onLine && !r.stopped) {
    try {
      await refreshCache();
      await kvSet("last_sync", Date.now());
    } catch {
      /* stay on the cached copy */
    }
  }
  renderSyncBar();
  return r;
}

onSyncChange(() => renderSyncBar());

async function renderSyncBar() {
  const bar = $("#sync");
  if (!bar) return;
  const items = await outboxAll();
  const pending = items.filter((i) => i.status === "pending").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const last = await kvGet("last_sync");
  bar.className = `sync-bar ${!navigator.onLine ? "offline" : failed ? "failed" : ""}`;
  mount(
    bar,
    html`<span>${!navigator.onLine ? "● Offline" : "● Online"}</span><span class="spacer"></span>
      <span>${pending ? `${pending} to send` : "All sent"}${failed ? html` · <a href="#/outbox">${failed} need attention</a>` : ""}</span>
      <span class="muted">${last ? `synced ${ago(last)}` : ""}</span>`,
  );
}

// ---------------------------------------------------------------- shell

function renderLogin(message) {
  mount(
    root,
    html`<div class="auth-wrap"><div class="card auth-card">
      <div class="brand"><img src="/shared/icon.svg" alt="">VacantWatch Field</div>
      ${message ? html`<div class="alert warn">${message}</div>` : ""}
      <form id="login">
        <div class="field"><label>Email</label><input name="email" type="email" autocomplete="username" required></div>
        <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
        <button class="primary block">Sign in</button>
      </form>
      <p class="muted"><small>You stay signed in for 14 days on this device. Install the app from your browser menu ("Add to Home Screen").</small></p>
    </div></div>`,
  );
  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await post("/auth/login", formData(e.target));
      boot();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function renderChangePassword() {
  mount(
    root,
    html`<div class="auth-wrap"><div class="card auth-card"><h1 style="font-size:1.2rem">Choose your own password</h1>
      <p>You signed in with a temporary password. Pick a new one (10+ characters; a short phrase is easiest to type outdoors).</p>
      <form id="pw">
        <div class="field"><label>Temporary password</label><input name="current" type="password" required autocomplete="current-password"></div>
        <div class="field"><label>New password</label><input name="next" type="password" minlength="10" required autocomplete="new-password"></div>
        <button class="primary block">Save and continue</button>
      </form></div></div>`,
  );
  $("#pw").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await post("/auth/change-password", formData(e.target));
      boot();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

function shell(title, back) {
  mount(
    root,
    html`<header class="f-top">${back ? html`<a class="btn small" href="${back}" aria-label="Back">‹</a>` : html`<img src="/shared/icon.svg" alt="" width="26" height="26" style="border-radius:6px">`}<h1>${title}</h1></header>
    <main class="f-main"><div id="sync" class="sync-bar"></div><div id="view"></div></main>
    <nav class="f-tabs">
      <a href="#/" data-tab="home"><span>⌂</span>Home</a>
      <a href="#/near" data-tab="near"><span>◎</span>Near me</a>
      <a href="#/report" data-tab="report"><span>＋</span>Report</a>
      <a href="#/tasks" data-tab="tasks"><span>✓</span>Tasks</a>
    </nav>`,
  );
  renderSyncBar();
  const tab = (location.hash.split("?")[0].split("/")[1] || "home").replace(/^$/, "home");
  $$(".f-tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  return $("#view");
}

const routes = [
  [/^#?\/?$/, () => home],
  [/^#\/near$/, () => near],
  [/^#\/report$/, () => report],
  [/^#\/tasks$/, () => tasks],
  [/^#\/outbox$/, () => outbox],
  [/^#\/help$/, () => helpNearby],
  [/^#\/p\/([\w-]+)$/, (m) => () => propertyCard(m[1])],
  [/^#\/visit\/([\w-]+)$/, (m) => () => visitForm(m[1])],
];

async function route() {
  if (!S.me) return;
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }
  const hash = location.hash.split("?")[0] || "#/";
  for (const [re, make] of routes) {
    const m = re.exec(hash);
    if (m) {
      try {
        const r = await make(m)();
        if (typeof r === "function") cleanup = r;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return;
        const v = $("#view") ?? shell("Error");
        mount(v, html`<div class="alert error">${err.message}</div>`);
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = "#/";
}
window.addEventListener("hashchange", route);

async function boot() {
  try {
    try {
      S.me = (await get("/auth/me")).user;
      await kvSet("me", S.me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return renderLogin();
      // Offline: trust the last known user; the server re-checks the cookie on every sync.
      S.me = await kvGet("me");
      if (!S.me) return renderLogin("You are offline. Sign in once while connected.");
    }
    if (S.me.mustChangePassword) return renderChangePassword();
    await loadMeta();
    route();
    runSync();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderLogin();
    mount(root, html`<div class="auth-wrap"><div class="alert error">${err.message}</div></div>`);
  }
}

// ---------------------------------------------------------------- home

async function home() {
  const v = shell(S.meta.org_name);
  const cached = await cachedProperties();
  const t = (await kvGet("tasks"))?.items ?? [];
  mount(
    v,
    html`<div class="big-actions">
      <a class="btn primary" href="#/report"><span class="icon">＋</span>Report a property</a>
      <a class="btn" href="#/near"><span class="icon">◎</span>Properties near me</a>
      <a class="btn" href="#/tasks"><span class="icon">✓</span>My tasks (${t.length})</a>
      <a class="btn" href="#/help"><span class="icon">♥</span>Help nearby</a>
    </div>
    <button class="btn block" data-action="sync" style="margin-bottom:1rem">⟳ Sync now</button>
    <div class="card"><h3>Before you go</h3><ul style="margin:0;padding-left:1.2rem">
      <li>Observe from the street. Never enter a building or private land.</li>
      <li>Do not photograph people or number plates.</li>
      <li>If someone may be sleeping rough: ${S.meta.outreach_contact}</li>
    </ul></div>
    <h3 style="margin-top:1rem">Highest priority in your areas</h3>
    ${cached.items.length ? cached.items.slice(0, 5).map((p) => item(p)) : html`<p class="muted">Nothing cached yet. Sync while online.</p>`}`,
  );
  onAction(v, {
    sync: async (b) => {
      b.disabled = true;
      const r = await runSync();
      b.disabled = false;
      toast(r?.stopped === "offline" ? "Offline: will send when you reconnect." : `Synced${r?.sent ? `, ${r.sent} sent` : ""}.`);
      route();
    },
  });
}

function item(p) {
  return html`<a class="p-item" href="#/p/${p.id}"><span class="band" style="background:${bandColour(p.priority_band)}"></span>
    <span class="grow"><strong>${p.address_line1}</strong><br><small>${p.postcode} · ${label(p.status)} · ${p.last_visited_at ? `seen ${ago(p.last_visited_at)}` : "never visited"}</small></span>
    ${p.distance_m !== undefined ? html`<span class="dist">${dist(p.distance_m)}</span>` : bandBadge(p.priority_band)}</a>`;
}

// ---------------------------------------------------------------- near me

async function near() {
  const v = shell("Near me");
  mount(v, loading("Finding your location…"));
  const pos = await locate();
  let items = [];
  let source = "live";
  if (pos && navigator.onLine) {
    try {
      items = (await get(`/properties?near=${pos.lat},${pos.lng}&radius=3000&limit=100`)).items;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      source = "cache";
    }
  } else source = "cache";
  if (source === "cache") {
    const c = await cachedProperties();
    items = c.items
      .filter((p) => p.latitude !== null)
      .map((p) => ({ ...p, distance_m: pos ? haversine(pos, { lat: p.latitude, lng: p.longitude }) : undefined }))
      .sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0))
      .slice(0, 100);
  }
  mount(
    v,
    html`${!pos ? html`<div class="alert warn">Location unavailable. Allow location access to sort by distance.</div>` : html`<p class="muted gps">You are at ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (±${Math.round(pos.accuracy)} m)${source === "cache" ? " · showing the offline copy" : ""}</p>`}
    <div id="nmap" class="map" style="height:260px;margin-bottom:.75rem"></div>
    ${items.length ? items.map((p) => item(p)) : html`<div class="empty">No open cases within 3 km. <a href="#/report">Report one</a>.</div>`}`,
  );
  try {
    const L = await leaflet();
    const map = await createMap($("#nmap"), { centre: pos ? [pos.lat, pos.lng] : undefined, zoom: pos ? 15 : 6 });
    items.forEach((p) => propertyMarker(L, p, { href: (q) => `#/p/${q.id}` }).addTo(map));
    if (pos) L.circleMarker([pos.lat, pos.lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).addTo(map).bindTooltip("You");
    else fitTo(map, items);
    return () => map.remove();
  } catch {
    $("#nmap").remove();
  }
}

// ---------------------------------------------------------------- property card

async function propertyCard(id) {
  const v = shell("Property", "#/near");
  mount(v, loading());
  let p = null;
  let detail = null;
  try {
    detail = await get(`/properties/${id}`);
    p = detail.property;
    const recent = (await kvGet("details")) ?? {};
    recent[id] = { saved_at: Date.now(), detail };
    // Keep the 40 most recently opened for offline use.
    const keep = Object.entries(recent).sort((a, b) => b[1].saved_at - a[1].saved_at).slice(0, 40);
    await kvSet("details", Object.fromEntries(keep));
  } catch (err) {
    if (err instanceof ApiError && err.status !== 0 && err.status !== 503) throw err;
    detail = ((await kvGet("details")) ?? {})[id]?.detail ?? null;
    p = detail?.property ?? (await cachedProperties()).items.find((x) => x.id === id);
    if (!p) throw new Error("This property is not available offline.");
  }
  const ins = p.insights;
  const profile = ins?.area_profile;
  const directions = p.latitude ? `https://www.google.com/maps/dir/?api=1&destination=${p.latitude},${p.longitude}` : null;
  mount(
    v,
    html`<h2 style="margin-bottom:.2rem">${p.address_line1}</h2>
    <p class="muted" style="margin:0 0 .5rem">${[p.address_line2, p.town, p.postcode].filter(Boolean).join(", ")}</p>
    <div class="row" style="margin-bottom:1rem">${statusBadge(p.status)} ${bandBadge(p.priority_band, p.priority_score)} <span class="badge">${label(p.category)}</span></div>
    <div class="big-actions">
      <a class="btn primary" href="#/visit/${p.id}"><span class="icon">✎</span>Log a visit</a>
      ${directions ? html`<a class="btn" href="${directions}" target="_blank" rel="noopener"><span class="icon">➜</span>Directions</a>` : html`<span></span>`}
    </div>
    ${
      ins?.recommended_actions?.length
        ? html`<div class="card" style="margin-bottom:.75rem"><h3>Next steps</h3><ul style="margin:0;padding-left:1.2rem">${ins.recommended_actions.map((a) => html`<li><strong>${a.title}</strong><br><small>${a.detail}</small></li>`)}</ul></div>`
        : ""
    }
    <div class="card" style="margin-bottom:.75rem"><h3>On record</h3><dl class="kv">
      <dt>Condition</dt><dd>${label(p.condition)}</dd><dt>Security</dt><dd>${label(p.security)}</dd>
      <dt>Empty since</dt><dd>${p.vacant_since ?? "—"}</dd><dt>Last visit</dt><dd>${p.last_visited_at ? `${date(p.last_visited_at)} (${ago(p.last_visited_at)})` : "never"}</dd>
    </dl>${p.description ? html`<p style="margin:.5rem 0 0;white-space:pre-wrap">${p.description}</p>` : ""}</div>
    ${profile?.headline?.length ? html`<div class="card" style="margin-bottom:.75rem"><h3>The area</h3><ul style="margin:0;padding-left:1.2rem">${profile.headline.map((l) => html`<li>${l}</li>`)}</ul></div>` : ""}
    ${
      detail?.visits?.length
        ? html`<div class="card"><h3>Recent visits</h3><ul class="timeline">${detail.visits.slice(0, 5).map(
            (x) => html`<li><strong>${date(x.visited_at, true)}</strong> · ${x.user_name ?? ""}<br>${x.observed_status ? statusBadge(x.observed_status) : ""} ${x.signals.map((s) => html`<span class="chip">${label(s)}</span> `)}${x.notes ? html`<br><small>${x.notes}</small>` : ""}</li>`,
          )}</ul></div>`
        : ""
    }
    ${detail?.photos?.length ? html`<div class="card" style="margin-top:.75rem"><h3>Photos</h3><div class="photos">${detail.photos.slice(0, 9).map((ph) => html`<a href="/api/photos/${ph.id}" target="_blank"><img src="/api/photos/${ph.id}" alt="" loading="lazy"></a>`)}</div></div>` : ""}
    <p style="margin-top:1rem"><a href="/#/property/${p.id}">Open in the full dashboard</a></p>`,
  );
}

// ---------------------------------------------------------------- shared form pieces

const URGENT = new Set(["signs_of_rough_sleeping", "open_or_unsecured", "structural_damage", "fire_damage"]);

function observationFields(current = {}) {
  const seg = (name, values, selected) =>
    html`<div class="seg">${values.map((v) => html`<label class="toggle"><input type="radio" name="${name}" value="${v}" ${v === selected ? raw("checked") : ""}><span>${label(v)}</span></label>`)}</div>`;
  return html`
    <div class="field"><label>What is its status now?</label>${seg("observed_status", ["suspected_vacant", "confirmed_vacant", "derelict", "abandoned", "occupied", "brought_back_into_use", "demolished"], current.status === "reported" ? null : current.status)}</div>
    <div class="field"><label>Condition</label>${seg("condition", S.meta.enums.conditions, current.condition)}</div>
    <div class="field"><label>Security</label>${seg("security", S.meta.enums.security, current.security)}</div>
    <div class="field"><label>What can you see? <span class="hint">tick all that apply</span></label>
      <div class="toggle-grid">${S.meta.enums.signals.map(
        (s) => html`<label class="toggle ${URGENT.has(s) ? "urgent" : ""}"><input type="checkbox" data-group="signals" name="sig_${s}" value="${s}"><span>${label(s)}</span></label>`,
      )}</div></div>
    <div id="welfare" class="alert error welfare" hidden><strong>Possible rough sleeping.</strong> ${S.meta.outreach_contact} Do not approach the building alone.</div>
    <div class="field"><label>Notes</label><textarea name="notes" placeholder="What you saw. No names or details that identify people."></textarea></div>
    <div class="field"><label>Photos <span class="hint">from the street</span></label><input type="file" name="photos" accept="image/*" capture="environment" multiple><div class="thumbs" id="thumbs"></div></div>
    <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="use_gps" checked> Record my GPS position</label><div class="gps muted" id="gps">Getting location…</div></div>`;
}

function wireObservation(form) {
  form.addEventListener("change", (e) => {
    if (e.target.name === "sig_signs_of_rough_sleeping") $("#welfare").hidden = !e.target.checked;
    if (e.target.name === "photos") {
      const t = $("#thumbs");
      t.innerHTML = "";
      for (const f of e.target.files) {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(f);
        img.onload = () => URL.revokeObjectURL(img.src);
        t.appendChild(img);
      }
    }
  });
  locate().then((p) => {
    const el = $("#gps");
    if (el) el.textContent = p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (±${Math.round(p.accuracy)} m)` : "Location unavailable.";
  });
}

async function queuePhotos(form, propertyRef, visitClientId) {
  for (const f of form.photos.files) {
    const blob = await downscale(f);
    await outboxAdd({ kind: "photo", payload: { property: propertyRef, visit_client_id: visitClientId, client_id: uuid(), blob, name: "photo.jpg" } });
  }
}

function visitBody(d, clientId) {
  const pos = d.use_gps ? S.position : null;
  return {
    client_id: clientId,
    visited_at: Date.now(),
    observed_status: d.observed_status,
    condition: d.condition,
    security: d.security,
    signals: d.signals ?? [],
    notes: d.notes,
    latitude: pos?.lat ?? null,
    longitude: pos?.lng ?? null,
    gps_accuracy_m: pos?.accuracy ?? null,
  };
}

async function afterQueue(message) {
  requestBackgroundSync();
  const r = await runSync();
  toast(r?.pending ? `${message} Saved on this phone; it will send when you have signal.` : `${message} Sent.`);
}

// ---------------------------------------------------------------- visit

async function visitForm(id) {
  const v = shell("Log a visit", `#/p/${id}`);
  const cached = ((await kvGet("details")) ?? {})[id]?.detail?.property ?? (await cachedProperties()).items.find((x) => x.id === id) ?? { id };
  mount(
    v,
    html`<p><strong>${cached.address_line1 ?? "Property"}</strong>${cached.postcode ? `, ${cached.postcode}` : ""}</p>
    <form id="vform">${observationFields(cached)}<button class="primary block">Save visit</button></form>`,
  );
  const form = $("#vform");
  wireObservation(form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button.primary");
    btn.disabled = true;
    const d = formData(form);
    const clientId = uuid();
    const propertyRef = (await idFor(id)) ? { id: await idFor(id) } : /^[\w-]{21}$/.test(id) ? { id } : { client_id: id };
    await outboxAdd({ kind: "visit", payload: { property: propertyRef, body: visitBody(d, clientId) } });
    await queuePhotos(form, propertyRef, clientId);
    await afterQueue("Visit saved.");
    location.hash = propertyRef.id ? `#/p/${propertyRef.id}` : "#/";
  });
}

// ---------------------------------------------------------------- report a new property

async function report() {
  const v = shell("Report a property");
  mount(
    v,
    html`<form id="rform">
      <div class="field"><label>House number / name and street</label><input name="address_line1" required maxlength="200" autocomplete="off" placeholder="e.g. 14 Park Road"></div>
      <div class="field"><label>Flat / building <span class="hint">optional</span></label><input name="address_line2" maxlength="200" autocomplete="off"></div>
      <div class="field"><label>Postcode</label><div class="row" style="flex-wrap:nowrap"><input name="postcode" required maxlength="10" style="text-transform:uppercase" autocomplete="off"><button type="button" data-action="nearest" class="small">Nearest</button></div><div id="pc-hint" class="muted gps"></div></div>
      <div class="field"><label>Ownership <span class="hint">if known</span></label><select name="category">${options(S.meta.enums.categories, "unknown")}</select></div>
      <div class="field"><label>Type</label><select name="property_type">${options(S.meta.enums.property_types, null, { blank: "Not sure" })}</select></div>
      ${observationFields({ status: "suspected_vacant" })}
      <button class="primary block">Save property</button>
    </form>`,
  );
  const form = $("#rform");
  wireObservation(form);
  onAction(form, {
    nearest: async () => {
      const hint = $("#pc-hint");
      hint.textContent = "Looking up…";
      const pos = S.position ?? (await locate());
      if (!pos) return (hint.textContent = "Location unavailable.");
      if (!navigator.onLine) return (hint.textContent = "Offline: type the postcode from a nearby sign or letterbox.");
      try {
        const r = await get(`/lookup/reverse?lat=${pos.lat}&lng=${pos.lng}`);
        if (!r.items.length) return (hint.textContent = "No postcode found nearby.");
        form.postcode.value = r.items[0].postcode;
        mount(hint, html`Nearest: ${r.items.map((x, i) => html`<button type="button" class="link-btn" data-action="pick" data-pc="${x.postcode}">${x.postcode}</button> (${x.distance_m} m)${i < r.items.length - 1 ? ", " : ""}`)}. Check it matches the street.`);
      } catch (err) {
        hint.textContent = err.message;
      }
    },
    pick: (b) => (form.postcode.value = b.dataset.pc),
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (!/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(d.postcode ?? "")) return toast("Enter a full UK postcode, e.g. M14 5TP.", "error");
    form.querySelector("button.primary").disabled = true;
    const propertyClientId = uuid();
    const visitClientId = uuid();
    const pos = d.use_gps ? S.position : null;
    await outboxAdd({
      kind: "property",
      payload: {
        body: {
          client_id: propertyClientId,
          address_line1: d.address_line1,
          address_line2: d.address_line2,
          postcode: d.postcode,
          category: d.category ?? "unknown",
          property_type: d.property_type,
          status: d.observed_status ?? "reported",
          condition: d.condition,
          security: d.security,
          description: d.notes,
          latitude: pos?.lat ?? null,
          longitude: pos?.lng ?? null,
          location_source: pos ? "gps" : null,
          source: "field",
        },
      },
    });
    await outboxAdd({ kind: "visit", payload: { property: { client_id: propertyClientId }, body: visitBody(d, visitClientId) } });
    await queuePhotos(form, { client_id: propertyClientId }, visitClientId);
    await afterQueue("Property reported.");
    const id = await idFor(propertyClientId);
    location.hash = id ? `#/p/${id}` : "#/";
  });
}

// ---------------------------------------------------------------- tasks

async function tasks() {
  const v = shell("My tasks");
  let items;
  try {
    items = (await get("/tasks?mine=1&status=active")).items;
    await kvSet("tasks", { saved_at: Date.now(), items });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    items = (await kvGet("tasks"))?.items ?? [];
  }
  mount(
    v,
    items.length
      ? html`${items.map(
          (t) => html`<div class="card" style="margin-bottom:.6rem"><div class="row between"><strong>${t.title}</strong>${t.due_at && t.due_at < Date.now() ? html`<span class="badge danger">overdue</span>` : ""}</div>
            <small class="muted">${label(t.type)}${t.due_at ? ` · due ${date(t.due_at)}` : ""}</small>
            ${t.property_id ? html`<p style="margin:.4rem 0"><a href="#/p/${t.property_id}">${t.address_line1}, ${t.postcode}</a></p>` : ""}
            ${t.notes ? html`<p class="muted" style="margin:.2rem 0"><small>${t.notes}</small></p>` : ""}
            <div class="row"><button class="small" data-action="status" data-id="${t.id}" data-s="in_progress">Started</button><button class="small primary" data-action="status" data-id="${t.id}" data-s="done">Done</button></div></div>`,
        )}`
      : html`<div class="empty">No tasks assigned to you.</div>`,
  );
  onAction(v, {
    status: async (b) => {
      await outboxAdd({ kind: "task", payload: { task_id: b.dataset.id, body: { status: b.dataset.s } } });
      b.closest(".card").style.opacity = b.dataset.s === "done" ? "0.5" : "1";
      await afterQueue("Task updated.");
    },
  });
}

// ---------------------------------------------------------------- help nearby

/** Services to signpost someone to: shelters, food banks, health. Cached for offline use. */
async function helpNearby() {
  const v = shell("Help nearby", "#/");
  mount(v, loading("Finding your location…"));
  const pos = await locate();
  let data = null;
  if (pos && navigator.onLine) {
    try {
      data = await get(`/services?near=${pos.lat},${pos.lng}&radius=3000`);
      await kvSet("help", { saved_at: Date.now(), pos, data });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
    }
  }
  let note = "";
  if (!data) {
    const cached = await kvGet("help");
    if (!cached) return mount(v, html`<div class="empty">Connect once to load nearby services.</div>`);
    data = cached.data;
    note = `Offline copy from ${ago(cached.saved_at)}, measured from where you were then.`;
  }
  const order = ["shelter", "food_bank", "social_support", "health", "pharmacy", "community", "facilities", "police"];
  mount(
    v,
    html`<div class="alert">${S.meta.outreach_contact}</div>${note ? html`<p class="muted">${note}</p>` : ""}
    ${order.map((k) => {
      const g = data.groups[k];
      if (!g?.count) return "";
      return html`<h3 style="margin-top:1rem">${g.label}</h3>${g.nearest.map(
        (n) => html`<div class="card" style="margin-bottom:.5rem"><div class="row between"><strong>${n.name ?? label(n.kind)}</strong><span class="dist">${dist(n.distance_m)}</span></div>
          ${n.address ? html`<small>${n.address}</small><br>` : ""}${n.opening_hours ? html`<small>${n.opening_hours}</small><br>` : ""}${n.notes ? html`<small class="muted">${n.notes}</small><br>` : ""}
          <div class="row" style="margin-top:.4rem">${n.phone ? html`<a class="btn small" href="tel:${n.phone}">Call</a>` : ""}<a class="btn small" href="https://www.google.com/maps/dir/?api=1&destination=${n.lat},${n.lng}" target="_blank" rel="noopener">Directions</a></div></div>`,
      )}`;
    })}
    ${order.every((k) => !data.groups[k]?.count) ? html`<div class="empty">No services in the directory within 3 km. Ask a coordinator to add local services.</div>` : ""}`,
  );
}

// ---------------------------------------------------------------- outbox

async function outbox() {
  const v = shell("Waiting to send", "#/");
  const items = (await outboxAll()).sort((a, b) => a.seq - b.seq);
  mount(
    v,
    items.length
      ? html`<p class="muted">Items are sent in order when you have signal. Failed items were refused by the server; fix or discard them.</p>
        ${items.map(
          (i) => html`<div class="card" style="margin-bottom:.5rem"><div class="row between"><strong>${label(i.kind)}</strong>${i.status === "failed" ? html`<span class="badge danger">Failed</span>` : html`<span class="badge">Pending</span>`}</div>
            <small class="muted">${date(i.created_at, true)}${i.payload?.body?.address_line1 ? ` · ${i.payload.body.address_line1}` : ""}</small>
            ${i.error ? html`<p style="margin:.3rem 0;color:var(--danger)"><small>${i.error}</small></p>` : ""}
            <div class="row" style="margin-top:.4rem">${i.status === "failed" ? html`<button class="small" data-action="retry" data-seq="${i.seq}">Retry</button>` : ""}<button class="small danger" data-action="discard" data-seq="${i.seq}">Discard</button></div></div>`,
        )}`
      : html`<div class="empty">Nothing waiting. Everything has been sent.</div>`,
  );
  onAction(v, {
    retry: async (b) => {
      const it = (await outboxAll()).find((x) => x.seq === Number(b.dataset.seq));
      if (it) await outboxPut({ ...it, status: "pending", error: null });
      await runSync();
      route();
    },
    discard: async (b) => {
      if (!confirm("Discard this item? It has not reached the server and cannot be recovered.")) return;
      await outboxDelete(Number(b.dataset.seq));
      renderSyncBar();
      route();
    },
  });
}

boot();
