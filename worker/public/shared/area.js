// Renders the public-data panels for a property or a postcode area report.
// `sources` is a map of source id -> { status, data, error, label, attribution, fetched_at }.
import { ago, bars, date, dist, esc, html, label, money, num, pct, raw } from "./ui.js";

const EPC_COLOURS = { A: "#008054", B: "#19b459", C: "#8dce46", D: "#ffd500", E: "#fcaa65", F: "#ef8023", G: "#e9153b" };

function panel(src, title, body, { open = true } = {}) {
  if (!src) return "";
  const status =
    src.status === "error"
      ? html`<span class="badge danger" title="${src.error ?? ""}">Unavailable</span>`
      : src.status === "skipped"
        ? html`<span class="badge" title="${src.error ?? ""}">Not configured</span>`
        : src.status === "empty"
          ? html`<span class="badge">No records</span>`
          : "";
  return html`<details class="card" ${open ? raw("open") : ""}>
    <summary class="card-head" style="cursor:pointer;list-style:none"><h3>${title}</h3><span class="row">${status}${src.fetched_at ? html`<small>${ago(src.fetched_at)}</small>` : ""}</span></summary>
    ${src.status === "error" || src.status === "skipped" ? html`<p class="muted">${src.error}</p>` : body}
    ${src.attribution ? html`<div class="attribution">${src.attribution}</div>` : ""}
  </details>`;
}

export function profileSummary(profile) {
  if (!profile?.headline?.length) return "";
  return html`<div class="card"><h3>Area at a glance</h3><ul>${profile.headline.map((l) => html`<li>${l}</li>`)}</ul></div>`;
}

function location(src, profile) {
  const d = src?.data;
  if (!d) return "";
  const dep = profile?.deprivation;
  return panel(
    src,
    "Location & administrative areas",
    html`<dl class="kv">
      <dt>Postcode</dt><dd>${d.postcode}${d.terminated ? html` <span class="badge warn">Terminated</span>` : ""}</dd>
      <dt>Local authority</dt><dd>${d.local_authority ?? "—"}</dd>
      <dt>Ward</dt><dd>${d.ward ?? "—"}</dd>
      <dt>Parish</dt><dd>${d.parish ?? "—"}</dd>
      <dt>Constituency</dt><dd>${d.constituency ?? "—"}</dd>
      <dt>Region</dt><dd>${d.region ?? "—"}, ${d.country ?? ""}</dd>
      <dt>Police force area</dt><dd>${d.police_force_area ?? "—"}</dd>
      <dt>Neighbourhood (LSOA)</dt><dd>${d.lsoa ?? "—"} <small>${d.lsoa_code ?? ""}</small></dd>
      <dt>Rural / urban</dt><dd>${d.rural_urban ?? "—"}</dd>
      <dt>Coordinates</dt><dd>${d.latitude?.toFixed(5)}, ${d.longitude?.toFixed(5)}</dd>
      <dt>Deprivation</dt><dd>${
        d.imd_decile
          ? html`<strong>Decile ${d.imd_decile}</strong> of 10 (1 = most deprived) · rank ${num(d.imd_rank)} of ${num(d.imd_of)}${dep ? html`<br><small>${dep.label}. ${dep.measure}.</small>` : ""}`
          : html`<span class="muted">Not available (England only)</span>`
      }</dd>
    </dl>`,
  );
}

