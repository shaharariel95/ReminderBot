import type { Env, Goal, Instance, Reminder, ReminderItem, Settings, Stats } from './types';
import { localDateKey, wallParts } from './time';

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
      // undefined on a database that has not run migrations/016. `?? null`
      // degrades to "address nobody by name", which is the safe direction —
      // the unsafe one is the owner's name in a stranger's chat, which is the
      // bug the column exists for.
      display_name: row.display_name ?? null,
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
    display_name: null,
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

/**
 * Remember what Telegram calls whoever is in this chat.
 *
 * Called only when the name has actually CHANGED, so an ordinary message costs
 * no write — the caller compares against the settings row it already loaded.
 * Refreshing on change rather than writing once matters: a rename in Telegram
 * should reach the prompt without anybody running a command, and the whole
 * point of the column is that the bot addresses the person who is there.
 *
 * Best-effort by contract. Failing to learn a name must never cost a turn; the
 * prompt simply addresses nobody, which is what it does for a chat nobody has
 * spoken in yet.
 */
export async function setDisplayName(env: Env, chatId: string, name: string): Promise<void> {
  // An upsert rather than a bare UPDATE. Today's only caller runs after
  // buildContext, so the row is always there — but a plain UPDATE against a
  // missing row succeeds while changing nothing, and a name that silently
  // fails to stick is the same class of bug as the one this column fixes.
  await env.DB.prepare(
    `INSERT INTO settings (chat_id, tz, display_name) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET display_name = excluded.display_name`,
  )
    .bind(chatId, env.DEFAULT_TZ ?? 'Asia/Jerusalem', name.slice(0, 60))
    .run();
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
  /**
   * `from_chat_id` is optional rather than required so that every existing
   * caller keeps meaning what it always meant: a reminder he set for himself.
   * Only the cross-chat path passes it, and it is the only path that may.
   */
  r: Omit<Reminder, 'id' | 'created_at' | 'status' | 'active' | 'from_chat_id'> & {
    from_chat_id?: string | null;
  },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO reminders
       (chat_id, title, notes, schedule, tz, requires_proof, proof_type,
        nag_interval_min, max_nags, next_fire_at, event_at, from_chat_id, status, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, ?)`,
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
      r.event_at ?? null,
      r.from_chat_id ?? null,
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
/**
 * When he last SAID something, or null if never.
 *
 * Read only on the path that is about to nag, which is rare — an ordinary
 * tick with nothing due never pays for it. Deliberately `role='user'`: the
 * bot's own messages are not evidence that he is present, and counting them
 * would mean a nag defers itself forever by existing.
 */
export async function lastInboundAt(env: Env, chatId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT created_at FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
  )
    .bind(chatId)
    .first<{ created_at: number }>();
  return row?.created_at ?? null;
}

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

/**
 * The chat a call could not be attributed to.
 *
 * Only two things land here: rows written before migration 012, and the bot's
 * own housekeeping. Deliberately a value no real chat_id can take, so
 * "unattributed" is never confusable with somebody's actual usage.
 */
export const UNATTRIBUTED = '-';

/**
 * The bot's own bookkeeping, parked in the `usage` table because it is a
 * per-day-per-chat counter and that is exactly what this table is.
 *
 * Named here rather than spelled inline in three places: it has to be
 * EXCLUDED from any sum over models (usageTodayAll), and a counter of the
 * times the validator caught the model lying is not a model call. Charging
 * him for those would be billing him for a bug.
 */
export const REJECTION_COUNTER = '_rejections';

export async function recordUsage(
  env: Env,
  model: string,
  chatId: string = UNATTRIBUTED,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (day, model, chat_id, calls) VALUES (?, ?, ?, 1)
     ON CONFLICT(day, model, chat_id) DO UPDATE SET calls = calls + 1`,
  )
    .bind(localDay(env, Date.now()), model, chatId)
    .run();
}

