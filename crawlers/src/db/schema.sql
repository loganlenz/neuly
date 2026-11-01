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

-- Care providers: state-licensed psilocybin service centers plus a curated list
CREATE TABLE IF NOT EXISTS care_providers (
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
  error       TEXT,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent upgrade for databases created before the error column existed
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS error TEXT;

-- ============================================
-- Application tables (auth, billing, alerts, newsletter)
-- These power the product surface and require the Postgres backend.
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  name               TEXT,
  plan               TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  newsletter_opt_in  BOOLEAN NOT NULL DEFAULT true,
  stripe_customer_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type      TEXT,          -- null = all entity types
  keyword          TEXT,          -- null = no keyword filter
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user saved/followed entities — powers the Save/Follow buttons and the
-- dashboard "Saved Items" panel.
CREATE TABLE IF NOT EXISTS saved_items (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  entity_title TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'save' CHECK (kind IN ('save', 'follow')),
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, entity_type, entity_id, kind)
);

CREATE TABLE IF NOT EXISTS newsletter_issues (
  id           TEXT PRIMARY KEY,
  subject      TEXT NOT NULL,
  html         TEXT NOT NULL,
  markdown     TEXT NOT NULL,
  event_count  INTEGER NOT NULL DEFAULT 0,
  recipients   INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Industry news: press coverage (Google News) + material SEC 8-K filings
CREATE TABLE IF NOT EXISTS news (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest quotes + 1-month closes for publicly traded companies
CREATE TABLE IF NOT EXISTS market_quotes (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  source        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alert_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_saved_items_user ON saved_items (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trials_data ON clinical_trials USING gin (data);
CREATE INDEX IF NOT EXISTS idx_papers_data ON research_papers USING gin (data);
CREATE INDEX IF NOT EXISTS idx_companies_data ON companies USING gin (data);
CREATE INDEX IF NOT EXISTS idx_jobs_data ON jobs USING gin (data);
CREATE INDEX IF NOT EXISTS idx_legislation_data ON legislation USING gin (data);
CREATE INDEX IF NOT EXISTS idx_funding_events_data ON funding_events USING gin (data);
CREATE INDEX IF NOT EXISTS idx_grants_data ON grants USING gin (data);
CREATE INDEX IF NOT EXISTS idx_care_providers_data ON care_providers USING gin (data);
CREATE INDEX IF NOT EXISTS idx_news_published ON news ((data->>'publishedAt') DESC);
CREATE INDEX IF NOT EXISTS idx_change_events_detected ON change_events (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_events_entity ON change_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_type ON crawl_runs (data_type, ran_at DESC);

-- ============================================
-- Launch additions: roles, password resets, user datasets, API metering,
-- admin-triggered crawls. All idempotent.
-- ============================================

-- Role-based permissions: 'user' (default) or 'admin' (operator console)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- Single-use password reset tokens (hash stored, never the token itself)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_reset_tokens (user_id);

-- User-built datasets: a named collection of hand-picked entities and/or
-- saved queries that resolve live against the platform data.
CREATE TABLE IF NOT EXISTS datasets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  is_public   BOOLEAN NOT NULL DEFAULT false,
  share_slug  TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_datasets_user ON datasets (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dataset_items (
  id           TEXT PRIMARY KEY,
  dataset_id   TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  entity_title TEXT NOT NULL,
  note         TEXT,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_dataset_items_dataset ON dataset_items (dataset_id, added_at DESC);

-- Saved queries: a dataset row that stays current as crawls land
CREATE TABLE IF NOT EXISTS dataset_queries (
  id          TEXT PRIMARY KEY,
  dataset_id  TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dataset_queries_dataset ON dataset_queries (dataset_id);

-- API usage metering: one row per key per UTC day
CREATE TABLE IF NOT EXISTS api_usage (
  api_key_id  TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  requests    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, day)
);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::text[];

-- Admin-requested crawls: the web process inserts, the scheduler picks up
CREATE TABLE IF NOT EXISTS crawl_requests (
  id           BIGSERIAL PRIMARY KEY,
  crawler      TEXT NOT NULL,
  requested_by TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawl_requests_pending ON crawl_requests (requested_at) WHERE started_at IS NULL;

-- Audit trail for sensitive account/admin actions
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

-- ============================================
-- Marketplace: interest tracking, leads, partner claims, pay-per-lead
-- ============================================

-- Every signed-in look at a provider, study, company, ... (the activity log
-- partners see in aggregate)
CREATE TABLE IF NOT EXISTS entity_views (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  entity_title TEXT,
  viewed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entity_views_entity ON entity_views (entity_type, entity_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_views_user ON entity_views (user_id, viewed_at DESC);

-- A user raising their hand: care inquiry or study-participation interest
CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('care_inquiry', 'study_interest')),
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  entity_title TEXT NOT NULL,
  contact      JSONB NOT NULL,          -- name, email, phone, location
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed', 'spam')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_entity ON leads (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_user ON leads (user_id, created_at DESC);

-- An institution claiming a listing (care provider, study sponsor/site, company)
CREATE TABLE IF NOT EXISTS entity_claims (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  entity_title     TEXT NOT NULL,
  organization     TEXT NOT NULL,
  contact_email    TEXT NOT NULL,
  message          TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  lead_price_cents INTEGER,             -- override of the default per-lead price
  notify_email     BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at      TIMESTAMPTZ,
  reviewed_by      TEXT,
  UNIQUE (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_claims_entity ON entity_claims (entity_type, entity_id) WHERE status = 'approved';

-- A partner unlocking a lead's contact details (Stripe one-off payment)
CREATE TABLE IF NOT EXISTS lead_purchases (
  id                 TEXT PRIMARY KEY,
  lead_id            TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  claim_id           TEXT NOT NULL REFERENCES entity_claims(id) ON DELETE CASCADE,
  buyer_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents       INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'usd',
  stripe_session_id  TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'comped', 'refunded')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at            TIMESTAMPTZ,
  UNIQUE (lead_id, claim_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_purchases_buyer ON lead_purchases (buyer_user_id, created_at DESC);

-- Headshot provenance on people
-- (stored inside the people JSONB payload: imageUrl, imageSource, imageAttribution)
