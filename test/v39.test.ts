/**
 * Run with `npm run test:v39`.
 *
 * **The recurrences he actually asks for.**
 *
 * 0.38.0 made every phrasing the parser did not know REFUSE instead of writing
 * a one-off. That is the safety half and it stands on its own — the cost of an
 * unknown phrase is now one extra exchange rather than a recurrence that ends
 * silently. This is the other half: teaching it the phrases, so the exchange
 * is not needed.
 *
 * Scope is evidence-led, and deliberately narrower than the refusals.
 *
 * **Weekly, in every lead-in he reached for.** `כל שני ב-8` has always worked.
 * On 30.09.2026 he tried three times and none of them was that phrasing:
 * `פעם בשבוע בימי שני`, then `כל שבוע בים שני`. `weekly` + `days[]` already
 * exists end to end — types, `scheduleFromIntent`, the router enum,
 * `computeNext` — so this is lead-ins and nothing else. No new schedule, no
 * migration.
 *
 * **The working week, and exclusions.** `כל יום חול` and `כל יום חוץ משבת`
 * were the two that wrote a plain `daily` and rang on the Saturday he had
 * excluded. Both are `weekly` with a day list; neither needs a new type.
 *
 * **Monthly, because refusing it would be a NEW dead end.** `כל חודש ב-10`
 * resolved to a single fire before 0.38.0, and widening `RECURRING` turns that
 * into a capture — honest, but worse for a standing bill than what it
 * replaced. `{type:'monthly'}` is the one new `Schedule` arm here.
 *
 * **Deferred on purpose, and they must still refuse.** Annual (`כל שנה`) and
 * every-N-days (`כל יומיים`, `כל שבועיים`) have no arm and no evidence behind
 * them — nothing in eleven weeks of live data asks for either. They already
 * refused before this change, so deferring them costs nothing, and the last
 * section holds them to refusing rather than quietly becoming weekly or daily.
 *
 * Also NOT supported, and worth saying out loud: the typo in `בים שני` (#97,
 * missing the י). The gate is grammar, not a spelling list — the same argument
 * that keeps a verb blocklist out of `asksForNewReminder`. It refuses, asks,
 * and that is the right answer.
 */
import worker from '../src/index';
import { applyIntent } from '../src/effects';
import type { Context } from '../src/brain';
import { quickParse } from '../src/quickparse';
import * as db from '../src/db';
import { computeNext, describeSchedule, wallParts, wallToUtc } from '../src/time';
import type { Schedule } from '../src/types';
import {
  callbackUpdate, check, createRig, done, eq, section, withNow, type Rig,
} from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

async function runCallback(rig: Rig, data: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException() {},
  };
  const req = new Request('https://x/tg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify(callbackUpdate(CHAT, data)),
  });
  await worker.fetch(req, rig.env, ctx);
  await Promise.all(pending);
}

/** 30.09.2026 22:19 — a Wednesday, the minute #96 was written. */
const NOW = wallToUtc(2026, 9, 30, 22, 19, TZ);

const PLANT = 'להשקות את העציץ';

function seedSettings(rig: Rig): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on, awaiting)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(CHAT, TZ);
}

