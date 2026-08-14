-- One reminder, several things to tick off.
--
-- Run once: npx wrangler d1 execute nu-bot --remote --file=./migrations/011_reminder_items.sql
--
-- On 12.08.2026 he sent "תזכיר לי להחזיר ראוטר, לקנות מחבת לטבון,ללכת למחסני
-- תאורה מחר ב8 בבוקר" and got one row with a comma-spliced title. The next
-- morning he reported two of the three done — "זה שלוש משימות, החזרתי את
-- הראוטר ואני עכשיו קונה מחבת, וסיימתי עם מחסני תאורה" — and there was no way
-- to represent any of it. The only `complete` the bot had closes the whole
-- instance, which would have been a lie about the middle errand.
--
-- Items hang off the REMINDER, not the instance, and their done state is
-- cleared when the reminder fires again (see db.resetItems). The alternative —
-- a row per item per instance — is the more obviously correct model and buys
-- nothing: nobody has ever wanted to know which errand they skipped three
-- Tuesdays ago, and it doubles the write path for the daily case.
--
-- Splitting is deliberately conservative (see effects.splitIntoItems). A
-- checklist he did not ask for is worse than a title with commas in it: the
-- first turns one task into three nags, and the second is what he typed.
CREATE TABLE IF NOT EXISTS reminder_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL,
  -- Denormalised so the callback handler can authorise a tap without joining
  -- back to `reminders`, the same reason `instances` carries it.
  chat_id     TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  position    INTEGER NOT NULL,          -- his order, which is the order he said them in
  done_at     INTEGER,                   -- NULL = still open
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_reminder ON reminder_items(reminder_id, position);
