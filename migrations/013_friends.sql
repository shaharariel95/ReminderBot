-- Reminders you can set for someone else — see CLAUDE.md, "Friends".
--
-- Run once: npx wrangler d1 execute nu-bot --remote --file=./migrations/013_friends.sql
--
-- One row is one DIRECTED edge: "in <chat_id>'s address book, <friend_chat_id>
-- is called <nickname>". Two rows make a friendship, and both are written at
-- the same moment — the one the requester asked for, and the reverse one that
-- lets the other side answer back and lets his fired reminder say who it came
-- from. A friendship with only one edge would deliver "נו? לקנות חלב" from
-- nobody, which is worse than not delivering it.
--
-- `status` is on the requester's edge only, and it is the consent record:
-- 'pending' until the other side taps yes. Nothing may be written into
-- somebody else's chat while a row is pending — that is the whole point of
-- the column, and db.friendsOf is the only reader that matters.
--
-- The row is kept rather than deleted on a refusal ('declined'), for the same
-- reason `pending` keeps denied strangers: a deleted row makes the next
-- request look brand new, and someone who said no gets asked forever.
CREATE TABLE IF NOT EXISTS friends (
  chat_id        TEXT    NOT NULL,   -- whose address book this row is in
  friend_chat_id TEXT    NOT NULL,   -- who it points at
  nickname       TEXT    NOT NULL,   -- what THIS side calls them
  status         TEXT    NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  -- What Telegram says the REQUESTER is called, captured when he asks.
  --
  -- It is the default nickname the other side gets for him at acceptance. It
  -- has to be captured here because that is the only moment it is available:
  -- the accept arrives as a button tap in HER chat, which carries her name
  -- and not his. Without it, her first reminder from him arrives from a bare
  -- chat_id — see db.acceptFriend.
  requester_name TEXT,
  -- Who asked. Kept after acceptance so /friends can say which way it went,
  -- and so a second request from the same pair is recognisable as a repeat.
  requested_by   TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (chat_id, friend_chat_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_chat ON friends(chat_id, status);

-- Who set this reminder, when it was not the person it fires for. NULL means
-- he set it himself, which is every row that existed before this migration.
--
-- Stored as the sender's chat_id rather than as their nickname: the recipient
-- may rename them tomorrow, and the message that fires next week has to say
-- what he calls them TODAY. The name is resolved at fire time through the
-- recipient's own `friends` row — see db.friendName.
ALTER TABLE reminders ADD COLUMN from_chat_id TEXT;
