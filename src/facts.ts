import type { Context } from './brain';
import type { Effect, Facts } from './types';
import { WROTE } from './types';
import { formatLocal, quietMinutesBetween } from './time';

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
  const elapsedRaw = new Set<number>();
  let spansQuiet = false;
  let spansGranted = false;

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
   *
   * `discountQuiet` is false for spans that are measured in DAYS by nature.
   * Taking his sleep out of "this has been open since 22:00" is the whole
   * point (see below). Taking it out of "you last touched this goal on Friday
   * morning" is distortion: two nights come off a two-and-a-quarter-day span
   * and the model is handed a number that reads as a day and a half. The
   * discount belongs to the pressure figure, not to every subtraction.
   */
  const addElapsed = (
    ts: number | null | undefined,
    discountQuiet = true,
    /**
     * Minutes the BOT agreed to, out of the same span.
     *
     * The quiet-hours discount below exists because counting his sleep as
     * avoidance is a claim about him. Time he ASKED for and the bot said yes
     * to is the same claim with the bot's own signature on it — production
     * 18:03, "93 דקות ש… פתוחה", against a snooze to 18:02 granted an hour
     * earlier. He was doing exactly what the bot offered.
     *
     * Separate from `discountQuiet` rather than folded into it: a grant is a
     * fact about this instance (`instances.granted_min`) while quiet hours are
     * a fact about the chat, and the goal spans that turn the quiet discount
     * off still want their grants subtracted — a goal is never snoozed, so the
     * value is 0 there and the parameter simply does not bite.
     */
    grantedMin = 0,
  ) => {
    if (typeof ts !== 'number') return;
    const now = Date.now();
    const raw = Math.round((now - ts) / 60_000);
    if (raw < 0) return;
    /*
     * The span he was AWAKE for, not the span on the wall clock.
     *
     * Production, 26.08.2026 08:03, chat B: instance 44 had fired at 22:00 the
     * previous night, so a flat subtraction handed the model 630 and he woke
     * up to "התרופה מאתמול גוררת חוב של 600 דקות". Nine of those hours were
     * this bot's own quiet window. The block exists so a nag can state a TRUE
     * number instead of guessing one; counting his sleep as time he spent
     * avoiding the task is arithmetic in the service of a claim about him,
     * which CLAUDE.md rules out more firmly than it rules out a wrong minute.
     *
     * The raw span is kept as well, but only for validate.ts — it is still a
     * true thing to say, and a rewrite that says it should not be discarded.
     */
    const quiet = discountQuiet
      ? quietMinutesBetween(
          ts, now, tz, ctx.settings.quiet_start_hour, ctx.settings.quiet_end_hour,
        )
      : 0;
    // Both discounts come off the same span, and both are floored at zero
    // together: a grant that overlaps the quiet window would otherwise be
    // subtracted twice and hand the model a NEGATIVE number to be rude about.
    const granted = Math.max(0, grantedMin);
    const waking = Math.max(0, raw - Math.min(raw, quiet + granted));
    elapsed.add(waking);
    if (waking !== raw) elapsedRaw.add(raw);
    // Which discount actually bit, tracked separately, because each one gets a
    // DIFFERENT sentence in the prompt and the wrong sentence is a false claim
    // about him. Folding them into one flag made a snoozed reminder announce
    // "הוא ישן אז" about an hour he had spent awake and had asked for.
    if (quiet > 0) spansQuiet = true;
    if (granted > 0) spansGranted = true;
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
    // been sitting there" about, and its fired_at is the only honest answer —
    // less whatever of that span the bot handed him when he asked for it.
    addElapsed(i.fired_at, true, i.granted_min ?? 0);
  }
  for (const g of ctx.goals) titles.add(g.title);
  // Item titles are shown to the model in openSummary, so it may truthfully
  // quote one back — and rule 3 would discard the whole rewrite for it.
  for (const list of ctx.items?.values() ?? []) for (const i of list) titles.add(i.title);

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
    // A person's name, not a task title — so it goes in `quotable`, which is
    // matched one-directionally. As a title, a short name like "דנה" would be
    // a wildcard: rule 3 accepts a quote that CONTAINS an allowed title, and
    // every invented task with her name in it would sail through.
    if (e.kind === 'friend_reminder_created') addQuotable(e.friend);
    if (e.kind === 'reminder_fired' && e.from) addQuotable(e.from);
    if (e.kind === 'needs_item_choice') for (const i of e.open) titles.add(i.title);
    if (e.kind === 'reminder_fired' && e.items) for (const i of e.items) titles.add(i.title);
    if (e.kind === 'needs_reminder_choice') {
      for (const r of e.rows) {
        titles.add(r.title);
        addTime(r.next_fire_at);
      }
    }
    if ('at' in e) addTime(e.at);
    // The event hour is none of the sources this list is otherwise built from
    // — not next_fire_at, not schedule.time, not fired_at, not `at`. Without
    // this line validate.ts rule 1 finds it outside the allow-list and throws
    // away the WHOLE rewrite for repeating something the baseline itself said.
    // That failure is silent: it surfaces as a rejection count in /diag, never
    // as an error.
    if ('eventAt' in e && e.eventAt) addTime(e.eventAt);
    // The hour a late fire says it was SUPPOSED to ring. None of the other
    // sources here would produce it: `next_fire_at` has already been advanced
    // by the time the effect exists, and `fired_at` is the hour it actually
    // rang — which is the whole point of the pair. Without this line validate
    // rule 1 finds it outside the allow-list and discards the entire rewrite
    // for repeating something the baseline itself said, silently, as a
    // rejection count in /diag.
    if ('dueAt' in e && e.dueAt) addTime(e.dueAt);
    if ('until' in e) addTime(e.until);
    if ('since' in e) {
      addTime(e.since);
      // `nagged` carries the moment the thing became due, which is the exact
      // span a nag is tempted to editorialise about — and the minutes of it
      // the bot granted, which are the ones it may not.
      addElapsed(e.since, true, 'granted' in e ? e.granted : 0);
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
      // `ahead` states an HOUR as well as a title — it is the one part of this
      // effect that looks forward. Sweeping the time is not optional: voice.ts
      // now prints it, and CLAUDE.md's rule is that a fact the model is shown
      // must be swept or rule 1 discards the rewrite for repeating what the
      // baseline itself said, silently, as a counter in /diag.
      for (const r of e.ahead) {
        titles.add(r.title);
        addTime(r.next_fire_at);
      }
    }
    if (e.kind === 'photo_accepted' || e.kind === 'photo_rejected') addQuotable(e.reason);
    if (e.kind === 'checkin_goal') {
      addQuotable(e.lastProgress);
      // "מאז יום שישי בבוקר שאמרת לה שהיא יפה לא שמענו ממך" (09.08.2026) — a
      // check-in's whole rhetorical move is how long it has been, and until
      // these two were swept the model had no fact to reach for and simply
      // made the span up. Both matter: last progress is how long since he DID
      // anything, last check-in is how long since the bot last asked.
      addElapsed(e.lastProgressAt, false);
      addElapsed(e.lastCheckinAt, false);
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
    // Passed straight through so speak() can render the ✓/☐ state in
    // openSummary. The router has always been shown these (brain.openSummary);
    // the persona was not — while being told to name one of them.
    items: ctx.items,
    settings: ctx.settings,
    stats: ctx.stats,
    nowLabel: ctx.nowLabel,
    times: [...times],
    elapsed: [...elapsed],
    elapsedRaw: [...elapsedRaw],
    elapsedSpansQuiet: spansQuiet,
    elapsedSpansGranted: spansGranted,
    titles: [...titles],
    quotable: [...quotable],
    // Filled in by sendOutcome, and only when the model is actually consulted.
    profile: [],
    wrote: effects.some((e) => WROTE.has(e.kind)),
  };
}
