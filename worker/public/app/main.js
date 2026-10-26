import { ApiError, del, get, onUnauthorized, patch, post, qs } from "../shared/api.js";
import { areaPanels, sourceStatusList } from "../shared/area.js";
import { createMap, fitTo, leaflet, propertyMarker } from "../shared/map.js";
import {
  $,
  $$,
  ago,
  bandBadge,
  bandColour,
  bars,
  date,
  debounce,
  dist,
  formData,
  html,
  label,
  loading,
  modal,
  mount,
  num,
  onAction,
  options,
  raw,
  statusBadge,
  toast,
} from "../shared/ui.js";
import { adminView } from "./admin.js";

const root = document.getElementById("root");
export const state = { me: null, meta: null, people: [] };
let cleanup = null;

const RANK = { viewer: 0, field_worker: 1, coordinator: 2, admin: 3 };
export const can = (role) => state.me && RANK[state.me.role] >= RANK[role];

onUnauthorized(() => {
  if (state.me) {
    state.me = null;
    toast("Your session has ended. Please sign in again.", "error");
    boot();
  }
});

// ---------------------------------------------------------------- auth screens

function authShell(title, body) {
  mount(
    root,
    html`<div class="auth-wrap"><div class="card auth-card">
      <div class="brand"><img src="/shared/icon.svg" alt="">${state.meta?.org_name ?? "VacantWatch"}</div>
      <h1 style="font-size:1.2rem">${title}</h1>${body}</div></div>`,
  );
}

