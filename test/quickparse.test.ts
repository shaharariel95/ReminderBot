/** Run with `npm run test:parse`. */
import { findFutureInstant, parseDuration, quickParse } from '../src/quickparse';
import { wallString, wallToUtc } from '../src/time';

const TZ = 'Asia/Jerusalem';
// Sunday 02 Aug 2026, 22:52 local — the moment the production transcript broke.
const NOW = wallToUtc(2026, 8, 2, 22, 52, TZ);

let failures = 0;

/**
 * A plain assertion, distinct from `check` above (which compares a whole
 * expected Intent shape). Named for what it does rather than reused/numbered,
 * since two near-identical `check`/`check2` helpers in one file is its own
 * maintenance trap.
 */
function assertTrue(label: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

function check(
  input: string,
  expected: { minutes?: number; at?: string; title?: string } | null,
) {
  const got = quickParse(input, NOW, TZ);
  let ok: boolean;
  if (expected === null) {
    ok = got === null;
  } else {
    ok =
      got !== null &&
      (expected.minutes === undefined || got.in_minutes === expected.minutes) &&
      (expected.at === undefined || got.once_at === expected.at) &&
      (expected.title === undefined || got.title === expected.title);
  }
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${input}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(got)}`);
  }
}

console.log('--- relative times ---');
check('תזכיר לי לבדוק אם אתה עובד עוד שלוש דקות', { minutes: 3, title: 'לבדוק אם אתה עובד' });
check('תזכיר לי עוד 5 דקות', { minutes: 5, title: 'תזכורת' });
check('תזכיר לבדוק שאתה עובד עוד 3 דקות', { minutes: 3 });
check('תזכיר לי לרוץ בעוד עשר דקות', { minutes: 10, title: 'לרוץ' });
// The time phrase must be consumed exactly — no eating the first word of the task.
check('תזכיר לי בעוד שעתיים להתקשר לאמא', { minutes: 120, title: 'להתקשר לאמא' });
check('תזכיר לי עוד שעה לשתות מים', { minutes: 60, title: 'לשתות מים' });
check('תזכיר לי עוד דקה לבדוק', { minutes: 1, title: 'לבדוק' });
check('תזכיר לי בעוד חצי שעה', { minutes: 30 });
check('תזכיר לי בעוד רבע שעה לצאת', { minutes: 15 });
check('תזכיר לי עוד 90 דקות', { minutes: 90 });
check('remind me in 5 minutes to check the oven', { minutes: 5 });
check('remind me in 2 hours', { minutes: 120 });

console.log('\n--- absolute clock times ---');
// 23:00 today is still ahead of 22:52.
check('תזכיר לי ללכת לישון ב11 בלילה', { at: '2026-08-02T23:00', title: 'ללכת לישון' });
check('תזכיר לי ב-23:00 ללכת לישון', { at: '2026-08-02T23:00' });
// 07:00 has passed today, so it rolls to tomorrow.
check('תזכיר לי ב-7 בבוקר לקום', { at: '2026-08-03T07:00', title: 'לקום' });
check('תזכיר לי מחר ב-9 בבוקר להתקשר', { at: '2026-08-03T09:00' });
check('תזכיר לי ב-8 בערב לצאת', { at: '2026-08-03T20:00' });
check('תזכיר לי ב-12 בלילה', { at: '2026-08-03T00:00' });
check('תזכיר לי ב-14:30 פגישה', { at: '2026-08-03T14:30' });

console.log('\n--- recurring rules are parsed here, not routed ---');
// `\b` is ASCII-only in JS, so the guard that was supposed to catch these
// never fired on Hebrew, and every one became a single reminder that rang
// once and stopped. They are now parsed properly rather than merely detected:
// a standing reminder is the phrase a daily driver types most, and routing it
// meant losing the habit outright whenever the model was rate-limited.
function recurring(
  input: string,
  expected: { type?: string; time?: string; days?: number[]; every?: number; title?: string } | null,
) {
  const got = quickParse(input, NOW, TZ);
  let ok: boolean;
  if (expected === null) {
    ok = got === null;
  } else {
    ok =
      got !== null &&
      (expected.type === undefined || got.schedule_type === expected.type) &&
      (expected.time === undefined || got.time === expected.time) &&
      (expected.every === undefined || got.interval_minutes === expected.every) &&
      (expected.title === undefined || got.title === expected.title) &&
      (expected.days === undefined ||
        JSON.stringify(got.days) === JSON.stringify(expected.days));
  }
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${input}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(got)}`);
  }
}

