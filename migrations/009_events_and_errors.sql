-- Two narrow logs, and the reason they are two.
--
-- Run once: npx wrangler d1 execute nu-bot --remote --file=./migrations/009_events_and_errors.sql
--
-- On 13.08.2026 a reminder set for 08:00 did not fire, and on 14.08.2026
-- another set for 10:00 did not either. Both are still unexplained, and the
-- reason they are unexplained is that nothing anywhere recorded what the cron
-- did. /diag could report the version, the model, the quota and the last
-- discarded rewrites — everything except the one subsystem that had failed.
-- The only trace of a failed delivery was a console.log, and Workers Logs is
-- off, so by the time anyone looked the answer was gone.
--
-- `events` is the life story of a reminder: created, fired, nagged, moved,
-- closed. It answers "what happened to #18" (/why) and, counted over a day,
-- "did the cron run and did anything fail to reach him" (/diag).
--
-- `errors` is where a THROW went. That is a different question with a
-- different reader: events are things the bot meant to do, errors are things
-- that happened to it. Merging them would mean the common case (a reminder
-- firing normally) and the rare case (something blew up) share a table whose
-- retention has to satisfy both, and the day errors arrive fastest is exactly
-- the day the reminder history must not be pushed out of the window.
--
-- Both are capped and pruned on write, for the reason migration 006 gives:
-- the day this fills fastest is the day the bot is already misbehaving, and
-- that is the worst possible moment to also start failing writes.

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT    NOT NULL,
  -- Both nullable: a chat-level event (a check-in, a brief) belongs to neither.
  reminder_id INTEGER,
  instance_id INTEGER,
  at          INTEGER NOT NULL,              -- epoch ms
  kind        TEXT    NOT NULL,              -- see db.EVENT_OF
  detail      TEXT
);
-- /why reads by reminder, /diag counts by chat and day. Both walk backwards.
CREATE INDEX IF NOT EXISTS idx_events_reminder ON events(reminder_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat_id, id DESC);

CREATE TABLE IF NOT EXISTS errors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id   TEXT    NOT NULL,
  at        INTEGER NOT NULL,                -- epoch ms
  -- WHICH STAGE, as a short tag: route/apply, tick, send, speak, handleUpdate.
  -- This is the first question asked of any failure and until now nothing
  -- could answer it.
  stage     TEXT    NOT NULL,
  message   TEXT    NOT NULL,
  -- What he had sent when it blew up, truncated. A report that reads
  -- "what he asked" -> "what broke" is diagnosable; a bare stack trace is not.
  user_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_errors_chat ON errors(chat_id, id DESC);
