// Tiny rendering kit. Every interpolated value in html`` is escaped unless wrapped in raw().

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(s);

function render(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

export function html(strings, ...values) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return raw(out);
}

export function mount(el, tpl) {
  el.innerHTML = render(tpl);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated click handling: <button data-action="name" data-id="..."> */
export function onAction(root, handlers) {
  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.action];
    if (fn) {
      e.preventDefault();
      fn(el, e);
    }
  });
}

// ---------- formatting ----------
export const label = (s) => (s ? String(s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");
export const num = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-GB"));
export const money = (n) => (n === null || n === undefined ? "—" : `£${Number(n).toLocaleString("en-GB")}`);
export const pct = (n) => (n === null || n === undefined ? "—" : `${Number(n).toFixed(1).replace(/\.0$/, "")}%`);
export const dist = (m) => (m === null || m === undefined ? "—" : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

export function date(ms, withTime = false) {
  if (!ms) return "—";
  const d = typeof ms === "number" ? new Date(ms) : new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  return d.toLocaleString("en-GB", withTime ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" });
}

export function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const units = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, name] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${name}${n > 1 ? "s" : ""} ago`;
    }
  }
  return "just now";
}

export function bandBadge(band, score) {
  if (!band) return html`<span class="badge" title="Not scored yet">Unscored</span>`;
  return html`<span class="badge band-${band}" title="Priority score ${score ?? ""}">${label(band)}${score !== null && score !== undefined ? html` · ${score}` : ""}</span>`;
}

const STATUS_TONE = {
  reported: "",
  suspected_vacant: "warn",
  confirmed_vacant: "warn",
  derelict: "danger",
  abandoned: "danger",
  referred: "",
  brought_back_into_use: "ok",
  occupied: "ok",
  demolished: "",
};
export const statusBadge = (s) => html`<span class="badge ${STATUS_TONE[s] ?? ""}">${label(s)}</span>`;

export const BAND_COLOURS = { critical: "#b42318", high: "#d4560b", medium: "#b88400", low: "#3d7c47" };
export const bandColour = (b) => BAND_COLOURS[b] ?? "#8a94a3";

export function bars(rows, { max, format = num } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value || 0));
  if (!rows.length) return html`<p class="muted">No data.</p>`;
  return html`<div class="bars">${rows.map(
    (r) => html`<div class="bar-row"><span>${r.label}</span><span class="track"><span class="fill" style="width:${Math.max(0, Math.min(100, ((r.value || 0) / top) * 100)).toFixed(1)}%;${r.colour ? `background:${r.colour}` : ""}"></span></span><span class="val">${format(r.value)}</span></div>`,
  )}</div>`;
}

export function toast(message, kind = "info") {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "toast-host";
    host.setAttribute("role", "status");
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = message;
  host.appendChild(t);
  setTimeout(() => t.remove(), kind === "error" ? 6000 : 3500);
}

export const loading = (text = "Loading…") => html`<div class="loading"><span class="spinner"></span>${text}</div>`;

/** Read a <form> into an object; empty strings become null, numbers stay strings unless data-type="number". */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") {
      if (el.dataset.group) {
        (out[el.dataset.group] ??= []);
        if (el.checked) out[el.dataset.group].push(el.value);
      } else out[el.name] = el.checked;
      continue;
    }
    if (el.type === "radio") {
      if (el.checked) out[el.name] = el.value || null;
      else if (!(el.name in out)) out[el.name] = null;
      continue;
    }
    let v = el.value.trim();
    if (v === "") v = null;
    else if (el.dataset.type === "number") v = Number(v);
    out[el.name] = v;
  }
  return out;
}

export function options(values, selected, { blank } = {}) {
  return html`${blank !== undefined ? html`<option value="">${blank}</option>` : ""}${values.map(
    (v) => html`<option value="${v}" ${v === selected ? raw("selected") : ""}>${label(v)}</option>`,
  )}`;
}

export function modal(content, { onSubmit, submitLabel = "Save", danger = false } = {}) {
  const dlg = document.createElement("dialog");
  mount(
    dlg,
    html`<form method="dialog"><div class="modal-body">${content}</div><div class="modal-foot"><button type="button" data-close>Cancel</button>${
      onSubmit ? html`<button type="submit" class="${danger ? "danger" : "primary"}">${submitLabel}</button>` : ""
    }</div></form>`,
  );
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form");
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => dlg.remove());
  form.addEventListener("submit", async (e) => {
    if (!onSubmit) return;
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const keep = await onSubmit(form, dlg);
      if (keep !== true) dlg.close();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
  dlg.showModal();
  return dlg;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
