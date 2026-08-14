import type { Env, Goal, Instance, Reminder, ReminderItem, Settings, Stats } from './types';
import { localDateKey } from './time';

const DAY = 86_400_000;

export async function getSettings(env: Env, chatId: string): Promise<Settings> {
  const row = await env.DB.prepare('SELECT * FROM settings WHERE chat_id = ?')
    .bind(chatId)
    .first<Settings>();
  // Defaults are re-applied here so a database that hasn't run migrations/001
  // yet degrades to "check-ins off" instead of throwing on undefined columns.
  if (row) {
    return {
      ...row,
      checkins_enabled: row.checkins_enabled ?? 0,
      checkin_per_day: row.checkin_per_day ?? 2,
      quiet_start_hour: row.quiet_start_hour ?? 23,
      quiet_end_hour: row.quiet_end_hour ?? 8,
      awaiting: row.awaiting ?? null,
      next_checkin_at: row.next_checkin_at ?? null,
      // A database that hasn't run migrations/003 reads these as undefined.
      // `?? null` means "switched off" there, which is the safe degradation:
      // no brief at all beats a brief at an hour nobody chose.
      brief_hour: row.brief_hour ?? null,
      closeout_hour: row.closeout_hour ?? null,
      last_brief_on: row.last_brief_on ?? null,
      last_closeout_on: row.last_closeout_on ?? null,
    };
  }
  const fresh: Settings = {
    chat_id: chatId,
    tz: env.DEFAULT_TZ ?? 'Asia/Jerusalem',
    intensity: 2,
    muted_until: null,
    off_limits: null,
    checkins_enabled: 1,
    checkin_per_day: 2,
    quiet_start_hour: 23,
    quiet_end_hour: 8,
    next_checkin_at: null,
    awaiting: null,
    brief_hour: 8,
    closeout_hour: 21,
    last_brief_on: null,
    last_closeout_on: null,
  };
  await env.DB.prepare('INSERT OR IGNORE INTO settings (chat_id, tz) VALUES (?, ?)')
    .bind(chatId, fresh.tz)
    .run();
  return fresh;
}

export async function setQuietHours(
  env: Env,
  chatId: string,
  startHour: number,
  endHour: number,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE settings SET quiet_start_hour = ?, quiet_end_hour = ? WHERE chat_id = ?',
  )
    .bind(startHour, endHour, chatId)
    .run();
}

export async function setOffLimits(
  env: Env,
  chatId: string,
  text: string | null,
): Promise<void> {
  await env.DB.prepare('UPDATE settings SET off_limits = ? WHERE chat_id = ?')
    .bind(text ? text.slice(0, 500) : null, chatId)
    .run();
}

export async function setNextCheckin(env: Env, chatId: string, ts: number | null): Promise<void> {
  await env.DB.prepare('UPDATE settings SET next_checkin_at = ? WHERE chat_id = ?')
    .bind(ts, chatId)
    .run();
}

export async function setCheckins(
  env: Env,
  chatId: string,
  enabled: boolean,
  perDay?: number,
): Promise<void> {
  if (perDay === undefined) {
    await env.DB.prepare('UPDATE settings SET checkins_enabled = ? WHERE chat_id = ?')
      .bind(enabled ? 1 : 0, chatId)
      .run();
    return;
  }
  await env.DB.prepare(
    'UPDATE settings SET checkins_enabled = ?, checkin_per_day = ? WHERE chat_id = ?',
  )
    .bind(enabled ? 1 : 0, Math.min(8, Math.max(1, Math.round(perDay))), chatId)
    .run();
}

// ------------------------------------------------------------------- goals

export async function addGoal(
  env: Env,
  chatId: string,
  title: string,
  why: string | null,
): Promise<number> {
  const res = await env.DB.prepare(
    'INSERT INTO goals (chat_id, title, why, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(chatId, title, why, Date.now())
    .run();
  return Number(res.meta.last_row_id);
}

export async function listGoals(env: Env, chatId: string): Promise<Goal[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM goals WHERE chat_id = ? AND status = 'active' ORDER BY last_checkin_at IS NOT NULL, last_checkin_at, id",
  )
    .bind(chatId)
    .all<Goal>();
  return res.results ?? [];
}

/** The active goal he has heard about least recently — the check-in candidate. */
/**
 * The goal most worth raising unprompted — or null when the honest answer is
 * "leave him alone about it".
 *
 * `checkin_count` is a run of UNANSWERED check-ins (recordGoalProgress resets
 * it), and the CASE below turns that run into patience. Without it, a chat with
 * exactly one active goal gets that goal returned on every single check-in
 * forever: "להגיד לאישתי משהו יפה" was raised five times across four days in
 * August 2026, each time quoting the same stale progress note, and nothing
 * anywhere noticed that nobody had ever replied.
 *
 * Done in SQL rather than filtered afterwards for the same reason the due
 * queries are: a goal in cooldown must not occupy the one row this returns.
 */
export async function stalestGoal(
  env: Env,
  chatId: string,
  now: number = Date.now(),
): Promise<Goal | null> {
  return env.DB.prepare(
    `SELECT * FROM goals WHERE chat_id = ? AND status = 'active'
       AND (last_checkin_at IS NULL OR ? - last_checkin_at >= CASE
              WHEN checkin_count <= 0 THEN 0
              WHEN checkin_count = 1 THEN 43200000
              WHEN checkin_count = 2 THEN 86400000
              WHEN checkin_count = 3 THEN 172800000
              ELSE 345600000 END)
      ORDER BY COALESCE(last_checkin_at, 0), COALESCE(last_progress_at, 0), id
      LIMIT 1`,
  )
    .bind(chatId, now)
    .first<Goal>();
}

/**
 * After this many unanswered check-ins, stop quoting the last progress note.
 *
 * "בפעם שעברה שלחת בלי הכנה והיא שמחה ממש" was replayed verbatim on the 11th,
 * the 12th, twice, the 13th and the 14th. Repeating a memory that far past its
 * moment stops reading as "I remember you" and starts reading as a stuck tape.
 */
export const STALE_PROGRESS_AFTER = 3;

