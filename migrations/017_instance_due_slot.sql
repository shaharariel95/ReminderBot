-- One instance per reminder per due slot, and the slot recorded on the row.
--
-- `due_at` is when the reminder was SUPPOSED to ring. `fired_at` is when it
-- actually did. They were the same column's worth of information right up
-- until they weren't: on 01.09.2026 reminder #69 was due at 16:30 and instance
-- 53 has fired_at 17:50:39, because Cloudflare's cron skipped eighty minutes.
-- With only fired_at on the row, nothing anywhere could tell that the reminder
-- had been late — so it opened with the same sentence it would have used on
-- time, which is a false claim about WHEN.
--
-- It does double duty as the idempotency key. `tick` reads the due rows and
-- then writes; two invocations that interleave both create an instance. The
-- claim in db.claimTick is the mechanism that stops that, but a claim is a
-- policy and this is an invariant: the database refuses the second row
-- whatever the caller believes.
--
-- The index is PARTIAL on purpose. Every instance that existed before this
-- migration has due_at NULL, and SQLite treats NULLs as distinct in a unique
-- index anyway — but stating it keeps the intent legible and keeps the index
-- off the rows it cannot say anything about.
ALTER TABLE instances ADD COLUMN due_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_due_slot
  ON instances(reminder_id, due_at)
  WHERE due_at IS NOT NULL;
