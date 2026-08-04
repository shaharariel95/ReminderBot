-- "נו?" schema. Safe to re-run, but it DROPS everything first.
-- If you already have data, use migrations/001_goals.sql instead.
DROP TABLE IF EXISTS instances;
DROP TABLE IF EXISTS reminders;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS goals;
DROP TABLE IF EXISTS settings;

CREATE TABLE reminders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  notes            TEXT,
  schedule         TEXT    NOT NULL,               -- JSON, see src/types.ts
  tz               TEXT    NOT NULL DEFAULT 'Asia/Jerusalem',
  requires_proof   INTEGER NOT NULL DEFAULT 0,
  proof_type       TEXT    NOT NULL DEFAULT 'any', -- text | photo | any
  nag_interval_min INTEGER NOT NULL DEFAULT 20,
  max_nags         INTEGER NOT NULL DEFAULT 3,
  next_fire_at     INTEGER,                        -- epoch ms; NULL = never again
  -- scheduled | inbox | done | cancelled. `active` is derived and kept only so a
  -- half-migrated database still reads; status is the source of truth.
  status           TEXT    NOT NULL DEFAULT 'scheduled',
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(status, next_fire_at);
CREATE INDEX idx_reminders_chat ON reminders(chat_id, status);

-- One row per firing. This table is what makes nagging, streaks and
-- "you flaked three times this week" possible at all.
CREATE TABLE instances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  chat_id     TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  fired_at    INTEGER NOT NULL,
  next_nag_at INTEGER,
  nag_count   INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'open',     -- open | done | failed | skipped
  proof       TEXT,
  closed_at   INTEGER
);
CREATE INDEX idx_instances_open ON instances(status, next_nag_at);
CREATE INDEX idx_instances_chat ON instances(chat_id, status);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL,                        -- user | bot
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_chat ON messages(chat_id, id DESC);

-- Ongoing ambitions with no fire time: "learn Bava Batra", "open a trading
-- account", "get back to the gym". Reminders are about a clock; goals are the
-- things the bot brings up on its own when the conversation has gone quiet.
CREATE TABLE goals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  why              TEXT,                           -- his stated reason; leverage later
  status           TEXT    NOT NULL DEFAULT 'active', -- active | done | dropped
  last_progress    TEXT,                           -- last thing he said about it
  last_progress_at INTEGER,
  last_checkin_at  INTEGER,
  checkin_count    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_goals_chat ON goals(chat_id, status, last_checkin_at);

CREATE TABLE settings (
  chat_id          TEXT PRIMARY KEY,
  tz               TEXT    NOT NULL DEFAULT 'Asia/Jerusalem',
  intensity        INTEGER NOT NULL DEFAULT 2,     -- 1 = dry, 2 = sharp, 3 = brutal
  muted_until      INTEGER,
  off_limits       TEXT,                           -- topics the bot must never touch
  checkins_enabled INTEGER NOT NULL DEFAULT 1,
  checkin_per_day  INTEGER NOT NULL DEFAULT 2,     -- unprompted messages per waking day
  quiet_start_hour INTEGER NOT NULL DEFAULT 23,    -- no check-ins or nags from here...
  quiet_end_hour   INTEGER NOT NULL DEFAULT 8,     -- ...until here (local time)
  next_checkin_at  INTEGER
);

-- One row per model per day. Small, and it lets /diag tell the truth about quota.
CREATE TABLE usage (
  day   TEXT    NOT NULL,                          -- "2026-08-04" UTC
  model TEXT    NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);