export async function markGoalCheckin(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    'UPDATE goals SET last_checkin_at = ?, checkin_count = checkin_count + 1 WHERE id = ?',
  )
    .bind(Date.now(), id)
    .run();
}

export async function recordGoalProgress(env: Env, id: number, note: string): Promise<void> {
  // checkin_count is reset here, and that reset is what makes it mean "how many
  // times running have I asked without getting an answer" rather than "how many
  // times have I ever asked". stalestGoal's cooldown is built on that reading:
  // the moment he engages, the bot's patience is restored in full.
  await env.DB.prepare(
    'UPDATE goals SET last_progress = ?, last_progress_at = ?, checkin_count = 0 WHERE id = ?',
  )
    .bind(note.slice(0, 500), Date.now(), id)
    .run();
}

export async function setGoalStatus(
  env: Env,
  chatId: string,
  id: number,
  status: 'done' | 'dropped',
): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE goals SET status = ? WHERE id = ? AND chat_id = ?')
    .bind(status, id, chatId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function setMuted(env: Env, chatId: string, until: number | null): Promise<void> {
  await env.DB.prepare('UPDATE settings SET muted_until = ? WHERE chat_id = ?')
    .bind(until, chatId)
    .run();
}

export async function setIntensity(env: Env, chatId: string, level: number): Promise<void> {
  const clamped = Math.min(3, Math.max(1, Math.round(level)));
  await env.DB.prepare('UPDATE settings SET intensity = ? WHERE chat_id = ?')
    .bind(clamped, chatId)
    .run();
}

export async function addReminder(
  env: Env,
  r: Omit<Reminder, 'id' | 'created_at' | 'status' | 'active'>,
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO reminders
       (chat_id, title, notes, schedule, tz, requires_proof, proof_type,
        nag_interval_min, max_nags, next_fire_at, status, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, ?)`,
  )
    .bind(
      r.chat_id,
      r.title,
      r.notes,
      r.schedule,
      r.tz,
      r.requires_proof,
      r.proof_type,
      r.nag_interval_min,
      r.max_nags,
      r.next_fire_at,
      Date.now(),
    )
    .run();
  return Number(res.meta.last_row_id);
}

/**
 * Scheduled reminders for this chat whose next_fire_at lands within
 * `windowMs` of `nearAt` — the candidate pool for duplicate detection.
 * A window rather than exact equality: two quick "עוד 5 דקות" double-sends
 * land seconds apart, not at the identical millisecond.
 */
export async function findNearbyReminders(
  env: Env,
  chatId: string,
  nearAt: number,
  windowMs: number,
): Promise<Reminder[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM reminders
      WHERE chat_id = ? AND status = 'scheduled' AND next_fire_at IS NOT NULL
        AND next_fire_at BETWEEN ? AND ?
      ORDER BY id`,
  )
    .bind(chatId, nearAt - windowMs, nearAt + windowMs)
    .all<Reminder>();
  return res.results ?? [];
}

/**
 * Scheduled reminders firing inside [from, to), excluding one id.
 *
 * Used for the same-DAY duplicate check, where the window is far too wide to
 * refuse anything on — "take the pill at 09:00 and again at 21:00" is a
 * perfectly ordinary pair of reminders. It can only ever produce a warning.
 */
export async function remindersSameDay(
  env: Env,
  chatId: string,
  from: number,
  to: number,
  exceptId: number,
): Promise<Reminder[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM reminders
      WHERE chat_id = ? AND status = 'scheduled' AND id != ?
        AND next_fire_at IS NOT NULL AND next_fire_at >= ? AND next_fire_at < ?
      ORDER BY next_fire_at`,
  )
    .bind(chatId, exceptId, from, to)
    .all<Reminder>();
  return res.results ?? [];
}

export async function listReminders(env: Env, chatId: string): Promise<Reminder[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM reminders WHERE chat_id = ? AND status = 'scheduled' ORDER BY next_fire_at IS NULL, next_fire_at",
  )
    .bind(chatId)
    .all<Reminder>();
  return res.results ?? [];
}

/** Scheduled reminders whose next firing falls inside [from, to). */
export async function remindersBetween(
  env: Env,
  chatId: string,
  from: number,
  to: number,
): Promise<Reminder[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM reminders
      WHERE chat_id = ? AND status = 'scheduled'
        AND next_fire_at IS NOT NULL AND next_fire_at >= ? AND next_fire_at < ?
      ORDER BY next_fire_at`,
  )
    .bind(chatId, from, to)
    .all<Reminder>();
  return res.results ?? [];
}

/** How the instances that CLOSED inside [from, to) turned out. */
export async function dayTally(
  env: Env,
  chatId: string,
  from: number,
  to: number,
): Promise<{ done: number; failed: number; skipped: number }> {
  const res = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM instances
      WHERE chat_id = ? AND closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?
      GROUP BY status`,
  )
    .bind(chatId, from, to)
    .all<{ status: string; n: number }>();
  const tally = { done: 0, failed: 0, skipped: 0 };
  for (const row of res.results ?? []) {
    if (row.status === 'done') tally.done = row.n;
    else if (row.status === 'failed') tally.failed = row.n;
    else if (row.status === 'skipped') tally.skipped = row.n;
  }
  return tally;
}

/**
 * Instances the bot gave up on inside [from, to) — nagged the full ladder and
 * never got an answer.
 *
 * These used to be unreachable the moment they were written: `status='failed'`
 * is excluded from openInstances, and every other reader of that status treats
 * it as a number to count. So a task you ignored three times stopped existing,
 * which is the exact failure a nagging bot is supposed to prevent.
 */
export async function droppedBetween(
  env: Env,
  chatId: string,
  from: number,
  to: number,
): Promise<Instance[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM instances
      WHERE chat_id = ? AND status = 'failed'
        AND closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?
      ORDER BY closed_at`,
  )
    .bind(chatId, from, to)
    .all<Instance>();
  return res.results ?? [];
}

/**
 * How many times in a row this reminder has fired without ever being closed as
 * done — counting both the ones nagged into failure and the ones waved off with
 * "לא היום", because from the outside they are the same fact: it isn't happening.
 *
 * Stops at the first 'done'. Open instances are excluded: the one firing right
 * now has not been answered yet and must not count itself.
 */
