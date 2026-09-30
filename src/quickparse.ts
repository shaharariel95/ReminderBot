import type { Intent } from './types';
import { UNTITLED_TITLE } from './types';
import { localDateKey, wallParts, wallString, wallToUtc } from './time';

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

export function toNumber(word: string): number | null {
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
/*
 * EVERY PHRASE MISSING FROM THIS REGEX WAS A CONFIDENT WRONG ANSWER, not a
 * miss — which is why it is worth being greedy here.
 *
 * `readWhen` refuses anything this matches and `quickParse` routes it to
 * `parseRecurring`. A phrase it does NOT match therefore falls through to the
 * clock path, which reads the hour, leaves the repeat words in the title, and
 * writes a `once`. Production, 30.09.2026 22:19:
 *
 *   him  תזכיר לי פעם בשבוע בימי שני בשעה 8 בערב להשקות את העציץ
 *   bot  קבעתי #96: "פעם בשבוע בימי שני להשקות את העציץ"
 *         — יום ה׳, 01.10.2026, 20:00.
 *
 * A weekly reminder became one fire, on a Thursday, with "פעם בשבוע" sitting
 * in the title as decoration. `כל חודש` was the same shape and worse: it
 * BEGINS with כל and still missed, because the alternation below had no
 * `חודש` arm, so rent was set once and never again.
 *
 * Over-matching costs one LLM call. Under-matching ends a recurrence. So the
 * arms below are deliberately loose — "כל ימי חייו" reaching the router is
 * the safe direction, and the only direction that is.
 *
 * Note the PLURAL `ימי` arm. "בימי שני" means "on Mondays" — habitual, and a
 * recurrence in its own right — while the singular "ביום שני" names one date
 * and is `matchDay`'s business. That is why the plural lives here rather than
 * in WEEKDAY_RESIDUE: as a recurrence marker it must bail unconditionally,
 * and WEEKDAY_RESIDUE is relaxed whenever an offset word already pinned the
 * day (see hasTimeResidue), which would have excused it in exactly the
 * sentence it appears in.
 */
export const RECURRING = new RegExp(
  [
    // כל + a unit or a weekday. `חודש`/`שנה` are the two that cost real
    // writes; the duals carry "כל יומיים"/"כל שבועיים".
    String.raw`כל\s+(?:יום|יומיים|שבוע|שבועיים|חודש|חודשיים|חודשים|שנה|שנתיים|שנים|בוקר|צהריי?ם|ערב|לילה|שעה|שעתיים|${WEEKDAY_ALT})`,
    // A counted interval. Minutes and hours were here; days, weeks and months
    // were not, so "כל 3 ימים" read as a bare clock. The optional ל is what
    // lets "כל 1 לחודש" — the ordinal-first way to name a day of the month —
    // be seen at all; without it that phrase fell through to the clock path
    // and became a one-off titled "כל 1 לחודש לשלם שכירות".
    String.raw`כל\s+\S+\s*ל?(?:דקות|דקה|שעות|שעה|ימים|יום|שבועות|שבוע|חודשים|חודש)`,
    String.raw`מדי\s+(?:יום|בוקר|ערב|שבוע|חודש|שנה)`,
    // "פעם בשבוע" — the #96 phrase, and the one anybody reaches for first.
    // The unit is REQUIRED so a bare "פעם" in an errand cannot match.
    String.raw`(?:פעם|פעמיים|שלוש\s+פעמים)\s+ב(?:יום|שבוע|שבועיים|חודש|חודשיים|שנה)`,
    // The plural weekday — see the note above.
    String.raw`(?:^|\s)[ובלמ]?ימי\s+(?:${WEEKDAY_ALT})(?![א-ת])`,
    // "ימי חול" / "יום עבודה" — the working week as a unit.
    String.raw`(?:^|\s)[ובלמ]?(?:ימי|יום)\s+(?:חול|עבודה)(?![א-ת])`,
    // An EXCLUSION is a repeat rule by implication: nobody excludes a day
    // from a single fire. "כל יום חוץ משבת" matched `כל יום` and was read as
    // plain daily, so the Saturday he excluded rang anyway.
    String.raw`(?:^|\s)(?:חוץ\s+מ|למעט|פרט\s+ל)`,
    String.raw`\bevery\s+(?:other\s+)?(?:\d{1,3}\s+)?(?:days?|weeks?|months?|years?|morning|evening|night|hours?|minutes?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)`,
    String.raw`\b(?:weekdays?|monthly|yearly|annually)\b`,
    String.raw`(?:יומי|שבועי|חודשי|שנתי)[תם]?(?![א-ת])`,
  ].join('|'),
  'i',
);

/**
 * A repeat rule that survived into the title, plus the fragments consuming one
 * can LEAVE BEHIND.
 *
 * `RECURRING` asked of the leftovers instead of the message — the same
 * question `hasTimeResidue` asks about clocks, and it belongs in the same
 * place for the same reason. `parseRecurring`'s own `finish` has always tested
 * `RECURRING.test(title)`; `parseClockTime` and the relative-time path never
 * did, which is the asymmetry that let #96 through even once `RECURRING` was
 * widened.
 *
 * The extra arm is the working-week qualifier standing ALONE. "כל יום חול
 * בשעה 7 לקום" has its "כל יום" eaten by RE_DAILY, and what is left is
 * "חול לקום" — the half that decides which days ring, with nothing
 * recurrence-shaped about it any more, so neither RECURRING nor CLOCK_RESIDUE
 * can see it and the row is written as plain daily, ringing on Saturday.
 *
 * `עבודה` is here because the red-proof found it: with only `חול` in this
 * arm, "כל יום עבודה בשעה 7 לקום" still came back `daily` titled
 * "עבודה לקום". Two words for one week, and the guard knew one of them.
 */
const REPEAT_RESIDUE = new RegExp(
  [RECURRING.source, String.raw`(?:^|\s)(?:חול|עבודה)(?![א-ת])`].join('|'),
  'i',
);

/**
 * Did he ask for a NEW reminder — as opposed to talking about one he has?
 *
 * This used to be `/תזכיר|תזכורת|תנדנד|תעיר לי|remind|ping/`, and the bare noun
 * in the middle of it was the bug. "תזכורת" is a NOUN: it says what he is
 * talking about, not what he is asking for. "בוא הזיז את התזכורת של הבשר
 * ל15:00" satisfied that gate on 14.08.2026 and produced a third reminder
 * called "בוא הזיז את ה של הבשר" — the stray "ה" being what survives of
 * "התזכורת" once cleanTitle strips the noun out of the title.
 *
 * The first attempt at a fix was a blocklist of move verbs, and it was wrong
 * twice over. It could not be complete — "הזיז" is neither "הזז" nor "תזיז",
 * and Hebrew has more forms where those came from. And it was actively
 * harmful: "הזיז" is a SUBSTRING of "להזיז", so adding the form he actually
 * typed would have refused "תזכיר לי להזיז את הארון מחר ב8" — a perfectly good
 * reminder whose SUBJECT happens to be moving something. What he wants to be
 * reminded of is none of this file's business.
 *
 * So the gate asks about grammar instead, and there is no verb list anywhere:
 *
 *   1. A request aimed at the bot — "תזכיר לי", "תנדנד לי", "remind me".
 *   2. A placement — "שים לי תזכורת", "תקבע תזכורת".
 *   3. Never, if the reminder is DEFINITE. "התזכורת" is *the* reminder, which
 *      by definition already exists, so the message is about operating on it.
 *      That one line retires the whole blocklist: it does not care which verb
 *      he reached for, or whether this file has ever heard of it.
 */
const REQUEST_VERB = /תזכיר|תנדנד|תעיר\s+לי|remind|ping/i;
const PLACE_REMINDER = /(?:^|\s)(?:תשים|שים|תקבע|קבע|תוסיף|הוסף)\s+(?:לי\s+)?תזכורת(?![א-ת])/;
/** The definite article is the tell. Longest alternative first, or "התזכורות"
 *  matches "התזכורת" and then trips the letter boundary. */
const ABOUT_EXISTING = /ה(?:תזכורות|תזכורת)(?![א-ת])/;

export function asksForNewReminder(t: string): boolean {
  if (ABOUT_EXISTING.test(t)) return false;
  return REQUEST_VERB.test(t) || PLACE_REMINDER.test(t);
}

// A blocklist of move verbs used to live here. It is gone on purpose — see
// asksForNewReminder above for why enumerating verb forms was both impossible
// to finish and harmful to get right.

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
    String.raw`(?:^|\s)ו?[בל]שעה\s+(?:\d{1,2}(?::\d{2})?|${HOUR_NAME_ALT})`,
    String.raw`(?:^|\s)ו?ב(?:${HOUR_NAME_ALT})(?![א-ת])`,
    String.raw`(?:^|\s)ו?ב\s*-?\s*\d{1,2}(?::\d{2})?`,
    // Must come before the bare-colon alternative below, or that one matches
    // the digits alone and the ל is left behind as residue — which reads as an
    // incomplete parse and bails a message this file understands perfectly.
    String.raw`(?:^|\s)ל\s*-?\s*\d{1,2}:\d{2}`,
    String.raw`(?:^|\s)(?:and\s+)?(?:at\s+)?\d{1,2}:\d{2}`,
    String.raw`(?:^|\s)at\s+\d{1,2}`,
    String.raw`(?:^|\s)\d{1,2}\s*(?:am|pm)`,
  ].join('|'),
  'gi',
);

