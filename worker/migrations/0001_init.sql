-- VacantWatch initial schema.
-- Conventions: ids are random text (21 chars), timestamps are unix milliseconds (INTEGER),
-- JSON is stored as TEXT. No semicolons inside string literals: the D1 runner splits on them.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'coordinator', 'field_worker', 'viewer')),
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  password_iters  INTEGER NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  phone           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

-- Session tokens are never stored: only their SHA-256.
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Postcode areas the charity watches: an outcode (M14), a sector (M14 5) or a full postcode.
CREATE TABLE watch_areas (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  postcode_prefix TEXT NOT NULL UNIQUE,
  latitude    REAL,
  longitude   REAL,
  local_authority TEXT,
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE properties (
  id              TEXT PRIMARY KEY,
  client_id       TEXT UNIQUE,
  address_line1   TEXT NOT NULL,
  address_line2   TEXT,
  town            TEXT,
  postcode        TEXT NOT NULL,
  uprn            TEXT,
  latitude        REAL,
  longitude       REAL,
  location_source TEXT CHECK (location_source IN ('gps', 'postcode', 'manual')),
  category        TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (category IN ('council', 'housing_association', 'private', 'commercial', 'mixed_use', 'unknown')),
  property_type   TEXT CHECK (property_type IN ('house', 'flat', 'bungalow', 'maisonette', 'hmo', 'commercial', 'land', 'other')),
  status          TEXT NOT NULL DEFAULT 'reported'
                  CHECK (status IN ('reported', 'suspected_vacant', 'confirmed_vacant', 'derelict', 'abandoned', 'referred', 'brought_back_into_use', 'occupied', 'demolished')),
  condition       TEXT CHECK (condition IN ('good', 'fair', 'poor', 'derelict')),
  security        TEXT CHECK (security IN ('secured', 'boarded', 'partially_open', 'open')),
  bedrooms        INTEGER,
  vacant_since    TEXT,
  owner_info      TEXT,
  description     TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  source          TEXT NOT NULL DEFAULT 'field'
                  CHECK (source IN ('field', 'admin', 'import', 'council_list', 'public_report')),
  source_ref      TEXT,
  watch_area_id   TEXT REFERENCES watch_areas(id) ON DELETE SET NULL,
  assigned_to     TEXT REFERENCES users(id) ON DELETE SET NULL,
  priority_score  INTEGER,
  priority_band   TEXT CHECK (priority_band IN ('critical', 'high', 'medium', 'low')),
  vacancy_likelihood REAL,
  insights        TEXT,
  enrichment_status TEXT NOT NULL DEFAULT 'pending'
                  CHECK (enrichment_status IN ('pending', 'running', 'complete', 'partial', 'failed')),
  last_enriched_at INTEGER,
  last_visited_at  INTEGER,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_properties_postcode ON properties(postcode);
CREATE INDEX idx_properties_status ON properties(status, archived);
CREATE INDEX idx_properties_area ON properties(watch_area_id);
CREATE INDEX idx_properties_geo ON properties(latitude, longitude);
CREATE INDEX idx_properties_priority ON properties(priority_score DESC);
CREATE INDEX idx_properties_enrichment ON properties(enrichment_status, last_enriched_at);

-- A ground visit. client_id makes offline replays idempotent.
CREATE TABLE visits (
  id              TEXT PRIMARY KEY,
  client_id       TEXT UNIQUE,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  visited_at      INTEGER NOT NULL,
  latitude        REAL,
  longitude       REAL,
  gps_accuracy_m  REAL,
  observed_status TEXT CHECK (observed_status IN ('reported', 'suspected_vacant', 'confirmed_vacant', 'derelict', 'abandoned', 'referred', 'brought_back_into_use', 'occupied', 'demolished')),
  condition       TEXT CHECK (condition IN ('good', 'fair', 'poor', 'derelict')),
  security        TEXT CHECK (security IN ('secured', 'boarded', 'partially_open', 'open')),
  signals         TEXT NOT NULL DEFAULT '[]',
  notes           TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_visits_property ON visits(property_id, visited_at DESC);
CREATE INDEX idx_visits_user ON visits(user_id, visited_at DESC);

CREATE TABLE photos (
  id            TEXT PRIMARY KEY,
  client_id     TEXT UNIQUE,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  visit_id      TEXT REFERENCES visits(id) ON DELETE SET NULL,
  r2_key        TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  caption       TEXT,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_photos_property ON photos(property_id, created_at DESC);

-- One row per property per public data source: the last result, good or bad.
CREATE TABLE enrichment (
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'error', 'skipped')),
  data         TEXT,
  error        TEXT,
  fetched_at   INTEGER NOT NULL,
  duration_ms  INTEGER,
  PRIMARY KEY (property_id, source)
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  property_id  TEXT REFERENCES properties(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('revisit', 'refer_council', 'refer_streetlink', 'report_unsafe', 'owner_contact', 'research', 'other')),
  title        TEXT NOT NULL,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  due_at       INTEGER,
  assigned_to  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_tasks_assignee ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_property ON tasks(property_id);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