export async function missStreak(env: Env, reminderId: number): Promise<number> {
  const res = await env.DB.prepare(
    `SELECT status FROM instances
      WHERE reminder_id = ? AND status IN ('done','failed','skipped')
      ORDER BY closed_at DESC LIMIT 20`,
  )
    .bind(reminderId)
    .all<{ status: string }>();
  let n = 0;
  for (const r of res.results ?? []) {
    if (r.status === 'done') break;
    n++;
  }
  return n;
}

/**
 * Record that a once-a-day message went out for local date `day`.
 * Written BEFORE the send in tick(), deliberately: a failed send costs one
 * message, whereas a failed write would repeat that message every minute for
 * the rest of the day.
 */
/** Set (or with nulls, switch off) the two once-a-day messages. */
export async function setDailyHours(
  env: Env,
  chatId: string,
  briefHour: number | null,
  closeoutHour: number | null,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE settings SET brief_hour = ?, closeout_hour = ? WHERE chat_id = ?',
  )
    .bind(briefHour, closeoutHour, chatId)
    .run();
}

export async function markDailySent(
  env: Env,
  chatId: string,
  which: 'brief' | 'closeout',
  day: string,
): Promise<void> {
  const column = which === 'brief' ? 'last_brief_on' : 'last_closeout_on';
  await env.DB.prepare(`UPDATE settings SET ${column} = ? WHERE chat_id = ?`)
    .bind(day, chatId)
    .run();
}

