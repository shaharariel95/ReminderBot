import type { Context } from './brain';
import type { Effect, Facts } from './types';
import { WROTE } from './types';
import { formatLocal } from './time';

/** "יום ד׳, 05.08.2026, 07:05" → "07:05" */
function clock(ts: number, tz: string): string | null {
  return /(\d{2}:\d{2})/.exec(formatLocal(ts, tz))?.[1] ?? null;
}

/**
 * Collect the times and titles the model is allowed to mention. Anything it
 * says that is not in here is, by definition, invented — see validate.ts.
 */
export function buildFacts(ctx: Context, effects: Effect[], tz: string): Facts {
  const times = new Set<string>();
  const titles = new Set<string>();
  const quotable = new Set<string>();

  const addQuotable = (s: string | null | undefined) => {
    if (typeof s === 'string' && s.trim().length > 0) quotable.add(s.trim());
  };

  const addTime = (ts: number | null | undefined) => {
    if (typeof ts === 'number') {
      const c = clock(ts, tz);
      if (c) times.add(c);
    }
  };

  // Everything already on file is fair game to talk about.
  for (const r of ctx.reminders) {
    titles.add(r.title);
    addTime(r.next_fire_at);
    try {
      const s = JSON.parse(r.schedule);
      if (typeof s?.time === 'string') times.add(s.time);
    } catch {
      /* raw schedule, nothing to extract */
    }
  }
  for (const i of ctx.open) {
    titles.add(i.title);
    addTime(i.fired_at);
  }
  for (const g of ctx.goals) titles.add(g.title);

  // Plus whatever this turn produced.
  for (const e of effects) {
    if ('title' in e && typeof e.title === 'string') titles.add(e.title);
    if ('at' in e) addTime(e.at);
    if ('until' in e) addTime(e.until);
    if ('since' in e) addTime(e.since);
    if (e.kind === 'listed_reminders') {
      for (const r of e.rows) {
        titles.add(r.title);
        addTime(r.next_fire_at);
        try {
          const s = JSON.parse(r.schedule);
          if (typeof s?.time === 'string') times.add(s.time);
        } catch {
          /* raw schedule, nothing to extract */
        }
      }
    }
    if (e.kind === 'listed_goals' || e.kind === 'listed_inbox') {
      for (const r of e.rows) titles.add(r.title);
    }
    if (e.kind === 'photo_accepted' || e.kind === 'photo_rejected') addQuotable(e.reason);
    if (e.kind === 'checkin_goal') addQuotable(e.lastProgress);
    if (e.kind === 'goal_progress') {
      addQuotable(e.note);
      addQuotable(e.previous);
    }
    if (e.kind === 'goal_created') addQuotable(e.why);
    if (e.kind === 'nothing') addQuotable(e.userText);
  }

  return {
    effects,
    reminders: ctx.reminders,
    open: ctx.open,
    goals: ctx.goals,
    settings: ctx.settings,
    stats: ctx.stats,
    nowLabel: ctx.nowLabel,
    times: [...times],
    titles: [...titles],
    quotable: [...quotable],
    wrote: effects.some((e) => WROTE.has(e.kind)),
  };
}
