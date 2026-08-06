-- Phase 2: the morning brief and the evening close-out.
--
-- Both are "once per local day" messages, so what has to be remembered is not
-- a timestamp but a DATE in the user's own timezone — comparing against an
-- epoch would send the brief twice on the day the clocks change, and skip it
-- on the day they change back.
--
-- A NULL hour means the message is switched off. The UPDATE below opts the
-- existing row in; anything created later gets the schema.sql defaults.
ALTER TABLE settings ADD COLUMN brief_hour        INTEGER DEFAULT 8;
ALTER TABLE settings ADD COLUMN closeout_hour     INTEGER DEFAULT 21;
ALTER TABLE settings ADD COLUMN last_brief_on     TEXT;
ALTER TABLE settings ADD COLUMN last_closeout_on  TEXT;

UPDATE settings SET brief_hour    = 8  WHERE brief_hour    IS NULL;
UPDATE settings SET closeout_hour = 21 WHERE closeout_hour IS NULL;