export async function deleteReminder(env: Env, chatId: string, id: number): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE reminders SET status = 'cancelled', active = 0, next_fire_at = NULL WHERE id = ? AND chat_id = ?",
  )
    .bind(id, chatId)
    .run();
  await env.DB.prepare(
    "UPDATE instances SET status = 'skipped', closed_at = ? WHERE reminder_id = ? AND status = 'open'",
  )
    .bind(Date.now(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Reminders whose next_fire_at has arrived. Inbox items are excluded by status. */
/**
 * `chats` is not optional and not a convenience: both this and dueNags carry
 * `LIMIT 25`, so filtering in JS after the fact would let rows belonging to a
 * revoked chat occupy the whole page forever and starve everyone else.
 */
export async function dueReminders(env: Env, now: number, chats: string[]): Promise<Reminder[]> {
  if (!chats.length) return [];
  const res = await env.DB.prepare(
    `SELECT * FROM reminders WHERE status = 'scheduled' AND next_fire_at IS NOT NULL
       AND next_fire_at <= ? AND chat_id IN (${chats.map(() => '?').join(',')}) LIMIT 25`,
  )
    .bind(now, ...chats)
    .all<Reminder>();
  return res.results ?? [];
}

export async function setNextFire(env: Env, id: number, next: number | null): Promise<void> {
  await env.DB.prepare(
    "UPDATE reminders SET next_fire_at = ?, status = ?, active = ? WHERE id = ?",
  )
    .bind(next, next === null ? 'done' : 'scheduled', next === null ? 0 : 1, id)
    .run();
}

export async function createInstance(
  env: Env,
  r: Reminder,
  firedAt: number,
  /**
   * When the first nag is due. Passed in rather than derived from
   * `r.nag_interval_min` because how hard to push is a persona decision, not a
   * storage one — see persona.nagDelayMinutes. The column stays as the
   * per-reminder override for anyone who sets it deliberately.
   */
  nextNagAt: number = firedAt + r.nag_interval_min * 60_000,
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status)
     VALUES (?, ?, ?, ?, ?, 0, 'open')`,
  )
    .bind(r.id, r.chat_id, r.title, firedAt, nextNagAt)
    .run();
  return Number(res.meta.last_row_id);
}

export async function openInstances(env: Env, chatId: string): Promise<Instance[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM instances WHERE chat_id = ? AND status = 'open' ORDER BY fired_at",
  )
    .bind(chatId)
    .all<Instance>();
  return res.results ?? [];
}

/** Open instances whose nag timer has elapsed. */
/** Scoped to `chats` for the same starvation reason as dueReminders. */
export async function dueNags(env: Env, now: number, chats: string[]): Promise<Instance[]> {
  if (!chats.length) return [];
  const res = await env.DB.prepare(
    `SELECT * FROM instances WHERE status = 'open' AND next_nag_at IS NOT NULL
       AND next_nag_at <= ? AND chat_id IN (${chats.map(() => '?').join(',')}) LIMIT 25`,
  )
    .bind(now, ...chats)
    .all<Instance>();
  return res.results ?? [];
}

/** Push a nag later without counting it — used to sit out quiet hours. */
export async function deferNag(env: Env, id: number, nextNagAt: number): Promise<void> {
  await env.DB.prepare('UPDATE instances SET next_nag_at = ? WHERE id = ?')
    .bind(nextNagAt, id)
    .run();
}

export async function bumpNag(env: Env, id: number, nextNagAt: number | null): Promise<void> {
  await env.DB.prepare('UPDATE instances SET nag_count = nag_count + 1, next_nag_at = ? WHERE id = ?')
    .bind(nextNagAt, id)
    .run();
}

export async function closeInstance(
  env: Env,
  id: number,
  status: 'done' | 'failed' | 'skipped',
  proof: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE instances SET status = ?, proof = ?, closed_at = ?, next_nag_at = NULL WHERE id = ?',
  )
    .bind(status, proof, Date.now(), id)
    .run();
}

export async function snoozeInstance(env: Env, id: number, minutes: number): Promise<void> {
  await env.DB.prepare('UPDATE instances SET next_nag_at = ? WHERE id = ?')
    .bind(Date.now() + minutes * 60_000, id)
    .run();
}

/**
 * He is doing it right now. Holds the nag ladder off for a grace window
 * without closing anything.
 *
 * Mechanically this is a snooze; semantically it is the opposite, and that is
 * why it is a separate function with a separate effect. A snooze is "not now";
 * this is "now" — the task stays open precisely because the bot still has to
 * hear how it went. `status = 'open'` in the WHERE clause keeps it from
 * reopening the nag clock on something already closed.
 */
export async function startInstance(env: Env, id: number, minutes: number): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE instances SET next_nag_at = ? WHERE id = ? AND status = 'open'",
  )
    .bind(Date.now() + minutes * 60_000, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function getReminder(env: Env, id: number): Promise<Reminder | null> {
  return env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first<Reminder>();
}

/** Close an open instance. Returns false if it was already closed — the guard
 *  that makes a double-tapped button a no-op rather than a double count. */
export async function closeIfOpen(
  env: Env,
  id: number,
  status: 'done' | 'failed' | 'skipped',
  proof: string | null = null,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE instances SET status = ?, proof = ?, closed_at = ?, next_nag_at = NULL WHERE id = ? AND status = 'open'",
  )
    .bind(status, proof, Date.now(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function getInstance(env: Env, id: number): Promise<Instance | null> {
  return env.DB.prepare('SELECT * FROM instances WHERE id = ?').bind(id).first<Instance>();
}

/** Re-arm a reminder's next fire time. Returns false if the reminder was
 *  cancelled — the guard that stops a stale retime button from un-cancelling
 *  and re-arming a reminder the user deliberately deleted. */
export async function retimeReminder(
  env: Env,
  id: number,
  at: number,
  schedule: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE reminders SET next_fire_at = ?, schedule = ?, status = 'scheduled', active = 1 WHERE id = ? AND status != 'cancelled'",
  )
    .bind(at, schedule, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Change a reminder's wording, leaving its schedule alone. Cancelled reminders
 *  are excluded for the same reason retimeReminder excludes them: renaming one
 *  would resurrect it in every listing that reads by title. */
export async function renameReminder(env: Env, id: number, title: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE reminders SET title = ? WHERE id = ? AND status != 'cancelled'",
  )
    .bind(title, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Max length of a reminder note. Long enough for "בשר ויין מהמשק", short
 *  enough that it can be shown in full on every prompt that lists reminders. */
export const REMINDER_NOTE_MAX = 200;

/**
 * Attach the detail that makes a reminder land — what it is for, what to
 * bring. Replaces rather than appends: a second answer to the same question is
 * a correction, and an accreting note would be unreadable within a week.
 */
export async function annotateReminder(env: Env, id: number, note: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE reminders SET notes = ? WHERE id = ? AND status != 'cancelled'",
  )
    .bind(note.slice(0, REMINDER_NOTE_MAX), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ------------------------------------------------------------------ profile

/** Cap per note and per prompt, so the profile can never crowd out the rest of
 *  the system prompt no matter how much he tells it. */
export const PROFILE_NOTE_MAX = 200;
export const PROFILE_LIMIT = 20;

/**
 * Store a stated fact about him. Returns null when an identical note is
 * already on file — saying the same thing twice must not produce two rows, and
 * more importantly must not produce a confirmation implying something new was
 * learned.
 */
export async function addProfileNote(
  env: Env,
  chatId: string,
  note: string,
): Promise<number | null> {
  const clean = note.trim().slice(0, PROFILE_NOTE_MAX);
  if (!clean) return null;
  const existing = await env.DB.prepare(
    'SELECT id FROM profile WHERE chat_id = ? AND note = ?',
  )
    .bind(chatId, clean)
    .first<{ id: number }>();
  if (existing) return null;
  const res = await env.DB.prepare(
    'INSERT INTO profile (chat_id, note, created_at) VALUES (?, ?, ?)',
  )
    .bind(chatId, clean, Date.now())
    .run();
  return Number(res.meta.last_row_id);
}

/** Newest first — the most recently stated fact is the most likely to be current. */
export async function listProfileNotes(
  env: Env,
  chatId: string,
  limit = PROFILE_LIMIT,
): Promise<{ id: number; note: string }[]> {
  const res = await env.DB.prepare(
    'SELECT id, note FROM profile WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
  )
    .bind(chatId, limit)
    .all<{ id: number; note: string }>();
  return res.results ?? [];
}

export async function deleteProfileNote(
  env: Env,
  chatId: string,
  id: number,
): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM profile WHERE id = ? AND chat_id = ?')
    .bind(id, chatId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function clearProfile(env: Env, chatId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM profile WHERE chat_id = ?').bind(chatId).run();
}

export async function addMessage(
  env: Env,
  chatId: string,
  role: 'user' | 'bot',
  text: string,
): Promise<void> {
  await env.DB.prepare('INSERT INTO messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)')
    .bind(chatId, role, text.slice(0, 4000), Date.now())
    .run();
}

export async function recentMessages(
  env: Env,
  chatId: string,
  limit = 14,
): Promise<{ role: 'user' | 'bot'; text: string }[]> {
  const res = await env.DB.prepare(
    'SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
  )
    .bind(chatId, limit)
    .all<{ role: 'user' | 'bot'; text: string }>();
  return (res.results ?? []).reverse();
}

/** Keep the messages table from growing forever. */
export async function pruneMessages(env: Env, chatId: string, keep = 200): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM messages WHERE chat_id = ? AND id NOT IN
       (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?)`,
  )
    .bind(chatId, chatId, keep)
    .run();
}

