import type { Schedule } from './types';
import { wallParts, wallToUtc } from './time';
import {
  PERIOD_HOUR,
  RECURRING,
  countTimeAnchors,
  matchClock,
  matchDay,
  parseRelative,
  resolve,
  toNumber,
  type Clock,
  type DayHint,
} from './quickparse';

/**
 * The one place that answers "when did he mean".
 *
 * ## Why this file exists
 *
 * `quickparse.ts` grew ten entry points that each answer some version of that
 * question — matchClock, matchDay, resolve, parseRelative, parseDuration,
 * findNamedTime, parseAnswerTime, findFutureInstant, parseRecurring,
 * scanDurations — and each decided independently how to parse, when to refuse,
 * and what a refusal MEANS. Add the router prompt's own fourteen lines of
 * Hebrew about times, `effects.scheduleFromIntent`, and `time.computeNext`, and
 * one question had four implementations that disagreed.
 *
 * CLAUDE.md records this class of bug three times under three incident names —
 * `asksForNewReminder` having two implementations that both had to be fixed,
 * `findNamedTime` being wired into `reschedule` and not `create_reminder`,
 * `namesSomeoneElse` and `addressesSomeoneElse` asking the same question two
 * ways — without ever naming the class. This file names it: **one question,
 * one implementation.**
 *
 * The lexers stay in quickparse.ts. They read tokens; this reads MEANING, and
 * the dependency runs one way only.
 *
 * ## Why the return type is a union
 *
 * `findNamedTime` returned `number | null`, and `null` carried five different
 * facts: he named no time, he named a repeat rule, he named two times, the
 * time has gone — and a fifth that had no representation at all and so came
 * back as a wrong ANSWER instead of a refusal.
 *
 * Production, 01.09.2026 00:08. "תעביר את 69 ל2.9 ב16:30" resolved to
 * **01.09** — today. matchClock found "ב16:30", matchDay found no day word,
 * and `resolve` defaulted to today. The "2.9" was invisible to every regex in
 * the file: TIME_ANCHOR does not count it, CLOCK_RESIDUE does not flag it,
 * matchDay does not know it. The bot then said "הזזתי … ב-01.09 בשעה 16:30" —
 * a move it had not made, to a date he had not named.
 *
 * That is not a model failure. It is deterministic code returning a confident
 * wrong answer, which is exactly what rule 2 at the top of quickparse.ts calls
 * "the whole design" and forbids — and `findNamedTime` was the one path never
 * held to it, because it had no residue check and no way to express doubt.
 *
 * So: **the parser must be able to say "there is something here I cannot
 * read", and that is a different fact from "there is nothing here".** That is
 * the `unparsed` arm, and it is the reason for the whole union.
 */
export type TimeRef =
  /** A specific moment. `altHour` is the other reading of a bare "ב-8", for
   *  the one-tap correction button — never applied, only offered. */
  | { kind: 'instant'; at: number; altHour?: number }
  /** A repeat rule he stated, resolved into a schedule. */
  | { kind: 'recurrence'; schedule: Schedule }
  /** A length of time. Left unresolved because `snooze` wants the minutes and
   *  `create` wants the instant, and turning one into the other is the
   *  caller's business — see scheduleFromIntent on why in_minutes must not be
   *  flattened into a date by anything that could end a recurrence. */
  | { kind: 'duration'; minutes: number }
  /**
   * Something time-shaped is here and guessing would be dishonest. `why` says
   * which kind of doubt, so a caller can ask a question that names it instead
   * of the generic "מתי?" that every one of these used to collapse into.
   */
  | { kind: 'ambiguous'; why: Ambiguity; seen: string[] }
  /** Nothing time-like in this sentence at all. */
  | { kind: 'none' };

export type Ambiguity =
  /** Two separate time phrases. One TimeRef cannot hold both. */
  | 'two-times'
  /** A repeat rule where an instant was wanted. Flattening it would END the
   *  recurrence — the trap the retime button was fixed for. */
  | 'repeat-rule'
  /** The moment he named has already gone. */
  | 'past'
  /** A token that looks like a time and could not be read. THE new arm. */
  | 'unparsed'
  /**
   * A DAY, pinned, with no hour on it — a bare "מחר", "ביום שלישי".
   *
   * Distinct from `none`, and that distinction is the whole point: the parser
   * knows strictly more than nothing here, and reporting `none` threw the
   * knowledge away at the seam. Production, chat B, 03.09.2026 23:46 —
   * "תזכיר לי מחר לבדוק כמה אתה טיפש" was captured and answered with a baseline
   * saying "לא אמרת על מה ולא מתי", about a day he had named in the first three
   * words. The persona resolved the contradiction by asserting "מחר בודקים"
   * over a row with no next_fire_at.
   *
   * It stays AMBIGUOUS rather than becoming an instant. The only guess this
   * file is allowed is a pinned day plus a named part of it ("מחר בערב" is
   * 20:00), and that is honest solely because voice.ts always states the hour
   * it chose so he can move it. A bare day has no hour to state.
   */
  | 'no-hour';

const ambiguous = (why: Ambiguity, ...seen: string[]): TimeRef => ({ kind: 'ambiguous', why, seen });