/**
 * Every call against `model` today, whoever made it.
 *
 * Still a total, even though the table is now per-chat: there is one API key
 * and one shared quota, and this is the number that protects it.
 */
export async function usageToday(env: Env, model: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT SUM(calls) AS calls FROM usage WHERE day = ? AND model = ?',
  )
    .bind(localDay(env, Date.now()), model)
    .first<{ calls: number | null }>();
  return Number(row?.calls ?? 0);
}

/**
 * One chat's share of today.
 *
 * This is the number /diag should show him, because it is the only one that
 * reconciles with the per-chat rejection list printed underneath it — and it
 * is what his check-in budget is measured against, so a guest burning the
 * day's calls cannot silently switch off the owner's.
 */
export async function usageTodayFor(env: Env, model: string, chatId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT calls FROM usage WHERE day = ? AND model = ? AND chat_id = ?',
  )
    .bind(localDay(env, Date.now()), model, chatId)
    .first<{ calls: number }>();
  return Number(row?.calls ?? 0);
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

/**
 * Hand back a slot `bumpRateWindow` reserved for a call that never happened.
 *
 * The bump has to come first — it is the atomic reservation, and reading then
 * writing would let two concurrent turns both believe they had the last slot.
 * But a reservation nobody uses is a leak, and it was leaking into the ONE
 * budget that matters: a decorative call refused at the 70% ceiling still
 * counted against the full limit that routing is measured against.
 *
 * Floored at zero. A release without a matching bump should not be able to
 * hand the minute free capacity it never had.
 */
export async function releaseRateWindow(env: Env, minute: string, model: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE rate_window SET calls = MAX(0, calls - 1) WHERE bucket = ?',
  )
    .bind(`${minute}|${model}`)
    .run();
}

/** Calls already spent in the current minute for `model` — read-only, for /diag. */
export async function rateWindowNow(env: Env, model: string): Promise<number> {
  // Date.now(), not `new Date()`. They agree in production, but only the
  // former is the clock gemini.minuteBucket uses to WRITE these rows — and
  // `new Date()` reads the system clock directly, so a test that pins the
  // time could never observe its own bookkeeping. A counter nothing can
  // measure is a counter nothing can prove.
  const minute = new Date(Date.now()).toISOString().slice(0, 16);
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
  // Attributed to the chat whose rewrite was discarded. Before migration 012
  // this was a global counter sitting directly above a per-chat listing, so
  // /diag once showed the owner "1" with nothing underneath it — the rejection
  // was a guest's, and there was no way for him to work that out.
  await recordUsage(env, REJECTION_COUNTER, chatId);
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
  // Not a write he made — a question the bot asked about a reminder that is
  // not working. Recorded so the offer has a COOLDOWN: without a row saying it
  // was already raised, every subsequent snooze past the threshold would ask
  // the same question again, which is nagging about the nagging.
  pattern_offered: 'הצעתי שינוי',
  // Both raise the same question, and the cooldown is per REMINDER rather than
  // per pattern kind: he does not want the other version of "this is not
  // working" a day after declining the first.
  pattern_pushed: 'הצעתי שינוי',
  pattern_failing: 'הצעתי שינוי',
};

/**
 * The behavioural record for one reminder, counted off `events`.
 *
 * Reads the same table `/why` prints, and it is the first thing in this
 * codebase to ask a QUESTION of that history rather than display it. Scoped by
 * chat_id as well as reminder_id: `events` is a shared table and a count is
 * still a leak if it crosses accounts.
 */
