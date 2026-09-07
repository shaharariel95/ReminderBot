/**
 * Run with `npm run test:v32`.
 *
 * The confirmation said the same moment twice.
 *
 * Production, 07.09.2026, reported verbatim:
 *
 *   קבעתי לאמנון: "להגיד לשחר שעובד" — פעם אחת ב-07.09 בשעה 20:58.
 *   הראשונה ב-יום ב׳, 07.09.2026, 20:58.
 *
 * and, from the same evening's /list:
 *
 *   #83 לשלוח לשחר …
 *      פעם אחת ב-07.09 בשעה 19:23 · הבא: יום ב׳, 07.09.2026, 19:23
 *
 * `describeSchedule` on a `once` schedule renders the whole instant already,
 * so every caller that then appended a formatted `next_fire_at` printed it
 * again. "הראשונה"/"הבא" only mean something when there IS a second one.
 *
 * FOUR call sites had the same sentence shape written out by hand — two in
 * voice.ts, two in slash.ts — which is how one bug came to be wrong in four
 * places. `time.scheduleWithNext` is now the only thing that answers "does
 * this repeat, and therefore is a first/next worth naming", and the assertions
 * below are counts rather than exact strings so they keep biting if the
 * wording changes.
 */
import { renderBaseline } from '../src/voice';
import { handleSlash } from '../src/slash';
import { scheduleWithNext } from '../src/time';
import { wallToUtc } from '../src/time';
import type { Effect, Schedule } from '../src/types';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const TZ = 'Asia/Jerusalem';
const CHAT = '12345';
const AT = wallToUtc(2026, 9, 7, 20, 58, TZ);
const ONCE: Schedule = { type: 'once', at: '2026-09-07T20:58' };
const DAILY: Schedule = { type: 'daily', time: '20:58' };

/** How many times `needle` occurs in `hay`. */
const times = (hay: string, needle: string) => hay.split(needle).length - 1;

// ===========================================================================
section('a one-off confirmation states the moment once');
{
  const mine = renderBaseline(
    [{ kind: 'reminder_created', id: 1, title: 'לרוץ', at: AT, schedule: ONCE, requiresProof: false } as Effect],
    TZ,
  );
  eq(`the hour, once — ${mine}`, times(mine, '20:58'), 1);
  eq('and the date, once', times(mine, '07.09'), 1);
  check('with no "first one" clause to repeat it', !mine.includes('הראשונה'), mine);

  const hers = renderBaseline(
    [{
      kind: 'friend_reminder_created', id: 1, title: 'להגיד לשחר שעובד', at: AT,
      schedule: ONCE, requiresProof: false, friend: 'אמנון', to: '999',
    } as Effect],
    TZ,
  );
  eq(`the friend confirmation too — ${hers}`, times(hers, '20:58'), 1);
  eq('and its date', times(hers, '07.09'), 1);
  check('it still names the friend', hers.includes('אמנון'), hers);
  check('and the errand', hers.includes('להגיד לשחר שעובד'), hers);
}

// ---------------------------------------------------------------------------
section('a RECURRING one still says the rule and the first fire');
//
// The other direction, and the reason this is not simply "delete the clause".
// "כל יום ב-20:58" and "the first is Monday" are two different facts, and a
// daily reminder that only stated the next fire would read as a one-off.
{
  const daily = renderBaseline(
    [{ kind: 'reminder_created', id: 1, title: 'לרוץ', at: AT, schedule: DAILY, requiresProof: false } as Effect],
    TZ,
  );
  check(`the rule is stated — ${daily}`, daily.includes('כל יום'), daily);
  check('and the first fire is named', daily.includes('הראשונה'), daily);
  eq('the date appears once, in the first-fire clause', times(daily, '07.09'), 1);
}

// ---------------------------------------------------------------------------
section('/list does not double it either');
{
  const rig = createRig({ tz: TZ });
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(CHAT, TZ);
  const add = (title: string, s: Schedule) =>
    rig.db
      .prepare(
        `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?, NULL)`,
      )
      .run(CHAT, title, JSON.stringify(s), TZ, AT, AT - 3_600_000);
  add('לשלוח לשחר', ONCE);
  add('לרוץ', DAILY);

  const out = (await withNow(AT - 60_000, () => handleSlash(rig.env, CHAT, '/list'))) ?? '';
  const oneOff = out.split('\n').filter((l) => l.includes('לשלוח לשחר') || (l.includes('20:58') && !l.includes('כל יום')));
  const joined = oneOff.join('\n');
  eq(`the one-off row names the hour once — ${JSON.stringify(joined)}`, times(joined, '20:58'), 1);
  check('and the daily row still shows its rule', out.includes('כל יום'), out);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the helper is the only thing deciding, and it decides on RECURRENCE');
//
// Asserted directly so the rule survives a rewording of any caller. A `once`
// schedule contributes nothing beyond the instant; everything else prefixes
// its rule.
{
  eq('once collapses to the instant alone',
    scheduleWithNext(ONCE, 'INSTANT', ' · ', 'הבא: '), 'INSTANT');
  eq('null (an unparseable row) does too',
    scheduleWithNext(null, 'INSTANT', ' · ', 'הבא: '), 'INSTANT');
  check('daily keeps both halves',
    scheduleWithNext(DAILY, 'INSTANT', ' · ', 'הבא: ') === 'כל יום ב-20:58 · הבא: INSTANT',
    scheduleWithNext(DAILY, 'INSTANT', ' · ', 'הבא: '));
  check('weekly too',
    scheduleWithNext({ type: 'weekly', days: [1], time: '08:00' }, 'X', ' · ', 'הבא: ').includes('כל שני'),
    scheduleWithNext({ type: 'weekly', days: [1], time: '08:00' }, 'X', ' · ', 'הבא: '));
  check('and interval',
    scheduleWithNext({ type: 'interval', minutes: 30 }, 'X', ' · ', 'הבא: ').includes('30 דקות'),
    scheduleWithNext({ type: 'interval', minutes: 30 }, 'X', ' · ', 'הבא: '));
}

done();
