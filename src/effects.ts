import * as db from './db';
import type { Context } from './brain';
import type { Effect, Env, Intent, Reminder, Schedule } from './types';
import { UNTITLED_TITLE } from './types';
import { computeNext, wallString } from './time';

/** Reminders whose next_fire_at lands within this many ms count as "the same time". */
const DUPLICATE_WINDOW_MS = 60_000;

/**
 * Comparison key for two titles: trim, collapse internal whitespace, strip
 * punctuation (replaced with a space so hyphenated words don't fuse), and
 * lowercase (a no-op on Hebrew, which has no case).
 */
function normalizeTitle(title: string): string {
  return title
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** The fallback title quickparse/the router use when no subject was extracted —
 *  two unrelated captures can both carry it, so it must not be allowed to
 *  near-match anything on title similarity alone. */
const GENERIC_TITLE = normalizeTitle(UNTITLED_TITLE);
function isGenericTitle(normalized: string): boolean {
  return normalized === GENERIC_TITLE;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * "Similar enough to warn about, not identical." Token (Jaccard) overlap
 * catches reordered/partially-shared phrasing; the containment check catches
 * one title being a strict elaboration of the other ("לקחת בגד ים" vs "לקחת
 * בגד ים לים"). The length-3 floor on the shorter side keeps a one-word
 * generic-ish title (but not GENERIC_TITLE itself, handled separately) from
 * matching everything that happens to contain it.
 */
function isNearMatch(normA: string, normB: string): boolean {
  const tokensA = new Set(normA.split(' ').filter(Boolean));
  const tokensB = new Set(normB.split(' ').filter(Boolean));
  if (jaccard(tokensA, tokensB) >= 0.5) return true;
  const [shorter, longer] = normA.length <= normB.length ? [normA, normB] : [normB, normA];
  return shorter.length >= 3 && longer.includes(shorter);
}

function scheduleFromIntent(intent: Intent, tz: string): Schedule | null {
  // Relative times are resolved here rather than by the model. Asking an LLM to
  // add 5 minutes to a wall clock and cross midnight/month/year boundaries
  // correctly is a coin flip; Date does it for free.
  if (intent.in_minutes && intent.in_minutes > 0) {
    return { type: 'once', at: wallString(Date.now() + intent.in_minutes * 60_000, tz) };
  }
  switch (intent.schedule_type) {
    case 'daily':
      return intent.time ? { type: 'daily', time: intent.time } : null;
    case 'weekly':
      return intent.time && intent.days?.length
        ? { type: 'weekly', time: intent.time, days: intent.days }
        : null;
    case 'interval':
      return intent.interval_minutes ? { type: 'interval', minutes: intent.interval_minutes } : null;
    case 'once':
      return intent.once_at ? { type: 'once', at: intent.once_at } : null;
    default:
      return null;
  }
}

/**
 * Which reminder a reschedule/rename is aimed at.
 *
 * Reads by id rather than searching ctx.reminders so that inbox captures —
 * which have no fire time and so never appear there — can still be renamed and
 * scheduled. The chat_id check is not ceremony: db.getReminder looks up by
 * primary key alone, so without it a target_id the model hallucinated could
 * point at another chat's row. Cancelled reminders are deliberately NOT
 * filtered here — retimeReminder and renameReminder both exclude them in their
 * WHERE clause, and one guard that is tested beats two that can disagree about
 * which message the user gets.
 */
async function resolveReminder(
  env: Env,
  chatId: string,
  ctx: Context,
  intent: Intent,
): Promise<Reminder | null> {
  if (intent.target_id) {
    const r = await db.getReminder(env, intent.target_id);
    return r && r.chat_id === chatId ? r : null;
  }
  // "תעביר את זה ל-8" with exactly one reminder on file is unambiguous.
  return ctx.reminders.length === 1 ? ctx.reminders[0] : null;
}

export async function applyIntent(
  env: Env,
  chatId: string,
  ctx: Context,
  intent: Intent,
  userText: string,
): Promise<Effect[]> {
  const tz = ctx.settings.tz;

  switch (intent.action) {
    case 'create_reminder': {
      const title = intent.title?.trim() || UNTITLED_TITLE;
      const schedule = scheduleFromIntent(intent, tz);

      // No time is not a failure any more. Capture first, schedule later.
      if (!schedule) {
        const id = await db.addInboxItem(env, chatId, title, tz);
        return [{ kind: 'reminder_captured', id, title }];
      }

      let next: number | null;
      try {
        next = computeNext(schedule, tz, Date.now());
      } catch {
        return [{ kind: 'nothing', why: 'bad_time', userText }];
      }
      if (next === null) return [{ kind: 'nothing', why: 'past_time', userText }];

      // Deterministic duplicate check — no model call. Only reminders close
      // in time to this one are even candidates, so this never touches
      // anything the user scheduled for a genuinely different moment.
      const normTitle = normalizeTitle(title);
      const generic = isGenericTitle(normTitle);
      const nearby = await db.findNearbyReminders(env, chatId, next, DUPLICATE_WINDOW_MS);

      const exact = nearby.find((r) => normalizeTitle(r.title) === normTitle);
      if (exact) {
        // Identical title at (near enough) the same time really is a double-
        // send — even for the generic fallback title, where two unrelated
        // untitled captures landing in the same minute is implausible enough
        // that treating it as a duplicate is still the right call. Nothing is
        // inserted; the capture already exists.
        return [
          { kind: 'reminder_duplicate', id: exact.id, title: exact.title, at: exact.next_fire_at ?? next },
        ];
      }

      // Near-matching is skipped for generic titles on either side — "תזכורת"
      // says nothing about the subject, so similarity here is noise, not signal.
      const near = generic
        ? undefined
        : nearby.find((r) => {
            const normExisting = normalizeTitle(r.title);
            return !isGenericTitle(normExisting) && isNearMatch(normTitle, normExisting);
          });

      const id = await db.addReminder(env, {
        chat_id: chatId,
        title,
        notes: null,
        schedule: JSON.stringify(schedule),
        tz,
        requires_proof: intent.requires_proof ? 1 : 0,
        proof_type: intent.proof_type ?? 'any',
        nag_interval_min: 20,
        max_nags: 3,
        next_fire_at: next,
      });
      return [
        {
          kind: 'reminder_created', id, title, at: next, schedule,
          requiresProof: !!intent.requires_proof,
          ...(intent.ambiguous_hour === undefined ? {} : { altHour: intent.ambiguous_hour }),
          ...(near ? { duplicateOf: { id: near.id, title: near.title } } : {}),
        },
      ];
    }

    case 'complete': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) {
        // More than one open task and no way to tell which: asking is
        // truthful, "no open task" (below) is not — those tasks are right
        // there. The genuinely-empty case keeps its existing message.
        if (ctx.open.length > 1) return [{ kind: 'needs_task_choice', action: 'complete', open: ctx.open }];
        return [{ kind: 'nothing', why: 'no_open_task', userText }];
      }
      await db.closeInstance(env, inst.id, 'done', userText.slice(0, 500) || 'דיווח');
      const fresh = await db.stats(env, chatId);
      return [{ kind: 'instance_done', id: inst.id, title: inst.title, streak: fresh.currentStreak }];
    }

    case 'snooze': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) {
        if (ctx.open.length > 1) return [{ kind: 'needs_task_choice', action: 'snooze', open: ctx.open }];
        return [{ kind: 'nothing', why: 'no_open_task', userText }];
      }
      const minutes = Math.min(720, Math.max(5, intent.snooze_minutes ?? 30));
      await db.snoozeInstance(env, inst.id, minutes);
      return [
        {
          kind: 'instance_snoozed',
          id: inst.id,
          title: inst.title,
          until: Date.now() + minutes * 60_000,
          minutes,
        },
      ];
    }

    case 'list':
      return [{ kind: 'listed_reminders', rows: ctx.reminders, openCount: ctx.open.length }];

    case 'list_goals':
      return [{ kind: 'listed_goals', rows: ctx.goals }];

    case 'delete': {
      if (!intent.target_id) return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      const rem = ctx.reminders.find((r) => r.id === intent.target_id);
      const ok = await db.deleteReminder(env, chatId, intent.target_id);
      if (!ok) return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      return [
        { kind: 'reminder_deleted', id: intent.target_id, title: rem?.title ?? String(intent.target_id) },
      ];
    }

    case 'reschedule': {
      const rem = await resolveReminder(env, chatId, ctx, intent);
      if (!rem) {
        if (ctx.reminders.length > 1) {
          return [{ kind: 'needs_reminder_choice', action: 'reschedule', rows: ctx.reminders }];
        }
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }

      const schedule = scheduleFromIntent(intent, tz);
      if (!schedule) return [{ kind: 'nothing', why: 'no_time', userText }];

      let next: number | null;
      try {
        next = computeNext(schedule, tz, Date.now());
      } catch {
        return [{ kind: 'nothing', why: 'bad_time', userText }];
      }
      if (next === null) return [{ kind: 'nothing', why: 'past_time', userText }];

      if (!(await db.retimeReminder(env, rem.id, next, JSON.stringify(schedule)))) {
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }
      return [{ kind: 'reminder_retimed', id: rem.id, title: rem.title, at: next }];
    }

    case 'rename': {
      const rem = await resolveReminder(env, chatId, ctx, intent);
      if (!rem) {
        if (ctx.reminders.length > 1) {
          return [{ kind: 'needs_reminder_choice', action: 'rename', rows: ctx.reminders }];
        }
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }

      const to = intent.title?.trim().slice(0, 120);
      // Nothing to rename it to, and renaming it to what it already says would
      // report a change that did not happen.
      if (!to || to === rem.title) return [{ kind: 'nothing', why: 'unknown_reminder', userText }];

      if (!(await db.renameReminder(env, rem.id, to))) {
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }
      return [{ kind: 'reminder_renamed', id: rem.id, from: rem.title, to }];
    }

    case 'create_goal': {
      if (!intent.title) return [{ kind: 'nothing', why: 'unknown_goal', userText }];
      const id = await db.addGoal(env, chatId, intent.title, intent.why ?? null);
      return [{ kind: 'goal_created', id, title: intent.title, why: intent.why ?? null }];
    }

    case 'goal_progress': {
      const goal = ctx.goals.find((g) => g.id === intent.goal_id);
      if (!goal) return [{ kind: 'nothing', why: 'unknown_goal', userText }];
      const note = (intent.reason ?? userText).slice(0, 400);
      await db.recordGoalProgress(env, goal.id, note);
      return [
        { kind: 'goal_progress', id: goal.id, title: goal.title, note, previous: goal.last_progress },
      ];
    }

    case 'complete_goal':
    case 'drop_goal': {
      const status = intent.action === 'complete_goal' ? 'done' : 'dropped';
      const goal = ctx.goals.find((g) => g.id === intent.goal_id);
      if (!goal || !(await db.setGoalStatus(env, chatId, goal.id, status))) {
        return [{ kind: 'nothing', why: 'unknown_goal', userText }];
      }
      return [{ kind: 'goal_closed', id: goal.id, title: goal.title, status }];
    }

    case 'set_checkins': {
      const enabled = intent.checkins_enabled ?? true;
      await db.setCheckins(env, chatId, enabled, intent.checkin_per_day);
      return [{ kind: 'checkins_set', enabled, perDay: intent.checkin_per_day ?? null }];
    }

    case 'chill': {
      const hours = Math.min(72, Math.max(1, intent.chill_hours ?? 4));
      const until = Date.now() + hours * 3_600_000;
      await db.setMuted(env, chatId, until);
      return [{ kind: 'muted', until, hours }];
    }

    case 'set_intensity': {
      const level = Math.min(3, Math.max(1, intent.intensity ?? 2));
      await db.setIntensity(env, chatId, level);
      return [{ kind: 'intensity_set', level }];
    }

    case 'chat':
    default:
      return [{ kind: 'nothing', why: 'chat', userText }];
  }
}