recurring('תזכיר לי כל יום ב-7 לרוץ', { type: 'daily', time: '07:00', title: 'לרוץ' });
recurring('תזכיר לי כל בוקר ב-7:05 לקום', { type: 'daily', time: '07:05', title: 'לקום' });
recurring('תזכיר לי בכל יום ב-8:00 לשתות', { type: 'daily', time: '08:00', title: 'לשתות' });
recurring('תזכיר לי מדי בוקר ב-6:30 להתאמן', { type: 'daily', time: '06:30', title: 'להתאמן' });
// "כל ערב ב-9" is 21:00 — the span word settles the hour exactly as a
// trailing "בערב" would, so there is nothing left to ask about.
recurring('תזכיר לי כל ערב ב-9 לקחת כדור', { type: 'daily', time: '21:00' });
recurring('תזכיר לי כל לילה ב-11 לכבות', { type: 'daily', time: '23:00' });
recurring('תזכיר לי כל שני ב-20:00 להוציא זבל', { type: 'weekly', time: '20:00', days: [1], title: 'להוציא זבל' });
recurring('תזכיר לי כל שני ורביעי ב-18:00 לשלם', { type: 'weekly', time: '18:00', days: [1, 3] });
recurring('תזכיר לי כל יום שלישי ב-9 להתקשר', { type: 'weekly', time: '09:00', days: [2] });
recurring('תזכיר לי כל שבת ב-10 לנוח', { type: 'weekly', time: '10:00', days: [6] });
recurring('תזכיר לי כל שעה לשתות מים', { type: 'interval', every: 60, title: 'לשתות מים' });
recurring('תזכיר לי כל 20 דקות למתוח', { type: 'interval', every: 20, title: 'למתוח' });
recurring('תזכיר לי כל שעתיים לזוז', { type: 'interval', every: 120 });
recurring('remind me every day at 7 to run', { type: 'daily', time: '07:00' });
{
  const got = quickParse('תזכיר לי כל יום ב-7 לרוץ', NOW, TZ);
  assertTrue('a bare recurring hour still offers the other reading', got?.ambiguous_hour === 19);
  const settled = quickParse('תזכיר לי כל ערב ב-9 לקחת כדור', NOW, TZ);
  assertTrue('a settled one does not', settled?.ambiguous_hour === undefined);
}

console.log('\n--- recurring shapes this file cannot express still route ---');
// An interval in DAYS is not an interval in minutes: 2880 minutes drifts by an
// hour at every DST change, and a reminder that slides is worse than one the
// router handles properly.
recurring('תזכיר לי כל יומיים לשלם', null);
recurring('תזכיר לי פעמיים ביום לקחת כדור', null);
// A repeat rule with no clock in it is not a schedule.
recurring('תזכיר לי כל יום לרוץ', null);
recurring('תזכורת יומית ב-8', null);
// Still a statement of fact, recurring or not.
recurring('כל יום ב-7 אני רץ', null);

console.log('\n--- must fall through to the router ---');
// Two times in one message: one Intent cannot carry both, so the router gets it.
check('תזכיר לי עוד 5 דקות לאכול ובעוד שעה להתקשר לאמא', null);
check('תזכיר לי ב-7:00 לקום וב-9:00 להתקשר', null);
check('אני רוצה לפתוח תיק מסחר', null);            // a goal
check('מה השעה', null);
check('סיימתי', null);
check('עוד מעט אני הולך', null);                    // no number
check('נפגשתי איתו ב-8 בערב אתמול', null);         // not a reminder request

