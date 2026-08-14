-- Who spent the quota, not just how much of it went.
--
-- Run once: npx wrangler d1 execute nu-bot --remote --file=./migrations/012_usage_by_chat.sql
--
-- `usage` was keyed (day, model) with no chat at all, while the rejection
-- LISTING beside it in /diag has always been per-chat. On 11.08.2026 that
-- produced "תשובות שנפסלו היום: 1" above an empty list: the rejection was
-- נתנאל's, and the owner was shown a number he had no way to explain.
--
-- The same gap had a second, quieter cost. GEMINI_SOFT_LIMIT gates unprompted
-- check-ins, and it was comparing against the GLOBAL total — so a guest
-- burning the day's calls silently switched off the owner's check-ins, with
-- nothing anywhere saying why they had stopped.
--
-- Both numbers are wanted, for different questions:
--   per chat  — "what did I use", and who to talk to when it is climbing
--   in total  — what actually protects the shared API key
-- so the total becomes a SUM rather than disappearing. See db.usageToday and
-- db.usageTodayFor.
--
-- SQLite cannot add a column to a PRIMARY KEY, so the table is rebuilt. The
-- rows carried over are attributed to '-' — an id no chat can have — because
-- inventing an owner for them would be a worse answer than admitting the old
-- rows predate the question. They age out within a day anyway.

CREATE TABLE IF NOT EXISTS usage_new (
  day     TEXT    NOT NULL,                 -- local date, see db.localDay
  model   TEXT    NOT NULL,
  chat_id TEXT    NOT NULL DEFAULT '-',
  calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, chat_id)
);

INSERT OR IGNORE INTO usage_new (day, model, chat_id, calls)
  SELECT day, model, '-', calls FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