function crime(src, profile) {
  const d = src?.data;
  const lvl = profile?.crime;
  const body = d
    ? html`${d.coverage_warning ? html`<div class="alert warn">${d.coverage_warning}</div>` : ""}
      <div class="tiles" style="margin-bottom:.75rem">
        <div class="tile"><div class="label">${d.latest_month}</div><div class="value">${num(d.latest_total)}</div><small>crimes within ${dist(d.radius_m)}</small></div>
        <div class="tile"><div class="label">3-month average</div><div class="value">${num(d.monthly_average)}</div>${lvl && lvl.level !== "unknown" ? html`<small>${label(lvl.level)}${lvl.trend ? `, ${lvl.trend}` : ""}</small>` : ""}</div>
        <div class="tile"><div class="label">Anti-social behaviour</div><div class="value">${num(d.anti_social_behaviour)}</div></div>
        <div class="tile"><div class="label">Damage & arson</div><div class="value">${num(d.criminal_damage_arson)}</div></div>
      </div>
      ${bars((d.categories ?? []).map((c) => ({ label: c.label, value: c.count })))}
      ${d.top_streets?.length ? html`<h4 style="margin-top:1rem">Most reports</h4><ul>${d.top_streets.map((s) => html`<li>${s.street} — ${s.count}</li>`)}</ul>` : ""}
      ${
        d.neighbourhood
          ? html`<h4>Neighbourhood policing team</h4><p>${d.neighbourhood.name ?? d.neighbourhood.id}${d.neighbourhood.telephone ? html` · ${d.neighbourhood.telephone}` : ""}${
              d.neighbourhood.email ? html` · <a href="mailto:${d.neighbourhood.email}">${d.neighbourhood.email}</a>` : ""
            }</p>`
          : ""
      }
      ${lvl && lvl.per_km2_per_month !== null ? html`<p class="muted"><small>${lvl.per_km2_per_month} recorded crimes per km² per month. ${lvl.note}</small></p>` : ""}`
    : "";
  return panel(src, "Crime & anti-social behaviour", body);
}

function market(src, profile) {
  const d = src?.data;
  if (!d) return panel(src, "Sales history", "");
  const me = d.this_property ?? {};
  const m = profile?.market;
  return panel(
    src,
    "Sales history (Land Registry)",
    html`
      ${
        me.matched
          ? html`<div class="alert"><strong>This property:</strong> last sold ${date(me.last_sale_date)} for ${money(me.last_sale_price)} (${me.years_since_last_sale} years ago).
            ${me.sales.length > 1 ? html`<br><small>Earlier: ${me.sales.slice(1).map((s) => `${date(s.date)} ${money(s.price)}`).join(" · ")}</small>` : ""}</div>`
          : html`<p class="muted">No sale since 1995 matched this exact address (properties not sold since then, or right-to-buy and non-market transfers, will not appear).</p>`
      }
      <dl class="kv">
        <dt>Sales in postcode</dt><dd>${num(d.transactions_in_postcode)} on record · ${num(d.sales_last_5y)} in five years</dd>
        <dt>Median (5 years)</dt><dd>${money(d.median_price_5y)}${d.excluded_from_median ? html` <small class="muted">(excludes ${d.excluded_from_median} portfolio or non-residential sale${d.excluded_from_median > 1 ? "s" : ""})</small>` : ""}${m?.price_change_pct !== null && m?.price_change_pct !== undefined ? html` <small>(${m.price_change_pct > 0 ? "+" : ""}${m.price_change_pct}% recent vs earlier)</small>` : ""}</dd>
      </dl>
      ${d.yearly_median?.length ? html`<h4 style="margin-top:1rem">Median by year</h4>${bars(d.yearly_median.map((y) => ({ label: `${y.year} (${y.count})`, value: y.median })), { format: money })}` : ""}
      ${
        d.recent_sales?.length
          ? html`<h4 style="margin-top:1rem">Recent sales in the postcode</h4><div class="table-wrap"><table><thead><tr><th>Date</th><th>Address</th><th>Type</th><th class="num">Price</th></tr></thead><tbody>${d.recent_sales.map(
              (s) => html`<tr><td>${date(s.date)}</td><td>${[s.saon, s.paon, s.street].filter(Boolean).join(" ")}</td><td>${s.property_type ?? "—"}${s.new_build ? " · new" : ""}${s.estate_type ? html` <small>${s.estate_type}</small>` : ""}${s.standard === false ? html` <span class="badge" title="Category B: repossession, portfolio or company sale">non-standard</span>` : ""}</td><td class="num">${money(s.price)}</td></tr>`,
            )}</tbody></table></div>`
          : ""
      }`,
  );
}

