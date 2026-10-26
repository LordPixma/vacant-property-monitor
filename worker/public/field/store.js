// IndexedDB: the offline outbox and a small key-value cache. No library; ~60 lines.
const DB_NAME = "vacantwatch-field";
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export const kvGet = (key) => tx("kv", "readonly", (s) => req(s.get(key)));
export const kvSet = (key, value) => tx("kv", "readwrite", (s) => req(s.put(value, key)));
export const kvDel = (key) => tx("kv", "readwrite", (s) => req(s.delete(key)));

export const outboxAll = () => tx("outbox", "readonly", (s) => req(s.getAll()));
export const outboxAdd = (item) => tx("outbox", "readwrite", (s) => req(s.add({ status: "pending", attempts: 0, created_at: Date.now(), ...item })));
export const outboxPut = (item) => tx("outbox", "readwrite", (s) => req(s.put(item)));
export const outboxDelete = (seq) => tx("outbox", "readwrite", (s) => req(s.delete(seq)));

/** Map from an offline client_id to the server id, once the server has it. */
export async function idFor(clientId) {
  const map = (await kvGet("idmap")) ?? {};
  return map[clientId] ?? null;
}
export async function rememberId(clientId, id) {
  const map = (await kvGet("idmap")) ?? {};
  map[clientId] = id;
  await kvSet("idmap", map);
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
