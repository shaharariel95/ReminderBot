-- Adds the inbox (reminders.status) and quota tracking to a live database.
-- Run once: npx wrangler d1 execute nu-bot --remote --file=./migrations/002_inbox_and_usage.sql
-- Running it twice errors harmlessly with "duplicate column name"; that is safe to ignore.

ALTER TABLE reminders ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled';

-- Existing rows: active=0 meant "finished or cancelled", which is 'done' for our
-- purposes. Nothing in a pre-migration database can be an inbox item.
UPDATE reminders SET status = 'done' WHERE active = 0;
UPDATE reminders SET status = 'scheduled' WHERE active = 1;

CREATE INDEX IF NOT EXISTS idx_reminders_chat ON reminders(chat_id, status);

CREATE TABLE IF NOT EXISTS usage (
  day   TEXT    NOT NULL,
  model TEXT    NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);