function epc(src) {
  const d = src?.data;
  if (!d) return panel(src, "Energy Performance Certificate", "");
  const me = d.this_property ?? {};
  const bandRows = Object.entries(d.bands_in_postcode ?? {})
    .sort()
    .map(([b, n]) => ({ label: `Band ${b}`, value: n, colour: EPC_COLOURS[b] }));
  return panel(
    src,
    "Energy Performance Certificate",
    html`${
      me.matched
        ? html`<div class="row" style="margin-bottom:.75rem"><span class="badge" style="background:${EPC_COLOURS[me.band] ?? "#888"};color:#111;font-size:1rem">EPC ${me.band ?? "?"}</span><small>Registered ${date(me.registration_date)}</small></div>
          <dl class="kv">
            <dt>Property type</dt><dd>${me.property_type ?? "—"} ${me.built_form ? `(${me.built_form})` : ""}</dd>
            <dt>Floor area</dt><dd>${me.floor_area_m2 ? `${me.floor_area_m2} m²` : "—"}</dd>
            <dt>Built</dt><dd>${me.construction_age ?? "—"}</dd>
            <dt>Tenure at assessment</dt><dd>${me.tenure ?? "—"}</dd>
            <dt>Why assessed</dt><dd>${me.transaction_type ?? "—"}</dd>
            <dt>Habitable rooms</dt><dd>${me.habitable_rooms ?? "—"}</dd>
            <dt>Heating</dt><dd>${me.heating ?? me.main_fuel ?? "—"}</dd>
            <dt>Potential</dt><dd>${me.potential_band ?? "—"}</dd>
            <dt>UPRN</dt><dd>${me.uprn ?? "—"}</dd>
          </dl>`
        : html`<p class="muted">No certificate matched this address. An old or missing EPC can be a sign the home has not been let or sold recently.</p>`
    }
    ${bandRows.length ? html`<h4 style="margin-top:1rem">Ratings in the postcode (${d.certificates_in_postcode})</h4>${bars(bandRows)}` : ""}`,
  );
}

function census(src, profile) {
  const d = src?.data;
  if (!d) return panel(src, "Census 2021", "");
  const t = profile?.tenure;
  const section = (block) =>
    block?.rows?.length
      ? html`<h4 style="margin-top:1rem">${block.title}</h4>${bars(
          // Tenure has sub-rows ("Social rented: Rents from council"); indent them under their parent.
          block.rows.map((r) => ({ label: r.label.includes(": ") ? `↳ ${r.label.split(": ").slice(1).join(": ")}` : r.label, value: r.percent })),
          { max: 100, format: pct },
        )}`
      : "";
  return panel(
    src,
    "Census 2021 neighbourhood profile",
    html`${t?.notes?.length ? html`<div class="alert">${t.notes.map((n) => html`<div>${n}</div>`)}</div>` : ""}
    ${
      t
        ? html`<p class="muted"><small>England: owned ${t.england.owned}%, social rented ${t.england.social_rented}%, private rented ${t.england.private_rented}%.</small></p>`
        : ""
    }
    ${section(d.tenure)}${section(d.accommodation_type)}${section(d.household_deprivation)}
    <p class="muted"><small>Neighbourhood ${d.lsoa_code} (about 1,500 residents).</small></p>`,
    { open: false },
  );
}

function planning(src) {
  const d = src?.data;
  if (!d) return panel(src, "Planning designations", "");
  const link = (e) => (e.entity ? html`<a href="${d.entity_link_base}${e.entity}" target="_blank" rel="noopener">${e.name || e.reference || "view"}</a>` : e.name);
  const yesno = (arr) => (arr?.length ? html`<span class="badge warn">Yes</span> ${arr.map((e) => html`${link(e)} `)}` : html`<span class="muted">No</span>`);
  return panel(
    src,
    "Planning designations",
    html`<dl class="kv">
      <dt>Planning authority</dt><dd>${d.local_planning_authority ?? "—"}</dd>
      <dt>Conservation area</dt><dd>${yesno(d.conservation_area)}</dd>
      <dt>Article 4 direction</dt><dd>${yesno(d.article_4)}</dd>
      <dt>Listed building</dt><dd>${d.listed_building_on_site?.length ? yesno(d.listed_building_on_site) : d.possibly_listed ? html`<span class="badge warn">Possibly</span> a listed building within 15 m` : html`<span class="muted">No</span>`}</dd>
      <dt>Brownfield register</dt><dd>${yesno(d.on_brownfield_register)}</dd>
      <dt>Tree preservation</dt><dd>${yesno(d.tree_preservation_zone)}</dd>
      <dt>Green belt</dt><dd>${d.green_belt ? html`<span class="badge warn">Yes</span>` : html`<span class="muted">No</span>`}</dd>
      <dt>Flood risk zone</dt><dd>${d.flood_risk_zone?.length ? d.flood_risk_zone.map((z) => html`<span class="badge warn">Zone ${z.level ?? "?"}</span> `) : html`<span class="muted">None recorded</span>`}</dd>
      <dt>Listed within 250 m</dt><dd>${num(d.listed_buildings_within_250m)}</dd>
    </dl>
    ${d.brownfield_sites_within_250m?.length ? html`<h4 style="margin-top:1rem">Brownfield sites within 250 m</h4><ul>${d.brownfield_sites_within_250m.map((b) => html`<li>${link(b)} — ${dist(b.distance_m)}${b.hectares ? ` · ${b.hectares} ha` : ""}${b.planning_permission_status ? html` <small>${label(b.planning_permission_status)}</small>` : ""}</li>`)}</ul>` : ""}`,
    { open: false },
  );
}

