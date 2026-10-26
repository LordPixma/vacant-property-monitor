import { del, get, patch, post, put, qs } from "../shared/api.js";
import { $, ago, date, formData, html, label, loading, modal, mount, num, onAction, options, raw, toast } from "../shared/ui.js";
import { can, go, refresh, state } from "./main.js";

const TABS = [
  ["users", "Users", "admin"],
  ["areas", "Watch areas", "coordinator"],
  ["services", "Services", "coordinator"],
  ["import", "Import", "coordinator"],
  ["sources", "Data sources", "coordinator"],
  ["settings", "Settings", "coordinator"],
  ["audit", "Audit log", "admin"],
];

export async function adminView(el, tab) {
  if (!can("coordinator")) {
    mount(el, html`<div class="alert error">Admin is for coordinators and administrators.</div>`);
    return;
  }
  const allowed = TABS.filter(([, , role]) => can(role));
  if (!allowed.some(([t]) => t === tab)) return go(`#/admin/${allowed[0][0]}`);
  mount(
    el,
    html`<div class="page-head"><h1>Admin</h1></div>
    <div class="row" style="margin-bottom:1rem">${allowed.map(([t, l]) => html`<a class="btn small ${t === tab ? "primary" : ""}" href="#/admin/${t}">${l}</a>`)}</div>
    <div id="admin-body">${loading()}</div>`,
  );
  const body = $("#admin-body", el);
  await { users, areas, services, import: importView, sources, settings, audit }[tab](body);
}

// ---------------------------------------------------------------- users

function showPassword(name, password) {
  modal(
    html`<h2>Temporary password</h2><p>Give this to ${name} securely (in person or by phone, not in the same message as their email address). It is shown only once, and they must change it at first sign-in.</p>
    <p style="font-size:1.4rem;font-family:ui-monospace,monospace;user-select:all;background:var(--surface-2);padding:.75rem;border-radius:8px;text-align:center">${password}</p>`,
  );
}

