import type { Intent } from './types';
import { wallParts, wallString, wallToUtc } from './time';

/**
 * Deterministic fast path for the single most common request:
 * "remind me to X in N minutes".
 *
 * This exists because routing that phrase through an LLM is all downside — it
 * costs a round trip, and when the model hiccups (RECITATION, MAX_TOKENS, a
 * bad JSON parse) the reminder silently isn't created, which is the one failure
 * this bot must never have. A regex either matches or it doesn't, and when it
 * doesn't we still fall through to the router.
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

const HOUR_WORD = /^(שעות|שעה|שעתיים|hours?|hrs?|h)$/i;
const MIN_WORD = /^(דקות|דקה|דק'?|minutes?|mins?|m)$/i;

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
 */
const RECURRING =
  /כל\s+(יום|יומיים|שבוע|שבועיים|בוקר|צהריי?ם|ערב|לילה|שעה|שעתיים|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|מדי\s+(יום|בוקר|ערב|שבוע)|פעמיים\s+ביום|\bevery\s+(day|week|morning|evening|night|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|יומי|שבועי/i;

/**
 * Time phrases in the message, however they are worded. Two or more means he
 * asked for two different things at two different times, which this file has no
 * way to express — one Intent carries one schedule. Hand it to the router.
 */
const TIME_ANCHOR =
  /(?:^|\s)(?:[ובלמ]?(?:עוד|בעוד|תוך)|in)\s|(?:^|\s)ו?ב\s*-?\s*\d{1,2}(?::\d{2})?|(?:^|\s)(?:and\s+)?(?:at\s+)?\d{1,2}:\d{2}/gi;

function countTimeAnchors(t: string): number {
  TIME_ANCHOR.lastIndex = 0;
  let n = 0;
  while (TIME_ANCHOR.exec(t) !== null) n++;
  return n;
}

/** Lead-in for a relative time: "עוד", "בעוד", "ובעוד", "תוך", "in". */
const LEAD = String.raw`(?:^|\s)(?:[ובלמ]?(?:עוד|בעוד|תוך)|in)\s+`;
const UNIT_H = String.raw`(?:שעות|שעה|hours?|hrs?|h)`;
const UNIT_M = String.raw`(?:דקות|דקה|דק['׳]?|minutes?|mins?|m)`;
// Right-hand boundary that works for Hebrew, unlike `\b`.
const END = String.raw`(?=$|[\s.,!?])`;

const REL_TWO_HOURS = new RegExp(LEAD + `שעתיים` + END, 'i');
const REL_FRACTION = new RegExp(
  LEAD + `(חצי|רבע|half|quarter)\\s+(?:an?\\s+)?(?:שעה|hour)` + END,
  'i',
);
const REL_COUNTED = new RegExp(LEAD + `(\\S+)\\s+(${UNIT_H}|${UNIT_M})` + END, 'i');
const REL_BARE = new RegExp(LEAD + `(${UNIT_H}|${UNIT_M})` + END, 'i');

/**
 * "in N minutes/hours" and friends, returning the phrase that was consumed so
 * the caller can strip exactly that much and keep the rest as the title.
 * Matching the phrase precisely matters: an earlier version consumed one word
 * too many and turned "בעוד שעתיים להתקשר לאמא" into a reminder called "לאמא".
 */
function parseRelative(t: string): { minutes: number; matched: string } | null {
  const two = REL_TWO_HOURS.exec(t);
  if (two) return { minutes: 120, matched: two[0] };

  const frac = REL_FRACTION.exec(t);
  if (frac) return { minutes: /חצי|half/i.test(frac[1]) ? 30 : 15, matched: frac[0] };

  const counted = REL_COUNTED.exec(t);
  if (counted) {
    const n = toNumber(counted[1]);
    if (n !== null) {
      const unit = counted[2];
      return { minutes: HOUR_WORD.test(unit) ? n * 60 : n, matched: counted[0] };
    }
  }

  // "עוד שעה" / "עוד דקה" — a bare unit with no number in front means one.
  const bare = REL_BARE.exec(t);
  if (bare) return { minutes: HOUR_WORD.test(bare[1]) ? 60 : 1, matched: bare[0] };

  return null;
}

/**
 * "ב-11 בלילה" · "ב23:00" · "מחר ב-7 בבוקר" — an absolute clock time today or
 * tomorrow. Only fast-pathed when the hour is unambiguous: either written as
 * HH:MM, or given a part-of-day word. A bare "ב-11" could mean 11:00 or 23:00,
 * so that one goes to the router where context can settle it.
 */
function parseClockTime(t: string, nowMs: number, tz: string): Intent | null {
  const m =
    /(?:^|\s)ב\s*-?\s*(\d{1,2})(?::(\d{2}))?\s*(בלילה|בבוקר|בערב|בצהריי?ם|אחה"צ|אחר\s+הצהריי?ם)?/.exec(
      t,
    ) ?? /(?:^|\s)(?:at\s+)?(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const period = m[3];
  if (hour > 23 || minute > 59) return null;

  if (period) {
    if (/בלילה/.test(period)) hour = hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
    else if (/בערב/.test(period)) hour = hour < 12 ? hour + 12 : hour;
    else if (/צהריי?ם|אחה"צ/.test(period)) hour = hour >= 1 && hour <= 6 ? hour + 12 : hour;
    // בבוקר: leave as written.
  } else if (!m[2]) {
    // No minutes and no part-of-day word — genuinely ambiguous. Let the LLM
    // read the surrounding conversation instead of guessing wrong.
    return null;
  }

  const tomorrow = /מחר|tomorrow/i.test(t);
  const base = wallParts(nowMs + (tomorrow ? 86_400_000 : 0), tz);
  let at = wallToUtc(base.year, base.month, base.day, hour, minute, tz);
  if (at <= nowMs) {
    const next = wallParts(nowMs + 86_400_000, tz);
    at = wallToUtc(next.year, next.month, next.day, hour, minute, tz);
  }

  const title =
    t
      .replace(m[0], ' ')
      .replace(/תזכיר\s+לי|תזכורת|תנדנד\s+לי|remind\s+me(\s+to)?|מחר|tomorrow/gi, ' ')
      .replace(/^\s*(ל|על|ש|that|to)\s+/i, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'תזכורת';

  return {
    action: 'create_reminder',
    title: title.slice(0, 120),
    schedule_type: 'once',
    once_at: wallString(at, tz),
  };
}

/** Returns a create_reminder Intent, or null to let the LLM router handle it. */
export function quickParse(text: string, nowMs: number, tz: string): Intent | null {
  const t = text.trim();
  if (!t) return null;
  if (RECURRING.test(t)) return null;
  // Two times in one message means two reminders. One Intent cannot hold both,
  // and guessing which one he meant is how a reminder goes missing.
  if (countTimeAnchors(t) > 1) return null;

  // Only treat it as a reminder request if he actually asked for one.
  const asked = /תזכיר|תזכורת|תנדנד|remind|ping/i.test(t);

  const rel = parseRelative(t);
  const minutes = rel?.minutes ?? null;

  // No relative time found (or it was out of range) — try an absolute clock
  // time, but only if he actually asked for a reminder.
  if (minutes === null || minutes < 1 || minutes > 60 * 24 * 7) {
    return asked ? parseClockTime(t, nowMs, tz) : null;
  }

  // Whatever is left after removing the time phrase and the "remind me" framing
  // is the thing he actually wants to be reminded about.
  const title =
    t
      .replace(rel!.matched, ' ')
      .replace(/תזכיר\s+לי|תזכורת|תנדנד\s+לי|remind\s+me(\s+to)?/gi, ' ')
      .replace(/^\s*(ל|על|ש|that|to)\s+/i, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'תזכורת';

  return {
    action: 'create_reminder',
    title: title.slice(0, 120),
    schedule_type: 'once',
    in_minutes: minutes,
  };
}
