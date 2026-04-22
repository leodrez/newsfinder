-- ─────────────────────────────────────────────────────────────────────────────
-- NewsFinder schema
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query)
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Headlines ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS headlines (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  url         TEXT        NOT NULL,
  source      TEXT        NOT NULL,
  published_ts BIGINT,               -- unix seconds
  fetched_ts  BIGINT      NOT NULL,  -- unix seconds (used for ordering)
  relevance   INTEGER     NOT NULL DEFAULT 5,
  impact      TEXT        NOT NULL DEFAULT 'medium',
  summary     TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS headlines_fetched_ts_idx ON headlines (fetched_ts DESC);

-- RLS: anon can SELECT (needed for Realtime + direct frontend queries)
ALTER TABLE headlines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select" ON headlines FOR SELECT TO anon USING (true);
-- INSERT / UPDATE / DELETE are only allowed via the service-role key (bypasses RLS)

-- Enable Realtime so inserts are broadcast to subscribed frontend clients
ALTER PUBLICATION supabase_realtime ADD TABLE headlines;


-- ── 2. Dedup ─────────────────────────────────────────────────────────────────
-- Stores MD5 hashes of normalised headline titles for 24-hour dedup.
CREATE TABLE IF NOT EXISTS headline_dedup (
  hash        TEXT        PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: no public access — only the service-role key (API) can read/write
ALTER TABLE headline_dedup ENABLE ROW LEVEL SECURITY;
-- (no policies = accessible to service_role only)


-- ── 3. Config ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed defaults
INSERT INTO config (key, value) VALUES
  ('market_focus', 'S&P 500 (SPY, ES) and Nasdaq 100 (QQQ, NQ) index futures and ETFs. Interested in: Fed rate decisions, CPI/PPI/jobs data, big tech earnings (AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA), geopolitical shocks, oil/energy disruptions, Treasury yields, and sector rotation signals.'),
  ('llm_model',    'claude-haiku-4-5-20251001'),
  ('last_poll_ts', '0')
ON CONFLICT (key) DO NOTHING;

-- RLS: no public access
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
-- (no policies = accessible to service_role only)


-- ── 4. Scheduled cleanup (optional — requires pg_cron extension) ─────────────
-- Uncomment if you have pg_cron enabled (Supabase Pro plan).
-- This purges dedup hashes older than 24h once a day at midnight UTC.
--
-- SELECT cron.schedule(
--   'purge-headline-dedup',
--   '0 0 * * *',
--   $$DELETE FROM headline_dedup WHERE created_at < NOW() - INTERVAL '24 hours'$$
-- );
