-- Every model rewrite the validator threw away, kept with its reason and its
-- text.
--
-- The `usage` row keyed '_rejections' already counted these, and on 10.08.2026
-- it reported three in one day. That number is useless on its own: the reason
-- existed for exactly one line inside a console.warn, the discarded wording was
-- never written down at all, and Workers Logs is not enabled — so by the time
-- anyone looked, the only honest answer to "which three?" was that they were
-- gone. A rejection rate is a thing to fix; a rejection rate you cannot read is
-- a thing to argue about.
--
-- Deliberately NOT a general log table. It holds one narrow class of event
-- whose whole purpose is being read back later by /diag, and it is capped (see
-- db.REJECTION_KEEP) because the day it fills fastest is the day the model is
-- misbehaving — exactly when the bot must not also start failing writes.
CREATE TABLE IF NOT EXISTS rejections (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT    NOT NULL,
  at      INTEGER NOT NULL,               -- epoch ms
  reason  TEXT    NOT NULL,               -- verbatim from validate.ts
  text    TEXT    NOT NULL,               -- the rewrite that was discarded
  effects TEXT    NOT NULL                -- the effect kinds in play, comma-separated
);
CREATE INDEX IF NOT EXISTS idx_rejections_chat ON rejections(chat_id, id DESC);