export function countTimeAnchors(t: string): number {
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
const CLOCK_RESIDUE = new RegExp(
  [
    String.raw`(?:^|\s)ו?(?:וחצי|ורבע|[בל]שעה|מחרתיים|מחר|היום|${PERIOD}|tomorrow|today|am|pm)(?:$|[\s.,!?])`,
    String.raw`(?:^|\s)ו?ב\s*-?\s*\d{1,2}(?::\d{2})?(?:$|[\s.,!?])`,
    String.raw`(?:^|\s)ו?ב(?:${HOUR_NAME_ALT})(?![א-ת])`,
    String.raw`\d{1,2}:\d{2}`,
  ].join('|'),
  'i',
);

/**
 * Both the "ביום שלישי" form we consume and the bare "בשלישי" form we
 * deliberately refuse to guess at — either one still sitting in the title
 * USUALLY means the day was never accounted for. See hasTimeResidue for the
 * one case where it means the opposite.
 */
const WEEKDAY_RESIDUE = new RegExp(
  [
    String.raw`(?:^|\s)ו?ב?יום\s+(?:${WEEKDAY_ALT})(?:$|[\s.,!?])`,
    String.raw`(?:^|\s)ו?ב(?:${WEEKDAY_ALT})(?![א-ת])`,
  ].join('|'),
  'i',
);

/**
 * "בבוקר של יום חמישי" — the morning OF Thursday. A possessive phrase like
 * this is a noun: it names when an APPOINTMENT is, not when to fire, and it
 * belongs in the title. Stripped before the residue check so it cannot be
 * mistaken for a schedule the parser failed to consume.
 *
 * The "של" is doing all the work here. Without it, "ב-8 בבוקר ובערב" is two
 * doses and must still bail — a conjoined period is a second instruction,
 * a possessive one is subject matter.
 */
// PERIOD is an alternation, so it needs its own group before `\s+` is attached:
// `(?:א|ב\s+)?` binds the space to the last branch only, which silently left
// "בבוקר" behind and made this whole strip a no-op for the message it exists for.
const SUBJECT_DAY = new RegExp(
  String.raw`(?:(?:${PERIOD})\s+)?של\s+יום\s+(?:${WEEKDAY_ALT})(?![א-ת])`,
  'gi',
);

/**
 * Rule 2 from the top of the file: a time word that survived into the title
 * means the parse was incomplete.
 *
 * `dayPinned` is the exception, and it is narrow. When an explicit offset word
 * — מחר, היום, מחרתיים — already fixed the day, a weekday appearing later
 * cannot change the answer, so it is no longer evidence of anything: it is
 * what the task is about. This is the 09.08.2026 message ("...לוודא שאני
 * מגיע בבוקר של יום חמישי..."), which bailed to the router and came back an
 * hour wrong.
 *
 * It stays false when the day came from a weekday itself: two weekdays in one
 * message really are two days, and nothing settles which one wins. The clock
 * half of the guard is never relaxed — a stray period can still change an
 * unsettled hour, and that is a different question from which day it is.
 */
function hasTimeResidue(title: string, dayPinned: boolean): boolean {
  const t = title.replace(SUBJECT_DAY, ' ');
  if (CLOCK_RESIDUE.test(t)) return true;
  /*
   * A repeat rule in the title, and `dayPinned` does NOT excuse it.
   *
   * The relaxation above exists because a weekday cannot change an answer a
   * מחר/היום already fixed. A repeat rule can change it completely — it says
   * the reminder does not have one answer at all — so it is evidence whatever
   * else is in the sentence.
   *
   * Checked HERE rather than at each call site, because that was the bug:
   * `parseRecurring`'s `finish` tested it and the two non-recurring create
   * paths did not, so one question had two implementations and only one of
   * them bit. See REPEAT_RESIDUE.
   */
  if (REPEAT_RESIDUE.test(t)) return true;
  return !dayPinned && WEEKDAY_RESIDUE.test(t);
}

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
export function parseRelative(t: string): { minutes: number; matched: string } | null {
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

/**
 * A length introduced by ב rather than by עוד — "בחצי שעה", "ב-20 דקות",
 * "בשעתיים". This is how a snooze gets phrased at least as often as with עוד,
 * and it is the wording /help itself advertises.
 *
 * The number must come BEFORE the unit. That single rule is what keeps a clock
 * reading out: "בשעה 10" puts the number after, so none of these match it, and
 * there is deliberately no bare-unit form (a bare "בשעה" is one keystroke away
 * from a time and worth nothing as a duration).
 */
const B_LEAD = String.raw`(?:^|\s)ב\s*-?\s*`;
const B_FRACTION = new RegExp(B_LEAD + String.raw`(?<frac>חצי|רבע)\s+שעה` + END, 'i');
const B_DUAL = new RegExp(B_LEAD + String.raw`(?<dual>שעתיים|יומיים|שבועיים)` + OPT_HALF + END, 'i');
const B_COUNTED = new RegExp(B_LEAD + String.raw`(?<n>\S+)\s+(?<unit>${UNIT})` + OPT_HALF + END, 'i');

/**
 * Minutes in an explicit length the user actually stated, or null when they
 * stated none.
 *
 * Exists for snooze. `applyIntent` falls back to 30 minutes when the router
 * omits `snooze_minutes`, and voice.ts then reports that fallback as a number
 * he chose — which is how "עוד שעה" came back as "הזזתי ב-30 דקות" in the
 * 10.08.2026 transcript. The default is fine; announcing it as his words is
 * not. Returning null rather than a guess is the point: it tells the caller
 * "he named no length", which is a different fact from "he named 30 minutes".
 */
/**
 * Is this fragment nothing but a time word?
 *
 * The same vocabulary CLOCK_RESIDUE polices, asked as a question about a whole
 * fragment rather than about a title's insides — because the caller
 * (effects.splitIntoItems) is deciding whether a comma-separated part names an
 * ERRAND, and "להיום" names a day.
 *
 * Production, reminder 57: "לקבוע רעמוו נשק במאי, להיום" was split into two
 * tickable items, the second of them "להיום", and the nag then read
 * "עזוב את 'להיום'. רק תעשה את החלק של לקבוע רעמוו נשק במאי" — the bot naming
 * an errand that does not exist. splitIntoItems counts a part as an action
 * when it starts with ל plus a letter, and ל+היום passes that test.
 *
 * Deliberately NOT a rule about ל followed by ה: "להיות", "להיכנס",
 * "להירדם" and every other nif'al infinitive have exactly that shape and are
 * real errands. What makes "להיום" different is the WORD, not the letters, so
 * this matches whole words off a closed list — days and parts of the day, with
 * the one-letter prefixes Hebrew glues onto them. Anchored, so it can only
 * ever reject a fragment that is a time word and nothing else.
 */
const BARE_TIME_WORD = new RegExp(
  String.raw`^[ולבמ]?(?:היום|הערב|הבוקר|הלילה|הצהריי?ם|מחרתיים|מחר|אתמול|` +
    String.raw`בוקר|ערב|לילה|צהריי?ם|${PERIOD})$`,
  'i',
);

export function isBareTimeWord(s: string): boolean {
  return BARE_TIME_WORD.test(s.trim());
}

export function parseDuration(text: string): number | null {
  const rel = parseRelative(text);
  if (rel && rel.minutes > 0) return rel.minutes;

  const frac = B_FRACTION.exec(text);
  if (frac) return /חצי/.test(frac.groups!.frac) ? 30 : 15;

  const dual = B_DUAL.exec(text);
  if (dual) {
    const unit = DUALS[dual.groups!.dual];
    return unit * 2 + halfBonus(dual.groups!.half, unit);
  }

  const counted = B_COUNTED.exec(text);
  if (counted) {
    const n = toNumber(counted.groups!.n);
    const unit = unitMinutes(counted.groups!.unit);
    // Both halves have to be real. A word that is not a number ("בעבודה שעות")
    // must fall through to null, not quietly become NaN minutes.
    if (n !== null && unit > 0) return n * unit + halfBonus(counted.groups!.half, unit);
  }

  return null;
}

/**
 * Every length-of-time phrase in `text`, with where it sits, so a caller can
 * judge each one in context. Unlike parseDuration this takes no lead-in word:
 * it is looking for quantities wherever they appear, because validate.ts has
 * to police the ones the model wrote unprompted.
 *
 * `(?<![א-ת])` is what keeps a clock out: "בשעה 10" and "היום" both glue a
 * Hebrew letter onto the front of the unit, and neither is a duration. A bare
 * unit with nothing in front of it ("שעה וחצי") is one.
 */
/**
 * The number words themselves, longest first so "עשרים" never loses to "עשר".
 * Spelled out rather than approximated as `[א-ת]+`: a catch-all there lets any
 * word in front of a unit swallow it, so "כבר שבוע" parses as <not-a-number>
 * + "שבוע" and the phrase vanishes from the scan entirely instead of being
 * read as one week.
 */
const NUMBER_WORD_ALT = [...Object.keys(HE_NUMBERS), ...Object.keys(EN_NUMBERS)]
  .sort((a, b) => b.length - a.length)
  .join('|');

const DURATION_SCAN = new RegExp(
  String.raw`(?<![א-ת])(?:` +
    String.raw`(?<dual>שעתיים|יומיים|שבועיים)(?:\s+ו(?<dualHalf>חצי|רבע))?` +
    '|' +
    String.raw`(?<frac>חצי|רבע)\s+(?<fracUnit>שעות|שעה|דקות|דקה|ימים|יום|שבוע)` +
    '|' +
    String.raw`(?<n>\d{1,4}|${NUMBER_WORD_ALT})\s+(?<unit>${UNIT})(?:\s+ו(?<nHalf>חצי|רבע))?` +
    '|' +
    String.raw`(?<bare>שעה|דקה|יום|שבוע)(?:\s+ו(?<bareHalf>חצי|רבע))?` +
    ')',
  'gi',
);

export interface DurationHit {
  minutes: number;
  /** Everything before the phrase, and everything after — the caller's context. */
  before: string;
  after: string;
}

export function scanDurations(text: string): DurationHit[] {
  const hits: DurationHit[] = [];
  // `.matchAll` rather than a shared `.exec` loop: DURATION_SCAN is /g, and a
  // stale lastIndex carried between calls would silently skip phrases.
  for (const m of text.matchAll(DURATION_SCAN)) {
    const g = m.groups!;
    let minutes: number | null = null;
    if (g.dual) {
      const unit = DUALS[g.dual];
      minutes = unit * 2 + halfBonus(g.dualHalf, unit);
    } else if (g.frac) {
      const unit = unitMinutes(g.fracUnit);
      minutes = /חצי/.test(g.frac) ? unit / 2 : unit / 4;
    } else if (g.n) {
      const n = toNumber(g.n);
      const unit = unitMinutes(g.unit);
      // A word that is not a number in front of a real unit ("הטלפון שעות")
      // is not a quantity — it is a sentence that happens to contain one.
      if (n !== null && unit > 0) minutes = n * unit + halfBonus(g.nHalf, unit);
    } else if (g.bare) {
      const unit = unitMinutes(g.bare);
      minutes = unit + halfBonus(g.bareHalf, unit);
    }
    if (minutes === null || minutes <= 0) continue;
    hits.push({
      minutes,
      before: text.slice(0, m.index),
      after: text.slice(m.index + m[0].length),
    });
  }
  return hits;
}

// ------------------------------------------------------- absolute times

export interface Clock {
  hour: number;
  minute: number;
  matched: string;
  /** "בערב"/"pm" was written, so the 12-hour reading is settled. */
  settled: boolean;
}

/** "ב-8" · "בשעה 20:30" · "בשמונה וחצי" · "at 8pm" · "14:30". */
export function matchClock(t: string): Clock | null {
  // Hebrew, digits: "ב-8", "ב8:30", "בשעה 20:30", "ב-8 וחצי", "ב-11 בלילה".
  // "ל-15:00" — how Hebrew names the new time when moving something, and the
  // form that made "בוא הזיז את התזכורת של הבשר ל15:00" (13.08.2026) parse as
  // no time at all.
  //
  // The colon is REQUIRED, and that is the whole guard: a bare "ל-4" is far
  // more often a quantity than a clock ("לקנות 3 ל-4 אנשים"), and there is no
  // way to tell from the digits. A colon cannot be a quantity. The bare form
  // is left to the router, which has an explicit "תעביר את זה ל-8" example.
  const lamed = /(?:^|\s)ל\s*-?\s*(?<h>\d{1,2}):(?<m>\d{2})/.exec(t);
  if (lamed) {
    const hour = Number(lamed.groups!.h);
    const minute = Number(lamed.groups!.m);
    if (hour > 23 || minute > 59) return null;
    // Written with minutes, so the 12-hour reading is settled — "ל-15:00"
    // cannot mean 03:00 and must not offer it as a correction.
    return { hour, minute, matched: lamed[0], settled: true };
  }

  const num = new RegExp(
    String.raw`(?:^|\s)(?:[בל]שעה\s+|ב\s*-?\s*)(?<h>\d{1,2})(?::(?<m>\d{2}))?` +
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

export interface DayHint {
  /** Calendar days from today, or null when he named a weekday instead. */
  offset: number | null;
  dow: number | null;
  matched: string;
}

/** "מחר" · "מחרתיים" · "היום" · "ביום שלישי" · "בשבת". */
export function matchDay(t: string): DayHint | null {
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
  //
  // The prefix is `[בל]`, not `ב`. "ליום חמישי" is at least as natural as
  // "ביום חמישי" and matched NOTHING, because the `(?:^|\s)` needs whitespace
  // before the ב and "ליום" puts a ל there instead — so the day silently
  // vanished and the clock alone decided, landing "תעביר את זה ליום חמישי
  // ב8:00" on tomorrow. Found by the when.ts regression floor, not in
  // production, which is the point of having one.
  //
  // Note the ל is NOT extended to the "בשבת" branch below. "לשבת" is also the
  // infinitive "to sit", and a reminder about sitting down would be filed
  // under Saturday.
  const named =
    new RegExp(String.raw`(?:^|\s)[בל]?יום\s+(?<d>${WEEKDAY_ALT})(?![א-ת])`).exec(t) ??
    /(?:^|\s)ב(?<d>שבת)(?![א-ת])/.exec(t);
  if (named) return { offset: null, dow: WEEKDAYS[named.groups!.d], matched: named[0] };

  return null;
}

// ------------------------------------------------------- recurring

/** "כל", "בכל", "מדי", "every" — the lead-in that makes a request repeat. */
const EVERY = String.raw`(?:^|\s)[ובלמ]?(?:כל|מדי|every)\s+`;

/**
 * Hours and minutes only. An `interval` schedule counts minutes forward from
 * the last firing, so days and weeks are deliberately excluded: "כל יומיים"
 * expressed as 2880 minutes drifts by an hour at every DST change, and a
 * reminder that slides is worse than one the router handles properly.
 */
const UNIT_HM = String.raw`(?:שעתיים|שעות|שעה|hours?|hrs?|h|דקות|דקה|דק['׳]?|minutes?|mins?|m)`;

const RE_INTERVAL = new RegExp(
  EVERY + String.raw`(?:(?<n>\d{1,3}|\S+)\s+)?(?<unit>${UNIT_HM})` + END,
  'i',
);
/** "שני", "שני ורביעי", "שני, רביעי וחמישי" — one or more weekday names. */
const DAY_LIST = String.raw`(?<days>(?:${WEEKDAY_ALT})(?:\s*(?:ו|,|\s+and\s+)\s*(?:${WEEKDAY_ALT}))*)`;

const RE_WEEKLY = new RegExp(EVERY + String.raw`(?:יום\s+)?` + DAY_LIST + String.raw`(?![א-ת])`, 'i');

/*
 * THE LEAD-INS HE ACTUALLY USED, none of which is `כל <day>`.
 *
 * `כל שני ב-8` has worked since parseRecurring was written. On 30.09.2026 he
 * asked for the same thing three times and reached for a different phrasing
 * every time — "פעם בשבוע בימי שני", then "כל שבוע בים שני". RE_WEEKLY above
 * matches neither, because both name the WEEK first and the day second.
 *
 * The right boundary on `שבוע` is BELT-AND-BRACES, and saying so is the point:
 * the obvious rationale for it — that `כל\s+שבוע` otherwise matches the front
 * of "כל שבועיים" and silently halves a fortnightly request — is what it was
 * written for, and the red-proof disproved it. Removing the boundary leaves
 * every `שבועיים` phrasing still refusing, because the dual suffix "יים" sits
 * where this pattern next requires whitespace, ב/ל, ימי/יום or a weekday, and
 * nothing here can consume it.
 *
 * Kept anyway: it costs nothing and it states the intent, so a later edit that
 * loosens what follows the lead-in cannot reintroduce the halving. But it is
 * not what makes "כל שבועיים" safe, and a comment claiming otherwise is the
 * failure CLAUDE.md names — writing the rule down is not checking it. Same
 * status for `חודש` in MONTH_LEAD.
 */
const WEEK_LEAD = String.raw`(?:[ובלמ]?כל\s+שבוע(?![א-ת])|פעם\s+בשבוע(?![א-ת])|מדי\s+שבוע(?![א-ת])|every\s+week(?![a-z]))`;

/** "כל שבוע ביום שני", "פעם בשבוע בימי שני", "מדי שבוע בשני". */
const RE_WEEKLY_LED = new RegExp(
  String.raw`(?:^|\s)` + WEEK_LEAD + String.raw`\s*,?\s*[בל]?\s*(?:ימי|יום)?\s*` + DAY_LIST +
    String.raw`(?![א-ת])`,
  'i',
);

/**
 * "בימי שני ורביעי" — the PLURAL day phrase carrying the recurrence on its
 * own, with no lead-in anywhere in the sentence.
 *
 * Tried after RE_WEEKLY_LED, not before: "פעם בשבוע בימי שני" matches both,
 * and this one would consume only the day half, leaving "פעם בשבוע" in the
 * title for `finish` to bail on.
 */
const RE_WEEKLY_PLURAL = new RegExp(
  String.raw`(?:^|\s)[ובלמ]?ימי\s+` + DAY_LIST + String.raw`(?![א-ת])`,
  'i',
);

/** Sunday–Thursday. The Israeli working week, and the only one this bot serves. */
const WORK_WEEK = [0, 1, 2, 3, 4];

/**
 * "ימי חול", "כל יום עבודה" — the working week as a single unit.
 *
 * It consumes its own `כל`, so the daily lead does not need stripping
 * separately. Before this, RE_DAILY matched the "כל יום" and left the
 * qualifier in the title: "כל יום חול בשעה 7 לקום" became plain `daily`
 * titled "חול לקום", ringing on the Saturday that "חול" excludes.
 */
const RE_WORKWEEK = new RegExp(
  String.raw`(?:^|\s)[ובלמ]?(?:כל\s+)?(?:ימי|יום)\s+(?:חול|עבודה)(?![א-ת])`,
  'i',
);

/**
 * "כל יום חוץ משבת", "כל יום חוץ משישי ושבת" — every day BUT these.
 *
 * An exclusion is a repeat rule by implication; nobody excludes a day from a
 * single fire. It is expressed as `weekly` with the complement of the named
 * days, so it needs no new schedule type — and it has to be tried before
 * RE_DAILY, which matches the "כל יום" in front of it and read the whole
 * thing as ringing seven days a week.
 */
const RE_EXCLUDE = new RegExp(
  String.raw`(?:חוץ\s+מ|למעט|פרט\s+ל)\s*[בהמ]?(?:ימי\s+|יום\s+)?` + DAY_LIST +
    String.raw`(?![א-ת])`,
  'i',
);

/*
 * "כל חודש ב-10", "פעם בחודש ב-15", "כל 1 לחודש", "בסוף כל חודש".
 *
 * Two shapes because Hebrew puts the ordinal on either side of the noun, and
 * a third for the end of the month, which is the phrasing a standing bill
 * actually gets asked for in.
 */
const MONTH_LEAD = String.raw`(?:[ובלמ]?כל\s+חודש(?![א-ת])|פעם\s+בחודש(?![א-ת])|מדי\s+חודש(?![א-ת])|every\s+month(?![a-z])|monthly)`;
const RE_MONTHLY_DAY = new RegExp(
  String.raw`(?:^|\s)` + MONTH_LEAD + String.raw`\s*,?\s*[בל]\s*-?\s*(?<dom>\d{1,2})(?![\d:])`,
  'i',
);
const RE_MONTHLY_NTH = new RegExp(
  String.raw`(?:^|\s)(?:[ובלמ]?כל\s+)?[בל]?\s*-?\s*(?<dom>\d{1,2})\s+לחודש(?![א-ת])`,
  'i',
);
const RE_MONTH_END = new RegExp(String.raw`(?:^|\s)[ובלמ]?סוף\s+(?:כל\s+)?ה?חודש(?![א-ת])`, 'i');
const RE_DAILY = new RegExp(
  EVERY + String.raw`(?<span>יום|בוקר|ערב|לילה|צהריי?ם|day|morning|evening|night)(?![א-ת])`,
  'i',
);

/** "07:05" from a matched clock — the shape daily/weekly schedules store. */
function hhmm(clock: Clock): string {
  return `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
}

/**
 * "כל יום ב-7 לרוץ" and friends.
 *
 * Worth parsing here rather than routing, because a standing reminder is the
 * phrase a daily driver types most, and until now every one of them cost a
 * round trip AND was lost outright whenever the model was rate-limited — which
 * for a recurring reminder means the habit silently never starts.
 *
 * Anything not covered below still falls through to the router: "פעמיים ביום",
 * "כל יומיים" (an interval in DAYS is not the same as one in minutes, and
 * pretending otherwise drifts by an hour every DST change), and any recurring
 * phrase with no clock time in it at all.
 */
function parseRecurring(t: string): Intent | null {
  const finish = (
    intent: Omit<Intent, 'title'>,
    consumed: string[],
  ): Intent | null => {
    const title = cleanTitle(t, consumed);
    if (hasTimeResidue(title, false) || RECURRING.test(title)) return null;
    return { ...intent, title: (title || UNTITLED_TITLE).slice(0, 120) } as Intent;
  };

  // "כל 20 דקות" / "כל שעה" — no clock time involved, it just repeats.
  const interval = RE_INTERVAL.exec(t);
  if (interval) {
    const g = interval.groups!;
    const dual = /שעתיים/i.test(g.unit);
    const per = dual ? 120 : unitMinutes(g.unit);
    const n = dual || g.n === undefined ? 1 : toNumber(g.n);
    if (n !== null && per > 0) {
      const minutes = n * per;
      if (minutes >= 1 && minutes <= 60 * 24) {
        return finish(
          { action: 'create_reminder', schedule_type: 'interval', interval_minutes: minutes },
          [interval[0]],
        );
      }
    }
    return null;
  }

  /*
   * MONTHLY COMES FIRST, AND READS ITS OWN CLOCK.
   *
   * "כל חודש ב10 בשעה 9" has two `ב`-numbers in it: the tenth and the hour.
   * `matchClock` scans left to right and its `ב\s*-?\s*\d` alternative hits
   * the "ב10" four words before the real "בשעה 9" — so it would return 10:00
   * and the day of the month would vanish.
   *
   * That is the same failure readWhen's numeric date has, with the same fix
   * and the same status: "not an optimisation — a correctness requirement",
   * because a lexer that can see the same characters as two different things
   * has to be given each of them exactly once. So the day-of-month span is
   * removed before anything else lexes the sentence.
   */
  const monthEnd = RE_MONTH_END.exec(t);
  const monthDay = RE_MONTHLY_DAY.exec(t) ?? RE_MONTHLY_NTH.exec(t);
  if (monthEnd || monthDay) {
    const eaten = [monthEnd?.[0], monthDay?.[0]].filter((x): x is string => Boolean(x));
    let rest = t;
    for (const c of eaten) rest = rest.replace(c, ' ');
    const monthClock = matchClock(rest);
    // `monthEnd` wins when both matched: "בסוף כל חודש" is the last day
    // whatever number happens to be elsewhere in the sentence.
    const dom = monthEnd ? 31 : Number(monthDay!.groups!.dom);
    if (!(dom >= 1 && dom <= 31)) return null;
    /*
     * NO HOUR STILL REPORTS THE RECURRENCE. It used to return null here.
     *
     * "כל חודש ב-10 לשלם שכירות" names how often and not when, and returning
     * null threw away the half that WAS read — handing the whole sentence to
     * the router, whose answer to "how often" is a guess where this is a
     * reading. `time` is left absent, so `scheduleFromIntent` still refuses and
     * the row is still captured rather than written; the recurrence rides along
     * to the question instead of dying in it. See db.Awaiting (`time.rec`).
     */
    const monthAmbiguous = monthClock !== null && !monthClock.settled && monthClock.hour <= 12;
    return finish(
      {
        action: 'create_reminder', schedule_type: 'monthly', day_of_month: dom,
        ...(monthClock ? { time: hhmm(monthClock) } : {}),
        ...(monthAmbiguous ? { ambiguous_hour: (monthClock!.hour + 12) % 24 } : {}),
      },
      [...eaten, monthClock?.matched ?? ''],
    );
  }

  /*
   * The hour is OPTIONAL from here down, and that is 0.40.0.
   *
   * This used to be `if (!clock) return null`, under the comment "כל יום alone
   * is not a schedule" — true, and the wrong conclusion. "פעם בשבוע בימי שני
   * להשקות את העציץ" names how often and not when, and returning null threw
   * away the half that had been read: the sentence went to the router, was
   * captured with a title and nothing else, and when he answered the hour a
   * minute later `parseAnswerTime` produced an instant and the row was written
   * as a ONE-OFF. The recurrence died in the gap between the question and the
   * answer.
   *
   * So the arms below report the days they read and leave `time` absent.
   * `scheduleFromIntent` still refuses an incomplete schedule, so the row is
   * still captured rather than written — nothing is guessed and nothing fires.
   * The difference is that the capture now knows what it is missing, and says
   * so. See db.Awaiting (`time.rec`).
   */
  const clock = matchClock(t);
  const ambiguous = clock !== null && !clock.settled && clock.hour <= 12;
  /** The hour, when he gave one — and the field left off entirely when he did not. */
  const atClock = clock
    ? { time: hhmm(clock), ...(ambiguous ? { ambiguous_hour: (clock.hour + 12) % 24 } : {}) }
    : {};
  /** Every weekly arm below reports its days the same way. */
  const weeklyFrom = (raw: string, days: number[], consumed: string[]): Intent | null => {
    if (!days.length) return null;
    return finish(
      { action: 'create_reminder', schedule_type: 'weekly', days, ...atClock },
      consumed,
    );
  };
  const dowsIn = (s: string): number[] => {
    const names = s.match(new RegExp(WEEKDAY_ALT, 'g')) ?? [];
    return [...new Set(names.map((d) => WEEKDAYS[d]))].filter((d) => d !== undefined);
  };

  /*
   * An EXCLUSION, before RE_DAILY gets to the "כל יום" in front of it.
   *
   * "כל יום חוץ משבת בשעה 7 לקום" used to come back `daily` titled
   * "חוץ משבת לקום" — ringing on the one day he had named in order to
   * exclude it, with the exclusion sitting in the title as decoration.
   */
  const excluded = RE_EXCLUDE.exec(t);
  if (excluded) {
    const drop = new Set(dowsIn(excluded.groups!.days));
    if (!drop.size) return null;
    const lead = RE_DAILY.exec(t) ?? RE_WORKWEEK.exec(t);
    const base = lead && RE_WORKWEEK.test(t) ? WORK_WEEK : [0, 1, 2, 3, 4, 5, 6];
    return weeklyFrom(
      excluded[0],
      base.filter((d) => !drop.has(d)),
      [excluded[0], lead?.[0] ?? '', clock?.matched ?? ''],
    );
  }

  // The working week as a unit. Also before RE_DAILY, and for the same reason.
  const workweek = RE_WORKWEEK.exec(t);
  if (workweek) return weeklyFrom(workweek[0], [...WORK_WEEK], [workweek[0], clock?.matched ?? '']);

  // Weekly, in three shapes. RE_WEEKLY_LED before RE_WEEKLY_PLURAL — see
  // RE_WEEKLY_PLURAL for why the order is not free.
  const weekly = RE_WEEKLY_LED.exec(t) ?? RE_WEEKLY_PLURAL.exec(t) ?? RE_WEEKLY.exec(t);
  if (weekly) return weeklyFrom(weekly[0], dowsIn(weekly.groups!.days), [weekly[0], clock?.matched ?? '']);

  const daily = RE_DAILY.exec(t);
  if (daily) {
    // "כל יום לשתות מים" — how often, with no hour on it. Reported rather than
    // discarded, for the same reason as the weekly arms above: the capture can
    // then ask for the one thing it is missing and keep the recurrence.
    if (!clock) {
      return finish({ action: 'create_reminder', schedule_type: 'daily' }, [daily[0]]);
    }
    // "כל ערב ב-8" is 20:00 — the span word settles the hour just as a
    // trailing "בערב" would, so there is nothing left to offer a button for.
    const span = daily.groups!.span;
    let hour = clock.hour;
    let settled = clock.settled;
    if (!settled) {
      if (/ערב|evening/i.test(span)) {
        hour = hour < 12 ? hour + 12 : hour;
        settled = true;
      } else if (/לילה|night/i.test(span)) {
        hour = hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
        settled = true;
      } else if (/בוקר|morning/i.test(span)) {
        settled = true; // as written
      }
    }
    const time = hhmm({ ...clock, hour });
    return finish(
      {
        action: 'create_reminder', schedule_type: 'daily', time,
        ...(!settled && hour <= 12 ? { ambiguous_hour: (hour + 12) % 24 } : {}),
      },
      [daily[0], clock.matched],
    );
  }

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
  // Rule 2: an unconsumed time word means we understood only part of the phrase
  // — unless an offset word already pinned the day, in which case a weekday
  // left in the title is what the task is ABOUT. See hasTimeResidue.
  if (hasTimeResidue(title, day?.offset != null)) return null;

  const at = resolve(clock, day, nowMs, tz);
  if (at === null) return null;

  return {
    action: 'create_reminder',
    title: (title || UNTITLED_TITLE).slice(0, 120),
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
export function resolve(
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

/**
 * The hour a period word implies, when nothing more precise was said.
 *
 * These are assumptions, and they are only ever acceptable because the one
 * caller uses them to OFFER something behind a button. Nothing here may reach
 * a path that writes a reminder without being tapped first.
 */
export const PERIOD_HOUR: [RegExp, number][] = [
  [/בוקר/, 9],
  [/צהריי?ם/, 13],
  [/אחה"צ|אחר\s+הצהריי?ם/, 16],
  [/ערב/, 20],
  [/לילה/, 21],
];

/**
 * The appointment buried inside a task, as an instant — or null when the text
 * does not name one clearly enough to offer.
 *
 * Unlike quickParse this deliberately has no ASKED gate: the input here is a
 * reminder TITLE or a report of what happened, not a request. "לדבר על המוסך
 * לוודא שאני מגיע בבוקר של יום חמישי לטיפול וטסט" was closed on the Monday and
 * nothing was ever created for the Thursday, which was the whole point of
 * making the call.
 *
 * A day alone is not enough — "ביום חמישי" with no hour and no period would
 * mean inventing a time out of nothing. A day plus either a clock or a period
 * word is enough to put a specific offer on screen, which he can ignore.
 */
export function findFutureInstant(text: string, nowMs: number, tz: string): number | null {
  const day = matchDay(text);
  const clock = matchClock(text);

  if (!day) {
    /**
     * No day word — but an explicit clock that is still ahead of us today.
     *
     * This used to refuse, and it cost the commonest phrasing there is.
     * Production, 09.08.2026, chat B — his first two messages ever:
     *
     *   יש לי אימון אגרוף תאילנדי בשעה 18:00 ויש לי נסיעה של 35 דקות...
     *   יש לי איגרוף תאילנדי בשעה 18:00
     *
     * Both were answered "נו?". He got a reminder only on the third try, once
     * he had phrased it the bot's way, and the transcript never recovered.
     *
     * In Hebrew an hour with no day, still ahead of now, is today. Nothing is
     * assumed here: the clock is explicit and the day is the one we are in.
     *
     * The restraint is that it must land TODAY. `resolve` rolls a past hour
     * forward to tomorrow, and tomorrow is a day he never mentioned — "יש לי
     * אימון ב-18:00" said at 20:00 is a story about this evening, not a plan
     * for the next one. A bare PERIOD still refuses below, because "בערב"
     * really is ambiguous and PERIOD_HOUR is a convention rather than a
     * reading.
     */
    if (!clock) return null;
    const at = resolve(clock, null, nowMs, tz)?.ts ?? null;
    return at !== null && localDateKey(at, tz) === localDateKey(nowMs, tz) ? at : null;
  }

  if (clock) return resolve(clock, day, nowMs, tz)?.ts ?? null;

  const period = PERIOD_HOUR.find(([re]) => re.test(text));
  if (!period) return null;
  return (
    resolve({ hour: period[1], minute: 0, matched: '', settled: true }, day, nowMs, tz)?.ts ?? null
  );
}

/**
 * Is this reminder AIMED at somebody, rather than being his own errand?
 *
 * Distinct from namesSomeoneElse, which asks the ADDRESS BOOK. This asks the
 * grammar, and it exists because the address book was the wrong question on
 * 17.08.2026: the book held the friend under his Telegram profile name
 * ("amnon") while the message said "לאמנון", nothing matched, and
 * "תזכיר לאמנון לדבר עם שחר עוד שתי דקות" was filed as HIS reminder — his
 * chat, his hour, somebody else's errand as the title. No model call happened,
 * so the router never got the chance to notice.
 *
 * CLAUDE.md is right that "לדנה" and "לקנות" cannot be told apart by shape,
 * and this does not try. It matches a stronger claim: **two** ל-phrases in a
 * row after "תזכיר" — an addressee AND an errand ("תזכיר לאמנון לדבר"). One
 * ל-phrase is just an errand ("תזכיר לקנות חלב") and is left alone.
 *
 * "לי" is excluded outright, because "תזכיר לי" is always his — the same fact
 * the router prompt states. Note that the exclusion is anchored: "לילדים"
 * begins with those letters and IS a third party, so it must still bail.
 *
 * Over-refusing is the intended direction. A bail costs one model call and the
 * router is shown the friends list; a wrong pass costs a row filed under
 * somebody else's errand, in his name, at his hour.
 */
const ADDRESSED_TO_SOMEONE = new RegExp(
  String.raw`(?:תזכיר|תזכירי|הזכר)\s+ל(?!י(?:\s|$))[א-ת]{2,}\s+ל[א-ת]`,
);

export function addressesSomeoneElse(text: string): boolean {
  return ADDRESSED_TO_SOMEONE.test(text);
}

/**
 * Does this message name somebody other than himself?
 *
 * Matched against the address book rather than against grammar, and that is
 * the whole design. There is no way to tell "לדנה" from "לקנות" by shape —
 * both are a ל followed by Hebrew letters, and the only difference is whether
 * the rest of it is a person. So the question asked here is the exact one
 * that can be answered: is this one of the handful of names he has actually
 * agreed to write reminders for?
 *
 * Anything else keeps the old behaviour exactly. A chat with no friends can
 * never reach this, and "תזכיר לי ללכת לדואר" is untouched by it — which
 * matters, because sending every ל through the router would cost a model call
 * on the commonest phrasing there is.
 *
 * The ל prefix is required, but only as a cheap filter — it is not a claim
 * that the name is the ADDRESSEE. "תזכיר לי לקנות מתנה לדנה" trips this too,
 * and that is deliberate: bailing costs one model call, and the router is
 * told outright that "תזכיר לי" is always his. Guessing the other way costs
 * an errand filed in her chat, which nobody is watching for.
 */
export function namesSomeoneElse(t: string, friends: string[]): boolean {
  return friends.some((name) => {
    const n = name.trim();
    if (n.length < 2) return false;
    // Built by concatenation, not as a template literal. In a template literal
    // an unrecognised escape loses its backslash — `\s` reads as a plain "s" —
    // so the first version of this line compiled to a regex that required a
    // literal letter s before the name and matched nothing at all.
    const re = new RegExp('(?:^|\\s)ל' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![א-ת])');
    return re.test(t);
  });
}

/**
 * Returns a create_reminder Intent, or null to let the LLM router handle it.
 *
 * The wrapper exists for one refusal that the parse itself cannot make, because
 * it depends on state this file is deliberately not given: whether a reminder
 * is currently RINGING and waiting for a report.
 *
 * "תזכיר לי עוד שעה", typed a minute after a reminder fired, is a snooze of the
 * thing being chased — not a brand-new reminder about nothing. This file cannot
 * tell those apart, and on 16.08.2026 it did not: it filed an empty reminder
 * called "תזכורת" and the open task kept nagging. So it does what rule 2 says
 * and BAILS. The router is shown open instances and can choose; a model call is
 * the correct price for a genuine ambiguity.
 *
 * Narrow on purpose. Only a create with NO SUBJECT defers — "תזכיר לי עוד שעה
 * לקנות חלב" says what it is about and is unaffected, open task or not.
 */
export function quickParse(
  text: string,
  nowMs: number,
  tz: string,
  friends: string[] = [],
  /** Is a fired reminder currently waiting for a report in this chat? */
  hasOpenTask = false,
): Intent | null {
  const intent = quickParseOwn(text, nowMs, tz, friends);
  if (!intent) return null;
  if (hasOpenTask && intent.action === 'create_reminder' && intent.title === UNTITLED_TITLE) {
    return null;
  }
  return intent;
}

function quickParseOwn(
  text: string,
  nowMs: number,
  tz: string,
  /**
   * The nicknames of people he may set reminders for. Present so this file can
   * REFUSE, never so it can route: resolving which friend, and writing into
   * their chat, is the router's and effects.ts's job. Empty (the default) is
   * every chat that has no friends, and behaves exactly as this file always
   * did.
   */
  friends: string[] = [],
): Intent | null {
  const t = text.trim();
  if (!t) return null;
  // Rule 1: this path only ever answers an explicit request for a NEW reminder.
  // A definite "התזכורת" is a reference to one he already has, and no verb list
  // is consulted to work that out — see asksForNewReminder.
  if (!asksForNewReminder(t)) return null;
  // Rule 1b: and only ever a reminder for HIM. Every parse below assumes the
  // reminder is his own — cleanTitle strips "תזכיר לי" and nothing else — so a
  // message aimed at somebody in his address book would be filed as his, at
  // his hour, in his chat, with her name left sitting in the title. The router
  // is the only thing that knows who she is.
  if (namesSomeoneElse(t, friends)) return null;
  // Rule 1c: and only when it is HIS errand. See addressesSomeoneElse — the
  // address book cannot answer this when the book spells the name differently
  // from the way he types it, which is the normal case for a nickname taken
  // from a Telegram profile.
  if (addressesSomeoneElse(t)) return null;
  /*
   * Recurring requests have their own grammar entirely — a repeat rule, not an
   * instant. parseRecurring returns null for the shapes it cannot express, and
   * those still reach the router.
   *
   * CHECKED BEFORE `countTimeAnchors`, and that ordering is the same lesson
   * readWhen's day-offset arm records: "two phrases that compose into one
   * moment are one time, not two". A monthly schedule is exactly that shape —
   * "כל חודש ב-10 בשעה 9" has a day of the month AND an hour, the anchor
   * count sees two time phrases and bails, and the whole schedule reached the
   * router as an unparsed sentence.
   *
   * Safe in this order because `finish` holds every arm to accounting for the
   * entire sentence: a second time phrase left over after the repeat rule and
   * the clock are consumed is caught by `hasTimeResidue`, so "כל יום ב-7
   * ובערב להתקשר" — genuinely two doses — still bails to the router. The
   * residue check is what makes the anchor count redundant here rather than
   * merely bypassed.
   */
  if (RECURRING.test(t)) return parseRecurring(t);

  // Two times in one message means two reminders. One Intent cannot hold both,
  // and guessing which one he meant is how a reminder goes missing.
  if (countTimeAnchors(t) > 1) return null;

  const rel = parseRelative(t);
  // Two months out is past the point where "in N weeks" is the phrasing anyone
  // reaches for, and well past where a typo stops being obvious.
  if (rel !== null && rel.minutes >= 1 && rel.minutes <= 60 * 24 * 60) {
    const title = cleanTitle(t, [rel.matched]);
    if (hasTimeResidue(title, false)) return null;
    return {
      action: 'create_reminder',
      title: (title || UNTITLED_TITLE).slice(0, 120),
      schedule_type: 'once',
      in_minutes: rel.minutes,
    };
  }

  return parseClockTime(t, nowMs, tz);
}

/**
 * A message that is NOTHING BUT a time — the answer to a question the bot just
 * asked.
 *
 * Deliberately stricter than quickParse: there is no ASKED gate here (he is
 * answering, not requesting), so the entire message must be consumed by the
 * time phrase. "15:00" qualifies; "15:00 אבל אולי מחר" does not, because the
 * leftover words mean he said something this function cannot represent, and
 * rule 2 at the top of this file applies with more force here than anywhere —
 * a wrong answer to "מתי?" retimes a real reminder.
 *
 * Returns an instant, never an Intent: the caller already knows WHICH reminder
 * it asked about, and re-deriving that from the text is exactly the guessing
 * this exists to remove.
 */
export function parseAnswerTime(text: string, nowMs: number, tz: string): number | null {
  const t = text.trim();
  // A long message is not an answer to "מתי?", whatever else it contains.
  if (!t || t.length > 40) return null;

  // "עוד שעה", "בעוד 20 דקות" — a length, not a clock.
  const rel = parseRelative(t);
  if (rel && rel.minutes >= 1 && cleanTitle(t, [rel.matched]) === '') {
    return nowMs + rel.minutes * 60_000;
  }

  const clock = matchClock(t);
  if (!clock) return null;
  const day = matchDay(t);
  // Anything left over means he said more than a time, and this function has
  // no way to express the rest.
  if (cleanTitle(t, [clock.matched, day?.matched ?? '']) !== '') return null;

  return resolve(clock, day, nowMs, tz)?.ts ?? null;
}

/*
 * `findNamedTime` USED TO LIVE HERE, and moving it out is the fix rather than
 * a tidy-up.
 *
 * It answered "did he name a time in this sentence" with `number | null`, and
 * that null carried four different refusals — no time, a repeat rule, two
 * times, an hour already gone — plus a fifth case it could not express at all.
 * The fifth is the one that reached production: a date written in digits
 * ("תעביר את 69 ל2.9 ב16:30") was invisible to every regex in this file, so
 * instead of refusing it returned a confident WRONG ANSWER — 01.09, the day it
 * was already on — and the bot reported a move it had not made.
 *
 * Rule 2 at the top of this file calls a partial parse "a confident wrong
 * answer" and calls refusing it the whole design. findNamedTime was the one
 * path never held to that rule, because it had no residue check and no way to
 * say "there is something here I cannot read".
 *
 * It is now `readWhen` in src/when.ts, returning a union in which refusal is a
 * VALUE with a reason on it. The lexers above stay here: they read tokens,
 * when.ts reads meaning, and the dependency runs one way only.
 */
