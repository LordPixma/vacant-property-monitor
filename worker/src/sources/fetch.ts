import type { Env } from "../env";
import type { SourceContext } from "./types";
import { UpstreamError } from "./types";

const DEFAULT_TIMEOUT = 12_000;

export function makeSourceContext(env: Env, fetchImpl: typeof fetch = fetch): SourceContext {
  const ua = `VacantWatch/1.0 (homelessness charity empty-homes monitor${env.CONTACT_EMAIL ? `; ${env.CONTACT_EMAIL}` : ""})`;

  async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const { timeoutMs = DEFAULT_TIMEOUT, ...rest } = init;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          ...rest,
          signal: ctrl.signal,
          headers: { "user-agent": ua, accept: "application/json", ...(rest.headers as Record<string, string>) },
        });
        if (res.status === 404) throw new UpstreamError(404, "not found");
        if (res.status === 429 || res.status >= 500) throw new UpstreamError(res.status, `upstream ${res.status}`);
        if (!res.ok) throw new UpstreamError(res.status, `upstream ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        // A timeout is not retried: the caller works to a time budget and a second wait would blow it.
        if (err instanceof Error && err.name === "AbortError") break;
        const retryable = !(err instanceof UpstreamError) || err.status === 429 || err.status >= 500;
        if (!retryable || attempt === 1) break;
        await new Promise((r) => setTimeout(r, 600));
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastErr instanceof Error && lastErr.name === "AbortError") throw new UpstreamError(504, "timed out");
    throw lastErr;
  }

  async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const k = `src:${key}`;
    try {
      const hit = await env.CACHE.get(k, "json");
      if (hit !== null) return hit as T;
    } catch (err) {
      console.warn("cache read failed", k, err);
    }
    const value = await load();
    try {
      await env.CACHE.put(k, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
    } catch (err) {
      console.warn("cache write failed", k, err);
    }
    return value;
  }

  return { env, fetchJson, cached };
}