console.log('\n--- ambiguous hours commit and offer a correction ---');
// Capture must never block on a question, so a bare hour is taken literally and
// the other reading is offered as a button.
{
  const got = quickParse('תזכיר לי ב-11 להתקשר', NOW, TZ);
  assertTrue('a bare hour still creates a reminder', got !== null && got.action === 'create_reminder');
  // Pin the full string, not just the trailing "11:00" — a rollover regression
  // that landed this on the wrong day (e.g. today instead of tomorrow) would
  // still satisfy an endsWith check.
  assertTrue('it takes the literal reading', got?.once_at === '2026-08-03T11:00');
  assertTrue('and flags the alternative', got?.ambiguous_hour === 23);
}
{
  const got = quickParse('תזכיר לי ב-7 בבוקר לקום', NOW, TZ);
  assertTrue('an explicit part-of-day is not ambiguous', got?.ambiguous_hour === undefined);
}
{
  const got = quickParse('תזכיר לי ב-14:30 פגישה', NOW, TZ);
  assertTrue('an explicit HH:MM is not ambiguous', got?.ambiguous_hour === undefined);
}
{
  // 12 is the edge case: (12 + 12) % 24 must wrap to 0, not the invalid "24".
  const got = quickParse('תזכיר לי ב-12 להתקשר', NOW, TZ);
  assertTrue('a bare "ב-12" takes the literal noon reading', got?.once_at?.endsWith('T12:00') === true);
  assertTrue('and flags midnight (0), not 24, as the alternative', got?.ambiguous_hour === 0);
}

console.log('\n--- a statement of fact is not a request ---');
// The relative-time path used to skip the "did he ask?" check entirely, so any
// sentence with a duration in it became a reminder. This is the "it reminds me
// of random things I never asked for" bug, and every line here reproduced it.
check('אני הולך עוד 20 דקות', null);
check('הוא יגיע בעוד שעה', null);
check('הסרט מתחיל עוד חצי שעה', null);
check('הישיבה נגמרת בעוד שעתיים', null);

console.log('\n--- a half-understood time phrase goes to the router ---');
// "ב-8 בבוקר ובערב" is two doses. The clock matcher happily consumes "ב-8
// בבוקר" and, without the residue guard, the leftover "ובערב" becomes part of
// the TITLE — one reminder at 08:00 and the evening dose silently gone.
check('תזכיר לי ב-8 בבוקר ובערב לקחת כדור', null);
// Same shape: a day word we recognise but did not consume alongside the hour.
check('תזכיר לי ב-7 מחרתיים בבוקר', null);
check('תזכיר לי בשעה 8 לצאת ובשעה 9 להתקשר', null);
// The relative path needs the same guard. "in two days, in the morning" is an
// ordinary sentence that this file cannot express — `in_minutes` carries a
// duration, not a time of day — and without the guard it becomes a reminder
// two days out at whatever o'clock it happens to be now, titled "בבוקר לשלם".
check('תזכיר לי עוד יומיים בבוקר לשלם', null);
check('תזכיר לי עוד שבוע ביום ראשון להתקשר', null);

console.log('\n--- "בשעה" and hours spelled as words ---');
check('תזכיר לי בשעה 8 לצאת', { at: '2026-08-03T08:00', title: 'לצאת' });
check('תזכיר לי בשעה 20:30 להתקשר', { at: '2026-08-03T20:30', title: 'להתקשר' });
check('תזכיר לי בשמונה לצאת', { at: '2026-08-03T08:00', title: 'לצאת' });
check('תזכיר לי בשבע בערב לצאת', { at: '2026-08-03T19:00', title: 'לצאת' });
check('תזכיר לי בשתים עשרה להתקשר', { at: '2026-08-03T12:00', title: 'להתקשר' });
// "בשלושה" is a count, not the hour three — the right boundary must reject it.
check('תזכיר לי בשלושה ימים לבדוק', null);

console.log('\n--- "וחצי" / "ורבע" are part of the time, not part of the title ---');
check('תזכיר לי ב-8 וחצי לצאת', { at: '2026-08-03T08:30', title: 'לצאת' });
check('תזכיר לי בשמונה וחצי לצאת', { at: '2026-08-03T08:30', title: 'לצאת' });
check('תזכיר לי בשבע ורבע לקום', { at: '2026-08-03T07:15', title: 'לקום' });
check('תזכיר לי בשעה 8 וחצי בערב לצאת', { at: '2026-08-03T20:30', title: 'לצאת' });
check('תזכיר לי עוד שעה וחצי לצאת', { minutes: 90, title: 'לצאת' });
check('תזכיר לי עוד שעתיים וחצי לצאת', { minutes: 150, title: 'לצאת' });

