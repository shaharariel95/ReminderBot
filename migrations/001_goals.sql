-- Adds goals + proactive check-ins to a database that already has data.
-- Run once:  npx wrangler d1 execute nu-bot --remote --file=./migrations/001_goals.sql
-- (If you have no data yet, just re-run schema.sql instead.)

CREATE TABLE IF NOT EXISTS goals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  why              TEXT,
  status           TEXT    NOT NULL DEFAULT 'active',
  last_progress    TEXT,
  last_progress_at INTEGER,
  last_checkin_at  INTEGER,
  checkin_count    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_chat ON goals(chat_id, status, last_checkin_at);

-- SQLite has no "ADD COLUMN IF NOT EXISTS". These five will error harmlessly
-- with "duplicate column name" if you run this file twice; that is safe to ignore.
ALTER TABLE settings ADD COLUMN checkins_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN checkin_per_day  INTEGER NOT NULL DEFAULT 2;
ALTER TABLE settings ADD COLUMN quiet_start_hour INTEGER NOT NULL DEFAULT 23;
ALTER TABLE settings ADD COLUMN quiet_end_hour   INTEGER NOT NULL DEFAULT 8;
ALTER TABLE settings ADD COLUMN next_checkin_at  INTEGER;