function flood(src) {
  const d = src?.data;
  if (!d) return panel(src, "Flood", "");
  return panel(
    src,
    "Flood warnings",
    html`${
      d.live_warnings?.length
        ? html`<div class="alert error"><strong>${d.live_warnings.length} live warning(s)</strong>${d.live_warnings.map((w) => html`<div>${w.severity}: ${w.area}</div>`)}</div>`
        : html`<p><span class="badge ok">No live warnings</span></p>`
    }
    ${
      d.areas?.length
        ? html`<p>Within ${d.areas.length} Environment Agency flood alert/warning area(s):</p><ul>${d.areas.map((a) => html`<li>${a.label} <small>(${a.kind}${a.water_body ? `, ${a.water_body}` : ""})</small></li>`)}</ul>`
        : html`<p class="muted">Not within an Environment Agency flood alert or warning area.</p>`
    }`,
    { open: false },
  );
}

function services(src, profile) {
  const d = src?.data;
  if (!d) return panel(src, "Nearby support services", "");
  const groups = Object.entries(d.groups ?? {});
  return panel(
    src,
    `Support services within ${dist(d.radius_m)}`,
    html`${d.note ? html`<div class="alert">${d.note}</div>` : profile?.support?.gap ? html`<div class="alert warn">No shelter, food bank or outreach service in the directory nearby. OpenStreetMap coverage may be incomplete: add local services under Admin, Services.</div>` : ""}
    <div class="grid cols-2">${groups.map(
      ([, g]) => html`<div><h4>${g.label} <span class="badge">${g.count}</span></h4>${
        g.nearest.length
          ? html`<ul>${g.nearest.map(
              (n) =>
                html`<li>${n.osm ? html`<a href="${n.osm}" target="_blank" rel="noopener">${n.name || label(n.kind)}</a>` : html`<strong>${n.name}</strong> <span class="badge">local</span>`} — ${dist(n.distance_m)}${n.phone ? html` · <a href="tel:${n.phone}">${n.phone}</a>` : ""}${n.opening_hours ? html`<br><small>${n.opening_hours}</small>` : ""}${n.notes ? html`<br><small class="muted">${n.notes}</small>` : ""}</li>`,
            )}</ul>`
          : html`<p class="muted"><small>None mapped.</small></p>`
      }</div>`,
    )}</div>`,
    { open: false },
  );
}

/** All panels, in reading order. */
export function areaPanels(sources, profile) {
  return html`<div class="stack">
    ${profileSummary(profile)}
    ${location(sources.postcode, profile)}
    ${crime(sources.crime, profile)}
    ${market(sources.price_paid, profile)}
    ${epc(sources.epc)}
    ${census(sources.census, profile)}
    ${services(sources.services, profile)}
    ${planning(sources.planning)}
    ${flood(sources.flood)}
  </div>`;
}

export function sourceStatusList(list) {
  return html`<ul class="chips">${list.map(
    (s) => html`<li class="chip" title="${s.error ?? ""}" style="${s.status === "error" ? "background:var(--danger-soft);color:var(--danger)" : ""}">${s.label ?? s.source}: ${s.status}</li>`,
  )}</ul>`;
}

export { esc };