console.log('\n--- "מחרתיים" is not "מחר" with letters after it ---');
// /מחר/ matches inside "מחרתיים". Stripping the short form left a reminder
// called "תיים", scheduled a full day early.
check('תזכיר לי מחרתיים ב-9 לקום', { at: '2026-08-04T09:00', title: 'לקום' });
check('תזכיר לי מחרתיים בשמונה לצאת', { at: '2026-08-04T08:00', title: 'לצאת' });

console.log('\n--- named weekdays ---');
// NOW is Sunday 02 Aug. Tuesday is the 4th, Saturday the 8th.
check('תזכיר לי ביום שלישי ב-9 להתקשר', { at: '2026-08-04T09:00', title: 'להתקשר' });
check('תזכיר לי בשבת ב-10 לנוח', { at: '2026-08-08T10:00', title: 'לנוח' });
// Today is Sunday and 09:00 has passed, so "ביום ראשון" means next Sunday.
check('תזכיר לי ביום ראשון ב-9 להתקשר', { at: '2026-08-09T09:00', title: 'להתקשר' });
// "בשני" reads just as easily as "in two" — guessing costs a day, so it routes.
check('תזכיר לי בשני ב-9 להתקשר', null);

console.log('\n--- days and weeks, not just hours and minutes ---');
check('תזכיר לי עוד יומיים לשלם', { minutes: 2880, title: 'לשלם' });
check('תזכיר לי עוד שבוע לחדש ביטוח', { minutes: 10080, title: 'לחדש ביטוח' });
check('תזכיר לי עוד שבועיים לבדוק', { minutes: 20160, title: 'לבדוק' });
check('תזכיר לי עוד 3 ימים לבדוק', { minutes: 4320, title: 'לבדוק' });
check('remind me in 3 days to check', { minutes: 4320 });

console.log('\n--- "יומי"/"שבועי" must not match inside "יומיים"/"שבועיים" ---');
// Both are bare alternatives in the RECURRING guard. Without a right boundary
// they matched inside the dual forms, and every "עוד יומיים" was thrown away.
check('תזכורת יומית ב-8', null);
check('תזכיר לי כל שבועיים ב-9', null);

console.log('\n--- English clock times ---');
check('remind me at 8pm to call mom', { at: '2026-08-03T20:00', title: 'call mom' });
check('remind me at 7:30 am to wake up', { at: '2026-08-03T07:30' });
check('remind me tomorrow at 9 to wake up', { at: '2026-08-03T09:00', title: 'wake up' });

console.log('\n--- a title keeps its own numbers ---');
// Digits alone are not a clock. Only a "ב" prefix or a colon makes one.
check('תזכיר לי ב-8 לקחת 2 כדורים', { at: '2026-08-03T08:00', title: 'לקחת 2 כדורים' });

console.log('\n--- "היום" pins the day, and settles the hour when it can ---');
{
  // 11:00 has passed, but 23:00 has not — "היום" leaves exactly one reading
  // that is still today, so there is nothing left to ask about.
  const got = quickParse('תזכיר לי היום ב-11 ללכת לישון', NOW, TZ);
  assertTrue('"היום" takes the reading that is still ahead', got?.once_at === '2026-08-02T23:00');
  assertTrue('and stops offering a correction', got?.ambiguous_hour === undefined);
}
{
  // Mid-afternoon, "היום ב-8" is tonight — never 08:00 tomorrow.
  const afternoon = wallToUtc(2026, 8, 2, 14, 30, TZ);
  const got = quickParse('תזכיר לי היום ב-8 לצאת', afternoon, TZ);
  assertTrue('"היום ב-8" at 14:30 means 20:00 tonight', got?.once_at === '2026-08-02T20:00');
}
{
  // Both readings are behind us. Scheduling it for tomorrow would contradict
  // the word he used, so the router gets to ask instead.
  const got = quickParse('תזכיר לי היום ב-7 בבוקר לקום', NOW, TZ);
  assertTrue('an impossible "היום" goes to the router rather than lying', got === null);
}

