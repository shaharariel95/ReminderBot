/** Run with `npm run test:parse`. */
import { quickParse } from '../src/quickparse';
import { wallToUtc } from '../src/time';

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

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
if (failures > 0) (globalThis as any).process?.exit?.(1);
