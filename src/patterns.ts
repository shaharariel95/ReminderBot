/**
 * What the behavioural record says about a reminder that is not working.
 *
 * The `events` table has always held every fire, snooze, close and give-up,
 * timestamped and keyed by reminder_id — and until now the only things that
 * ever read it were `/why` (printing one reminder's story to a human) and
 * `/diag` (counting a day's rows). Nothing asked the obvious question: is this
 * particular reminder actually working?
 *
 * The consequence was that the bot applied identical pressure to a reminder he
 * closes every morning and one he has pushed eleven times running. The nag
 * ladder escalates WITHIN an instance and resets completely at the next fire,
 * so there was no learning across instances at all.
 *
 * ## The rule this file exists under
 *
 * **State the count. Never state the motive.**
 *
 * `NAG_LADDER[2]` used to end "ותנקוב בשם דפוס ההימנעות שלו", and on 13.08.2026
 * it produced "הימנעות קלאסית דרך שתיקה." after ninety minutes of silence. He
 * might have been driving. That line was removed because the bot does not know
 * WHY he went quiet and must not pretend to.
 *
 * Pattern detection is the same temptation with arithmetic behind it, which
 * makes it more persuasive and no more true. "דחית 6 מתוך 7" is a fact and is
 * checkable against rows. "אתה נמנע מזה" is a claim about him that nothing in
 * the database supports, and a wrong claim about HIM is worse than a wrong
 * claim about a reminder — he cannot open a list and check it.
 *
 * So everything here is a COUNT and an OFFER. No diagnosis, no adjectives.
 *
 * Pure on purpose: no env, no database, no clock beyond what it is handed. The
 * thresholds are the whole judgement, and they should be readable in one place
 * and testable without a rig.
 */

/** Counted off the `events` table for one reminder. See db.behaviourOf. */
export interface Behaviour {
  /** Times it came due (`reminder_fired`). The denominator for everything. */
  fires: number;
  /** Times he pushed it (`instance_snoozed`). */
  snoozes: number;
  /** Times he closed it (`instance_done`). */
  dones: number;
  /** Times the ladder ran out and gave up (`gave_up`). */
  failures: number;
  /**
   * The local hours at which he actually CLOSED it, one per completion. The
   * useful signal inside a snooze habit: a reminder pushed every morning and
   * closed every evening is not a discipline problem, it is set an hour wrong.
   */
  doneHours: number[];
}

export type Pattern =
  /**
   * He keeps pushing it, and there is enough history to say where it lands.
   * `hour` is present only when his completions actually cluster — see
   * usualHour. Without one, the honest offer is "when, then?", not a guess.
   */
  | { kind: 'pushed'; snoozes: number; fires: number; hour: number | null }
  /**
   * It has run out the ladder repeatedly and he has never once closed it.
   * The offer here is to DROP it. A reminder that has never worked is not
   * evidence about him; it is a reminder that is wrong.
   */
  | { kind: 'failing'; failures: number; fires: number };

/**
 * Below this there is no pattern, only a bad week.
 *
 * Four is deliberately not two. A bot that announces a habit off two data
 * points is doing astrology, and being told "you always do this" about
 * something done twice is the fastest way to stop trusting everything else it
 * says.
 */
export const MIN_SAMPLE = 4;

/** Of the times it fired, this proportion pushed = a habit rather than a week. */
const PUSH_RATE = 0.6;

/** Never closed once, and the ladder ran out this many times. */
const FAILURE_FLOOR = 3;

/**
 * The hour his completions cluster at, or null if they do not cluster.
 *
 * Deliberately the MODE over a 2-hour bucket rather than the mean: a mean of
 * 08:00 and 20:00 is 14:00, an hour he has never once closed anything at, and
 * offering it would be inventing a habit out of two real ones. If no bucket
 * holds a clear majority there is no usual hour and the caller must ask
 * instead of guessing.
 */
export function usualHour(hours: number[]): number | null {
  if (hours.length < MIN_SAMPLE) return null;
  const buckets = new Map<number, number[]>();
  for (const h of hours) {
    const key = Math.floor(h / 2) * 2;
    buckets.set(key, [...(buckets.get(key) ?? []), h]);
  }
  let best: number[] = [];
  for (const list of buckets.values()) if (list.length > best.length) best = list;
  // A plurality is not a habit. More than half his completions have to fall in
  // the same two-hour window before this is worth saying out loud.
  if (best.length * 2 <= hours.length) return null;
  // The median WITHIN the winning bucket, so the offer is an hour he has
  // actually used rather than the bucket's arbitrary edge.
  const sorted = [...best].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The one pattern worth raising, or null.
 *
 * Returns at most ONE. Two observations in a single message is a lecture, and
 * the whole point is a single question with a button under it.
 */
export function detectPattern(b: Behaviour): Pattern | null {
  if (b.fires < MIN_SAMPLE) return null;

  // Failing is checked first: a reminder he has never once completed is a
  // worse problem than one he completes late, and offering to retime it would
  // be treating a wrong reminder as a scheduling detail.
  if (b.dones === 0 && b.failures >= FAILURE_FLOOR) {
    return { kind: 'failing', failures: b.failures, fires: b.fires };
  }

  if (b.snoozes >= MIN_SAMPLE && b.snoozes / b.fires >= PUSH_RATE) {
    return { kind: 'pushed', snoozes: b.snoozes, fires: b.fires, hour: usualHour(b.doneHours) };
  }

  return null;
}