async function users(el) {
  const { items } = await get("/admin/users");
  mount(
    el,
    html`<div class="row between" style="margin-bottom:.75rem"><p class="muted" style="margin:0">Roles: <strong>admin</strong> manages users and settings · <strong>coordinator</strong> assigns, imports and sees owner notes · <strong>field worker</strong> adds properties, visits and photos · <strong>viewer</strong> reads only.</p><button class="primary" data-action="add">Add user</button></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="num">Visits</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead><tbody>${items.map(
      (u) => html`<tr>
        <td>${u.name}${u.id === state.me.id ? html` <span class="badge">you</span>` : ""}</td><td>${u.email}</td>
        <td><select data-role="${u.id}" ${u.id === state.me.id ? raw("disabled") : ""}>${options(state.meta.enums.roles, u.role)}</select></td>
        <td class="num">${num(u.visit_count)}</td>
        <td>${u.last_login_at ? ago(u.last_login_at) : "never"}</td>
        <td>${u.active ? html`<span class="badge ok">Active</span>` : html`<span class="badge">Disabled</span>`}${u.must_change_password ? html` <span class="badge warn">Temp password</span>` : ""}${u.locked_until && u.locked_until > Date.now() ? html` <span class="badge danger">Locked</span>` : ""}</td>
        <td class="row">${u.id === state.me.id ? "" : html`<button class="small" data-action="reset" data-id="${u.id}" data-name="${u.name}">Reset password</button><button class="small" data-action="toggle" data-id="${u.id}" data-active="${u.active}">${u.active ? "Disable" : "Enable"}</button>`}</td>
      </tr>`,
    )}</tbody></table></div>`,
  );
  el.addEventListener("change", async (e) => {
    const s = e.target.closest("[data-role]");
    if (!s) return;
    try {
      await patch(`/admin/users/${s.dataset.role}`, { role: s.value });
      toast("Role updated. They will need to sign in again.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  onAction(el, {
    add: () =>
      modal(
        html`<h2>Add user</h2>
        <div class="field"><label>Name</label><input name="name" required maxlength="100"></div>
        <div class="field"><label>Email</label><input name="email" type="email" required></div>
        <div class="field"><label>Role</label><select name="role">${options(state.meta.enums.roles, "field_worker")}</select></div>
        <div class="field"><label>Phone <span class="hint">(optional, for coordination)</span></label><input name="phone" maxlength="30"></div>
        <p class="muted"><small>A temporary password is generated and shown once.</small></p>`,
        {
          submitLabel: "Create",
          onSubmit: async (form) => {
            const d = formData(form);
            const r = await post("/admin/users", d);
            refresh();
            setTimeout(() => showPassword(d.name, r.temporary_password), 50);
          },
        },
      ),
    reset: async (btn) => {
      if (!confirm(`Reset ${btn.dataset.name}'s password? They will be signed out everywhere.`)) return;
      try {
        const r = await post(`/admin/users/${btn.dataset.id}/reset-password`);
        showPassword(btn.dataset.name, r.temporary_password);
      } catch (err) {
        toast(err.message, "error");
      }
    },
    toggle: async (btn) => {
      try {
        await patch(`/admin/users/${btn.dataset.id}`, { active: btn.dataset.active !== "1" });
        refresh();
      } catch (err) {
        toast(err.message, "error");
      }
    },
  });
}

// ---------------------------------------------------------------- watch areas

async function areas(el) {
  const { items } = await get("/areas");
  mount(
    el,
    html`<div class="row between" style="margin-bottom:.75rem"><p class="muted" style="margin:0">Postcodes the charity monitors. New properties are filed under the most specific matching area.</p><button class="primary" data-action="add">Add area</button></div>
    ${
      items.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Postcode prefix</th><th>Local authority</th><th class="num">Properties</th><th class="num">Open</th><th class="num">Urgent</th><th>Services directory</th><th>Status</th><th></th></tr></thead><tbody>${items.map(
            (a) => html`<tr><td><a href="#/properties?area=${a.id}&open=1">${a.name}</a>${a.notes ? html`<br><small class="muted">${a.notes}</small>` : ""}</td><td><code>${a.postcode_prefix}</code></td><td>${a.local_authority ?? "—"}</td>
              <td class="num">${num(a.property_count)}</td><td class="num">${num(a.open_count ?? 0)}</td><td class="num">${num(a.urgent_count ?? 0)}</td>
              <td>${num(a.service_count)} · ${a.services_synced_at ? html`synced ${ago(a.services_synced_at)}` : html`<span class="muted">not synced</span>`}${a.services_sync_error ? html`<br><small class="muted" title="${a.services_sync_error}">last attempt failed; the daily sync retries</small>` : ""}
                <br><button class="link-btn" data-action="sync" data-id="${a.id}">Sync from OpenStreetMap now</button></td>
              <td>${a.active ? html`<span class="badge ok">Watching</span>` : html`<span class="badge">Paused</span>`}</td>
              <td class="row"><button class="small" data-action="toggle" data-id="${a.id}" data-active="${a.active}">${a.active ? "Pause" : "Resume"}</button>${can("admin") ? html`<button class="small danger" data-action="delete" data-id="${a.id}">Delete</button>` : ""}</td></tr>`,
          )}</tbody></table></div>`
        : html`<div class="empty">No watch areas yet. Add the outcodes (e.g. M14) or sectors (e.g. M14 5) your teams cover.</div>`
    }`,
  );
  onAction(el, {
    add: () =>
      modal(
        html`<h2>Add a watch area</h2>
        <div class="field"><label>Name</label><input name="name" required placeholder="e.g. Moss Side"></div>
        <div class="field"><label>Postcode prefix <span class="hint">outcode (M14), sector (M14 5, with the space) or a full postcode</span></label><input name="postcode_prefix" required style="text-transform:uppercase"></div>
        <div class="field"><label>Notes</label><textarea name="notes"></textarea></div>`,
        {
          submitLabel: "Add",
          onSubmit: async (form) => {
            const r = await post("/areas", formData(form));
            toast(`Watching ${r.prefix}${r.adopted ? `; ${r.adopted} existing properties filed under it` : ""}.`);
            refresh();
          },
        },
      ),
    toggle: async (btn) => {
      await patch(`/areas/${btn.dataset.id}`, { active: btn.dataset.active !== "1" });
      refresh();
    },
    sync: async (btn) => {
      btn.disabled = true;
      btn.textContent = "Syncing (can take a minute)…";
      try {
        const r = await post(`/areas/${btn.dataset.id}/sync-services`);
        toast(r.ok ? `${r.count} services synced.` : `OpenStreetMap did not answer: ${r.error}`, r.ok ? "info" : "error");
        refresh();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
      }
    },
    delete: async (btn) => {
      if (!confirm("Delete this area? Properties in it are kept but no longer filed under it.")) return;
      await del(`/areas/${btn.dataset.id}`);
      refresh();
    },
  });
}

// ---------------------------------------------------------------- services directory

async function services(el) {
  const p = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const group = p.get("group") ?? "";
  const source = p.get("source") ?? "";
  const r = await get(`/services${qs({ group, source })}`);
  const groups = Object.keys(r.labels);
  mount(
    el,
    html`<div class="row between" style="margin-bottom:.75rem"><p class="muted" style="margin:0">Where people can get help. Filled daily from OpenStreetMap for each watch area; add the services your team knows that the map does not.</p><button class="primary" data-action="add">Add a service</button></div>
    <div class="filters">
      <div class="field"><label>Type</label><select id="sg"><option value="">All except transport</option>${groups.map((g) => html`<option value="${g}" ${g === group ? raw("selected") : ""}>${r.labels[g]}</option>`)}</select></div>
      <div class="field"><label>Source</label><select id="ss"><option value="">Any</option><option value="manual" ${source === "manual" ? raw("selected") : ""}>Added by hand</option><option value="osm" ${source === "osm" ? raw("selected") : ""}>OpenStreetMap</option></select></div>
    </div>
    ${
      r.items.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Contact</th><th>Area</th><th>Source</th><th></th></tr></thead><tbody>${r.items.map(
            (s) => html`<tr style="${s.active ? "" : "opacity:.5"}"><td><strong>${s.name ?? label(s.kind)}</strong>${s.address ? html`<br><small>${s.address}</small>` : ""}${s.notes ? html`<br><small class="muted">${s.notes}</small>` : ""}</td>
              <td>${r.labels[s.group_key]}${s.kind ? html`<br><small class="muted">${label(s.kind)}</small>` : ""}</td>
              <td>${s.phone ?? ""}${s.website ? html`<br><a href="${s.website}" target="_blank" rel="noopener">website</a>` : ""}${s.opening_hours ? html`<br><small>${s.opening_hours}</small>` : ""}</td>
              <td>${s.area_name ?? "—"}</td>
              <td>${s.source === "manual" ? html`<span class="badge ok">Local</span>` : html`<a href="https://www.openstreetmap.org/${s.osm_ref}" target="_blank" rel="noopener">OSM</a>`}</td>
              <td class="row"><button class="small" data-action="toggle" data-id="${s.id}" data-active="${s.active}">${s.active ? "Hide" : "Show"}</button>${s.source === "manual" ? html`<button class="small danger" data-action="delete" data-id="${s.id}">Delete</button>` : ""}</td></tr>`,
          )}</tbody></table></div>`
        : html`<div class="empty">No services yet. Add a watch area (they sync from OpenStreetMap) or add one by hand.</div>`
    }`,
  );
  const nav = () => go(`#/admin/services?${new URLSearchParams({ group: $("#sg", el).value, source: $("#ss", el).value })}`);
  $("#sg", el).addEventListener("change", nav);
  $("#ss", el).addEventListener("change", nav);
  onAction(el, {
    add: () =>
      modal(
        html`<h2>Add a support service</h2>
        <div class="field"><label>Name</label><input name="name" required maxlength="200"></div>
        <div class="form-grid">
          <div class="field"><label>Type</label><select name="group_key">${groups.map((g) => html`<option value="${g}">${r.labels[g]}</option>`)}</select></div>
          <div class="field"><label>Postcode</label><input name="postcode" required maxlength="10" style="text-transform:uppercase"></div>
        </div>
        <div class="field"><label>Address</label><input name="address" maxlength="300"></div>
        <div class="form-grid">
          <div class="field"><label>Phone</label><input name="phone" maxlength="40"></div>
          <div class="field"><label>Website</label><input name="website" type="url" maxlength="300" placeholder="https://"></div>
        </div>
        <div class="field"><label>Opening hours</label><input name="opening_hours" maxlength="300" placeholder="e.g. Mon–Fri 9–5, drop-in Tue 10–12"></div>
        <div class="field"><label>Notes for workers</label><textarea name="notes" placeholder="Referral route, who to ask for, eligibility"></textarea></div>`,
        {
          submitLabel: "Add",
          onSubmit: async (form) => {
            await post("/services", formData(form));
            toast("Service added.");
            refresh();
          },
        },
      ),
    toggle: async (b) => {
      await patch(`/services/${b.dataset.id}`, { active: b.dataset.active !== "1" });
      refresh();
    },
    delete: async (b) => {
      if (!confirm("Delete this service?")) return;
      await del(`/services/${b.dataset.id}`);
      refresh();
    },
  });
}

// ---------------------------------------------------------------- import

async function importView(el) {
  mount(
    el,
    html`<div class="split"><div class="card">
      <h3>Import properties from CSV</h3>
      <p>Use this for council empty-property lists, business-rates empty lists published as open data, or a partner's spreadsheet. Up to 2,000 rows at a time.</p>
      <form id="imp">
        <div class="field"><label>CSV file</label><input type="file" name="file" accept=".csv,text/csv" required></div>
        <div class="form-grid">
          <div class="field"><label>Source</label><select name="source"><option value="import">General import</option><option value="council_list">Council list</option></select></div>
          <div class="field"><label>Ownership when not in the file</label><select name="default_category">${options(state.meta.enums.categories, "unknown")}</select></div>
        </div>
        <div class="row"><button type="button" data-action="preview">Check file</button><button class="primary" type="submit">Import</button></div>
      </form>
      <div id="imp-result" style="margin-top:1rem"></div>
    </div>
    <div class="card"><h3>Columns</h3>
      <p class="muted">Headers are matched loosely. Only <strong>address</strong> and <strong>postcode</strong> are required.</p>
      <dl class="kv">
        <dt>address</dt><dd>address, address_line1, property_address, first_line</dd>
        <dt>postcode</dt><dd>postcode, post_code</dd>
        <dt>address_line2</dt><dd>address_line2, locality</dd>
        <dt>town</dt><dd>town, city</dd>
        <dt>category</dt><dd>council, housing association, private, commercial</dd>
        <dt>property_type</dt><dd>house, flat, bungalow, maisonette, hmo…</dd>
        <dt>status</dt><dd>${state.meta.enums.statuses.join(", ")}</dd>
        <dt>vacant_since</dt><dd>empty_since, void_date (YYYY-MM-DD or DD/MM/YYYY)</dd>
        <dt>reference</dt><dd>source_ref, ref, property_reference</dd>
        <dt>uprn, bedrooms, notes</dt><dd></dd>
      </dl>
      <p class="muted"><small>Rows already on the register (same address and postcode) are skipped. Imported rows are enriched with public data by the hourly sweep, ten at a time.</small></p>
    </div></div>`,
  );
  const form = $("#imp", el);
  const run = async (dry) => {
    const file = form.file.files[0];
    if (!file) return toast("Choose a CSV file.", "error");
    const csv = await file.text();
    const r = await post("/admin/import", { csv, source: form.source.value, default_category: form.default_category.value, dry_run: dry });
    mount(
      $("#imp-result", el),
      html`<div class="alert ${r.errors.length ? "warn" : "success"}">${r.rows} rows · ${dry ? html`<strong>${r.would_import}</strong> would be imported` : html`<strong>${r.imported}</strong> imported`} · ${r.duplicates} already recorded · ${r.errors.length} with errors</div>
      ${r.errors.length ? html`<ul>${r.errors.map((e) => html`<li>Line ${e.row}: ${e.message}</li>`)}</ul>` : ""}`,
    );
  };
  onAction(el, { preview: () => run(true).catch((e) => toast(e.message, "error")) });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(false).catch((err) => toast(err.message, "error"));
  });
}