export async function stats(env: Env, chatId: string): Promise<Stats> {
  const now = Date.now();
  // Two independent reads of the same table. Awaiting them in sequence cost a
  // round trip on every single message for no reason — neither depends on the
  // other's result.
  const [row, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status='done'   AND closed_at >= ?1 THEN 1 ELSE 0 END) AS done7,
         SUM(CASE WHEN status='failed' AND closed_at >= ?1 THEN 1 ELSE 0 END) AS failed7,
         SUM(CASE WHEN status='done'   AND closed_at >= ?2 THEN 1 ELSE 0 END) AS done30,
         SUM(CASE WHEN status='failed' AND closed_at >= ?2 THEN 1 ELSE 0 END) AS failed30
       FROM instances WHERE chat_id = ?3`,
    )
      .bind(now - 7 * DAY, now - 30 * DAY, chatId)
      .first<{ done7: number; failed7: number; done30: number; failed30: number }>(),
    // Current streak: consecutive closed instances ending in 'done', newest first.
    env.DB.prepare(
      `SELECT status FROM instances
        WHERE chat_id = ? AND status IN ('done','failed')
        ORDER BY closed_at DESC LIMIT 40`,
    )
      .bind(chatId)
      .all<{ status: string }>(),
  ]);

  let streak = 0;
  for (const r of recent.results ?? []) {
    if (r.status === 'done') streak++;
    else break;
  }

  return {
    done7: row?.done7 ?? 0,
    failed7: row?.failed7 ?? 0,
    done30: row?.done30 ?? 0,
    failed30: row?.failed30 ?? 0,
    currentStreak: streak,
  };
}

// -------------------------------------------------------------------- inbox

/** Capture with no time. The whole point: this can never fail for lack of a schedule. */
export async function addInboxItem(
  env: Env,
  chatId: string,
  title: string,
  tz: string,
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO reminders
       (chat_id, title, notes, schedule, tz, requires_proof, proof_type,
        nag_interval_min, max_nags, next_fire_at, status, active, created_at)
     VALUES (?, ?, NULL, '', ?, 0, 'any', 20, 3, NULL, 'inbox', 1, ?)`,
  )
    .bind(chatId, title.slice(0, 200), tz, Date.now())
    .run();
  return Number(res.meta.last_row_id);
}

export async function listInbox(env: Env, chatId: string): Promise<Reminder[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM reminders WHERE chat_id = ? AND status = 'inbox' ORDER BY created_at",
  )
    .bind(chatId)
    .all<Reminder>();
  return res.results ?? [];
}

/** Promote an inbox item to a real scheduled reminder. */
export async function scheduleInboxItem(
  env: Env,
  id: number,
  at: number,
  schedule: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE reminders SET status = 'scheduled', next_fire_at = ?, schedule = ? WHERE id = ? AND status = 'inbox'",
  )
    .bind(at, schedule, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// -------------------------------------------------------------------- usage

/**
 * The day a call is counted against, in HIS calendar.
 *
 * This was `toISOString().slice(0, 10)` — a UTC date — while every other date
 * in the bot is Asia/Jerusalem. "שימוש היום" in /diag therefore rolled over at
 * 03:00 local, so the numbers he read at midnight were for a day that had
 * already ended and the daily soft limit guarded the wrong window.
 *
 * Rows written under the old key simply age out; nothing needs migrating.
 */
const localDay = (env: Env, ts: number) => localDateKey(ts, env.DEFAULT_TZ ?? 'Asia/Jerusalem');

export async function recordUsage(env: Env, model: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (day, model, calls) VALUES (?, ?, 1)
     ON CONFLICT(day, model) DO UPDATE SET calls = calls + 1`,
  )
    .bind(localDay(env, Date.now()), model)
    .run();
}

export async function usageToday(env: Env, model: string): Promise<number> {
  const row = await env.DB.prepare('SELECT calls FROM usage WHERE day = ? AND model = ?')
    .bind(localDay(env, Date.now()), model)
    .first<{ calls: number }>();
  return row?.calls ?? 0;
}

/** Counts validator rejections so /diag can report how often the model lies. */
/**
 * Count one call against the current minute's window and return the new total.
 *
 * Counts ATTEMPTS, not successes — unlike recordUsage, which only fires on a
 * reply that came back with text. A 429 costs the same quota as a 200, so a
 * counter that ignores failures would happily keep hammering a limit it had
 * already blown through.
 *
 * The first call of a new minute prunes every older window: the bucket key puts
 * the minute first precisely so that this is one range delete rather than a
 * scan, and doing it here means no cron job has to remember to.
 */
export async function bumpRateWindow(env: Env, minute: string, model: string): Promise<number> {
  const bucket = `${minute}|${model}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_window (bucket, calls) VALUES (?, 1)
       ON CONFLICT(bucket) DO UPDATE SET calls = calls + 1
       RETURNING calls`,
  )
    .bind(bucket)
    .first<{ calls: number }>();
  const calls = row?.calls ?? 1;
  if (calls === 1) {
    await env.DB.prepare('DELETE FROM rate_window WHERE bucket < ?').bind(`${minute}|`).run();
  }
  return calls;
}

/** Calls already spent in the current minute for `model` — read-only, for /diag. */
export async function rateWindowNow(env: Env, model: string): Promise<number> {
  const minute = new Date().toISOString().slice(0, 16);
  const row = await env.DB.prepare('SELECT calls FROM rate_window WHERE bucket = ?')
    .bind(`${minute}|${model}`)
    .first<{ calls: number }>();
  return row?.calls ?? 0;
}

export interface Rejection {
  at: number;
  reason: string;
  text: string;
  effects: string;
}

/**
 * How many discarded rewrites are kept. Small on purpose: this is a debugging
 * aid you read the tail of, not an archive, and the day it fills fastest is
 * the day the model is misbehaving — the last moment the bot should start
 * spending writes on its own diagnostics.
 */
export const REJECTION_KEEP = 40;

/**
 * Record a rewrite the validator threw away.
 *
 * Best-effort by construction: the caller has already decided to ship the
 * deterministic baseline, so a failure here must cost the user nothing. The
 * `usage` counter is bumped first and separately — it is what /diag has always
 * shown, and it stays correct even if the detail row is the thing that fails.
 */
/**
 * Record that `version` is now the running one, and report whether that was
 * NEWS — i.e. whether this call is the one that should announce the deploy.
 *
 * One statement, so two ticks racing cannot both claim the same deploy: the
 * conditional `DO UPDATE ... WHERE` means only the call that actually changes
 * the row gets a RETURNING row back, and every other call gets nothing.
 *
 * The caller must claim BEFORE it announces. A send that fails after a
 * successful claim costs one missed message; a send that succeeded before the
 * claim was written would re-announce the same deploy every minute until
 * someone noticed.
 */
/**
 * Every chat allowed to use the bot.
 *
 * The owner is ALWAYS in the set, whatever the database says. That is the
 * whole safety property here: a missing row, an empty string, a botched
 * `/deny`, or a table that has not been migrated yet all degrade to exactly
 * the behaviour this bot had before guests existed — owner-only — rather than
 * locking everyone out of their own reminders.
 *
 * Stored as one comma-separated `meta` row rather than a table of its own. It
 * is read on every inbound message, it will hold single digits of entries, and
 * a second table would need its own migration to say the same thing.
 */
export async function allowedChats(env: Env, ownerId = env.OWNER_CHAT_ID): Promise<Set<string>> {
  const allowed = new Set<string>();
  if (ownerId && ownerId !== '0') allowed.add(ownerId);
  try {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'allowed_chats'")
      .first<{ value: string }>();
    for (const id of (row?.value ?? '').split(',')) {
      const trimmed = id.trim();
      if (trimmed) allowed.add(trimmed);
    }
  } catch (err) {
    // Fail closed to owner-only. An unreadable guest list is not a reason to
    // stop answering the person who owns the bot.
    console.error('allowedChats', err);
  }
  return allowed;
}

export interface Pending {
  chat_id: string;
  name: string | null;
  status: 'asked' | 'named' | 'denied';
  created_at: number;
}

/**
 * How many strangers may be waiting at once.
 *
 * This is the only number standing between "the bot answers people it does
 * not know" and "anyone with a script can make it send unbounded messages to
 * the owner". Past the cap the bot goes back to total silence, which is what
 * it did before onboarding existed — degrading to the old, safe behaviour
 * rather than to a new, noisy one.
 */
export const PENDING_MAX = 20;

export async function getPending(env: Env, chatId: string): Promise<Pending | null> {
  return env.DB.prepare('SELECT * FROM pending WHERE chat_id = ?').bind(chatId).first<Pending>();
}

/**
 * Start the conversation with a stranger. Returns false when the queue is
 * full, which the caller must treat as "say nothing at all".
 */
export async function addPending(env: Env, chatId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM pending').first<{ n: number }>();
  if ((row?.n ?? 0) >= PENDING_MAX) return false;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO pending (chat_id, status, created_at) VALUES (?, 'asked', ?)",
  )
    .bind(chatId, Date.now())
    .run();
  return true;
}

/** They answered. `status='asked'` in the WHERE is what makes this once-only. */
export async function namePending(env: Env, chatId: string, name: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE pending SET name = ?, status = 'named' WHERE chat_id = ? AND status = 'asked'",
  )
    .bind(name.slice(0, 60), chatId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Everyone still waiting on a decision, oldest first. Denied rows are not waiting. */
export async function listPending(env: Env): Promise<Pending[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM pending WHERE status != 'denied' ORDER BY created_at",
  ).all<Pending>();
  return res.results ?? [];
}

/**
 * Find who the owner meant, by name or by chat_id.
 *
 * Returns null when nothing matches AND when more than one does — an
 * ambiguous "/allow דנה" with two Danas must ask, not guess, because guessing
 * hands someone access meant for another person.
 */
export async function findPending(env: Env, needle: string): Promise<Pending[]> {
  const want = needle.trim().toLowerCase();
  const rows = await listPending(env);
  return rows.filter(
    (p) => p.chat_id === want || (p.name ?? '').trim().toLowerCase() === want,
  );
}

/**
 * Refuse someone, permanently. The row is kept rather than deleted: a deleted
 * row makes their next message look like a brand-new stranger, and the owner
 * gets asked about the same person forever.
 */
export async function denyPending(env: Env, chatId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO pending (chat_id, status, created_at) VALUES (?, 'denied', ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET status = 'denied'",
  )
    .bind(chatId, Date.now())
    .run();
}

/** They are in; they are not waiting for anything any more. */
export async function clearPending(env: Env, chatId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM pending WHERE chat_id = ?').bind(chatId).run();
}

/** Replace the guest list. The owner is implicit and need not be included. */
export async function setAllowedChats(env: Env, ids: string[]): Promise<void> {
  const value = [...new Set(ids.map((s) => s.trim()).filter(Boolean))].join(',');
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('allowed_chats', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
  )
    .bind(value, value)
    .run();
}

export async function claimVersion(env: Env, version: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = ? WHERE meta.value <> ?
       RETURNING value`,
  )
    .bind(version, version, version)
    .first<{ value: string }>();
  return row !== null;
}

