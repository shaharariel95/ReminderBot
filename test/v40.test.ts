/**
 * Run with `npm run test:v40`.
 *
 * **The recurrence died in the gap between the question and the answer.**
 *
 * 0.38.0 stopped a repeat rule being written as a single fire. 0.39.0 taught
 * the parser the phrasings. Both of those are about ONE message. This is about
 * two, and it is the last place a weekly reminder silently becomes a one-off.
 *
 *   him  תזכיר לי פעם בשבוע בימי שני להשקות את העציץ
 *   bot  תפסתי #98: "להשקות את העציץ". בלי שעה בינתיים — תגיד לי מתי.
 *   him  ב8 בערב
 *
 * He stated the recurrence in the first message and the hour in the second.
 * Nothing joined them. The capture stores a title and no schedule; the awaiting
 * slot stores `{k:'time', r:98}`; and his answer goes through
 * `parseAnswerTime`, which returns an INSTANT, so the synthesised intent was
 * `reschedule` + `once_at`. A reminder he asked to repeat every Monday was
 * written to fire once.
 *
 * This is production #85's shape exactly, one field over. CLAUDE.md already
 * states the rule it breaks — **"A missing hour ASKS, and the question carries
 * the request"** — and records what happens when the question carries only half
 * of it: `no_time` armed no slot, his answer reached the router as a fresh
 * sentence with no name in it, and became a reminder for the wrong person.
 * Here the missing half is not WHO but HOW OFTEN.
 *
 * What must hold:
 *
 *   1. The parser reports the recurrence it DID read even when the hour is
 *      missing, rather than returning null and letting the router guess. Code
 *      computes; that is what the whole time seam is for.
 *   2. The capture carries it, the slot stores it, and the answer rebuilds the
 *      RECURRING schedule around the hour he just gave.
 *   3. A capture with no recurrence behind it still answers to a one-off —
 *      this must not turn every "מתי?" into a weekly reminder.
 *   4. The question says what it is holding. A bot that has silently
 *      remembered "every Monday" and asks only "when?" is asking him to
 *      confirm something he cannot see.
 */
import worker from '../src/index';
import { applyIntent } from '../src/effects';
import type { Context } from '../src/brain';
import { quickParse } from '../src/quickparse';
import * as db from '../src/db';
import { renderBaseline } from '../src/voice';
import { wallParts, wallToUtc } from '../src/time';
import type { Schedule } from '../src/types';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

/** 30.09.2026 22:19 — a Wednesday. */
const NOW = wallToUtc(2026, 9, 30, 22, 19, TZ);

const PLANT = 'להשקות את העציץ';

