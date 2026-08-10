-- One row per piece of bot-level state that belongs to the deployment rather
-- than to the user. Currently one key: 'version'.
--
-- This exists because a Cloudflare Worker cannot be told it was deployed.
-- There is no start-up hook, no build callback, nothing that fires once when
-- new code goes live — every invocation looks identical to the last. So the
-- bot works it out: the version compiled into the code (src/version.ts) is
-- compared against the last one written here, and a difference means the code
-- running now is not the code that ran a minute ago.
--
-- Deliberately generic (key/value) rather than a `version` column somewhere:
-- `settings` is per-chat and this is not about a chat, and the next piece of
-- deployment state will want to live beside this one rather than invent
-- another table.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
