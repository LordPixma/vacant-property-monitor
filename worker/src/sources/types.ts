import type { Env } from "../env";

export interface SourceInput {
  postcode: string;
  addressLine1: string | null;
  latitude: number | null;
  longitude: number | null;
  /** 2021 LSOA code, from the postcode source. */
  lsoaCode: string | null;
  radiusM: number;
}

export type SourceStatus = "ok" | "empty" | "error" | "skipped";

export interface SourceResult {
  status: SourceStatus;
  data?: unknown;
  error?: string;
}

export interface SourceContext {
  env: Env;
  fetchJson: <T = unknown>(url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>;
  /** Reads through KV, so properties in one postcode share one upstream call. */
  cached: <T>(key: string, ttlSeconds: number, load: () => Promise<T>) => Promise<T>;
}

export interface SourceDef {
  id: string;
  label: string;
  /** Shown beside the data, as the licences require. */
  attribution: string;
  /** What has to be known before this source can run. */
  needs: ("latlng" | "lsoa" | "address")[];
  run(input: SourceInput, ctx: SourceContext): Promise<SourceResult>;
}

export class UpstreamError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
