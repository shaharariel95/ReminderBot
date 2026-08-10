import type { Env, Goal, Instance, Reminder, Settings, Stats } from './types';

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
export async function stalestGoal(env: Env, chatId: string): Promise<Goal | null> {
  return env.DB.prepare(
    `SELECT * FROM goals WHERE chat_id = ? AND status = 'active'
      ORDER BY COALESCE(last_checkin_at, 0), COALESCE(last_progress_at, 0), id
      LIMIT 1`,
  )
    .bind(chatId)
    .first<Goal>();
}

export async function markGoalCheckin(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    'UPDATE goals SET last_checkin_at = ?, checkin_count = checkin_count + 1 WHERE id = ?',
  )
    .bind(Date.now(), id)
    .run();
}

export async function recordGoalProgress(env: Env, id: number, note: string): Promise<void> {
  await env.DB.prepare('UPDATE goals SET last_progress = ?, last_progress_at = ? WHERE id = ?')
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
export async function dueReminders(env: Env, now: number): Promise<Reminder[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM reminders WHERE status = 'scheduled' AND next_fire_at IS NOT NULL AND next_fire_at <= ? LIMIT 25",
  )
    .bind(now)
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
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status)
     VALUES (?, ?, ?, ?, ?, 0, 'open')`,
  )
    .bind(r.id, r.chat_id, r.title, firedAt, firedAt + r.nag_interval_min * 60_000)
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
export async function dueNags(env: Env, now: number): Promise<Instance[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM instances WHERE status = 'open' AND next_nag_at IS NOT NULL AND next_nag_at <= ? LIMIT 25",
  )
    .bind(now)
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

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export async function recordUsage(env: Env, model: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (day, model, calls) VALUES (?, ?, 1)
     ON CONFLICT(day, model) DO UPDATE SET calls = calls + 1`,
  )
    .bind(utcDay(Date.now()), model)
    .run();
}

export async function usageToday(env: Env, model: string): Promise<number> {
  const row = await env.DB.prepare('SELECT calls FROM usage WHERE day = ? AND model = ?')
    .bind(utcDay(Date.now()), model)
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
