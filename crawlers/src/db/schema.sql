-- Neuly database schema
-- Entity tables share one shape: the validated crawler payload lives in
-- `data` (JSONB) with provenance/versioning columns alongside. Key fields
-- stay queryable through JSONB expression indexes; promoting hot fields to
-- real columns can happen table-by-table later without breaking the API.

CREATE TABLE IF NOT EXISTS clinical_trials (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_papers (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS people (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS educational_resources (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- State bills (LegiScan) and federal regulatory documents (Federal Register)
CREATE TABLE IF NOT EXISTS legislation (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- SEC Form D (exempt offering) filings by psychedelic companies
CREATE TABLE IF NOT EXISTS funding_events (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NIH RePORTER research grants
CREATE TABLE IF NOT EXISTS grants (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Typed change log written by the diff engine; feeds alerts + newsletter
CREATE TABLE IF NOT EXISTS change_events (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  entity_title TEXT NOT NULL,
  change_type  TEXT NOT NULL CHECK (change_type IN ('added', 'updated', 'removed')),
  fields       JSONB,
  summary      TEXT NOT NULL,
  detected_at  TIMESTAMPTZ NOT NULL
);

-- One row per crawler execution; replaces manifest.json crawl history
CREATE TABLE IF NOT EXISTS crawl_runs (
  id          BIGSERIAL PRIMARY KEY,
  data_type   TEXT NOT NULL,
  item_count  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trials_data ON clinical_trials USING gin (data);
CREATE INDEX IF NOT EXISTS idx_papers_data ON research_papers USING gin (data);
CREATE INDEX IF NOT EXISTS idx_companies_data ON companies USING gin (data);
CREATE INDEX IF NOT EXISTS idx_jobs_data ON jobs USING gin (data);
CREATE INDEX IF NOT EXISTS idx_legislation_data ON legislation USING gin (data);
CREATE INDEX IF NOT EXISTS idx_funding_events_data ON funding_events USING gin (data);
CREATE INDEX IF NOT EXISTS idx_grants_data ON grants USING gin (data);
CREATE INDEX IF NOT EXISTS idx_change_events_detected ON change_events (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_events_entity ON change_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_type ON crawl_runs (data_type, ran_at DESC);