export async function recordRejection(
  env: Env,
  chatId: string,
  reason: string,
  text: string,
  effects: string,
): Promise<void> {
  await recordUsage(env, '_rejections');
  await env.DB.prepare(
    'INSERT INTO rejections (chat_id, at, reason, text, effects) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(chatId, Date.now(), reason.slice(0, 300), text.slice(0, 1000), effects.slice(0, 200))
    .run();
  // Pruned here rather than on a schedule, for the same reason rate_window is:
  // no cron job has to remember to, and the cost lands on the path that caused
  // the growth.
  await env.DB.prepare(
    `DELETE FROM rejections WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM rejections WHERE chat_id = ? ORDER BY id DESC LIMIT ?
     )`,
  )
    .bind(chatId, chatId, REJECTION_KEEP)
    .run();
}

/** The most recent discarded rewrites, newest first. */
export async function recentRejections(
  env: Env,
  chatId: string,
  limit = 3,
): Promise<Rejection[]> {
  const res = await env.DB.prepare(
    'SELECT at, reason, text, effects FROM rejections WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
  )
    .bind(chatId, limit)
    .all<Rejection>();
  return res.results ?? [];
}

// ------------------------------------------------------- events and errors

/**
 * How many rows each of the two logs keeps, per chat.
 *
 * Pruned on write for the reason migration 006 gives about `rejections`: the
 * day a log fills fastest is the day the bot is already misbehaving, and that
 * is the worst possible moment for a cron job to be the only thing standing
 * between a table and unbounded growth.
 */
export const EVENT_KEEP = 400;
export const ERROR_KEEP = 30;

export interface Event {
  at: number;
  kind: string;
  detail: string | null;
  reminder_id: number | null;
  instance_id: number | null;
}

export interface BotError {
  at: number;
  stage: string;
  message: string;
  user_text: string | null;
}

/**
 * Which effects earn a row in a reminder's history, and what to call it there.
 *
 * Deliberately NOT every effect kind. `listed_reminders` is the bot answering a
 * question, not something that happened to a reminder, and a history padded
 * with reads is a history nobody scrolls. The test for inclusion is whether the
 * line would help answer "why did this not fire" three days later.
 */
const EVENT_OF: Record<string, string> = {
  reminder_created: 'נקבעה',
  reminder_captured: 'נתפסה בלי שעה',
  reminder_scheduled: 'קיבלה שעה',
  reminder_retimed: 'הוזזה',
  reminder_renamed: 'שונה השם',
  reminder_deleted: 'בוטלה',
  reminder_annotated: 'נוספה הערה',
  // 'came due', not 'was sent'. A fired reminder whose send then failed must
  // not leave a row claiming it reached him — that is the project's whole rule,
  // and the delivery failure is recorded separately right beside it.
  reminder_fired: 'צלצלה',
  nagged: 'נדנוד',
  instance_done: 'נסגרה',
  instance_skipped: 'דילג',
  instance_snoozed: 'נדחתה',
  instance_started: 'בדרך',
  gave_up: 'ויתרתי',
  photo_accepted: 'תמונה התקבלה',
};

/**
 * Effects whose `id` is an INSTANCE id, not a reminder id.
 *
 * This distinction is the whole correctness of /why. `reminder_fired` carries
 * the reminder in `id` and the instance in `instanceId`; `instance_done`
 * carries the instance in `id` and no reminder at all. Storing one as the other
 * makes /why silently empty, which is the one failure a debugging command must
 * not have — it would look exactly like "nothing ever happened to this".
 */
const ID_IS_INSTANCE = new Set([
  'instance_done', 'instance_skipped', 'instance_snoozed', 'instance_started',
]);
/** Effects that name only an instance, via `instanceId`. */
const INSTANCE_ONLY = new Set(['nagged', 'gave_up', 'photo_accepted']);

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Write the history rows for one turn's effects.
 *
 * Called from sendOutcome, the single point EVERY path converges on — webhook,
 * button tap and cron alike — and which runs after the writes have committed.
 * Recording at each write site instead would be five call sites that can drift,
 * and would still miss the button path entirely.
 *
 * Best-effort by contract: the caller must never let a logging failure become a
 * failure to answer him. A history with a hole in it is a bad afternoon; a
 * reminder that did not send because its history row failed is the exact bug
 * this project exists to prevent.
 */
export async function recordEvents(
  env: Env,
  chatId: string,
  effects: { kind: string; [k: string]: unknown }[],
  at: number = Date.now(),
): Promise<void> {
  const rows = effects.filter((e) => EVENT_OF[e.kind]);
  if (!rows.length) return;

  for (const e of rows) {
    let reminderId: number | null = null;
    let instanceId: number | null = null;
    if (ID_IS_INSTANCE.has(e.kind)) {
      instanceId = numOrNull(e.id);
    } else if (INSTANCE_ONLY.has(e.kind)) {
      instanceId = numOrNull(e.instanceId);
    } else {
      reminderId = numOrNull(e.id);
      instanceId = numOrNull(e.instanceId);
    }
    // An instance-only event still belongs to a reminder's story, and /why
    // reads by reminder. One extra read here is what keeps "נסגרה" from
    // vanishing out of the history of the very reminder it closed.
    if (reminderId === null && instanceId !== null) {
      reminderId = (await getInstance(env, instanceId))?.reminder_id ?? null;
    }

    await env.DB.prepare(
      `INSERT INTO events (chat_id, reminder_id, instance_id, at, kind, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        chatId,
        reminderId,
        instanceId,
        at,
        EVENT_OF[e.kind],
        typeof e.title === 'string' ? e.title.slice(0, 120) : null,
      )
      .run();
  }

  await env.DB.prepare(
    `DELETE FROM events WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM events WHERE chat_id = ? ORDER BY id DESC LIMIT ?
     )`,
  )
    .bind(chatId, chatId, EVENT_KEEP)
    .run();
}

/**
 * A fired reminder that never reached him.
 *
 * No effect produces this — it is the absence of a successful send — so it is
 * recorded by hand. It is also the original bug of this whole project ("marked
 * delivered, never received"), and until now the only trace it left anywhere
 * was a console.log into a log that is not enabled.
 */
export async function recordDeliveryFailure(
  env: Env,
  chatId: string,
  reminderIds: (number | null | undefined)[],
  at: number = Date.now(),
): Promise<void> {
  for (const id of reminderIds) {
    await env.DB.prepare(
      `INSERT INTO events (chat_id, reminder_id, instance_id, at, kind, detail)
       VALUES (?, ?, NULL, ?, 'לא נמסרה', NULL)`,
    )
      .bind(chatId, numOrNull(id), at)
      .run();
  }
}

/** Everything that ever happened to one reminder, oldest first — /why reads this. */
export async function eventsFor(env: Env, reminderId: number): Promise<Event[]> {
  const res = await env.DB.prepare(
    `SELECT at, kind, detail, reminder_id, instance_id FROM events
      WHERE reminder_id = ? ORDER BY id LIMIT 40`,
  )
    .bind(reminderId)
    .all<Event>();
  return res.results ?? [];
}

/** How many of each kind happened in a window — /diag's cron block reads this. */
export async function eventCounts(
  env: Env,
  chatId: string,
  from: number,
  to: number,
): Promise<Record<string, number>> {
  const res = await env.DB.prepare(
    'SELECT kind, COUNT(*) AS n FROM events WHERE chat_id = ? AND at >= ? AND at < ? GROUP BY kind',
  )
    .bind(chatId, from, to)
    .all<{ kind: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.kind] = r.n;
  return out;
}

/**
 * Record that a throw happened, and where.
 *
 * `stage` is the catch site as a short tag. Which stage failed is the first
 * question asked of any failure, and before this table nothing could answer it:
 * the only record was a console.error into a log nobody was tailing, so by the
 * time anyone looked the answer was gone.
 */
export async function recordError(
  env: Env,
  chatId: string,
  stage: string,
  err: unknown,
  userText?: string,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO errors (chat_id, at, stage, message, user_text) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      chatId,
      Date.now(),
      stage.slice(0, 40),
      String(err instanceof Error ? err.message : err).slice(0, 500),
      userText ? userText.slice(0, 200) : null,
    )
    .run();
  await env.DB.prepare(
    `DELETE FROM errors WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM errors WHERE chat_id = ? ORDER BY id DESC LIMIT ?
     )`,
  )
    .bind(chatId, chatId, ERROR_KEEP)
    .run();
}

/** The most recent failures, newest first. */
export async function recentErrors(env: Env, chatId: string, limit = 5): Promise<BotError[]> {
  const res = await env.DB.prepare(
    'SELECT at, stage, message, user_text FROM errors WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
  )
    .bind(chatId, limit)
    .all<BotError>();
  return res.results ?? [];
}

/** When the cron last ran, as epoch ms, or null if it never has. */
export async function lastTick(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_tick'").first<{
    value: string;
  }>();
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stamp that the cron ran.
 *
 * Written at the START of a tick, not the end. The question /diag has to answer
 * is "is the scheduler alive at all", and a tick that began and then died is a
 * completely different diagnosis from one that never began — recording only
 * ticks that finished would report both as the same silence.
 */
export async function markTick(env: Env, at: number = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_tick', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(String(at))
    .run();
}

// ------------------------------------------------------- the open question

/**
 * How long a question the bot asked stays answerable.
 *
 * Long enough to walk away from the phone and come back; short enough that a
 * bare "15:00" typed hours later, about something else entirely, is not
 * silently applied to whatever was last asked about. That second failure is
 * worse than the first: an unanswered question costs one more exchange, a
 * mis-applied answer moves a reminder he never touched.
 */
export const AWAITING_TTL_MS = 30 * 60_000;

/**
 * The one question outstanding for a chat, if it is still fresh.
 *
 * Keys are one letter because this is JSON in a column read on every message.
 *   time  — "מתי?" was asked about reminder `r`.
 *   offer — "לשים לך תזכורת?" was asked about a thing he MENTIONED: title `t`
 *           at instant `w`. Nothing is written until he taps, which is the
 *           whole point — see the appointment_offer effect.
 */
export type Awaiting =
  | { k: 'time'; r: number; at: number }
  | { k: 'offer'; t: string; w: number; at: number };

export async function setAwaiting(
  env: Env,
  chatId: string,
  awaiting: Awaiting | null,
): Promise<void> {
  await env.DB.prepare('UPDATE settings SET awaiting = ? WHERE chat_id = ?')
    .bind(awaiting ? JSON.stringify(awaiting) : null, chatId)
    .run();
}

/**
 * The outstanding question, or null.
 *
 * Expiry is enforced on READ rather than by a sweep, so a slot that goes stale
 * while nothing is happening simply stops existing — there is no window in
 * which a cron job has not got round to clearing it yet.
 */
export function readAwaiting(raw: string | null, now: number = Date.now()): Awaiting | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Awaiting;
    if (!a || !Number.isFinite(a.at) || now - a.at > AWAITING_TTL_MS) return null;
    if (a.k === 'time') return Number.isInteger(a.r) ? a : null;
    if (a.k === 'offer') {
      return typeof a.t === 'string' && a.t.length > 0 && Number.isFinite(a.w) ? a : null;
    }
    return null;
  } catch {
    // A row written by a future version, or corrupted. Forgetting it is always
    // safe; acting on half of it is not.
    return null;
  }
}

// ------------------------------------------------------------------- items

/**
 * More than this in one reminder is a misparse, not a checklist. Six errands
 * in one sentence is already unusual; sixty is a comma-separated paragraph
 * that happened to contain the word "תזכיר".
 */
export const MAX_ITEMS = 6;

export async function addItems(
  env: Env,
  reminderId: number,
  chatId: string,
  titles: string[],
): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < titles.length; i++) {
    await env.DB.prepare(
      `INSERT INTO reminder_items (reminder_id, chat_id, title, position, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(reminderId, chatId, titles[i].slice(0, 120), i, now)
      .run();
  }
}

export async function listItems(env: Env, reminderId: number): Promise<ReminderItem[]> {
  const res = await env.DB.prepare(
    'SELECT * FROM reminder_items WHERE reminder_id = ? ORDER BY position',
  )
    .bind(reminderId)
    .all<ReminderItem>();
  return res.results ?? [];
}

/** Every item on every reminder in `ids`, so a list of reminders costs one query. */
export async function itemsForReminders(
  env: Env,
  ids: number[],
): Promise<Map<number, ReminderItem[]>> {
  const out = new Map<number, ReminderItem[]>();
  if (!ids.length) return out;
  const res = await env.DB.prepare(
    `SELECT * FROM reminder_items WHERE reminder_id IN (${ids.map(() => '?').join(',')})
      ORDER BY reminder_id, position`,
  )
    .bind(...ids)
    .all<ReminderItem>();
  for (const row of res.results ?? []) {
    const list = out.get(row.reminder_id) ?? [];
    list.push(row);
    out.set(row.reminder_id, list);
  }
  return out;
}

export async function getItem(env: Env, id: number): Promise<ReminderItem | null> {
  return env.DB.prepare('SELECT * FROM reminder_items WHERE id = ?').bind(id).first<ReminderItem>();
}

/**
 * Tick one item off. Returns false when it was already done, so a double tap
 * cannot report the same errand twice — same contract as closeIfOpen.
 */
export async function completeItem(env: Env, id: number, at: number = Date.now()): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE reminder_items SET done_at = ? WHERE id = ? AND done_at IS NULL',
  )
    .bind(at, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** How many items are still open on a reminder. Zero means the task is finished. */
export async function openItemCount(env: Env, reminderId: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM reminder_items WHERE reminder_id = ? AND done_at IS NULL',
  )
    .bind(reminderId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Clear every tick when the reminder comes round again.
 *
 * Items live on the reminder rather than on the instance (see migrations/011),
 * so this is what makes a daily three-errand reminder work on the second day.
 * Called from the tick right after the instance is created, which is also why
 * it must be cheap and must not throw the tick — a stale tick costs a wrong ☑
 * in one message, and a thrown tick costs everyone their reminders.
 */
export async function resetItems(env: Env, reminderId: number): Promise<void> {
  await env.DB.prepare(
    'UPDATE reminder_items SET done_at = NULL WHERE reminder_id = ? AND done_at IS NOT NULL',
  )
    .bind(reminderId)
    .run();
}
