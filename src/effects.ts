import * as db from './db';
import type { Context } from './brain';
import type { Effect, Env, Intent, Schedule } from './types';
import { computeNext, wallString } from './time';

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
      const title = intent.title?.trim() || 'תזכורת';
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
        { kind: 'reminder_created', id, title, at: next, schedule, requiresProof: !!intent.requires_proof },
      ];
    }

    case 'complete': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) return [{ kind: 'nothing', why: 'no_open_task', userText }];
      await db.closeInstance(env, inst.id, 'done', userText.slice(0, 500) || 'דיווח');
      const fresh = await db.stats(env, chatId);
      return [{ kind: 'instance_done', id: inst.id, title: inst.title, streak: fresh.currentStreak }];
    }

    case 'snooze': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) return [{ kind: 'nothing', why: 'no_open_task', userText }];
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
