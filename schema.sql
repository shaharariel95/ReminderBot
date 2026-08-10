-- "נו?" schema. Safe to re-run, but it DROPS everything first.
-- If you already have data, use migrations/001_goals.sql instead.
DROP TABLE IF EXISTS instances;
DROP TABLE IF EXISTS reminders;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS goals;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS profile;
DROP TABLE IF EXISTS rejections;
DROP TABLE IF EXISTS meta;
DROP TABLE IF EXISTS pending;

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

-- Durable facts he has STATED about himself — see migrations/005. Not a
-- conversation summary, and not anything the bot inferred.
CREATE TABLE profile (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  note       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_profile_chat ON profile(chat_id, id DESC);

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
  next_checkin_at  INTEGER,
  -- Once-a-day messages. NULL hour = switched off. The "last sent on" columns
  -- hold a LOCAL date (YYYY-MM-DD), not a timestamp: an epoch comparison sends
  -- the brief twice on the day the clocks go back.
  brief_hour       INTEGER DEFAULT 8,
  closeout_hour    INTEGER DEFAULT 21,
  last_brief_on    TEXT,
  last_closeout_on TEXT
);

-- One row per minute per model. The free tier limits requests per MINUTE, not
-- per day, so this is the counter that actually protects anything. Old rows are
-- pruned by the first call of each new minute — see db.bumpRateWindow.
CREATE TABLE rate_window (
  bucket TEXT    PRIMARY KEY,           -- "2026-08-07T14:32|gemini-3.5-flash"
  calls  INTEGER NOT NULL DEFAULT 0
);

-- One row per model per day. Small, and it lets /diag tell the truth about quota.
CREATE TABLE usage (
  day   TEXT    NOT NULL,                          -- "2026-08-04" UTC
  model TEXT    NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);

-- People who have messaged but are not allowed yet — see migrations/008. The
-- only place the bot speaks to someone it does not know, and the table is what
-- bounds that: capped rows, two replies per chat, and a 'denied' row is kept
-- so a refusal cannot be reset by messaging again.
CREATE TABLE pending (
  chat_id    TEXT PRIMARY KEY,
  name       TEXT,
  status     TEXT    NOT NULL DEFAULT 'asked',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_status ON pending(status, created_at);

-- Deployment-level state, not user state — see migrations/007. Holds the last
-- version the database saw, which is how a Worker with no start-up hook works
-- out that it has just been deployed.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every model rewrite the validator threw away — see migrations/006. The
-- '_rejections' row in `usage` counts them; this is the one that says which.
CREATE TABLE rejections (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  reason  TEXT    NOT NULL,
  text    TEXT    NOT NULL,
  effects TEXT    NOT NULL
);
CREATE INDEX idx_rejections_chat ON rejections(chat_id, id DESC);