console.log('\n--- a day word in the TASK is subject matter, not a schedule ---');
{
  // 09.08.2026, 14:55. He wrote this and got a reminder at 09:00 the next
  // morning instead of 10:00 — a silent hour lost, which he never noticed.
  //
  // The chain: "יום חמישי" is what the task is ABOUT (a garage appointment),
  // but TIME_RESIDUE read it as a day the parser had failed to consume and
  // bailed to the router; the router returned a capture with no time at all;
  // it landed in the inbox; and the "מחר" inbox button is hardcoded to 09:00.
  // Three layers, each individually defensible, and an hour disappeared.
  const at1455 = wallToUtc(2026, 8, 9, 14, 55, TZ);
  const got = quickParse(
    'תזכיר לי מחר ב10 בבוקר לדבר על המוסך לוודא שאני מגיע בבוקר של יום חמישי לטיפול וטסט',
    at1455, TZ,
  );
  assertTrue('the real message parses at all', got !== null);
  assertTrue('at the hour he actually asked for', got?.once_at === '2026-08-10T10:00');
  assertTrue('and the appointment day stays in the title where it belongs',
    (got?.title ?? '').includes('חמישי'));
}
// "בבוקר של יום שני" is a noun phrase — the morning OF Monday — not a second
// instruction about when to fire.
// The phrase is stripped for the RESIDUE CHECK only — it stays in the title,
// because "the morning of Monday" is exactly what he wants to be reminded about.
check('תזכיר לי מחר ב10 לקנות חלב בבוקר של יום שני',
  { at: '2026-08-03T10:00', title: 'לקנות חלב בבוקר של יום שני' });
// Once "מחר" has pinned the day, a weekday later in the sentence cannot change
// it, so it is no longer evidence of a half-understood phrase.
check('תזכיר לי מחר ב10 בבוקר לדבר על המוסך ביום חמישי', { at: '2026-08-03T10:00' });

console.log('\n--- ...but the residue guard keeps its teeth ---');
// No day was pinned, so this weekday IS the schedule — and "בשלישי" is the
// bare form quickparse deliberately refuses to guess at.
check('תזכיר לי בשלישי ב-9 לרוץ', null);
// The clock is unsettled and a stray period could still change it. Nothing
// pinned the day here either.
check('תזכיר לי מחר ב8 לרוץ בערב', null);
// Two doses, not one reminder — the case the residue guard was written for.
check('תזכיר לי ב-8 בבוקר ובערב לקחת כדור', null);
// A weekday-derived day plus a SECOND weekday is genuinely two days, and no
// offset word settled which one wins.
check('תזכיר לי ביום שלישי ב-9 לרוץ ביום חמישי', null);

// ------------------------------------------------------- parseDuration
//
// The snooze bug from the 10.08.2026 transcript: he said "עוד שעה", the router
// returned a snooze with no snooze_minutes, effects.ts fell back to its
// 30-minute default, and the bot then ANNOUNCED that default as though he had
// asked for it ("הזזתי ב-30 דקות"). The default itself is fine — stating it as
// his words is not. parseDuration is what effects.ts consults before falling
// back, so a length he actually said is never silently replaced.

console.log('\n--- parseDuration — a length he actually said ---');

function dur(text: string, expected: number | null): void {
  const got = parseDuration(text);
  assertTrue(`"${text}" → ${expected === null ? 'null' : `${expected}m`} (got ${got})`, got === expected);
}

// The exact message that produced the bug, comma and trailing clause included.
dur('עוד שעה, אעבוד עד קצת יותר מאוחר היום', 60);
// The one that already worked, kept so a fix for the above cannot break it.
dur('אני סופר עמוס בעבודה, עוד חצי שעה', 30);
dur('עוד שעתיים', 120);
dur('תדחה בעוד 20 דקות', 20);
dur('תוך רבע שעה', 15);

// "ב" forms — how a snooze is phrased at least as often as with "עוד", and the
// wording /help itself advertises ("תדחה בחצי שעה").
dur('תדחה בחצי שעה', 30);
dur('תדחה ב-20 דקות', 20);
dur('תדחה בעשרים דקות', 20);
dur('תדחה בשעתיים', 120);

// A clock reading is NOT a duration. "בשעה 10" must never be read as 10
// minutes/hours — the number follows the unit there, which is what separates
// the two forms.
dur('תדחה לשעה 10', null);
dur('תזכיר לי בשעה 10:00', null);
dur('ב-10 תדחה', null);
// No length stated at all: the caller's own default is the right answer, and
// parseDuration must say so rather than guessing one.
dur('תדחה', null);
dur('אני עמוס, אחר כך', null);

