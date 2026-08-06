import type { Intent } from './types';
import { wallParts, wallString, wallToUtc } from './time';

/**
 * Deterministic fast path for the common shapes of "remind me to X at Y".
 *
 * This exists because routing that phrase through an LLM is all downside — it
 * costs a round trip, and when the model hiccups (RECITATION, MAX_TOKENS, a
 * bad JSON parse) the reminder silently isn't created, which is the one failure
 * this bot must never have. A regex either matches or it doesn't, and when it
 * doesn't we still fall through to the router.
 *
 * TWO RULES GOVERN EVERYTHING BELOW, both learned the hard way:
 *
 * 1. Only parse what he ASKED for. An earlier version skipped the "did he ask
 *    for a reminder" check on the relative-time path, so "אני הולך עוד 20 דקות"
 *    — a statement of fact — became a reminder titled "אני הולך". That is the
 *    "it reminds me of random things I never asked for" bug.
 *
 * 2. Parse the time phrase COMPLETELY or hand the message to the router.
 *    The failure mode of a partial parse is not a miss, it is a confident wrong
 *    answer: "מחרתיים ב-9" used to strip the "מחר" inside "מחרתיים", leaving a
 *    reminder called "תיים" scheduled a day early. Anything this file does not
 *    fully understand must leave a mark in the leftover text, and TIME_RESIDUE
 *    below turns that mark into a bail. Falling through costs one LLM call;
 *    guessing costs a missed reminder.
 */

const HE_NUMBERS: Record<string, number> = {
  אחת: 1, אחד: 1,
  שתיים: 2, שתי: 2, שניים: 2, שני: 2, שעתיים: 2,
  שלוש: 3, שלושה: 3,
  ארבע: 4, ארבעה: 4,
  חמש: 5, חמישה: 5,
  שש: 6, שישה: 6,
  שבע: 7, שבעה: 7,
  שמונה: 8,
  תשע: 9, תשעה: 9,
  עשר: 10, עשרה: 10,
  עשרים: 20,
  שלושים: 30,
  ארבעים: 40,
  חמישים: 50,
};

const EN_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30,
};

function toNumber(word: string): number | null {
  const cleaned = word.trim().toLowerCase().replace(/^ב/, '');
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  return HE_NUMBERS[cleaned] ?? EN_NUMBERS[cleaned] ?? null;
}

/**
 * Hours spelled as words — "בשמונה", "בשעה תשע". Distinct from HE_NUMBERS
 * because these only ever appear as a clock reading, never as a count.
 */
const HOUR_NAMES: Record<string, number> = {
  אחת: 1, שתיים: 2, שתים: 2, שלוש: 3, ארבע: 4, חמש: 5,
  שש: 6, שבע: 7, שמונה: 8, תשע: 9, עשר: 10,
  'אחת עשרה': 11, 'שתים עשרה': 12, 'שתיים עשרה': 12,
};

/** Longest alternatives first, or "שתיים" would shadow "שתיים עשרה". */
const HOUR_NAME_ALT =
  String.raw`שתיים\s+עשרה|שתים\s+עשרה|אחת\s+עשרה|שמונה|שלוש|ארבע|חמש|שבע|תשע|עשר|שתיים|שתים|אחת|שש`;

const WEEKDAYS: Record<string, number> = {
  ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6,
};
const WEEKDAY_ALT = String.raw`ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת`;

const PERIOD = String.raw`בלילה|בבוקר|בערב|בצהריי?ם|אחה"צ|אחר\s+הצהריי?ם`;

/**
 * Never use `\b` next to Hebrew. JavaScript's `\b` is defined against ASCII
 * `\w`, and Hebrew letters are not word characters, so `\bכל` can only match
 * when the *previous* character is ASCII alphanumeric — i.e. essentially never.
 * That silently disabled this guard, and every "כל יום ב-7" was fast-pathed
 * into a one-off reminder that fired once and switched itself off.
 *
 * There is deliberately no left boundary at all: "בכל יום" and "לכל ערב" are
 * recurring too. Over-matching here only sends the message to the router, which
 * is the safe direction.
 *
 * The trailing "יומי"/"שבועי" DO need a right boundary, though — without one
 * they match inside "יומיים" and "שבועיים", and "תזכיר לי עוד יומיים" was
 * being read as a recurring reminder and thrown to the router every time.
 */