async function ctxFor(rig: Rig): Promise<Context> {
  return {
    settings: await db.getSettings(rig.env, CHAT),
    stats: await db.stats(rig.env, CHAT),
    reminders: await db.listReminders(rig.env, CHAT),
    goals: [],
    open: [],
    inbox: [],
    friends: [],
    done: [],
  } as unknown as Context;
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section('weekly, in the lead-ins he actually types');
  {
    const cases: [string, string, number[], string, string][] = [
      // The #96 sentence, with only his בשנה/בשעה typo corrected.
      ['פעם בשבוע בימי <day>', `תזכיר לי פעם בשבוע בימי שני בשעה 8 בערב ${PLANT}`, [1], '20:00', PLANT],
      ['כל שבוע ביום <day>', `תזכיר לי כל שבוע ביום שני בשעה 8 בערב ${PLANT}`, [1], '20:00', PLANT],
      ['מדי שבוע ב<day>', `תזכיר לי מדי שבוע בשני ב20:00 ${PLANT}`, [1], '20:00', PLANT],
      // No lead-in at all — the plural day phrase carries the recurrence.
      ['בימי <day> ו<day>', `תזכיר לי בימי שני ורביעי ב20:00 ${PLANT}`, [1, 3], '20:00', PLANT],
      ['פעם בשבוע ב<day>', `תזכיר לי פעם בשבוע בשישי ב10:00 לנקות`, [5], '10:00', 'לנקות'],
      // The phrasing that has always worked. A regression floor: every arm
      // above is new code in the same function.
      ['כל <day> (unchanged)', `תזכיר לי כל שני בשעה 8 בערב ${PLANT}`, [1], '20:00', PLANT],
      ['כל יום <day> ו<day> (unchanged)', `תזכיר לי כל יום שני ורביעי ב20:00 ${PLANT}`, [1, 3], '20:00', PLANT],
    ];
    for (const [label, text, days, time, title] of cases) {
      const q = quickParse(text, NOW, TZ);
      eq(`${label} → weekly`, q?.schedule_type, 'weekly');
      eq(`${label} → days`, JSON.stringify(q?.days), JSON.stringify(days));
      eq(`${label} → time`, q?.time, time);
      eq(`${label} → title`, q?.title, title);
    }
  }

  // -------------------------------------------------------------------------
  section('the working week, and days he excluded');
  {
    const WORK = [0, 1, 2, 3, 4];
    const cases: [string, string, number[]][] = [
      ['בימי חול', 'תזכיר לי בימי חול בשעה 7 לקום', WORK],
      ['כל יום חול', 'תזכיר לי כל יום חול בשעה 7 לקום', WORK],
      ['כל יום עבודה', 'תזכיר לי כל יום עבודה בשעה 7 לקום', WORK],
      // The one that rang on Saturday. Six days, not seven and not five.
      ['כל יום חוץ משבת', 'תזכיר לי כל יום חוץ משבת בשעה 7 לקום', [0, 1, 2, 3, 4, 5]],
      ['כל יום חוץ משישי ושבת', 'תזכיר לי כל יום חוץ משישי ושבת בשעה 7 לקום', WORK],
    ];
    for (const [label, text, days] of cases) {
      const q = quickParse(text, NOW, TZ);
      eq(`${label} → weekly`, q?.schedule_type, 'weekly');
      eq(`${label} → days`, JSON.stringify(q?.days), JSON.stringify(days));
      eq(`${label} → title`, q?.title, 'לקום');
    }
  }

  // -------------------------------------------------------------------------
  section('monthly — and the day-of-month is not an hour');
  {
    const cases: [string, string, number, string][] = [
      // "ב10" is the tenth, "בשעה 9" is the hour, and matchClock reads left to
      // right — so the day has to come OFF before the clock is lexed. Exactly
      // the ordering requirement readWhen's numeric date has, and the reason
      // that comment says it is a correctness rule rather than an optimisation.
      ['כל חודש ב<n> בשעה <h>', 'תזכיר לי כל חודש ב10 בשעה 9 לשלם שכירות', 10, '09:00'],
      ['כל <n> לחודש', 'תזכיר לי כל 1 לחודש בשעה 9 לשלם שכירות', 1, '09:00'],
      ['פעם בחודש ב<n>', 'תזכיר לי פעם בחודש ב15 בשעה 9 לשלם שכירות', 15, '09:00'],
      ['בסוף כל חודש', 'תזכיר לי בסוף כל חודש בשעה 9 לשלם שכירות', 31, '09:00'],
    ];
    for (const [label, text, day, time] of cases) {
      const q = quickParse(text, NOW, TZ);
      eq(`${label} → monthly`, q?.schedule_type, 'monthly');
      eq(`${label} → day`, q?.day_of_month, day);
      eq(`${label} → time`, q?.time, time);
      eq(`${label} → title`, q?.title, 'לשלם שכירות');
    }
  }

  // -------------------------------------------------------------------------
  section('computeNext walks a month, and clamps a short one');
  {
    const monthly = (day: number): Schedule => ({ type: 'monthly', day, time: '09:00' });

    const tenth = computeNext(monthly(10), TZ, wallToUtc(2026, 9, 30, 22, 19, TZ));
    const p = wallParts(tenth!, TZ);
    eq('the 10th, next month', `${p.day}.${p.month} ${p.hour}:00`, '10.10 9:00');

    // Same month, before the day — it must not skip to next month.
    const soon = computeNext(monthly(10), TZ, wallToUtc(2026, 10, 3, 12, 0, TZ));
    eq('the 10th, this month', wallParts(soon!, TZ).day, 10);

    // And not the same day twice: strictly after `afterMs`.
    const after = computeNext(monthly(10), TZ, wallToUtc(2026, 10, 10, 9, 0, TZ));
    const ap = wallParts(after!, TZ);
    eq('never the fire it was called with', `${ap.day}.${ap.month}`, '10.11');

    /*
     * February. The 31st does not exist, and the choice is clamp or skip.
     *
     * Clamping, because a standing bill on the 31st is a bill at the END of
     * the month and skipping February silently drops a payment. It is honest
     * only because voice.ts always states the instant it chose, the same
     * argument PERIOD_HOUR's 20:00 guess rests on.
     */
    const feb = computeNext(monthly(31), TZ, wallToUtc(2027, 1, 31, 23, 0, TZ));
    const fp = wallParts(feb!, TZ);
    eq('the 31st in February is the 28th', `${fp.day}.${fp.month}`, '28.2');

    const leap = computeNext(monthly(31), TZ, wallToUtc(2028, 1, 31, 23, 0, TZ));
    eq('and the 29th in a leap year', wallParts(leap!, TZ).day, 29);
  }

  // -------------------------------------------------------------------------
  section('describeSchedule says which recurrence it is');
  {
    eq(
      'monthly names the day',
      describeSchedule({ type: 'monthly', day: 10, time: '09:00' }),
      'כל 10 בחודש ב-09:00',
    );
    // 31 IS the last day under clamping, so saying "the 31st" would be wrong
    // in four months of the year and this says the thing that is always true.
    eq(
      'the last day says so',
      describeSchedule({ type: 'monthly', day: 31, time: '09:00' }),
      'בסוף כל חודש ב-09:00',
    );
  }

  // -------------------------------------------------------------------------
  section('#96 end to end: the row is weekly and it lands on a Monday');
  {
    const rig = createRig();
    seedSettings(rig);
    const ctx = await ctxFor(rig);
    const text = `תזכיר לי פעם בשבוע בימי שני בשעה 8 בערב ${PLANT}`;
    const q = quickParse(text, NOW, TZ);

    const out = await withNow(NOW, () => applyIntent(rig.env, CHAT, ctx, q!, text));
    eq('it created a reminder', out[0]?.kind, 'reminder_created');

    const row = rig.db
      .prepare('SELECT title, schedule, next_fire_at FROM reminders WHERE chat_id = ?')
      .get(CHAT) as { title: string; schedule: string; next_fire_at: number };
    eq('the errand is his sentence, nothing else', row.title, PLANT);
    eq('the schedule repeats', JSON.parse(row.schedule).type, 'weekly');
    // The whole point. #96 fired on Thursday 01.10 because it was a one-off
    // computed from the clock alone; a weekly [1] cannot land anywhere but a
    // Monday, and the next one after Wednesday 30.09 is 05.10.
    const fp = wallParts(row.next_fire_at, TZ);
    eq('and lands on Monday 05.10 at 20:00', `${fp.dow} ${fp.day}.${fp.month} ${fp.hour}:00`, '1 5.10 20:00');
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('the hour-correction button does not flatten a monthly');
  {
    /*
     * ADDING A SCHEDULE ARM IS NOT ONE EDIT, and this is the site nothing
     * reminds you about.
     *
     * The `retime` callback rebuilds the schedule around the corrected hour,
     * and it preserves `daily` and `weekly` by name — its own comment says
     * writing a `once` unconditionally "would have turned כל יום ב-7 into a
     * single 19:00 reminder the moment he tapped לא, 19:00 — ending the
     * recurrence silently, which is the worst outcome a correction button
     * could have."
     *
     * A `monthly` arm lands straight in that fallback. "כל חודש ב-10 בשעה 9"
     * is unsettled (9 ≤ 12, no period), so the button IS offered, and one tap
     * would have converted a standing bill into a one-off. The comment
     * describes the bug; the code shape is what has to prevent it.
     */
    const rig = createRig();
    seedSettings(rig);
    const id = Number(
      rig.db
        .prepare(
          `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
           VALUES (?, 'לשלם שכירות', ?, ?, ?, 'scheduled', 1, ?)`,
        )
        .run(CHAT, JSON.stringify({ type: 'monthly', day: 10, time: '09:00' }), TZ, NOW, NOW)
        .lastInsertRowid,
    );

    rig.speakQueue.push('שיניתי.');
    await withNow(NOW, () => runCallback(rig, `r:${id}:21:00`));

    const row = rig.db
      .prepare('SELECT schedule, next_fire_at FROM reminders WHERE id = ?')
      .get(id) as { schedule: string; next_fire_at: number };
    const s = JSON.parse(row.schedule) as Schedule;
    eq('it is still monthly', s.type, 'monthly');
    eq('on the same day of the month', s.type === 'monthly' ? s.day : null, 10);
    eq('at the corrected hour', s.type === 'monthly' ? s.time : null, '21:00');
    const np = wallParts(row.next_fire_at, TZ);
    eq('and the next fire is the 10th at 21:00', `${np.day}.${np.month} ${np.hour}:00`, '10.10 21:00');
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('what is deferred still refuses, rather than becoming something else');
  {
    /*
     * These have no arm on purpose. The assertion is not "returns null" — it
     * is that none of them produces a schedule that would ring on a day he
     * did not ask for, which is what they each did before 0.38.0.
     *
     * If a later version teaches one of these, this section fails loudly and
     * that is correct: the new arm has to be asserted properly, not silently
     * absorbed by a check that accepts anything.
     */
    const cases: [string, string, string[]][] = [
      ['כל שנה (annual)', 'תזכיר לי כל שנה ב15.3 בשעה 9 יום הולדת לאמא', ['once', 'daily', 'weekly', 'monthly']],
      ['כל שבועיים (fortnightly)', 'תזכיר לי כל שבועיים ביום שני ב20:00 להשקות', ['once', 'daily', 'weekly', 'monthly']],
      ['כל יומיים (every other day)', 'תזכיר לי כל יומיים בשעה 8 לקחת תרופה', ['once', 'daily', 'weekly', 'monthly']],
      ['כל חודשיים', 'תזכיר לי כל חודשיים ב10 בשעה 9 לשלם', ['once', 'daily', 'weekly', 'monthly']],
      // The dual is the trap: every lead-in added above ends in שבוע or חודש,
      // and these phrases begin with exactly that. A fortnightly request read
      // as weekly would fire twice as often as he asked, which is the same
      // class of silent error as a repeat rule read as one fire.
      ['פעם בשבועיים ביום <day>', 'תזכיר לי פעם בשבועיים ביום שני ב20:00 להשקות', ['once', 'daily', 'weekly', 'monthly']],
      ['פעם בשבועיים ב<day>', 'תזכיר לי פעם בשבועיים בשני ב20:00 להשקות', ['once', 'daily', 'weekly', 'monthly']],
      ['פעם בחודשיים', 'תזכיר לי פעם בחודשיים ב10 בשעה 9 לשלם', ['once', 'daily', 'weekly', 'monthly']],
      // His #97 typo. Grammar, not a spelling list.
      ['בים שני (his typo)', `תזכיר לי כל שבוע בים שני בשעה 8 בערב ${PLANT}`, ['once', 'daily', 'weekly', 'monthly']],
    ];
    for (const [label, text, forbidden] of cases) {
      const q = quickParse(text, NOW, TZ);
      check(
        `${label} → never ${forbidden.join('/')}`,
        q === null || !forbidden.includes(q.schedule_type ?? ''),
        `got ${JSON.stringify(q)}`,
      );
    }
  }

  done();
}

main();