// ---------------------------------------------------------------- data sources

async function sources(el) {
  const r = await get("/admin/sources");
  mount(
    el,
    html`<div class="row between" style="margin-bottom:.75rem"><p class="muted" style="margin:0">Each property is enriched from these open datasets. Results are cached so neighbouring properties share calls.</p>${can("admin") ? html`<button data-action="sweep">Run enrichment sweep now</button>` : ""}</div>
    <div class="alert ${r.insights?.ok ? "success" : "error"}">Python insights service: ${r.insights?.ok ? html`online (model ${r.insights.model_version})` : html`unreachable — properties will not be scored. ${r.insights?.error ?? ""}`}</div>
    <div class="table-wrap"><table><thead><tr><th>Source</th><th class="num">OK</th><th class="num">Empty</th><th class="num">Errors</th><th class="num">Skipped</th><th class="num">Avg time</th><th>Last fetch</th></tr></thead><tbody>${r.sources.map(
      (s) => html`<tr><td><strong>${s.label}</strong>${s.configured ? "" : html` <span class="badge warn">Not configured</span>`}<br><small class="muted">${s.attribution}</small></td>
        <td class="num">${num(s.counts.ok ?? 0)}</td><td class="num">${num(s.counts.empty ?? 0)}</td><td class="num">${s.counts.error ? html`<span class="badge danger">${s.counts.error}</span>` : "0"}</td><td class="num">${num(s.counts.skipped ?? 0)}</td>
        <td class="num">${s.avg_ms ? `${(s.avg_ms / 1000).toFixed(1)} s` : "—"}</td><td>${s.last_fetched ? ago(s.last_fetched) : "—"}</td></tr>`,
    )}</tbody></table></div>
    ${
      r.sources.find((s) => s.id === "epc" && !s.configured)
        ? html`<div class="alert warn" style="margin-top:1rem">EPC data is off. Register free at <a href="https://get-energy-performance-data.communities.gov.uk/" target="_blank" rel="noopener">get-energy-performance-data.communities.gov.uk</a>, then set the token with <code>wrangler secret put EPC_API_TOKEN</code>.</div>`
        : ""
    }
    ${r.recent_errors.length ? html`<h3 style="margin-top:1rem">Recent errors</h3><div class="table-wrap"><table><thead><tr><th>Source</th><th>Error</th><th class="num">Count</th><th>Last</th></tr></thead><tbody>${r.recent_errors.map((e) => html`<tr><td>${e.source}</td><td><code>${e.error}</code></td><td class="num">${e.n}</td><td>${ago(e.at)}</td></tr>`)}</tbody></table></div>` : ""}`,
  );
  onAction(el, {
    sweep: async (btn) => {
      btn.disabled = true;
      btn.textContent = "Running…";
      try {
        const s = await post("/admin/sources/sweep");
        toast(`Processed ${s.processed}.`);
        refresh();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
      }
    },
  });
}

