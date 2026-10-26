# Architecture

```
                 ┌───────────────────────── Cloudflare ──────────────────────────┐
 Browser ──────► │ vacantwatch (Worker, TypeScript/Hono)                           │
 (dashboard,     │   /api/*  → routes ─┬─► D1  vacantwatch-db   (all records)      │
  field PWA)     │                     ├─► R2  vacantwatch-photos (visit photos)   │
                 │                     ├─► KV  CACHE (public-data cache, rate limits)
                 │                     └─► service binding INSIGHTS ──┐            │
                 │   everything else → static assets (worker/public) │            │
                 │   cron 15 * * * *  → enrichment sweep             ▼            │
                 │   cron 40 3 * * *  → revisits, rescore,   vacantwatch-insights │
                 │                      services sync        (Python Worker,      │
                 └──────────────┬──────────────────────────   no public URL)      │
                                │ fetch                                           │
        postcodes.io · police.uk · Land Registry · EPC · Environment Agency ·      │
        planning.data.gov.uk · Nomis · Overpass (OpenStreetMap)                   │
```

## Languages

- **TypeScript** — the API Worker: auth, routes, the eight public-data adapters, the enrichment orchestrator, crons.
- **Python** — the insights Worker: priority scoring, vacancy likelihood, recommended actions and area profiles. Pure functions in `insights/src/insights/`, tested with pytest outside the Workers runtime; `entry.py` is the thin Workers entrypoint. Uses the runtime's built-in `workers` SDK (`disable_python_external_sdk`), no third-party packages.
- **SQL** — D1 schema and migrations.
- **HTML/CSS/JavaScript** — dashboard and PWA as native ES modules, no build step. Leaflet is vendored into `public/vendor` so no third-party script runs.

## Enrichment

`enrichProperty` runs the postcode source first (it supplies coordinates and the LSOA), then the other seven in parallel. Each result is stored in `enrichment` (one row per property per source, with status `ok`, `empty`, `error` or `skipped`), so one failing API never blanks the others. Raw upstream responses are cached in KV by postcode or rounded coordinates, so properties in the same street share calls.

Every run has a **time budget**: 20 s when started from a request (`waitUntil` is cut off about 30 s after the response), 40 s for a coordinator's "Refresh data", 60 s from the cron. A source still running at the deadline is recorded as an error and the run is `partial`; the hourly sweep retries `partial` and `failed` after an hour, and picks up anything stuck in `running` for ten minutes.

After enrichment, or after any visit or edit, `rescoreProperty` sends the property, its last ten visits and the stored enrichment to the Python Worker and stores the result on the property.

### Why services are a directory, not a live query

Public Overpass instances refuse requests from Cloudflare Workers (overpass-api.de answers 521) or rate-limit the shared egress (429), and the one that answers can take 15 s. So support services are synced into the `support_services` table per watch area by the daily cron (up to 120 s per area, trying each mirror in turn), and enrichment reads from D1. Coordinators can add services OpenStreetMap does not know about, and hide wrong ones.

## Offline field app

- `sw.js` precaches the app shell, serves static files stale-while-revalidate, caches map tiles that have been viewed (capped at 600), and never caches `/api/`.
- Writes go into an IndexedDB **outbox** (`store.js`) and are replayed oldest first by `sync.js` on load, on the `online` event, every minute, and on Background Sync where supported.
- Every write carries a `client_id`; the API returns the existing record on a replay, so a dropped response never duplicates a visit. A property reported offline gets a client id; its visit and photos reference that id and are resolved to the server id once the property syncs. A 409 (someone else already recorded the address) attaches the visit to the existing record.
- A 4xx the server will never accept parks the item as `failed` for the worker to review under "Waiting to send"; 5xx, 429 and network errors leave it pending.
- The open-case list, tasks, the 40 most recently opened properties and the last "help nearby" result are kept in IndexedDB for offline browsing.

## Security

- Sessions: a random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie; only its SHA-256 is stored. 14-day sliding expiry.
- Passwords: PBKDF2-SHA256, 100,000 iterations (the Workers maximum), per-user salt. Five failures lock the account for 15 minutes; logins are rate-limited per IP. A temporary password opens nothing but the auth endpoints until changed.
- Roles are ordered `viewer < field_worker < coordinator < admin`. Owner notes are returned only to coordinators and admins, and redacted in the audit log.
- Writes refuse a foreign `Origin` or `Sec-Fetch-Site: cross-site`.
- Every create, update and delete writes to `audit_log`.
- Photos are type-checked by magic bytes (JPEG, PNG, WebP), stored privately in R2 and served only to signed-in users.
- CSP allows scripts from self only; `frame-ancestors 'none'`.
- The insights Worker has no public URL; it is reachable only through the service binding.
- First admin is created once, with the `SETUP_TOKEN` secret, in a race-safe insert.