export async function behaviourOf(
  env: Env,
  chatId: string,
  reminderId: number,
  tz: string,
  sinceMs: number,
): Promise<import('./patterns').Behaviour> {
  const res = await env.DB.prepare(
    `SELECT kind, at FROM events
      WHERE chat_id = ? AND reminder_id = ? AND at >= ?
      ORDER BY id DESC LIMIT 200`,
  )
    .bind(chatId, reminderId, sinceMs)
    .all<{ kind: string; at: number }>();

  const rows = res.results ?? [];
  const b = { fires: 0, snoozes: 0, dones: 0, failures: 0, doneHours: [] as number[] };
  for (const r of rows) {
    if (r.kind === EVENT_OF.reminder_fired) b.fires++;
    else if (r.kind === EVENT_OF.instance_snoozed) b.snoozes++;
    else if (r.kind === EVENT_OF.gave_up) b.failures++;
    else if (r.kind === EVENT_OF.instance_done) {
      b.dones++;
      // The LOCAL hour, because the question is "when in his day", and a
      // reminder can live in a timezone that is not the chat's.
      b.doneHours.push(wallParts(r.at, tz).hour);
    }
  }
  return b;
}

/** Has this reminder's pattern already been raised inside the window? */
export async function patternOfferedSince(
  env: Env,
  chatId: string,
  reminderId: number,
  sinceMs: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS hit FROM events WHERE chat_id = ? AND reminder_id = ? AND kind = ? AND at >= ? LIMIT 1',
  )
    .bind(chatId, reminderId, EVENT_OF.pattern_offered, sinceMs)
    .first<{ hit: number }>();
  return !!row;
}

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
  | { k: 'offer'; t: string; w: number; at: number }
  /**
   * title — "על מה להזכיר?" was asked about reminder `r`, which exists and has
   * an hour but no subject. His answer is a RENAME of that row, not a new
   * reminder. voice.ts has asked this since untitled creates were allowed and
   * nothing registered it, so on 16.08.2026 "על זה" reached the router with
   * nothing to bind to and came back "אין לי משימה פתוחה שמתאימה לזה".
   */
  | { k: 'title'; r: number; at: number };

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
    // Exhaustive on purpose. This used to be a chain of `if`s ending in a bare
    // `return null`, which meant a NEW arm added to the union compiled
    // silently, was written by setAwaiting, and read back as null forever —
    // the bot asking a question and forgetting it the same instant, which is
    // the exact bug the awaiting slot exists to prevent. The `never` binding
    // below turns adding an arm without a validator into a compile error.
    switch (a.k) {
      case 'time':
        return Number.isInteger(a.r) ? a : null;
      case 'offer':
        return typeof a.t === 'string' && a.t.length > 0 && Number.isFinite(a.w) ? a : null;
      case 'title':
        return Number.isInteger(a.r) ? a : null;
      default: {
        const _never: never = a;
        return _never ?? null;
      }
    }
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

// ------------------------------------------------------------------ friends

/**
 * How many friends one chat may hold, and how long a nickname may be.
 *
 * The cap is not about storage. Every accepted friend is somebody who can
 * write a row into your chat and make your phone buzz at 07:00, so the number
 * of people who can do that has to be a number you could name from memory.
 */
export const FRIEND_MAX = 20;
export const NICKNAME_MAX = 40;

export interface Friend {
  chat_id: string;
  friend_chat_id: string;
  nickname: string;
  status: 'pending' | 'accepted' | 'declined';
  /** The requester's Telegram name, captured when he asked. See acceptFriend. */
  requester_name: string | null;
  requested_by: string;
  created_at: number;
}

/** One directed edge: what `chatId` calls `friendChatId`, and where it stands. */
export async function friendEdge(
  env: Env,
  chatId: string,
  friendChatId: string,
): Promise<Friend | null> {
  return env.DB.prepare('SELECT * FROM friends WHERE chat_id = ? AND friend_chat_id = ?')
    .bind(chatId, friendChatId)
    .first<Friend>();
}

/**
 * Everyone who can already set a reminder in this chat, and everyone this chat
 * can set one for. Accepted only — a pending row is a question, not consent,
 * and this is the list every cross-chat WRITE is checked against.
 */
export async function friendsOf(env: Env, chatId: string): Promise<Friend[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM friends WHERE chat_id = ? AND status = 'accepted' ORDER BY nickname",
  )
    .bind(chatId)
    .all<Friend>();
  return res.results ?? [];
}