// ------------------------------------------------- findFutureInstant
//
// He set "לדבר על המוסך לוודא שאני מגיע בבוקר של יום חמישי לטיפול וטסט",
// closed it on Monday morning — and nothing was ever created for Thursday,
// which was the entire point of making the call. The bot watched the whole
// arrangement happen and had no way to notice the appointment inside it.
//
// Unlike quickParse this takes no "remind me": the text here is a task title
// or a report, not a request. It is only ever used to OFFER something behind a
// button, which is what makes an assumed hour acceptable.

console.log('\n--- findFutureInstant — the appointment inside the task ---');

function fut(text: string, expected: string | null, now = wallToUtc(2026, 8, 10, 10, 26, TZ)): void {
  const got = findFutureInstant(text, now, TZ);
  const label = got === null ? 'null' : wallString(got, TZ);
  assertTrue(`${label.padEnd(17)} ← ${text}`, label === (expected ?? 'null'));
}

// The real title, closed on Monday 10.08. Thursday is the 13th.
fut('לדבר על המוסך לוודא שאני מגיע בבוקר של יום חמישי לטיפול וטסט', '2026-08-13T09:00');
// An explicit clock beats the assumed hour every time.
fut('הטיפול ביום חמישי ב-8:30', '2026-08-13T08:30');
fut('הפגישה מחר בערב', '2026-08-11T20:00');
// A day with no hour and no period is too little to guess from.
fut('לדבר על המוסך ביום חמישי', null);
// No day at all is nothing to offer.
fut('לדבר על המוסך', null);
fut('לקנות חלב', null);
// Already past this week rolls forward rather than offering yesterday.
fut('בבוקר של יום ראשון', '2026-08-16T09:00');

// ---------------------------------------------------------------------------
// A reminder addressed to somebody else must never become his own.
//
// "תזכיר לאמנון לדבר עם שחר עוד שתי דקות" was filed as HIS reminder on
// 17.08.2026 — his chat, his hour, the other person's errand as the title.
//
// namesSomeoneElse gates on the ADDRESS BOOK, and the book held the friend
// under his Telegram profile name ("amnon") while the message says "לאמנון".
// Nothing matched, so the fast path answered it — with no model call, and
// therefore no chance for the router (which IS shown the friends list, and is
// told to report a name it does not recognise) to catch it.
//
// The gate cannot become a name list: CLAUDE.md is explicit that "לדנה" and
// "לקנות" cannot be told apart by shape. But "תזכיר ל<X> ל<verb>" is a
// different claim — an addressee AND an errand, two ל-phrases — and "לי" is
// excluded outright. Anything matching that bails to the router, which is the
// rule-2 move: bailing costs one model call, guessing costs a row filed under
// the wrong person's errand.
{
  const N = wallToUtc(2026, 8, 17, 21, 11, TZ);

  // The exact production messages, with the book in the state it was in.
  assertTrue(
    'the message that broke it defers to the router',
    quickParse('תזכיר לאמנון לדבר עם שחר עוד שתי דקות', N, TZ, ['amnon']) === null,
  );
  assertTrue(
    'and the same shape with an explicit hour',
    quickParse('תזכיר לאמנון להגיד לשחר על הפיצר בשעה 21:07', N, TZ, ['amnon']) === null,
  );
  // Somebody not in the book at all. The bot cannot know who אמא is — but it
  // must not quietly file her errand as his.
  assertTrue(
    'an addressee it has never heard of also defers',
    quickParse('תזכיר לאמא להתקשר לרופא מחר ב-9', N, TZ, []) === null,
  );

  // ...and the fast path must keep answering the case it exists for.
  const mine = quickParse('תזכיר לי לקנות חלב מחר ב-8', N, TZ, ['amnon']);
  assertTrue('his own reminder still costs no model call', mine?.action === 'create_reminder');
  assertTrue('with just the errand as the title', mine?.title === 'לקנות חלב');
  // A single ל-phrase is an errand, so the fast path must still answer it.
  // The title keeps the leading "תזכיר" here — cleanTitle strips "תזכיר לי"
  // and not a bare "תזכיר", which predates this gate and is why the older
  // cases above assert minutes without asserting a title.
  const bare = quickParse('תזכיר לקנות חלב מחר ב-8', N, TZ, []);
  assertTrue('and a bare infinitive is an errand, not a person', bare?.action === 'create_reminder');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
if (failures > 0) (globalThis as any).process?.exit?.(1);
