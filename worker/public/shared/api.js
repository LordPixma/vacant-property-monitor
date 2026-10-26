// Fetch wrapper for the VacantWatch API. Same-origin cookie session.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

const listeners = new Set();
/** Called with no arguments when any request comes back 401. */
export const onUnauthorized = (fn) => listeners.add(fn);

export async function api(path, { method = "GET", body, headers = {}, raw = false, signal } = {}) {
  const init = { method, headers: { ...headers }, credentials: "same-origin", signal };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(`/api${path}`, init);
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/login")) listeners.forEach((fn) => fn());
    throw new ApiError(res.status, json);
  }
  return json;
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { ...o, method: "POST", body });
export const patch = (p, body, o) => api(p, { ...o, method: "PATCH", body });
export const put = (p, body, o) => api(p, { ...o, method: "PUT", body });
export const del = (p, o) => api(p, { ...o, method: "DELETE" });

export function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : "";
}