const RECURRING =
  /כל\s+(יום|יומיים|שבוע|שבועיים|בוקר|צהריי?ם|ערב|לילה|שעה|שעתיים|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|מדי\s+(יום|בוקר|ערב|שבוע)|פעמיים\s+ביום|\bevery\s+(day|week|morning|evening|night|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:יומי|שבועי)[תם]?(?![א-ת])/i;

/** Did he actually ask to be reminded, or is he just telling me something? */
const ASKED = /תזכיר|תזכורת|תנדנד|תעיר\s+לי|remind|ping/i;

/**
 * Time phrases in the message, however they are worded. Two or more means he
 * asked for two different things at two different times, which this file has no
 * way to express — one Intent carries one schedule. Hand it to the router.
 *
 * Each alternative must consume its ENTIRE phrase including the digits, or a
 * later alternative matches the same clock time again and one reminder counts
 * as two. Day words (מחר, ביום שלישי) are deliberately absent: they qualify a
 * time, they are not one, and counting them would make "ביום שלישי ב-9" bail.
 */
const TIME_ANCHOR = new RegExp(
  [
    String.raw`(?:^|\s)(?:[ובלמ]?(?:עוד|בעוד|תוך)|in)\s`,
    String.raw`(?:^|\s)ו?בשעה\s+(?:\d{1,2}(?::\d{2})?|${HOUR_NAME_ALT})`,
    String.raw`(?:^|\s)ו?ב(?:${HOUR_NAME_ALT})(?![א-ת])`,
    String.raw`(?:^|\s)ו?ב\s*-?\s*\d{1,2}(?::\d{2})?`,
    String.raw`(?:^|\s)(?:and\s+)?(?:at\s+)?\d{1,2}:\d{2}`,
    String.raw`(?:^|\s)at\s+\d{1,2}`,
    String.raw`(?:^|\s)\d{1,2}\s*(?:am|pm)`,
  ].join('|'),
  'gi',
);

function countTimeAnchors(t: string): number {
  TIME_ANCHOR.lastIndex = 0;
  let n = 0;
  while (TIME_ANCHOR.exec(t) !== null) n++;
  return n;
}

/**
 * A time word that survived into the title means the parse was incomplete —
 * see rule 2 at the top of the file. Digits alone are NOT residue: "לקחת 2
 * כדורים" is a perfectly good title, and only a digit wearing a "ב" prefix or
 * a colon reads as a clock.
 */
const TIME_RESIDUE = new RegExp(
  [
    String.raw`(?:^|\s)ו?(?:וחצי|ורבע|בשעה|מחרתיים|מחר|היום|${PERIOD}|tomorrow|today|am|pm)(?:$|[\s.,!?])`,
    String.raw`(?:^|\s)ו?ב\s*-?\s*\d{1,2}(?::\d{2})?(?:$|[\s.,!?])`,
    String.raw`(?:^|\s)ו?ב(?:${HOUR_NAME_ALT})(?![א-ת])`,
    String.raw`\d{1,2}:\d{2}`,
    // Both the "ביום שלישי" form we consume and the bare "בשלישי" form we
    // deliberately refuse to guess at — either one still sitting in the title
    // means the day was never accounted for.
    String.raw`(?:^|\s)ו?ב?יום\s+(?:${WEEKDAY_ALT})(?:$|[\s.,!?])`,
    String.raw`(?:^|\s)ו?ב(?:${WEEKDAY_ALT})(?![א-ת])`,
  ].join('|'),
  'i',
);

// ------------------------------------------------------- relative times

/** Lead-in for a relative time: "עוד", "בעוד", "ובעוד", "תוך", "in". */
const LEAD = String.raw`(?:^|\s)(?:[ובלמ]?(?:עוד|בעוד|תוך)|in)\s+`;
// Longest alternatives first so "h" never wins over "hours".
const UNIT = String.raw`(?:שעות|שעה|hours?|hrs?|h|דקות|דקה|דק['׳]?|minutes?|mins?|m|ימים|יום|days?|שבועות|שבוע|weeks?)`;
/** "שעה וחצי", "יומיים ורבע" — a fraction of the same unit, tacked on. */
const OPT_HALF = String.raw`(?:\s+ו(?<half>חצי|רבע))?`;
// Right-hand boundary that works for Hebrew, unlike `\b`.
const END = String.raw`(?=$|[\s.,!?])`;

/** Minutes in one of `unit`, or 0 if it isn't a unit we know. */
function unitMinutes(unit: string): number {
  const u = unit.toLowerCase();
  if (/^(?:שעות|שעה|hours?|hrs?|h)$/.test(u)) return 60;
  if (/^(?:דקות|דקה|דק['׳]?|minutes?|mins?|m)$/.test(u)) return 1;
  if (/^(?:ימים|יום|days?)$/.test(u)) return 1440;
  if (/^(?:שבועות|שבוע|weeks?)$/.test(u)) return 10080;
  return 0;
}

/** "שעתיים" / "יומיים" / "שבועיים" — the dual, which means two without saying so. */
const DUALS: Record<string, number> = { שעתיים: 60, יומיים: 1440, שבועיים: 10080 };

const REL_DUAL = new RegExp(LEAD + String.raw`(?<dual>שעתיים|יומיים|שבועיים)` + OPT_HALF + END, 'i');
const REL_FRACTION = new RegExp(
  LEAD + String.raw`(?<frac>חצי|רבע|half|quarter)\s+(?:an?\s+)?(?:שעה|hour)` + END,
  'i',
);
const REL_COUNTED = new RegExp(LEAD + String.raw`(?<n>\S+)\s+(?<unit>${UNIT})` + OPT_HALF + END, 'i');
const REL_BARE = new RegExp(LEAD + String.raw`(?<unit>${UNIT})` + OPT_HALF + END, 'i');

/** How much a trailing "וחצי"/"ורבע" adds, given the unit it hangs off. */
function halfBonus(half: string | undefined, unit: number): number {
  if (!half) return 0;
  return half === 'חצי' ? unit / 2 : unit / 4;
}

/**
 * "in N minutes/hours/days/weeks" and friends, returning the phrase that was
 * consumed so the caller can strip exactly that much and keep the rest as the
 * title. Matching the phrase precisely matters: an earlier version consumed one
 * word too many and turned "בעוד שעתיים להתקשר לאמא" into a reminder called
 * "לאמא".
 */
function parseRelative(t: string): { minutes: number; matched: string } | null {
  const dual = REL_DUAL.exec(t);
  if (dual) {
    const unit = DUALS[dual.groups!.dual];
    return { minutes: unit * 2 + halfBonus(dual.groups!.half, unit), matched: dual[0] };
  }

  const frac = REL_FRACTION.exec(t);
  if (frac) return { minutes: /חצי|half/i.test(frac.groups!.frac) ? 30 : 15, matched: frac[0] };

  const counted = REL_COUNTED.exec(t);
  if (counted) {
    const n = toNumber(counted.groups!.n);
    if (n !== null) {
      const unit = unitMinutes(counted.groups!.unit);
      return { minutes: n * unit + halfBonus(counted.groups!.half, unit), matched: counted[0] };
    }
  }

  // "עוד שעה" / "עוד דקה" — a bare unit with no number in front means one.
  const bare = REL_BARE.exec(t);
  if (bare) {
    const unit = unitMinutes(bare.groups!.unit);
    return { minutes: unit + halfBonus(bare.groups!.half, unit), matched: bare[0] };
  }

  return null;
}

// ------------------------------------------------------- absolute times

interface Clock {
  hour: number;
  minute: number;
  matched: string;
  /** "בערב"/"pm" was written, so the 12-hour reading is settled. */
  settled: boolean;
}

/** "ב-8" · "בשעה 20:30" · "בשמונה וחצי" · "at 8pm" · "14:30". */
function matchClock(t: string): Clock | null {
  // Hebrew, digits: "ב-8", "ב8:30", "בשעה 20:30", "ב-8 וחצי", "ב-11 בלילה".
  const num = new RegExp(
    String.raw`(?:^|\s)(?:בשעה\s+|ב\s*-?\s*)(?<h>\d{1,2})(?::(?<m>\d{2}))?` +
      String.raw`(?:\s+ו(?<half>חצי|רבע))?\s*(?<period>${PERIOD})?`,
  ).exec(t);
  if (num) {
    const g = num.groups!;
    const hour = Number(g.h);
    if (hour > 23) return null;
    const minute = g.m ? Number(g.m) : g.half ? (g.half === 'חצי' ? 30 : 15) : 0;
    if (minute > 59) return null;
    return {
      hour: applyPeriod(hour, g.period),
      minute,
      matched: num[0],
      settled: Boolean(g.period) || Boolean(g.m) || hour > 12,
    };
  }

  // Hebrew, words: "בשמונה", "בשעה תשע וחצי", "בשבע בערב".
  const word = new RegExp(
    String.raw`(?:^|\s)(?:בשעה\s+|ב)(?<hw>${HOUR_NAME_ALT})(?![א-ת])` +
      String.raw`(?:\s+ו(?<half>חצי|רבע))?\s*(?<period>${PERIOD})?`,
  ).exec(t);
  if (word) {
    const g = word.groups!;
    const hour = HOUR_NAMES[g.hw.replace(/\s+/g, ' ')];
    if (hour === undefined) return null;
    return {
      hour: applyPeriod(hour, g.period),
      minute: g.half ? (g.half === 'חצי' ? 30 : 15) : 0,
      matched: word[0],
      settled: Boolean(g.period),
    };
  }

  // English with an explicit meridiem: "at 8pm", "8:30 am".
  const ampm = /(?:^|\s)(?:at\s+)?(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)(?![a-z])/i.exec(t);
  if (ampm) {
    const g = ampm.groups!;
    let hour = Number(g.h);
    const minute = g.m ? Number(g.m) : 0;
    if (hour > 12 || minute > 59) return null;
    if (/pm/i.test(g.ap) && hour < 12) hour += 12;
    if (/am/i.test(g.ap) && hour === 12) hour = 0;
    return { hour, minute, matched: ampm[0], settled: true };
  }

  // Bare "14:30" — always a 24-hour reading, nothing to disambiguate.
  const hhmm = /(?:^|\s)(?:at\s+)?(?<h>\d{1,2}):(?<m>\d{2})/.exec(t);
  if (hhmm) {
    const g = hhmm.groups!;
    const hour = Number(g.h);
    const minute = Number(g.m);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, matched: hhmm[0], settled: true };
  }

  // "at 9" — the "at" is doing the same work Hebrew's "ב" does, so it carries
  // the same ambiguity and gets the same one-tap correction.
  const bareAt = /(?:^|\s)at\s+(?<h>\d{1,2})(?![:\d])/i.exec(t);
  if (bareAt) {
    const hour = Number(bareAt.groups!.h);
    if (hour > 23) return null;
    return { hour, minute: 0, matched: bareAt[0], settled: hour > 12 };
  }

  return null;
}

function applyPeriod(hour: number, period: string | undefined): number {
  if (!period) return hour;
  if (/בלילה/.test(period)) return hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
  if (/בערב/.test(period)) return hour < 12 ? hour + 12 : hour;
  if (/צהריי?ם|אחה"צ/.test(period)) return hour >= 1 && hour <= 6 ? hour + 12 : hour;
  return hour; // בבוקר: leave as written.
}

interface DayHint {
  /** Calendar days from today, or null when he named a weekday instead. */
  offset: number | null;
  dow: number | null;
  matched: string;
}

/** "מחר" · "מחרתיים" · "היום" · "ביום שלישי" · "בשבת". */
function matchDay(t: string): DayHint | null {
  // מחרתיים FIRST — /מחר/ matches inside it, and testing the short form first
  // is exactly how "מחרתיים ב-9" became a reminder called "תיים", one day early.
  const twoDays = /(?:^|\s)מחרתיים|day\s+after\s+tomorrow/i.exec(t);
  if (twoDays) return { offset: 2, dow: null, matched: twoDays[0] };

  const tomorrow = /(?:^|\s)מחר(?![א-ת])|tomorrow/i.exec(t);
  if (tomorrow) return { offset: 1, dow: null, matched: tomorrow[0] };

  const today = /(?:^|\s)היום(?![א-ת])|today/i.exec(t);
  if (today) return { offset: 0, dow: null, matched: today[0] };

  // "ביום שלישי". The bare "בשלישי" form is left to the router on purpose:
  // "בשני" is just as readable as "in two" and guessing wrong costs a day.
  // "בשבת" is the exception — it can only ever mean Saturday.
  const named =
    new RegExp(String.raw`(?:^|\s)ב?יום\s+(?<d>${WEEKDAY_ALT})(?![א-ת])`).exec(t) ??
    /(?:^|\s)ב(?<d>שבת)(?![א-ת])/.exec(t);
  if (named) return { offset: null, dow: WEEKDAYS[named.groups!.d], matched: named[0] };

  return null;
}

// ------------------------------------------------------- assembly

/** Strip the phrases we consumed plus the "remind me" framing; what's left is the task. */
function cleanTitle(t: string, consumed: string[]): string {
  let s = t;
  for (const c of consumed) if (c) s = s.replace(c, ' ');
  return s
    .replace(/תזכיר\s+לי|תזכורת|תנדנד\s+לי|תעיר\s+לי|remind\s+me(\s+to)?/gi, ' ')
    .replace(/^\s*(ל|על|ש|that|to)\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseClockTime(t: string, nowMs: number, tz: string): Intent | null {
  const clock = matchClock(t);
  if (!clock) return null;
  const day = matchDay(t);

  const title = cleanTitle(t, [clock.matched, day?.matched ?? '']);
  // Rule 2: an unconsumed time word means we understood only part of the phrase.
  if (TIME_RESIDUE.test(title)) return null;

  const at = resolve(clock, day, nowMs, tz);
  if (at === null) return null;

  return {
    action: 'create_reminder',
    title: (title || 'תזכורת').slice(0, 120),
    schedule_type: 'once',
    once_at: wallString(at.ts, tz),
    ...(at.altHour === undefined ? {} : { ambiguous_hour: at.altHour }),
  };
}

/**
 * Turn a clock reading plus an optional day hint into an instant.
 *
 * A bare hour like "ב-8" could be 08:00 or 20:00. Capture must never block on a
 * question, so it commits to the literal reading and offers the other as a
 * one-tap correction. Predictable beats clever: no inference from the wording of
 * the task itself.
 */
function resolve(
  clock: Clock,
  day: DayHint | null,
  nowMs: number,
  tz: string,
): { ts: number; altHour?: number } | null {
  const ambiguous = !clock.settled && clock.hour <= 12;
  const altHour = ambiguous ? (clock.hour + 12) % 24 : undefined;
  const at = (offset: number, hour: number) => {
    const p = wallParts(nowMs + offset * 86_400_000, tz);
    return wallToUtc(p.year, p.month, p.day, hour, clock.minute, tz);
  };

  if (day?.dow != null) {
    const delta = (day.dow - wallParts(nowMs, tz).dow + 7) % 7;
    let ts = at(delta, clock.hour);
    if (ts <= nowMs) ts = at(delta + 7, clock.hour);
    return { ts, altHour };
  }

  if (day?.offset != null) {
    const ts = at(day.offset, clock.hour);
    if (ts > nowMs) return { ts, altHour };
    // He said "today" and that hour is already behind us. If the other reading
    // of an ambiguous hour is still ahead, he plainly meant that one.
    if (ambiguous) {
      const pm = at(day.offset, altHour!);
      if (pm > nowMs) return { ts: pm };
    }
    // "היום ב-7 בבוקר" said at 14:30 is not a request this file can honour
    // without contradicting the word he used. Let the router ask.
    return null;
  }

  let ts = at(0, clock.hour);
  if (ts <= nowMs) ts = at(1, clock.hour);
  return { ts, altHour };
}

/** Returns a create_reminder Intent, or null to let the LLM router handle it. */
export function quickParse(text: string, nowMs: number, tz: string): Intent | null {
  const t = text.trim();
  if (!t) return null;
  if (RECURRING.test(t)) return null;
  // Rule 1: this path only ever answers an explicit request.
  if (!ASKED.test(t)) return null;
  // Two times in one message means two reminders. One Intent cannot hold both,
  // and guessing which one he meant is how a reminder goes missing.
  if (countTimeAnchors(t) > 1) return null;

  const rel = parseRelative(t);
  // Two months out is past the point where "in N weeks" is the phrasing anyone
  // reaches for, and well past where a typo stops being obvious.
  if (rel !== null && rel.minutes >= 1 && rel.minutes <= 60 * 24 * 60) {
    const title = cleanTitle(t, [rel.matched]);
    if (TIME_RESIDUE.test(title)) return null;
    return {
      action: 'create_reminder',
      title: (title || 'תזכורת').slice(0, 120),
      schedule_type: 'once',
      in_minutes: rel.minutes,
    };
  }

  return parseClockTime(t, nowMs, tz);
}
