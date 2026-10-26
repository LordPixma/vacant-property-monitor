export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  /** The Python insights Worker (scoring + area profiles). Optional so the API degrades rather than fails. */
  INSIGHTS?: Fetcher;

  ENVIRONMENT: string;
  ORG_NAME: string;
  /** Sent as the User-Agent contact on public API calls, as OSM and police.uk ask. */
  CONTACT_EMAIL?: string;

  /** One-time token that allows creating the first admin account. */
  SETUP_TOKEN?: string;
  /** Bearer token for the EPC register (get-energy-performance-data.communities.gov.uk). Optional. */
  EPC_API_TOKEN?: string;
}

export type Role = "admin" | "coordinator" | "field_worker" | "viewer";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
}

export type AppBindings = { Bindings: Env; Variables: { user: SessionUser; sessionHash: string } };
