-- A per-minute call counter, which is the axis the Gemini free tier actually
-- limits. GEMINI_SOFT_LIMIT guards a DAILY budget and had therefore never
-- fired: /diag caught a 429 carrying `limit: 20` and "retry in 56s" while the
-- day's usage was still in the twenties.
--
-- The bucket key is "<minute>|<model>", minute FIRST, so that pruning older
-- windows is a single lexicographic range delete across every model at once.
CREATE TABLE IF NOT EXISTS rate_window (
  bucket TEXT    PRIMARY KEY,           -- "2026-08-07T14:32|gemini-3.5-flash"
  calls  INTEGER NOT NULL DEFAULT 0
);
