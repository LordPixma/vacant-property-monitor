// Replays the outbox against the API, oldest first. Every write carries a client_id, so a
// replay after a dropped response is harmless: the server returns the existing record.
import { api, ApiError } from "../shared/api.js";
import { idFor, outboxAll, outboxDelete, outboxPut, rememberId } from "./store.js";

let running = null;
const listeners = new Set();
export const onSyncChange = (fn) => listeners.add(fn);
const emit = (s) => listeners.forEach((fn) => fn(s));

async function resolveProperty(ref) {
  if (ref.id) return ref.id;
  return idFor(ref.client_id);
}

async function send(item) {
  const p = item.payload;
  switch (item.kind) {
    case "property": {
      try {
        const r = await api("/properties", { method: "POST", body: p.body });
        await rememberId(p.body.client_id, r.id);
      } catch (err) {
        // Someone already recorded it: attach this worker's visit and photos to that record.
        if (err instanceof ApiError && err.status === 409 && err.details?.id) await rememberId(p.body.client_id, err.details.id);
        else throw err;
      }
      return;
    }
    case "visit": {
      const id = await resolveProperty(p.property);
      if (!id) throw new Error("waiting-for-property");
      await api(`/properties/${id}/visits`, { method: "POST", body: p.body });
      return;
    }
    case "photo": {
      const id = await resolveProperty(p.property);
      if (!id) throw new Error("waiting-for-property");
      const fd = new FormData();
      fd.set("file", p.blob, p.name ?? "photo.jpg");
      fd.set("client_id", p.client_id);
      if (p.visit_client_id) fd.set("visit_client_id", p.visit_client_id);
      if (p.caption) fd.set("caption", p.caption);
      await api(`/properties/${id}/photos`, { method: "POST", body: fd });
      return;
    }
    case "task": {
      await api(`/tasks/${p.task_id}`, { method: "PATCH", body: p.body });
      return;
    }
    default:
      throw new Error(`Unknown outbox item ${item.kind}`);
  }
}

/** Returns { sent, pending, failed, stopped } where stopped is why the run ended early, if it did. */
export function syncNow() {
  if (running) return running;
  running = (async () => {
    let sent = 0;
    let stopped = null;
    if (!navigator.onLine) stopped = "offline";
    const items = (await outboxAll()).sort((a, b) => a.seq - b.seq);
    for (const item of items) {
      if (stopped) break;
      if (item.status === "failed") continue;
      try {
        await send(item);
        await outboxDelete(item.seq);
        sent++;
        emit({ running: true, sent });
      } catch (err) {
        if (err.message === "waiting-for-property") continue;
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 401) stopped = "signed-out";
        else if (!status || status >= 500 || status === 429) stopped = "network";
        else {
          // A 4xx the server will never accept: park it for the worker to review.
          await outboxPut({ ...item, status: "failed", error: err.message, attempts: item.attempts + 1 });
        }
      }
    }
    const left = await outboxAll();
    const result = { sent, pending: left.filter((i) => i.status === "pending").length, failed: left.filter((i) => i.status === "failed").length, stopped };
    emit({ running: false, ...result });
    return result;
  })().finally(() => (running = null));
  return running;
}