/** His whole address book, pending rows included — what /friends prints. */
export async function friendBook(env: Env, chatId: string): Promise<Friend[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM friends WHERE chat_id = ? AND status != 'declined' ORDER BY status, nickname",
  )
    .bind(chatId)
    .all<Friend>();
  return res.results ?? [];
}

/**
 * Requests aimed AT this chat and still unanswered.
 *
 * Read off the requester's edge, because while a request is pending that is
 * the only row there is — the reverse edge is written at acceptance, which is
 * what makes "pending" and "consented" impossible to confuse.
 */
export async function incomingFriendRequests(env: Env, chatId: string): Promise<Friend[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM friends WHERE friend_chat_id = ? AND status = 'pending' ORDER BY created_at",
  )
    .bind(chatId)
    .all<Friend>();
  return res.results ?? [];
}

/** What `chatId` calls `friendChatId`, or null when they are nobody to him. */
export async function friendName(
  env: Env,
  chatId: string,
  friendChatId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT nickname FROM friends WHERE chat_id = ? AND friend_chat_id = ? AND status = 'accepted'",
  )
    .bind(chatId, friendChatId)
    .first<{ nickname: string }>();
  return row?.nickname ?? null;
}

/** Which friend `needle` names, by nickname. Null on no match AND on a tie. */
export function matchFriend(friends: Friend[], needle: string): Friend | null {
  const want = needle.trim().toLowerCase();
  if (!want) return null;
  const exact = friends.filter((f) => f.nickname.trim().toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  // A tie is deliberately not broken. Sending "לקנות חלב ב-7" to the wrong
  // person is not a wrong guess about wording — it is a message in someone
  // else's chat, and there is no version of that the bot gets to invent.
  const loose = friends.filter((f) => f.nickname.trim().toLowerCase().includes(want));
  return loose.length === 1 ? loose[0] : null;
}

export type FriendAsk =
  /** The request was written and the other side has been asked. */
  | { ok: true; kind: 'asked' }
  /** They had already asked him, so saying it back is the answer to it. */
  | { ok: true; kind: 'accepted' }
  /** Same pair, still pending — the nickname was updated, nothing else. */
  | { ok: true; kind: 'again' }
  | { ok: false; kind: 'self' | 'already' | 'declined' | 'full' };

/**
 * Ask someone to be a friend, under the name you will call them by.
 *
 * Nothing about this grants anything: the row lands as `pending` and stays
 * that way until they tap yes. The caller must separately have checked that
 * the target is a chat the bot may talk to at all — this function is about
 * consent between two users, not about who is allowed to use the bot.
 *
 * The `accepted` branch is the one worth reading twice. If they asked first
 * and he answers by asking back, that IS a yes — and a better one than the
 * button, because it arrives with his own name for them instead of the one
 * derived at acceptance. Refusing it as a duplicate would leave two people
 * who have each said yes waiting on each other.
 */
export async function requestFriend(
  env: Env,
  chatId: string,
  targetId: string,
  nickname: string,
  /**
   * What Telegram calls the person asking. Stored rather than used here: it is
   * the name the OTHER side will get for him if she says yes, and the accept
   * arrives as a tap in her chat, which carries her name and not his.
   */
  senderName?: string,
  now: number = Date.now(),
): Promise<FriendAsk> {
  if (!targetId || targetId === chatId) return { ok: false, kind: 'self' };
  const name = nickname.trim().slice(0, NICKNAME_MAX);

  const mine = await friendEdge(env, chatId, targetId);
  if (mine?.status === 'accepted') return { ok: false, kind: 'already' };
  // Their refusal, remembered. Re-asking is exactly the nagging this prevents
  // — the same rule a denied stranger gets in `pending`.
  if (mine?.status === 'declined') return { ok: false, kind: 'declined' };

  const theirs = await friendEdge(env, targetId, chatId);
  if (theirs?.status === 'pending' && theirs.requested_by === targetId) {
    // His own name for her wins over the one acceptance would have derived —
    // he just typed it.
    await acceptFriend(env, chatId, targetId, name, now);
    return { ok: true, kind: 'accepted' };
  }

  if (!mine) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM friends WHERE chat_id = ?')
      .bind(chatId)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= FRIEND_MAX) return { ok: false, kind: 'full' };
  }

  await env.DB.prepare(
    `INSERT INTO friends
       (chat_id, friend_chat_id, nickname, status, requester_name, requested_by, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT(chat_id, friend_chat_id) DO UPDATE SET
         nickname = excluded.nickname,
         requester_name = excluded.requester_name`,
  )
    .bind(chatId, targetId, name, senderName?.trim().slice(0, NICKNAME_MAX) ?? null, chatId, now)
    .run();
  return { ok: true, kind: mine ? 'again' : 'asked' };
}