// ------------------------------------------------------------ numeric dates

/**
 * "2.9", "2/9", "2.9.2026" — a date written in digits.
 *
 * Nothing in this codebase could see one before, which is the entire 01.09
 * bug. The prefix is optional because he writes both "ל2.9" and a bare "2.9",
 * and the right-hand boundary keeps it off the tail of a longer number.
 */
const NUMERIC_DATE = /(?:^|\s)(?:[בלמ]\s*-?\s*)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/;

interface DateHint {
  day: number;
  month: number;
  year: number | null;
  matched: string;
  /** The raw span to cut out before anything else lexes the sentence. */
  consumed: string;
  /** True when the digits are there but do not name a real date. */
  bad: boolean;
}

function matchNumericDate(t: string): DateHint | null {
  const m = NUMERIC_DATE.exec(t);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const raw = m[3];
  const year = raw === undefined ? null : Number(raw.length === 2 ? `20${raw}` : raw);
  const bad = !(day >= 1 && day <= 31 && month >= 1 && month <= 12);
  return { day, month, year, matched: m[0].trim(), consumed: m[0], bad };
}

/**
 * The instant a written date plus a clock lands on.
 *
 * Forward-only when he did not name a year: "ל3.1" said in September means
 * next January, not the one eight months gone. Guessing backwards would write a
 * reminder into the past, `computeNext` would refuse it, and he would be told
 * "הזמן הזה כבר עבר" about a date he plainly meant in the future.
 */
function dateInstant(d: DateHint, clock: Clock, nowMs: number, tz: string): number {
  const here = wallParts(nowMs, tz);
  const year = d.year ?? here.year;
  let ts = wallToUtc(year, d.month, d.day, clock.hour, clock.minute, tz);
  if (d.year === null && ts <= nowMs) {
    ts = wallToUtc(year + 1, d.month, d.day, clock.hour, clock.minute, tz);
  }
  return ts;
}

// ------------------------------------------------------------- day offsets

/**
 * "עוד יומיים", "בעוד 3 ימים", "עוד שבוע" — a whole number of DAYS forward.
 *
 * Deliberately days and weeks only. An hour or a minute in front of a clock
 * ("עוד שעתיים ב16:30") is not an offset anybody means, and reading it as one
 * would be an invention; that case falls through and is refused as two-times.
 *
 * This is the half of the 01.09 failure that was not the 2.9. "תזכיר לי עוד
 * יומיים ב16:30" had every piece present and threw them all away: parseRelative
 * read 2880 correctly, and then quickParse and findNamedTime both bailed on
 * `countTimeAnchors > 1`, leaving the router to do date arithmetic it got wrong
 * by two days.
 */
const DAY_OFFSET = new RegExp(
  String.raw`(?:^|\s)(?:[ובלמ]?(?:עוד|בעוד|תוך)|in)\s+` +
    String.raw`(?:(?<dual>יומיים|שבועיים)|(?:(?<n>\S+)\s+)?(?<unit>ימים|יום|שבועות|שבוע|days?|weeks?))` +
    String.raw`(?=$|[\s.,!?])`,
  'i',
);

function matchDayOffset(t: string): { days: number; matched: string } | null {
  const m = DAY_OFFSET.exec(t);
  if (!m) return null;
  const g = m.groups!;
  if (g.dual) return { days: /יומיים/.test(g.dual) ? 2 : 14, matched: m[0] };
  const per = /שבוע|week/i.test(g.unit) ? 7 : 1;
  /*
   * `toNumber`, not `Number`.
   *
   * The count is `\S+` and goes through the same reader `parseRelative` has
   * used since it was written, because he types "עוד שלושה ימים" at least as
   * often as "עוד 3 ימים". The first version of this matched `\d{1,3}` only,
   * so on 02.09.2026 22:42 "תזכיר לי עוד שלושה ימים ב10:10 לבדוק משימות
   * חדשות" matched nothing here, fell through to the two-times refusal, and
   * was captured with no hour — the exact failure Stage 1 exists to prevent,
   * reintroduced by writing a second number parser instead of reusing the one
   * that was already right.
   *
   * A word that is not a number ("עוד כמה ימים") returns null and falls
   * through to the refusal, which is the honest answer.
   */
  const n = g.n === undefined ? 1 : toNumber(g.n);
  if (n === null || !Number.isFinite(n) || n < 1 || n > 365) return null;
  return { days: n * per, matched: m[0] };
}

// ------------------------------------------------------------- the resolver

/**
 * Read the time out of a sentence that is doing something else.
 *
 * This is `findNamedTime`'s job with the refusals made explicit and two
 * readings added that nothing could do before. The caller decides what to do
 * with each arm; nothing here writes, asks or guesses.
 */
