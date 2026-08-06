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

console.log('\n--- must fall through to the router ---');
// Recurring. `\b` is ASCII-only in JS, so the old guard never fired on Hebrew
// and every one of these became a single reminder that rang once and stopped.
check('תזכיר לי כל יום ב-7 לרוץ', null);
check('תזכיר לי כל שני ב-20:00', null);
check('תזכיר לי כל בוקר ב-7:05 לקום', null);
check('תזכיר לי כל ערב ב-21:00 לקחת כדור', null);
check('תזכיר לי בכל יום ב-8:00 לשתות', null);
check('תזכיר לי מדי בוקר ב-6:30 להתאמן', null);
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
  assertTrue('it takes the literal reading', got?.once_at?.endsWith('11:00') === true);
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

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
if (failures > 0) (globalThis as any).process?.exit?.(1);