function renderLogin(message) {
  authShell(
    "Sign in",
    html`${message ? html`<div class="alert error">${message}</div>` : ""}
    <form id="login">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="primary" style="width:100%">Sign in</button>
    </form>
    <p class="muted" style="margin-top:1rem"><small>Field workers: use the <a href="/field/">field app</a> on your phone.</small></p>`,
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

function renderSetup(status) {
  authShell(
    "Set up VacantWatch",
    html`<p>Create the first administrator account. You need the setup token that was configured when this was deployed.</p>
    ${status.setupTokenConfigured ? "" : html`<div class="alert error">No SETUP_TOKEN secret is configured, so setup is disabled. Set one with <code>wrangler secret put SETUP_TOKEN</code>.</div>`}
    <form id="setup">
      <div class="field"><label>Setup token</label><input name="token" type="password" required></div>
      <div class="field"><label>Your name</label><input name="name" required autocomplete="name"></div>
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>
      <div class="field"><label>Password <span class="hint">(10+ characters)</span></label><input name="password" type="password" minlength="10" required autocomplete="new-password"></div>
      <button class="primary" style="width:100%">Create admin account</button>
    </form>`,
  );
  $("#setup").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await post("/auth/setup", formData(e.target));
      boot();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

function passwordForm(id) {
  return html`<form id="${id}">
    <div class="field"><label>Current password</label><input name="current" type="password" required autocomplete="current-password"></div>
    <div class="field"><label>New password <span class="hint">(10+ characters; a passphrase is best)</span></label><input name="next" type="password" minlength="10" required autocomplete="new-password"></div>
    <button class="primary">Change password</button></form>`;
}

function renderForcedChange() {
  authShell("Choose a new password", html`<p>Your account has a temporary password. Choose your own before continuing.</p>${passwordForm("pw")}`);
  $("#pw").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await post("/auth/change-password", formData(e.target));
      toast("Password changed.");
      boot();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------------------------------------------------------------- shell

const NAV = [
  ["#/", "Overview"],
  ["#/map", "Map"],
  ["#/properties", "Properties"],
  ["#/tasks", "Tasks"],
  ["#/area", "Area report"],
];

function renderShell() {
  mount(
    root,
    html`<header class="topbar">
      <a class="brand" href="#/"><img src="/shared/icon.svg" alt="">${state.meta.org_name}</a>
      <nav class="nav" id="nav">${NAV.map(([h, l]) => html`<a href="${h}">${l}</a>`)}${can("coordinator") ? html`<a href="#/admin">Admin</a>` : ""}</nav>
      <div class="user-menu">
        ${can("field_worker") ? html`<a class="btn small primary" href="#/new">+ Add property</a>` : ""}
        <a class="btn small" href="/field/" title="Open the mobile field app">Field app</a>
        <a href="#/account" title="Account">${state.me.name}</a>
        <button class="small" data-action="logout">Sign out</button>
      </div>
    </header>
    <main class="container" id="view"></main>`,
  );
  onAction(root.querySelector(".topbar"), {
    logout: async () => {
      await post("/auth/logout").catch(() => undefined);
      state.me = null;
      boot();
    },
  });
}

function setActiveNav(hash) {
  $$("#nav a").forEach((a) => {
    const h = a.getAttribute("href");
    a.classList.toggle("active", h === "#/" ? hash === "#/" || hash === "" : hash.startsWith(h));
  });
}

// ---------------------------------------------------------------- router

const routes = [
  [/^#?\/?$/, () => overview],
  [/^#\/map$/, () => mapView],
  [/^#\/properties$/, () => propertiesView],
  [/^#\/property\/([\w-]+)$/, (m) => (el) => propertyView(el, m[1])],
  [/^#\/property\/([\w-]+)\/edit$/, (m) => (el) => propertyForm(el, m[1])],
  [/^#\/new$/, () => (el) => propertyForm(el, null)],
  [/^#\/tasks$/, () => tasksView],
  [/^#\/area$/, () => areaView],
  [/^#\/account$/, () => accountView],
  [/^#\/admin(?:\/(\w+))?$/, (m) => (el) => adminView(el, m[1] ?? "users")],
];

export function params() {
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : "");
}

export const refresh = () => route();

export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  if (!state.me) return;
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }
  const hash = location.hash.split("?")[0] || "#/";
  setActiveNav(hash);
  // A fresh container per render, so listeners bound by the previous view go with it.
  const view = document.createElement("div");
  $("#view").replaceChildren(view);
  for (const [re, make] of routes) {
    const m = re.exec(hash);
    if (m) {
      mount(view, loading());
      try {
        const result = await make(m)(view);
        if (typeof result === "function") cleanup = result;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return;
        mount(view, html`<div class="alert error">${err.message}</div>`);
        console.error(err);
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  mount(view, html`<div class="empty">Page not found. <a href="#/">Go to the overview</a>.</div>`);
}

window.addEventListener("hashchange", route);

async function boot() {
  try {
    const setup = await get("/auth/setup-status");
    if (setup.needsSetup) return renderSetup(setup);
    try {
      state.me = (await get("/auth/me")).user;
    } catch {
      return renderLogin();
    }
    if (state.me.mustChangePassword) return renderForcedChange();
    const [meta, people] = await Promise.all([get("/meta"), get("/admin/people")]);
    state.meta = meta;
    state.people = people.items;
    document.title = meta.org_name;
    renderShell();
    route();
  } catch (err) {
    mount(root, html`<div class="auth-wrap"><div class="alert error">Could not reach the server: ${err.message}</div></div>`);
  }
}

// ---------------------------------------------------------------- overview

async function overview(el) {
  const [stats, top, tasks] = await Promise.all([
    get("/stats"),
    get(`/properties${qs({ open: 1, sort: "priority", limit: 10 })}`),
    get(`/tasks${qs({ status: "active", mine: can("coordinator") ? undefined : 1 })}`),
  ]);
  const bandOrder = ["critical", "high", "medium", "low"];
  const bandRows = bandOrder.map((b) => ({ label: label(b), value: stats.by_band.find((x) => x.band === b)?.n ?? 0, colour: bandColour(b) }));
  const statusRows = state.meta.enums.statuses.map((s) => ({ label: label(s), value: stats.by_status[s] ?? 0 })).filter((r) => r.value);
  const overdue = tasks.items.filter((t) => t.due_at && t.due_at < Date.now());
  mount(
    el,
    html`<div class="page-head"><div><h1>Overview</h1><p class="muted">Vacant, derelict and abandoned properties across your watched postcodes.</p></div></div>
    <div class="tiles">
      <div class="tile"><div class="label">Open cases</div><div class="value">${num(stats.open_cases)}</div></div>
      <div class="tile ${(stats.by_band.find((b) => b.band === "critical")?.n ?? 0) ? "alert" : ""}"><div class="label">Critical priority</div><div class="value">${num(stats.by_band.find((b) => b.band === "critical")?.n ?? 0)}</div></div>
      <div class="tile"><div class="label">New (30 days)</div><div class="value">${num(stats.new_last_30_days)}</div></div>
      <div class="tile"><div class="label">Back in use (30 days)</div><div class="value">${num(stats.brought_back_last_30_days)}</div></div>
      <div class="tile"><div class="label">Visits (30 days)</div><div class="value">${num(stats.visits_last_30_days)}</div><small>${num(stats.active_workers_last_30_days)} workers</small></div>
      <div class="tile ${stats.overdue_tasks ? "alert" : ""}"><div class="label">Overdue tasks</div><div class="value">${num(stats.overdue_tasks)}</div><small>of ${num(stats.open_tasks)} open</small></div>
      <div class="tile"><div class="label">Avg. months empty</div><div class="value">${stats.avg_months_vacant ?? "—"}</div></div>
    </div>
    <div class="grid cols-3" style="margin-top:1rem">
      <div class="card"><h3>Open cases by priority</h3>${bars(bandRows)}</div>
      <div class="card"><h3>All cases by status</h3>${bars(statusRows)}</div>
      <div class="card"><h3>Open cases by ownership</h3>${bars(stats.by_category.map((c) => ({ label: label(c.category), value: c.n })))}</div>
    </div>
    <div class="split" style="margin-top:1rem">
      <div class="card"><div class="card-head"><h3>Highest priority</h3><a href="#/properties">All properties</a></div>
        ${top.items.length ? propertyTable(top.items, { compact: true }) : html`<div class="empty">No open cases yet. <a href="#/new">Add the first property</a> or <a href="#/admin/import">import a list</a>.</div>`}
      </div>
      <div class="card"><div class="card-head"><h3>${can("coordinator") ? "Open tasks" : "My tasks"}</h3><a href="#/tasks">All tasks</a></div>
        ${overdue.length ? html`<div class="alert warn">${overdue.length} overdue</div>` : ""}
        ${tasks.items.length ? taskList(tasks.items.slice(0, 8)) : html`<p class="muted">Nothing outstanding.</p>`}
      </div>
    </div>
    ${
      stats.new_by_month.length
        ? html`<div class="card" style="margin-top:1rem"><h3>Properties added per month</h3>${bars(stats.new_by_month.map((m) => ({ label: m.month, value: m.n })))}</div>`
        : ""
    }`,
  );
  rowLinks(el);
}

function rowLinks(el) {
  el.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a,button")) go(tr.dataset.href);
  });
}

function propertyTable(items, { compact = false } = {}) {
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Priority</th><th>Address</th><th>Status</th>${compact ? "" : html`<th>Ownership</th><th>Area</th><th>Assigned</th>`}<th>Last visit</th>${items[0]?.distance_m !== undefined ? html`<th class="num">Distance</th>` : ""}</tr></thead>
    <tbody>${items.map(
      (p) => html`<tr class="clickable" data-href="#/property/${p.id}">
        <td>${bandBadge(p.priority_band, p.priority_score)}</td>
        <td><a href="#/property/${p.id}">${p.address_line1}</a><br><small>${[p.address_line2, p.town, p.postcode].filter(Boolean).join(", ")}</small></td>
        <td>${statusBadge(p.status)}</td>
        ${compact ? "" : html`<td>${label(p.category)}</td><td>${p.area_name ?? "—"}</td><td>${p.assignee_name ?? "—"}</td>`}
        <td>${p.last_visited_at ? ago(p.last_visited_at) : html`<span class="muted">never</span>`}</td>
        ${p.distance_m !== undefined ? html`<td class="num">${dist(p.distance_m)}</td>` : ""}
      </tr>`,
    )}</tbody></table></div>`;
}

function taskList(items) {
  return html`<ul class="timeline">${items.map(
    (t) => html`<li><div class="row between"><strong>${t.title}</strong>${t.priority_band ? bandBadge(t.priority_band) : ""}</div>
      <small>${label(t.type)} · ${t.due_at ? html`due ${date(t.due_at)}${t.due_at < Date.now() ? html` <span class="badge danger">overdue</span>` : ""}` : "no due date"} · ${t.assignee_name ?? "unassigned"}</small>
      ${t.property_id && t.address_line1 ? html`<br><a href="#/property/${t.property_id}">${t.address_line1}, ${t.postcode}</a>` : ""}</li>`,
  )}</ul>`;
}

// ---------------------------------------------------------------- map

async function mapView(el) {
  const p = params();
  const closed = p.get("closed") === "1";
  mount(
    el,
    html`<div class="page-head"><h1>Map</h1>
      <div class="row">
        <label class="row" style="font-weight:500"><input type="checkbox" id="closed" ${closed ? raw("checked") : ""}> Show closed cases</label>
        <label class="row" style="font-weight:500"><input type="checkbox" id="areas" checked> Watch areas</label>
      </div></div>
    <div class="legend" style="margin-bottom:.5rem">${["critical", "high", "medium", "low", null].map((b) => html`<span><i class="dot" style="background:${bandColour(b)}"></i>${b ? label(b) : "Unscored"}</span>`)}</div>
    <div id="map" class="map tall"></div>`,
  );
  const [{ items }, areas] = await Promise.all([get(`/properties/map${qs({ closed: closed ? 1 : undefined })}`), get("/areas")]);
  const L = await leaflet();
  const map = await createMap($("#map"));
  const markers = L.layerGroup(items.map((x) => propertyMarker(L, x, { href: (q) => `#/property/${q.id}` }))).addTo(map);
  const areaLayer = L.layerGroup(
    areas.items
      .filter((a) => a.latitude !== null && a.active)
      .map((a) => L.circle([a.latitude, a.longitude], { radius: a.postcode_prefix.includes(" ") ? 600 : 1500, color: "#0f5c8c", weight: 1, fillOpacity: 0.04 }).bindTooltip(`${a.name} (${a.postcode_prefix})`)),
  ).addTo(map);
  if (items.length) fitTo(map, items);
  else if (areas.items.length) fitTo(map, areas.items.filter((a) => a.latitude !== null), 13);
  $("#closed").addEventListener("change", (e) => go(`#/map${e.target.checked ? "?closed=1" : ""}`));
  $("#areas").addEventListener("change", (e) => (e.target.checked ? areaLayer.addTo(map) : areaLayer.remove()));
  void markers;
  return () => map.remove();
}

// ---------------------------------------------------------------- properties list

async function propertiesView(el) {
  const p = params();
  const areas = await get("/areas");
  const f = {
    q: p.get("q") ?? "",
    status: p.get("status") ?? "",
    category: p.get("category") ?? "",
    band: p.get("band") ?? "",
    area: p.get("area") ?? "",
    assigned: p.get("assigned") ?? "",
    sort: p.get("sort") ?? "priority",
    open: p.get("open") ?? (p.get("status") ? "" : "1"),
    offset: Number(p.get("offset") ?? 0),
  };
  const limit = 50;
  mount(
    el,
    html`<div class="page-head"><h1>Properties</h1>
      <div class="row">${can("coordinator") ? html`<a class="btn small" href="/api/admin/export?format=csv">Export CSV</a><a class="btn small" href="/api/admin/export?format=geojson">Export GeoJSON</a>` : ""}</div></div>
    <form class="filters" id="filters">
      <div class="field" style="flex:2 1 220px"><label>Search</label><input name="q" value="${f.q}" placeholder="Address, postcode or reference"></div>
      <div class="field"><label>Status</label><select name="status"><option value="">${f.open ? "All open" : "Any"}</option>${options(state.meta.enums.statuses, f.status)}</select></div>
      <div class="field"><label>Ownership</label><select name="category">${options(state.meta.enums.categories, f.category, { blank: "Any" })}</select></div>
      <div class="field"><label>Priority</label><select name="band">${options(["critical", "high", "medium", "low"], f.band, { blank: "Any" })}</select></div>
      <div class="field"><label>Area</label><select name="area"><option value="">Any</option>${areas.items.map((a) => html`<option value="${a.id}" ${a.id === f.area ? raw("selected") : ""}>${a.name}</option>`)}</select></div>
      <div class="field"><label>Assigned</label><select name="assigned"><option value="">Anyone</option><option value="me" ${f.assigned === "me" ? raw("selected") : ""}>Me</option>${state.people.map((u) => html`<option value="${u.id}" ${u.id === f.assigned ? raw("selected") : ""}>${u.name}</option>`)}</select></div>
      <div class="field"><label>Sort</label><select name="sort">${[["priority", "Priority"], ["updated", "Recently updated"], ["created", "Newest"], ["visited", "Longest since visit"], ["postcode", "Postcode"]].map(([v, l]) => html`<option value="${v}" ${v === f.sort ? raw("selected") : ""}>${l}</option>`)}</select></div>
      <label class="row" style="font-weight:500;flex:0 0 auto"><input type="checkbox" name="open" value="1" ${f.open ? raw("checked") : ""}> Open cases only</label>
    </form>
    <div id="results">${loading()}</div>`,
  );
  const apply = () => {
    const d = new FormData($("#filters"));
    const next = new URLSearchParams();
    for (const [k, v] of d) if (v) next.set(k, v);
    if (!d.get("open")) next.set("open", "");
    go(`#/properties?${next}`);
  };
  $("#filters").addEventListener("change", apply);
  $("#filters").addEventListener("input", debounce((e) => e.target.name === "q" && apply(), 500));
  $("#filters").addEventListener("submit", (e) => {
    e.preventDefault();
    apply();
  });
  const res = await get(
    `/properties${qs({ q: f.q, status: f.status, category: f.category, band: f.band, area: f.area, assigned: f.assigned, sort: f.sort, open: f.open && !f.status ? 1 : undefined, limit, offset: f.offset })}`,
  );
  const page = (o) => {
    const n = params();
    n.set("offset", String(o));
    return `#/properties?${n}`;
  };
  mount(
    $("#results"),
    res.items.length
      ? html`${propertyTable(res.items)}<div class="pager"><small>${num(res.offset + 1)}–${num(res.offset + res.items.length)} of ${num(res.total)}</small>
          ${res.offset > 0 ? html`<a class="btn small" href="${page(Math.max(0, res.offset - limit))}">Previous</a>` : ""}
          ${res.offset + limit < res.total ? html`<a class="btn small" href="${page(res.offset + limit)}">Next</a>` : ""}</div>`
      : html`<div class="empty">No properties match.</div>`,
  );
  rowLinks($("#results"));
}

// ---------------------------------------------------------------- property detail

function sourcesById(enrichment) {
  return Object.fromEntries(enrichment.map((e) => [e.source, e]));
}

async function propertyView(el, id) {
  const d = await get(`/properties/${id}`);
  const p = d.property;
  const ins = p.insights;
  const sources = sourcesById(d.enrichment);
  const canEdit = can("field_worker");
  mount(
    el,
    html`<div class="page-head">
      <div><h1>${p.address_line1}</h1>
        <p class="muted" style="margin:0">${[p.address_line2, p.town, p.postcode].filter(Boolean).join(", ")}</p>
        <div class="row" style="margin-top:.5rem">${statusBadge(p.status)} ${bandBadge(p.priority_band, p.priority_score)} <span class="badge">${label(p.category)}</span>
          ${p.vacancy_likelihood !== null ? html`<span class="badge" title="Estimated likelihood the property is empty">${Math.round(p.vacancy_likelihood * 100)}% likely vacant</span>` : ""}
          ${p.archived ? html`<span class="badge danger">Archived</span>` : ""}</div>
      </div>
      <div class="row">
        ${canEdit ? html`<button class="primary" data-action="visit">Log visit</button><a class="btn" href="#/property/${p.id}/edit">Edit</a><button data-action="task">Add task</button>` : ""}
        ${can("coordinator") ? html`<button data-action="enrich" title="Fetch all public data again now">Refresh data</button>` : ""}
        ${can("coordinator") && !p.archived ? html`<button class="danger" data-action="archive">Archive</button>` : ""}
      </div>
    </div>
    ${p.enrichment_status === "pending" || p.enrichment_status === "running" ? html`<div class="alert">Public data is being gathered for this property. Refresh in a minute.</div>` : ""}
    <div class="split">
      <div class="stack">
        ${
          ins
            ? html`<div class="card"><div class="card-head"><h3>Priority assessment</h3><small>model ${ins.model_version}</small></div>
              ${ins.recommended_actions?.length ? html`<h4>Recommended next steps</h4><ul>${ins.recommended_actions.map(
                (a, i) => html`<li style="margin-bottom:.4rem"><strong>${a.title}</strong> <span class="badge ${a.urgency === "now" ? "danger" : a.urgency === "this_week" ? "warn" : ""}">${label(a.urgency)}</span><br><small>${a.detail}</small>
                  ${canEdit ? html` <button class="link-btn" data-action="action-task" data-i="${i}">Create task</button>` : ""}</li>`,
              )}</ul>` : ""}
              <h4>Why it scores ${ins.priority_score}</h4>
              <ul>${ins.reasons.map((r) => html`<li>${r.impact ? html`<strong>+${r.impact}</strong> ` : ""}${r.detail}</li>`)}</ul>
              ${ins.months_vacant ? html`<p class="muted"><small>Estimated ${ins.months_vacant} months empty.</small></p>` : ""}</div>`
            : html`<div class="card"><h3>Priority assessment</h3><p class="muted">Not scored yet. Scores appear once public data has been gathered.</p></div>`
        }
        <div class="card"><h3>Case details</h3>
          <dl class="kv">
            <dt>Ownership</dt><dd>${label(p.category)}</dd>
            <dt>Property type</dt><dd>${label(p.property_type)}${p.bedrooms !== null ? `, ${p.bedrooms} bed` : ""}</dd>
            <dt>Condition</dt><dd>${label(p.condition)}</dd>
            <dt>Security</dt><dd>${label(p.security)}</dd>
            <dt>Empty since</dt><dd>${p.vacant_since ?? "—"}</dd>
            <dt>Watch area</dt><dd>${p.area_name ?? "—"}</dd>
            <dt>Assigned to</dt><dd>${p.assignee_name ?? "—"}</dd>
            <dt>UPRN</dt><dd>${p.uprn ?? sources.epc?.data?.this_property?.uprn ?? "—"}</dd>
            <dt>Source</dt><dd>${label(p.source)}${p.source_ref ? ` · ${p.source_ref}` : ""}</dd>
            <dt>Added</dt><dd>${date(p.created_at)} by ${p.created_by_name ?? "—"}</dd>
            <dt>Last visit</dt><dd>${p.last_visited_at ? `${date(p.last_visited_at)} (${ago(p.last_visited_at)})` : "never"}</dd>
            ${"owner_info" in p ? html`<dt>Owner notes</dt><dd>${p.owner_info ?? "—"} <small class="muted">(coordinators only)</small></dd>` : ""}
          </dl>
          ${p.description ? html`<h4 style="margin-top:1rem">Notes</h4><p style="white-space:pre-wrap">${p.description}</p>` : ""}
          ${p.tags?.length ? html`<div class="chips" style="margin-top:.5rem">${p.tags.map((t) => html`<span class="chip">${t}</span>`)}</div>` : ""}
        </div>
        <div class="card"><div class="card-head"><h3>Photos (${d.photos.length})</h3>${canEdit ? html`<label class="btn small" style="margin:0">Upload<input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden id="photo-input"></label>` : ""}</div>
          ${d.photos.length ? html`<div class="photos">${d.photos.map((ph) => html`<a href="/api/photos/${ph.id}" target="_blank" rel="noopener" title="${ph.caption ?? date(ph.created_at)}"><img src="/api/photos/${ph.id}" alt="${ph.caption ?? "Property photo"}" loading="lazy"></a>`)}</div>` : html`<p class="muted">No photos yet. Photograph from the street; avoid people and number plates.</p>`}
        </div>
        <div class="card"><h3>Visits (${d.visits.length})</h3>
          ${
            d.visits.length
              ? html`<ul class="timeline">${d.visits.map(
                  (v) => html`<li><div class="row between"><strong>${date(v.visited_at, true)}</strong><small>${v.user_name ?? "—"}</small></div>
                    <div class="row" style="margin:.25rem 0">${v.observed_status ? statusBadge(v.observed_status) : ""}${v.condition ? html`<span class="badge">${label(v.condition)}</span>` : ""}${v.security ? html`<span class="badge">${label(v.security)}</span>` : ""}</div>
                    ${v.signals.length ? html`<div class="chips">${v.signals.map((s) => html`<span class="chip">${label(s)}</span>`)}</div>` : ""}
                    ${v.notes ? html`<p style="white-space:pre-wrap;margin:.4rem 0 0">${v.notes}</p>` : ""}
                    ${v.latitude ? html`<small class="muted">GPS ${v.latitude.toFixed(5)}, ${v.longitude.toFixed(5)}${v.gps_accuracy_m ? ` ±${Math.round(v.gps_accuracy_m)} m` : ""}</small>` : ""}</li>`,
                )}</ul>`
              : html`<p class="muted">No visits logged.</p>`
          }
        </div>
        <div class="card"><h3>Tasks</h3>${d.tasks.length ? taskList(d.tasks) : html`<p class="muted">No tasks.</p>`}</div>
        <div class="card"><h3>History</h3>${
          d.history.length
            ? html`<ul class="timeline">${d.history.map((h) => html`<li><strong>${label(h.action)}</strong> by ${h.user_name ?? "system"} · <small>${date(h.created_at, true)}</small>${historyDetail(h)}</li>`)}</ul>`
            : html`<p class="muted">No changes recorded.</p>`
        }</div>
      </div>
      <div class="stack">
        <div class="card"><div id="pmap" class="map"></div>
          <p class="muted" style="margin:.5rem 0 0"><small>${p.location_source === "postcode" ? "Pin is the postcode centre, not the exact building." : p.location_source === "gps" ? "Pin placed by GPS." : p.location_source === "manual" ? "Pin placed by hand." : "No location yet."}</small>
          ${p.latitude ? html` · <a href="https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=18/${p.latitude}/${p.longitude}" target="_blank" rel="noopener">OpenStreetMap</a> · <a href="https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}" target="_blank" rel="noopener">Google Maps</a>` : ""}</p>
        </div>
        <div class="card"><div class="card-head"><h3>Public data</h3><a href="#/area?postcode=${encodeURIComponent(p.postcode)}">Postcode report</a></div>
          ${d.enrichment.length ? sourceStatusList(d.enrichment) : html`<p class="muted">Not gathered yet.</p>`}</div>
        ${areaPanels(sources, ins?.area_profile)}
      </div>
    </div>`,
  );
  let map = null;
  if (p.latitude !== null) {
    const L = await leaflet();
    map = await createMap($("#pmap"), { centre: [p.latitude, p.longitude], zoom: 17 });
    propertyMarker(L, p).addTo(map);
  } else $("#pmap").outerHTML = '<p class="muted">No location yet.</p>';

  onAction(el, {
    visit: () => visitModal(p, refresh),
    task: () => taskModal({ property_id: p.id }, refresh),
    "action-task": (btn) => {
      const a = ins.recommended_actions[Number(btn.dataset.i)];
      taskModal({ property_id: p.id, type: a.type, title: a.title, notes: a.detail }, refresh);
    },
    enrich: async (btn) => {
      btn.disabled = true;
      btn.textContent = "Fetching…";
      try {
        const r = await post(`/properties/${id}/enrich`);
        toast(`Public data ${r.status}.`);
        refresh();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
      }
    },
    archive: () =>
      modal(html`<h2>Archive this property?</h2><p>It will disappear from lists and the map. The record and its history are kept.</p>`, {
        submitLabel: "Archive",
        danger: true,
        onSubmit: async () => {
          await del(`/properties/${id}`);
          toast("Archived.");
          go("#/properties");
        },
      }),
  });
  $("#photo-input")?.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    for (const f of files) {
      const fd = new FormData();
      fd.set("file", await downscale(f));
      try {
        await post(`/properties/${id}/photos`, fd);
      } catch (err) {
        toast(`${f.name}: ${err.message}`, "error");
      }
    }
    toast(`${files.length} photo(s) uploaded.`);
    refresh();
  });
  return () => map?.remove();
}

function historyDetail(h) {
  if (!h.detail || typeof h.detail !== "object") return "";
  const entries = Object.entries(h.detail).filter(([k]) => !["visit_id", "photo_id"].includes(k));
  if (!entries.length) return "";
  return html`<br><small class="muted">${entries
    .slice(0, 6)
    .map(([k, v]) => (v && typeof v === "object" && "to" in v ? `${label(k)}: ${fmt(v.from)} → ${fmt(v.to)}` : `${label(k)}: ${fmt(v)}`))
    .join(" · ")}</small>`;
}
const fmt = (v) => (v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.map(label).join(", ") : typeof v === "string" ? label(v) : String(v));

/** Downscale to 1600px JPEG in the browser. Re-encoding also strips EXIF, including GPS. */
export async function downscale(file, max = 1600) {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function signalPicker(selected = []) {
  return html`<div class="chips" role="group" aria-label="What did you see?">${state.meta.enums.signals.map(
    (s) => html`<label class="chip" style="cursor:pointer;display:inline-flex;gap:.3rem;align-items:center"><input type="checkbox" data-group="signals" name="sig_${s}" value="${s}" ${selected.includes(s) ? raw("checked") : ""}> ${label(s)}</label>`,
  )}</div>`;
}

function visitModal(p, done) {
  modal(
    html`<h2>Log a visit</h2><p class="muted">${p.address_line1}, ${p.postcode}. Observe from the street; never enter a building.</p>
    <div class="form-grid">
      <div class="field"><label>Status seen</label><select name="observed_status">${options(state.meta.enums.statuses, p.status)}</select></div>
      <div class="field"><label>Condition</label><select name="condition">${options(state.meta.enums.conditions, p.condition, { blank: "Not assessed" })}</select></div>
      <div class="field"><label>Security</label><select name="security">${options(state.meta.enums.security, p.security, { blank: "Not assessed" })}</select></div>
      <div class="field"><label>When</label><input type="datetime-local" name="when" value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}"></div>
    </div>
    <div class="field"><label>What did you see?</label>${signalPicker()}</div>
    <div class="field"><label>Notes</label><textarea name="notes" placeholder="Anything else worth recording. Do not record names or identifying details of people."></textarea></div>`,
    {
      submitLabel: "Save visit",
      onSubmit: async (form) => {
        const d = formData(form);
        await post(`/properties/${p.id}/visits`, {
          observed_status: d.observed_status,
          condition: d.condition,
          security: d.security,
          signals: d.signals ?? [],
          notes: d.notes,
          visited_at: d.when ? new Date(d.when).getTime() : undefined,
        });
        toast("Visit saved.");
        done();
      },
    },
  );
}

export function taskModal(preset, done) {
  modal(
    html`<h2>New task</h2>
    <div class="field"><label>Title</label><input name="title" required maxlength="200" value="${preset.title ?? ""}"></div>
    <div class="form-grid">
      <div class="field"><label>Type</label><select name="type">${options(state.meta.enums.task_types, preset.type ?? "other")}</select></div>
      <div class="field"><label>Due</label><input type="date" name="due"></div>
      <div class="field"><label>Assign to</label><select name="assigned_to" ${can("coordinator") ? "" : raw("disabled")}><option value="">Unassigned</option>${state.people.map((u) => html`<option value="${u.id}" ${u.id === state.me.id && !can("coordinator") ? raw("selected") : ""}>${u.name}</option>`)}</select></div>
    </div>
    <div class="field"><label>Notes</label><textarea name="notes">${preset.notes ?? ""}</textarea></div>`,
    {
      submitLabel: "Create task",
      onSubmit: async (form) => {
        const d = formData(form);
        await post("/tasks", {
          property_id: preset.property_id ?? null,
          type: d.type,
          title: d.title,
          notes: d.notes,
          due_at: d.due ? new Date(`${d.due}T17:00:00`).getTime() : null,
          assigned_to: can("coordinator") ? d.assigned_to : state.me.id,
        });
        toast("Task created.");
        done();
      },
    },
  );
}

// ---------------------------------------------------------------- property form

async function propertyForm(el, id) {
  const existing = id ? (await get(`/properties/${id}`)).property : null;
  const p = existing ?? { category: "unknown", status: "reported" };
  const isCoord = can("coordinator");
  mount(
    el,
    html`<div class="page-head"><h1>${existing ? "Edit property" : "Add a property"}</h1></div>
    <form id="pform" class="split">
      <div class="card">
        <h3>Address</h3>
        <div class="field"><label>Address line 1 <span class="hint">(house number/name and street)</span></label><input name="address_line1" required maxlength="200" value="${p.address_line1 ?? ""}"></div>
        <div class="field"><label>Address line 2</label><input name="address_line2" maxlength="200" value="${p.address_line2 ?? ""}"></div>
        <div class="form-grid">
          <div class="field"><label>Town</label><input name="town" maxlength="100" value="${p.town ?? ""}"></div>
          <div class="field"><label>Postcode</label><input name="postcode" required maxlength="10" value="${p.postcode ?? ""}" autocomplete="postal-code" style="text-transform:uppercase"><small id="pc-info" class="muted"></small></div>
        </div>
        <h3 style="margin-top:1rem">Case</h3>
        <div class="form-grid">
          <div class="field"><label>Status</label><select name="status">${options(state.meta.enums.statuses, p.status)}</select></div>
          <div class="field"><label>Ownership</label><select name="category">${options(state.meta.enums.categories, p.category)}</select></div>
          <div class="field"><label>Property type</label><select name="property_type">${options(state.meta.enums.property_types, p.property_type, { blank: "Unknown" })}</select></div>
          <div class="field"><label>Bedrooms</label><input name="bedrooms" type="number" min="0" max="50" data-type="number" value="${p.bedrooms ?? ""}"></div>
          <div class="field"><label>Condition</label><select name="condition">${options(state.meta.enums.conditions, p.condition, { blank: "Not assessed" })}</select></div>
          <div class="field"><label>Security</label><select name="security">${options(state.meta.enums.security, p.security, { blank: "Not assessed" })}</select></div>
          <div class="field"><label>Empty since <span class="hint">(YYYY-MM or YYYY-MM-DD)</span></label><input name="vacant_since" pattern="\\d{4}-\\d{2}(-\\d{2})?" value="${p.vacant_since ?? ""}" placeholder="2025-03"></div>
          <div class="field"><label>Reference</label><input name="source_ref" maxlength="200" value="${p.source_ref ?? ""}" placeholder="e.g. council list ref"></div>
          ${isCoord ? html`<div class="field"><label>Assign to</label><select name="assigned_to"><option value="">Unassigned</option>${state.people.map((u) => html`<option value="${u.id}" ${u.id === p.assigned_to ? raw("selected") : ""}>${u.name}</option>`)}</select></div>` : ""}
        </div>
        <div class="field"><label>Notes</label><textarea name="description" maxlength="5000">${p.description ?? ""}</textarea></div>
        ${isCoord ? html`<div class="field"><label>Owner notes <span class="hint">(coordinators only. Record only what is needed; owners may be private individuals.)</span></label><textarea name="owner_info" maxlength="2000">${p.owner_info ?? ""}</textarea></div>` : ""}
        <div class="field"><label>Tags <span class="hint">(comma separated)</span></label><input name="tags" value="${(p.tags ?? []).join(", ")}"></div>
      </div>
      <div class="card"><h3>Location</h3><p class="muted"><small>Click the map to pin the exact building. Without a pin, the postcode centre is used.</small></p>
        <div id="fmap" class="map" style="height:380px"></div>
        <input type="hidden" name="latitude" data-type="number" value="${p.latitude ?? ""}"><input type="hidden" name="longitude" data-type="number" value="${p.longitude ?? ""}">
        <div class="row" style="margin-top:.5rem"><button type="button" data-action="clear-pin" class="small">Clear pin</button><small id="pin-info" class="muted"></small></div>
        <div class="row" style="margin-top:1.5rem"><button class="primary" type="submit">${existing ? "Save changes" : "Add property"}</button><a class="btn" href="${existing ? `#/property/${existing.id}` : "#/properties"}">Cancel</a></div>
      </div>
    </form>`,
  );
  const L = await leaflet();
  const map = await createMap($("#fmap"));
  let marker = null;
  const form = $("#pform");
  const setPin = (lat, lng, pan = true) => {
    form.latitude.value = lat ?? "";
    form.longitude.value = lng ?? "";
    if (marker) marker.remove();
    marker = lat !== null && lat !== undefined ? L.marker([lat, lng]).addTo(map) : null;
    $("#pin-info").textContent = marker ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : "No pin";
    if (marker && pan) map.setView([lat, lng], Math.max(map.getZoom(), 17));
  };
  if (p.latitude !== null && p.latitude !== undefined && p.location_source !== "postcode") setPin(p.latitude, p.longitude);
  else if (p.latitude) map.setView([p.latitude, p.longitude], 16);
  map.on("click", (e) => setPin(e.latlng.lat, e.latlng.lng, false));
  onAction(form, { "clear-pin": () => setPin(null, null) });
  const lookup = debounce(async () => {
    const v = form.postcode.value.trim();
    if (v.length < 5) return;
    try {
      const pc = await get(`/lookup/postcode/${encodeURIComponent(v)}`);
      form.postcode.value = pc.postcode;
      $("#pc-info").textContent = [pc.ward, pc.local_authority].filter(Boolean).join(", ");
      if (!marker && pc.latitude) map.setView([pc.latitude, pc.longitude], 17);
    } catch (err) {
      $("#pc-info").textContent = err.message;
    }
  }, 500);
  form.postcode.addEventListener("input", lookup);
  if (p.postcode) lookup();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(form);
    const body = {
      address_line1: d.address_line1,
      address_line2: d.address_line2,
      town: d.town,
      postcode: d.postcode,
      status: d.status,
      category: d.category,
      property_type: d.property_type,
      bedrooms: d.bedrooms,
      condition: d.condition,
      security: d.security,
      vacant_since: d.vacant_since,
      source_ref: d.source_ref,
      description: d.description,
      tags: d.tags ? d.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      latitude: d.latitude,
      longitude: d.longitude,
      location_source: d.latitude !== null ? "manual" : null,
    };
    if (isCoord) {
      body.owner_info = d.owner_info;
      body.assigned_to = d.assigned_to;
    }
    try {
      if (existing) {
        if (d.latitude === null && existing.location_source === "postcode") {
          delete body.latitude;
          delete body.longitude;
          delete body.location_source;
        }
        await patch(`/properties/${existing.id}`, body);
        toast("Saved.");
        go(`#/property/${existing.id}`);
      } else {
        const r = await post("/properties", body);
        toast("Property added. Public data is being gathered.");
        go(`#/property/${r.id}`);
      }
    } catch (err) {
      if (err.status === 409 && err.details?.id) {
        modal(html`<h2>Already recorded</h2><p>${err.message}</p><p><a href="#/property/${err.details.id}">Open the existing record</a></p>`, {
          submitLabel: "Add anyway",
          onSubmit: async () => {
            const r = await post("/properties", { ...body, force: true });
            go(`#/property/${r.id}`);
          },
        });
      } else toast(err.message, "error");
    }
  });
  return () => map.remove();
}

// ---------------------------------------------------------------- tasks

async function tasksView(el) {
  const p = params();
  const scope = p.get("scope") ?? (can("coordinator") ? "all" : "mine");
  const status = p.get("status") ?? "active";
  const res = await get(`/tasks${qs({ mine: scope === "mine" ? 1 : undefined, unassigned: scope === "unassigned" ? 1 : undefined, status })}`);
  const tab = (s, l) => html`<a class="btn small ${scope === s ? "primary" : ""}" href="#/tasks?scope=${s}&status=${status}">${l}</a>`;
  const stab = (s, l) => html`<a class="btn small ${status === s ? "primary" : ""}" href="#/tasks?scope=${scope}&status=${s}">${l}</a>`;
  mount(
    el,
    html`<div class="page-head"><h1>Tasks</h1>${can("field_worker") ? html`<button class="primary" data-action="new">New task</button>` : ""}</div>
    <div class="row" style="margin-bottom:1rem">${tab("mine", "Mine")}${tab("all", "Everyone")}${tab("unassigned", "Unassigned")}<span class="spacer"></span>${stab("active", "Open")}${stab("done", "Done")}</div>
    ${
      res.items.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Task</th><th>Property</th><th>Due</th><th>Assigned</th><th>Status</th></tr></thead><tbody>${res.items.map(
            (t) => html`<tr>
              <td><strong>${t.title}</strong><br><small>${label(t.type)}</small>${t.notes ? html`<br><small class="muted">${t.notes}</small>` : ""}</td>
              <td>${t.property_id ? html`<a href="#/property/${t.property_id}">${t.address_line1}</a><br><small>${t.postcode}</small>` : "—"}</td>
              <td>${t.due_at ? html`${date(t.due_at)}${t.due_at < Date.now() && t.status !== "done" ? html` <span class="badge danger">overdue</span>` : ""}` : "—"}</td>
              <td>${
                can("coordinator")
                  ? html`<select data-assign="${t.id}"><option value="">Unassigned</option>${state.people.map((u) => html`<option value="${u.id}" ${u.id === t.assigned_to ? raw("selected") : ""}>${u.name}</option>`)}</select>`
                  : t.assignee_name ?? "—"
              }</td>
              <td><select data-status="${t.id}" ${can("field_worker") ? "" : raw("disabled")}>${options(state.meta.enums.task_statuses, t.status)}</select></td>
            </tr>`,
          )}</tbody></table></div>`
        : html`<div class="empty">No tasks here.</div>`
    }`,
  );
  el.addEventListener("change", async (e) => {
    const s = e.target.closest("[data-status]");
    const a = e.target.closest("[data-assign]");
    try {
      if (s) await patch(`/tasks/${s.dataset.status}`, { status: s.value });
      if (a) await patch(`/tasks/${a.dataset.assign}`, { assigned_to: a.value || null });
      toast("Updated.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  onAction(el, { new: () => taskModal({}, refresh) });
}

// ---------------------------------------------------------------- area report

async function areaView(el) {
  const postcode = params().get("postcode") ?? "";
  mount(
    el,
    html`<div class="page-head"><div><h1>Area report</h1><p class="muted">Everything public about a postcode: deprivation, crime, sales, energy, Census, planning, flood and nearby services.</p></div></div>
    <form id="aform" class="filters"><div class="field" style="max-width:240px"><label>Postcode</label><input name="postcode" value="${postcode}" required placeholder="e.g. M14 5TP" style="text-transform:uppercase"></div><button class="primary" style="flex:0 0 auto">Run report</button></form>
    <div id="report"></div>`,
  );
  $("#aform").addEventListener("submit", (e) => {
    e.preventDefault();
    go(`#/area?postcode=${encodeURIComponent(e.target.postcode.value.trim())}`);
  });
  if (!postcode) return;
  mount($("#report"), loading("Querying eight public data sources…"));
  const r = await get(`/area-report${qs({ postcode })}`);
  const sources = Object.fromEntries(r.sources.map((s) => [s.source, { ...s, fetched_at: Date.now() }]));
  mount(
    $("#report"),
    html`<div class="split">
      <div class="stack">${areaPanels(sources, r.area_profile)}</div>
      <div class="stack">
        <div class="card"><div id="amap" class="map"></div></div>
        <div class="card"><div class="card-head"><h3>Recorded properties in ${r.postcode}</h3>${can("field_worker") ? html`<a class="btn small" href="#/new" data-action="add">Add one here</a>` : ""}</div>
          ${r.properties.length ? html`<ul>${r.properties.map((p) => html`<li><a href="#/property/${p.id}">${p.address_line1}</a> ${statusBadge(p.status)} ${bandBadge(p.priority_band)}</li>`)}</ul>` : html`<p class="muted">None recorded.</p>`}
        </div>
        <div class="card"><h3>Source status</h3>${sourceStatusList(r.sources)}</div>
      </div></div>`,
  );
  const L = await leaflet();
  const map = await createMap($("#amap"), { centre: [r.location.latitude, r.location.longitude], zoom: 16 });
  L.circle([r.location.latitude, r.location.longitude], { radius: 50, color: "#0f5c8c" }).addTo(map);
  const services = sources.services?.data?.groups ?? {};
  for (const g of Object.values(services)) {
    for (const n of g.nearest) L.circleMarker([n.lat, n.lng], { radius: 5, color: "#3d7c47" }).bindTooltip(`${n.name ?? label(n.kind)} (${g.label})`).addTo(map);
  }
  return () => map.remove();
}

// ---------------------------------------------------------------- account

async function accountView(el) {
  mount(
    el,
    html`<div class="page-head"><h1>Your account</h1></div>
    <div class="grid cols-2"><div class="card"><dl class="kv"><dt>Name</dt><dd>${state.me.name}</dd><dt>Email</dt><dd>${state.me.email}</dd><dt>Role</dt><dd>${label(state.me.role)}</dd></dl></div>
    <div class="card"><h3>Change password</h3><p class="muted"><small>Changing it signs you out everywhere else.</small></p>${passwordForm("pw")}</div></div>`,
  );
  $("#pw").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await post("/auth/change-password", formData(e.target));
      toast("Password changed.");
      e.target.reset();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

boot();