export function readWhen(text: string, nowMs: number, tz: string): TimeRef {
  const t = text.trim();
  if (!t) return { kind: 'none' };

  // A repeat rule is a different shape of answer entirely, and flattening one
  // into an instant ends the recurrence. Refused here rather than parsed,
  // exactly as findNamedTime refused it — parseRecurring is quickparse's job
  // and it owns the shapes it can express.
  if (RECURRING.test(t)) return ambiguous('repeat-rule', t);

  /*
   * The date comes off FIRST, and everything below lexes what is left.
   *
   * Not an optimisation — a correctness requirement, and the first version got
   * it wrong. `matchClock` reads "ב" followed by digits, so in
   * "תזכיר לי ב2.9 בשעה 16:30" it found the "ב2" inside the DATE and returned
   * 02:00, quietly beating the real "16:30" that was sitting four words later.
   * A lexer that can see the same characters as two different things has to be
   * given each of them once.
   */
  const date = matchNumericDate(t);
  const rest = date ? t.replace(date.consumed, ' ') : t;
  const clock = matchClock(rest);

  /*
   * A date he wrote in digits.
   *
   * Only read as a date when there is a CLOCK to go with it, and that
   * restraint is the point. "8.30" on its own is 08:30 or the 8th of March,
   * both readings live, and picking one is the 2.9 bug with the sign flipped.
   * With a separate "ב16:30" in the sentence there is nothing left for the
   * dotted pair to be.
   *
   * Digits that look like a date and are not one — "2.13", "45.9" — are
   * REFUSED rather than stepped over. That is the whole reason this function
   * has an `unparsed` arm: the old code's answer to something it could not
   * read was to pretend it was not there.
   */
  if (date && clock) {
    if (date.bad) return ambiguous('unparsed', date.matched);
    return { kind: 'instant', at: dateInstant(date, clock, nowMs, tz) };
  }
  if (date && !date.bad && !clock) {
    // A real date with no hour. Honest answer: I know the day, not the time.
    return ambiguous('unparsed', date.matched);
  }
  if (date && date.bad) return ambiguous('unparsed', date.matched);

  /*
   * "עוד יומיים ב16:30" — an offset in days AND a clock.
   *
   * Checked before countTimeAnchors, because the anchor count sees two phrases
   * here ("עוד" and "ב16:30") and bails — which is precisely how this reached
   * the router and came back two days early. Two phrases that compose into one
   * moment are one time, not two.
   */
  if (clock) {
    const offset = matchDayOffset(rest);
    if (offset) {
      const p = wallParts(nowMs + offset.days * 86_400_000, tz);
      return {
        kind: 'instant',
        at: wallToUtc(p.year, p.month, p.day, clock.hour, clock.minute, tz),
      };
    }
  }

  // Two separate time phrases and nothing here can say which he meant. Only
  // now, after the composing shapes above have had their look.
  if (countTimeAnchors(rest) > 1) return ambiguous('two-times', rest.trim());

  // A bare length of time — "עוד חצי שעה", "בעוד 20 דקות". Left as minutes:
  // snooze wants the number, create wants the instant, and flattening it here
  // would take that choice away from both.
  const rel = parseRelative(rest);
  if (rel && rel.minutes >= 1 && rel.minutes <= 60 * 24 * 60) {
    return { kind: 'duration', minutes: rel.minutes };
  }

  const day = matchDay(rest);

  if (clock) {
    const hit = resolve(clock, day, nowMs, tz);
    // `resolve` returns null when he pinned a day and named an hour on it that
    // has already gone — "היום ב-7" said at ten.
    if (hit === null) return ambiguous('past', rest.trim());
    if (hit.ts <= nowMs) return ambiguous('past', rest.trim());
    return hit.altHour === undefined
      ? { kind: 'instant', at: hit.ts }
      : { kind: 'instant', at: hit.ts, altHour: hit.altHour };
  }

  /*
   * A pinned day plus a named part of it — "מחר בערב" is 20:00.
   *
   * findFutureInstant's rule, kept whole. It is a convention rather than a
   * reading, and it is honest for exactly one reason: voice.ts ALWAYS states
   * the hour it set, so he reads "20:00" back and can move it. The day must be
   * pinned — a bare "בערב" is tonight or tomorrow and still refuses.
   */
  if (day) {
    const period = PERIOD_HOUR.find(([re]) => re.test(rest));
    if (period) {
      const hit = resolve({ hour: period[1], minute: 0, matched: '', settled: true }, day, nowMs, tz);
      if (hit === null || hit.ts <= nowMs) return ambiguous('past', rest.trim());
      return { kind: 'instant', at: hit.ts };
    }
    // A day, and nothing on it. Reported rather than discarded — see 'no-hour'.
    // `matched` is his own wording, so the question can quote the day back at
    // him instead of asking about a time he already gave half of.
    return ambiguous('no-hour', day.matched.trim());
  }

  return { kind: 'none' };
}

/**
 * The instant a TimeRef names, or null if it does not name one.
 *
 * The convenience every caller that only wants "did he say a time" needs, and
 * the ONLY place `duration` is allowed to become a date silently — because the
 * caller asked for an instant by calling this. A caller that must not flatten a
 * duration (anything touching a recurrence) reads the union directly.
 */
export function instantOf(ref: TimeRef, nowMs: number): number | null {
  if (ref.kind === 'instant') return ref.at;
  if (ref.kind === 'duration') return nowMs + ref.minutes * 60_000;
  return null;
}