/**
 * They said yes.
 *
 * `requesterId` is who asked; `chatId` is who is answering. The `status =
 * 'pending'` clause in the UPDATE is what makes this once-only: a second tap
 * on the same message changes nothing and returns false, so the requester
 * cannot be told twice that he was accepted.
 *
 * BOTH edges are written. A friendship is mutual by construction — he asked
 * for one and she agreed to it — and a single edge would deliver her reminder
 * into his chat from a chat_id he has no name for. Her name for him is
 * derived rather than asked (`theirName`, normally his Telegram first name),
 * because a second question at the moment of saying yes is a question most
 * people simply abandon. She can rename him with /friend whenever she likes.
 */
export async function acceptFriend(
  env: Env,
  chatId: string,
  requesterId: string,
  /**
   * Her name for him. Omitted by the button — a tap carries her name, not his
   * — in which case the one captured when he asked is used, and his chat_id
   * if Telegram never gave one. Ugly beats anonymous: a reminder from a bare
   * number is one she cannot place, and /friend renames him in one line.
   */
  theirName?: string,
  now: number = Date.now(),
): Promise<boolean> {
  // Read before the UPDATE, or the row this needs is already the accepted one.
  const asked = await friendEdge(env, requesterId, chatId);
  const res = await env.DB.prepare(
    `UPDATE friends SET status = 'accepted'
      WHERE chat_id = ? AND friend_chat_id = ? AND status = 'pending'`,
  )
    .bind(requesterId, chatId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return false;

  await env.DB.prepare(
    `INSERT INTO friends (chat_id, friend_chat_id, nickname, status, requested_by, created_at)
       VALUES (?, ?, ?, 'accepted', ?, ?)
       ON CONFLICT(chat_id, friend_chat_id) DO UPDATE SET status = 'accepted'`,
  )
    .bind(
      chatId,
      requesterId,
      (theirName ?? asked?.requester_name ?? '').trim().slice(0, NICKNAME_MAX) || requesterId,
      requesterId,
      now,
    )
    .run();
  return true;
}

/** They said no. The row is kept — see migrations/013 for why. */
export async function declineFriend(
  env: Env,
  chatId: string,
  requesterId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE friends SET status = 'declined'
      WHERE chat_id = ? AND friend_chat_id = ? AND status = 'pending'`,
  )
    .bind(requesterId, chatId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * End it, from either side, in both directions.
 *
 * Deleted rather than marked declined, and both edges rather than one: this
 * is the one case where the pair genuinely should be able to start over, and
 * leaving the other edge in place would leave someone still able to write
 * reminders into a chat that has just removed them.
 */
export async function removeFriend(
  env: Env,
  chatId: string,
  friendChatId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    'DELETE FROM friends WHERE (chat_id = ? AND friend_chat_id = ?) OR (chat_id = ? AND friend_chat_id = ?)',
  )
    .bind(chatId, friendChatId, friendChatId, chatId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ------------------------------------------------------------- model health

export interface ModelHealth {
  model: string;
  blocked_until: number;
  strikes: number;
  reason: string | null;
}

/**
 * Every model currently written off, by id.
 *
 * Read once per generate() — one query against a table with as many rows as
 * there are models, which is cheaper than the single wasted round trip it
 * saves. Expired rows come back too, on purpose: the caller needs the strike
 * count to decide how long the NEXT block should be, and an expired row is
 * exactly the model it is about to probe.
 */
export async function modelHealth(env: Env): Promise<Map<string, ModelHealth>> {
  const out = new Map<string, ModelHealth>();
  try {
    const res = await env.DB.prepare('SELECT * FROM model_health').all<ModelHealth>();
    for (const row of res.results ?? []) out.set(row.model, row);
  } catch (err) {
    // Fails OPEN, like every other piece of bookkeeping around the model: an
    // unreadable health table must cost a wasted round trip, never a reply.
    console.error('modelHealth', err);
  }
  return out;
}

/** Write a model off until `until`. `strikes` is the new consecutive count. */
export async function blockModel(
  env: Env,
  model: string,
  until: number,
  strikes: number,
  reason: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_health (model, blocked_until, strikes, reason, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET
         blocked_until = excluded.blocked_until,
         strikes = excluded.strikes,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
  )
    .bind(model, until, strikes, reason.slice(0, 40), Date.now())
    .run();
}

/**
 * It answered. Forget everything.
 *
 * The strike count goes with the row, which is what makes the backoff recover
 * in one step rather than decay: a model that was down for an hour and is
 * working again starts its next bad minute at one strike, not at five.
 */
export async function clearModelBlock(env: Env, model: string): Promise<void> {
  await env.DB.prepare('DELETE FROM model_health WHERE model = ?').bind(model).run();
}

/**
 * Everything this chat spent today, across every model.
 *
 * The soft limit used to be measured against ONE model's counter, which was
 * right while there were two models and one of them took nearly every call.
 * With a ladder several models deep the same day's work is spread across all
 * of them, so a single-model number understates it by as much as the ladder
 * is long — and the budget it gates would never bind again.
 *
 * `_rejections` is excluded because it is not a model. It shares this table
 * (see recordRejection) and counting it would charge him for the times the
 * validator caught the model lying.
 */
export async function usageTodayAll(env: Env, chatId?: string): Promise<number> {
  // Omit the chat and it is the whole key's spend for the day — two questions,
  // the same shape, and the same exclusion of `_rejections` either way.
  // `model != ?` rather than a LIKE on the underscore prefix: a LIKE needs an
  // ESCAPE clause to stop `_` meaning "any character", and in a template
  // literal the backslashes that clause needs are eaten before SQLite ever
  // sees them — which produced `ESCAPE ''` and a bare "SQL logic error".
  const where = chatId ? 'AND chat_id = ?' : '';
  const stmt = env.DB.prepare(
    `SELECT SUM(calls) AS calls FROM usage
      WHERE day = ? ${where} AND model != ?`,
  );
  const bound = chatId
    ? stmt.bind(localDay(env, Date.now()), chatId, REJECTION_COUNTER)
    : stmt.bind(localDay(env, Date.now()), REJECTION_COUNTER);
  const row = await bound.first<{ calls: number | null }>();
  return Number(row?.calls ?? 0);
}

/**
 * Change what one side calls the other. One edge only — his name for her is
 * his business, and hers for him is hers.
 *
 * This exists because the reverse edge is NAMED rather than asked for (see
 * acceptFriend): whoever says yes gets the requester's Telegram first name,
 * or his chat_id when Telegram did not give one, and both of those are
 * things a person should be able to fix.
 */
export async function renameFriend(
  env: Env,
  chatId: string,
  friendChatId: string,
  nickname: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE friends SET nickname = ? WHERE chat_id = ? AND friend_chat_id = ? AND status = 'accepted'",
  )
    .bind(nickname.trim().slice(0, NICKNAME_MAX), chatId, friendChatId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}
