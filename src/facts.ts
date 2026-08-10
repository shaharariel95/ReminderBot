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
  const elapsed = new Set<number>();

  const addQuotable = (s: string | null | undefined) => {
    if (typeof s === 'string' && s.trim().length > 0) quotable.add(s.trim());
  };

  const addTime = (ts: number | null | undefined) => {
    if (typeof ts === 'number') {
      const c = clock(ts, tz);
      if (c) times.add(c);
    }
  };

  /**
   * How long ago `ts` was, in whole minutes. Read from the clock at build
   * time, exactly like the message it is about to license — which is what
   * makes it comparable to anything the model says in the same breath.
   */
  const addElapsed = (ts: number | null | undefined) => {
    if (typeof ts !== 'number') return;
    const mins = Math.round((Date.now() - ts) / 60_000);
    if (mins >= 0) elapsed.add(mins);
  };

  // Everything already on file is fair game to talk about.
  for (const r of ctx.reminders) {
    titles.add(r.title);
    // The note is shown to the model (see remindersSummary), so it must be
    // quotable — otherwise rule 3 discards a rewrite for repeating something
    // the prompt handed it.
    addQuotable(r.notes);
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
    // An open instance is the commonest thing to be asked "how long has this
    // been sitting there" about, and its fired_at is the only honest answer.
    addElapsed(i.fired_at);
  }
  for (const g of ctx.goals) titles.add(g.title);

  // Plus whatever this turn produced.
  for (const e of effects) {
    if ('title' in e && typeof e.title === 'string') titles.add(e.title);
    // The generic `'title' in e` check above only reaches the TOP LEVEL of an
    // effect. duplicateOf is nested inside reminder_created, so its title
    // needs an explicit sweep — otherwise a truthful mention of the existing
    // similar reminder gets discarded by validate.ts as an invented task.
    if (e.kind === 'reminder_created' && e.duplicateOf) {
      titles.add(e.duplicateOf.title);
      // Its TIME is nested too, and the warning is worthless without it.
      addTime(e.duplicateOf.at);
    }
    // Same reason: a rename carries `from`/`to`, never `title`, so without this
    // the model gets discarded for naming either side of a change it just made.
    if (e.kind === 'reminder_renamed') {
      titles.add(e.from);
      titles.add(e.to);
    }
    if (e.kind === 'needs_reminder_choice') {
      for (const r of e.rows) {
        titles.add(r.title);
        addTime(r.next_fire_at);
      }
    }
    if ('at' in e) addTime(e.at);
    if ('until' in e) addTime(e.until);
    if ('since' in e) {
      addTime(e.since);
      // `nagged` carries the moment the thing became due, which is the exact
      // span a nag is tempted to editorialise about.
      addElapsed(e.since);
    }
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
    if (e.kind === 'morning_brief') {
      for (const r of e.rows) {
        titles.add(r.title);
        addTime(r.next_fire_at);
      }
    }
    if (e.kind === 'evening_closeout') {
      for (const i of [...e.missed, ...e.dropped]) titles.add(i.title);
    }
    if (e.kind === 'photo_accepted' || e.kind === 'photo_rejected') addQuotable(e.reason);
    if (e.kind === 'checkin_goal') {
      addQuotable(e.lastProgress);
      // "מאז יום שישי בבוקר שאמרת לה שהיא יפה לא שמענו ממך" (09.08.2026) — a
      // check-in's whole rhetorical move is how long it has been, and until
      // these two were swept the model had no fact to reach for and simply
      // made the span up. Both matter: last progress is how long since he DID
      // anything, last check-in is how long since the bot last asked.
      addElapsed(e.lastProgressAt);
      addElapsed(e.lastCheckinAt);
    }
    if (e.kind === 'goal_progress') {
      addQuotable(e.note);
      addQuotable(e.previous);
    }
    if (e.kind === 'goal_created') addQuotable(e.why);
    // Profile notes are prose in his own words, not task titles, so they go in
    // `quotable` — matched one-directionally, which is what keeps a short note
    // from becoming a wildcard that authorises any longer quote.
    if (e.kind === 'profile_noted' || e.kind === 'profile_known' || e.kind === 'profile_forgotten') {
      addQuotable(e.note);
    }
    if (e.kind === 'listed_profile') for (const r of e.rows) addQuotable(r.note);
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
    elapsed: [...elapsed],
    titles: [...titles],
    quotable: [...quotable],
    // Filled in by sendOutcome, and only when the model is actually consulted.
    profile: [],
    wrote: effects.some((e) => WROTE.has(e.kind)),
  };
}
