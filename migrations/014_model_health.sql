-- Which models are worth calling right now — see src/gemini.ts.
--
-- Run once: npx wrangler d1 execute nu-bot --remote --file=./migrations/014_model_health.sql
--
-- The ladder used to be two models deep and had no memory: every 429 was
-- rediscovered from scratch on the next message, at the cost of a round trip
-- each time. With a ladder several models long that is several wasted round
-- trips per turn, inside a budget that has to leave room for an answer.
--
-- So a model that says "not now" is written down, and skipped without being
-- called until `blocked_until` passes. Nothing else clears it: the expiry IS
-- the probe. The next message after it lands tries the model again, and the
-- answer to "has the block lifted" is the one thing that cannot be known
-- without asking.
--
-- `strikes` is what stops the probe becoming a nuisance. Each consecutive
-- block doubles the wait, so a model that is merely over its per-minute limit
-- is back within the minute, while one whose DAILY quota is gone is asked
-- roughly twice an hour instead of twice a minute. A success clears the row
-- outright — see db.clearModelBlock — which is what makes the backoff
-- recover instantly rather than decay.
--
-- Deliberately global, not per chat: the API key is shared, and a 429 is a
-- fact about the key, not about who happened to trigger it.
CREATE TABLE IF NOT EXISTS model_health (
  model         TEXT    PRIMARY KEY,
  blocked_until INTEGER NOT NULL,      -- epoch ms; <= now means "try it again"
  strikes       INTEGER NOT NULL DEFAULT 1, -- consecutive blocks, drives the backoff
  reason        TEXT,                  -- "429", "503", "404" — shown by /diag
  updated_at    INTEGER NOT NULL
);