// ---------------------------------------------------------------- settings

async function settings(el) {
  const r = await get("/admin/settings");
  const s = r.settings;
  const ro = can("admin") ? "" : raw("disabled");
  mount(
    el,
    html`<form id="sform" class="card" style="max-width:760px">
      <div class="field"><label>Organisation name</label><input name="org_name" value="${s.org_name}" ${ro}></div>
      <div class="form-grid">
        <div class="field"><label>Area radius (m) <span class="hint">crime and services</span></label><input name="area_radius_m" type="number" min="100" max="2000" data-type="number" value="${s.area_radius_m}" ${ro}></div>
        <div class="field"><label>Refresh public data after (days)</label><input name="enrichment_stale_days" type="number" min="1" max="365" data-type="number" value="${s.enrichment_stale_days}" ${ro}></div>
        <div class="field"><label>Revisit live cases after (days)</label><input name="revisit_after_days" type="number" min="1" max="365" data-type="number" value="${s.revisit_after_days}" ${ro}></div>
      </div>
      <div class="field"><label>Outreach contact <span class="hint">shown to field workers when they record signs of rough sleeping</span></label><textarea name="outreach_contact" ${ro}>${s.outreach_contact}</textarea></div>
      <div class="field"><label>Council empty homes contact</label><textarea name="council_empty_homes_contact" ${ro}>${s.council_empty_homes_contact}</textarea></div>
      <dl class="kv" style="margin-bottom:1rem"><dt>EPC token</dt><dd>${r.epc_configured ? html`<span class="badge ok">Configured</span>` : html`<span class="badge warn">Not set</span>`}</dd><dt>Insights binding</dt><dd>${r.insights_bound ? html`<span class="badge ok">Bound</span>` : html`<span class="badge danger">Missing</span>`}</dd></dl>
      ${can("admin") ? html`<button class="primary">Save settings</button>` : html`<p class="muted">Only administrators can change settings.</p>`}
    </form>`,
  );
  $("#sform", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await put("/admin/settings", formData(e.target));
      toast("Settings saved.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------------------------------------------------------------- audit

async function audit(el) {
  const entity = new URLSearchParams(location.hash.split("?")[1] ?? "").get("entity") ?? "";
  let before = Date.now() + 1;
  mount(
    el,
    html`<div class="row" style="margin-bottom:.75rem"><label class="row" style="font-weight:500">Show <select id="ent">${options(["property", "user", "task", "watch_area", "settings"], entity, { blank: "Everything" })}</select></label></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead><tbody id="rows"></tbody></table></div>
    <div class="pager"><button data-action="more">Load more</button></div>`,
  );
  const load = async () => {
    const r = await get(`/admin/audit${qs({ entity, before, limit: 100 })}`);
    if (r.items.length) before = r.items[r.items.length - 1].created_at;
    $("#rows", el).insertAdjacentHTML(
      "beforeend",
      r.items
        .map((a) =>
          String(
            html`<tr><td>${date(a.created_at, true)}</td><td>${a.user_name ?? "system"}</td><td>${label(a.action)}</td><td>${label(a.entity)}${
              a.entity === "property" && a.entity_id ? html` <a href="#/property/${a.entity_id}">open</a>` : ""
            }</td><td><small><code>${a.detail ? JSON.stringify(a.detail).slice(0, 220) : ""}</code></small></td></tr>`,
          ),
        )
        .join(""),
    );
    if (r.items.length < 100) $("[data-action=more]", el).hidden = true;
  };
  await load();
  $("#ent", el).addEventListener("change", (e) => go(`#/admin/audit${e.target.value ? `?entity=${e.target.value}` : ""}`));
  onAction(el, { more: load });
}