async function runWebhook(rig: Rig, text: string): Promise<void> {
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
    body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text, message_id: 999 } }),
  });
  await worker.fetch(req, rig.env, ctx);
  await Promise.all(pending);
}

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
    inbox: await db.listInbox(rig.env, CHAT),
    friends: [],
    done: [],
  } as unknown as Context;
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section('the parser reports the recurrence it read, without the hour');
  {
    // It used to return null here, which handed the whole sentence to the
    // router — and the router's answer to "how often" is a guess where this is
    // a reading. `time` is absent, so scheduleFromIntent still refuses and the
    // row is still captured rather than written.
    const q = quickParse(`תזכיר לי פעם בשבוע בימי שני ${PLANT}`, NOW, TZ);
    eq('weekly', q?.schedule_type, 'weekly');
    eq('with the day he named', JSON.stringify(q?.days), '[1]');
    eq('and no hour invented', q?.time, undefined);
    eq('the errand is his', q?.title, PLANT);

    const m = quickParse('תזכיר לי כל חודש ב10 לשלם שכירות', NOW, TZ);
    eq('monthly too', m?.schedule_type, 'monthly');
    eq('with the day of the month', m?.day_of_month, 10);
    eq('and no hour invented', m?.time, undefined);

    // A bare "פעם בשבוע" names no day, so there is nothing to carry and
    // nothing to ask about beyond the hour. It must NOT become weekly-on-today.
    const bare = quickParse(`תזכיר לי פעם בשבוע ${PLANT}`, NOW, TZ);
    check(
      'a recurrence with no day named carries no days',
      bare === null || !bare.days?.length,
      `got ${JSON.stringify(bare)}`,
    );
  }

  // -------------------------------------------------------------------------
  section('the capture carries it and the question says so');
  {
    const rig = createRig();
    seedSettings(rig);
    const ctx = await ctxFor(rig);
    const text = `תזכיר לי פעם בשבוע בימי שני ${PLANT}`;
    const q = quickParse(text, NOW, TZ);

    const out = await withNow(NOW, () => applyIntent(rig.env, CHAT, ctx, q!, text));
    eq('it captured', out[0]?.kind, 'reminder_captured');
    check(
      'and the capture knows it repeats weekly on Monday',
      out[0]?.kind === 'reminder_captured' && JSON.stringify(out[0].rec) === '{"d":[1]}',
      `got ${JSON.stringify(out[0])}`,
    );

    // Nothing was SCHEDULED. The row is still an inbox capture with no
    // schedule — the recurrence is a pending question, not a write.
    const row = rig.db
      .prepare('SELECT status, schedule, next_fire_at FROM reminders WHERE chat_id = ?')
      .get(CHAT) as { status: string; schedule: string; next_fire_at: number | null };
    eq('the row is still a capture', row.status, 'inbox');
    eq('with nothing armed', row.next_fire_at, null);

    // The wording. A slot holding "every Monday" that asks only "when?" is
    // asking him to confirm something he cannot see.
    const said = renderBaseline(out, TZ);
    check('the question names the recurrence it is holding', /שני/.test(said), `said: ${said}`);
    check('and still asks for the hour', /שעה|מתי/.test(said), `said: ${said}`);
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('his hour rebuilds the RECURRING schedule, not a one-off');
  {
    const rig = createRig();
    seedSettings(rig);

    // Message one: the recurrence, no hour. Driven through the webhook so the
    // awaiting slot is armed by the real path rather than by the test.
    rig.speakQueue.push('תפסתי.');
    await withNow(NOW, () => runWebhook(rig, `תזכיר לי פעם בשבוע בימי שני ${PLANT}`));

    const armed = rig.db
      .prepare('SELECT awaiting FROM settings WHERE chat_id = ?')
      .get(CHAT) as { awaiting: string | null };
    const slot = db.readAwaiting(armed.awaiting, NOW);
    check(
      'the slot remembers the recurrence',
      slot?.k === 'time' && JSON.stringify(slot.rec) === '{"d":[1]}',
      `slot: ${armed.awaiting}`,
    );

    // Message two: the hour alone. No router call — the slot answers it.
    const before = rig.geminiCalls.filter((c) => c.kind === 'router').length;
    rig.speakQueue.push('קבעתי.');
    await withNow(NOW + 60_000, () => runWebhook(rig, 'ב8 בערב'));
    eq(
      'the answer costs no router call',
      rig.geminiCalls.filter((c) => c.kind === 'router').length,
      before,
    );

    const row = rig.db
      .prepare('SELECT status, schedule, next_fire_at FROM reminders WHERE chat_id = ?')
      .get(CHAT) as { status: string; schedule: string; next_fire_at: number };
    const s = JSON.parse(row.schedule) as Schedule;
    eq('it is scheduled now', row.status, 'scheduled');
    // The whole point of the version.
    eq('and it REPEATS', s.type, 'weekly');
    eq('on the day from message one', s.type === 'weekly' ? JSON.stringify(s.days) : null, '[1]');
    eq('at the hour from message two', s.type === 'weekly' ? s.time : null, '20:00');
    const p = wallParts(row.next_fire_at, TZ);
    eq('landing on Monday 05.10', `${p.dow} ${p.day}.${p.month} ${p.hour}:00`, '1 5.10 20:00');
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('a recurrence that cannot fire is dropped, and his hour still lands');
  {
    /*
     * The slot survives a round trip through a TEXT column, so what comes back
     * is not necessarily what was written — a stale row from an older version,
     * or one written before a clamp existed. `{d:[]}` and `{d:[9]}` both
     * produce a `weekly` that `computeNext` returns null for, which means the
     * row is never written at all: he answers the question and NOTHING
     * happens, with no error and no message that says so.
     *
     * Dropping the recurrence and falling back to a one-off is the honest
     * degradation — he gets the reminder he asked for at the hour he named,
     * and can make it repeat in one more message. Losing the hour is worse
     * than losing the recurrence.
     *
     * This case exists because the red-proof said so: with the sections above
     * alone, deleting `validRecurrence` left the suite green.
     */
    for (const [label, bad] of [['no days', { d: [] }], ['an impossible day', { d: [9] }]] as const) {
      const rig = createRig();
      seedSettings(rig);
      const id = Number(
        rig.db
          .prepare(
            `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
             VALUES (?, ?, '', ?, NULL, 'inbox', 1, ?)`,
          )
          .run(CHAT, PLANT, TZ, NOW).lastInsertRowid,
      );
      rig.db
        .prepare('UPDATE settings SET awaiting = ? WHERE chat_id = ?')
        .run(JSON.stringify({ k: 'time', r: id, rec: bad, at: NOW }), CHAT);

      rig.speakQueue.push('קבעתי.');
      await withNow(NOW + 60_000, () => runWebhook(rig, 'ב8 בערב'));

      const row = rig.db
        .prepare('SELECT status, schedule, next_fire_at FROM reminders WHERE id = ?')
        .get(id) as { status: string; schedule: string; next_fire_at: number | null };
      eq(`${label}: the reminder is still set`, row.status, 'scheduled');
      check(
        `${label}: at the hour he gave`,
        row.next_fire_at !== null && wallParts(row.next_fire_at, TZ).hour === 20,
        `row: ${JSON.stringify(row)}`,
      );
      rig.restore();
    }
  }

  // -------------------------------------------------------------------------
  section('a capture with no recurrence still answers to a one-off');
  {
    /*
     * The control, and it is not ceremony: the change above rewrites the
     * synthesised intent for EVERY answer to "מתי?", and the overwhelmingly
     * common case is a plain capture that should become a single fire. A
     * version of this that turned every answered question into a weekly
     * reminder would pass every assertion in the section above.
     */
    const rig = createRig();
    seedSettings(rig);

    rig.speakQueue.push('תפסתי.');
    await withNow(NOW, () => runWebhook(rig, `תזכיר לי ${PLANT}`));
    const slot = db.readAwaiting(
      (rig.db.prepare('SELECT awaiting FROM settings WHERE chat_id = ?').get(CHAT) as any).awaiting,
      NOW,
    );
    check('the slot carries no recurrence', slot?.k === 'time' && slot.rec === undefined,
      `slot: ${JSON.stringify(slot)}`);

    rig.speakQueue.push('קבעתי.');
    await withNow(NOW + 60_000, () => runWebhook(rig, 'ב8 בערב'));

    const row = rig.db
      .prepare('SELECT schedule FROM reminders WHERE chat_id = ?')
      .get(CHAT) as { schedule: string };
    eq('it is a one-off', (JSON.parse(row.schedule) as Schedule).type, 'once');
    rig.restore();
  }

  done();
}

main();
