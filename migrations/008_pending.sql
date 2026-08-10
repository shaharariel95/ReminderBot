-- People who have messaged the bot but are not allowed to use it yet.
--
-- Before this, an unknown chat got silence and nothing else. That was safe but
-- useless: someone the owner actually wanted to add had no way to say so, and
-- the owner had to dig their chat_id out of `wrangler tail` to invite them.
--
-- This is the ONLY place the bot speaks to someone it does not know, so the
-- table is what bounds it: one row per chat, at most PENDING_MAX rows in
-- total (see db.ts), and at most two replies per chat in their lifetime. Past
-- the cap the bot goes back to saying nothing at all, which is exactly what it
-- did before — a flood of accounts costs a bounded number of rows and a
-- bounded number of messages to the owner, then nothing.
--
-- `status` is what makes a decision stick:
--   asked  — prompted for a name, nothing said back yet
--   named  — gave a name, waiting for the owner
--   denied — refused. Kept ON PURPOSE rather than deleted: deleting the row
--            would make the next message look like a brand-new stranger and
--            start the whole conversation again, forever.
CREATE TABLE IF NOT EXISTS pending (
  chat_id    TEXT PRIMARY KEY,
  name       TEXT,                                  -- NULL until they answer
  status     TEXT    NOT NULL DEFAULT 'asked',      -- asked | named | denied
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending(status, created_at);
