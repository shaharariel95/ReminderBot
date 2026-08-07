-- Durable facts he has stated about himself: "אני קם ב-6", "אני שונא לרוץ
-- בבוקר", "יום שלישי זה יום ארוך בעבודה".
--
-- Deliberately NOT a summary of the conversation. Recent messages already give
-- the model short-term context and are pruned; this is the small set of things
-- that stay true after the conversation that produced them has scrolled away,
-- and it is the difference between a bot that remembers him and one that reads
-- the last ten messages very carefully.
--
-- Only things he SAID. Patterns the bot observed (a reminder missed four times
-- running) are computed from `instances` instead — see db.missStreak. Mixing
-- inference into a table of stated facts would make it impossible to tell,
-- later, which is which.
CREATE TABLE IF NOT EXISTS profile (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  note       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_chat ON profile(chat_id, id DESC);
