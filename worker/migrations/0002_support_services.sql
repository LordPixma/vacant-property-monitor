-- Support services directory: synced from OpenStreetMap per watch area by the daily cron,
-- plus services the charity adds by hand. Property enrichment reads from here, because
-- public Overpass instances refuse or rate-limit requests from Cloudflare's shared egress.

CREATE TABLE support_services (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL CHECK (source IN ('osm', 'manual')),
  osm_ref        TEXT UNIQUE,
  group_key      TEXT NOT NULL CHECK (group_key IN ('shelter', 'food_bank', 'social_support', 'health', 'pharmacy', 'community', 'facilities', 'police', 'transport')),
  name           TEXT,
  kind           TEXT,
  latitude       REAL NOT NULL,
  longitude      REAL NOT NULL,
  address        TEXT,
  phone          TEXT,
  website        TEXT,
  opening_hours  TEXT,
  notes          TEXT,
  watch_area_id  TEXT REFERENCES watch_areas(id) ON DELETE SET NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_services_geo ON support_services(latitude, longitude);
CREATE INDEX idx_services_area ON support_services(watch_area_id, source);

ALTER TABLE watch_areas ADD COLUMN services_synced_at INTEGER;
ALTER TABLE watch_areas ADD COLUMN services_sync_error TEXT;
