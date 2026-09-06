/**
 * Run with `npm run test:v25`.
 *
 * issues.md §4, first half: `reminders.status` answers three different
 * questions with one enum — does the row exist, will it ring again, and is it
 * finished. 0.17.0 fixed the ENGAGEMENT half at two consumers (the router's
 * active list, and `/list`). This is the contradiction that fix left behind.
 *
 * `setNextFire(id, null)` flips a one-off to `status='done'` the moment it
 * FIRES. So while the bot is actively chasing him, the same reminder is
 * rendered into the router prompt three times:
 *
 *   תזכורות פעילות (מתוזמנות לשעה):        #12 "..." — צלצלה כבר, מחכה לדיווח
 *   כבר קרו והסתיימו — ...                  #12 "..." — כבר נסגרה
 *   משימות פתוחות שמחכות לדיווח:            instance 3 → "..."
 *
 * The second block's own heading says "already happened and ENDED". A model
 * asked to reconcile "waiting for a report" with "already closed" in one
 * prompt is being set up to fail, and CLAUDE.md's whole "What the model can
 * SEE" section exists because a partial or contradictory view is the usual
 * cause of what looks like a comprehension failure.
 *
 * It is also what made three of the 0.17.0 tests pass vacuously: they asserted
 * `system.includes(title)`, which was true from the done block whether the fix
 * worked or not. That is why the assertions here are scoped to one block.
 */
import worker from '../src/index';
import * as db from '../src/db';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';
const DUE = wallToUtc(2026, 9, 4, 14, 59, TZ);

function seedSettings(rig: Rig): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(CHAT, TZ);
}

function seedReminder(rig: Rig, title: string): number {
  return Number(
    rig.db
      .prepare(
        `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?, NULL)`,
      )
      .run(CHAT, title, JSON.stringify({ type: 'once', at: '2026-09-04T14:59' }), TZ, DUE, DUE - 3_600_000)
      .lastInsertRowid,
  );
}

/*
 * The `Promise.all(pending)` is INSIDE withNow, not after it.
 *
 * handleUpdate runs under ctx.waitUntil, so awaiting the queue outside the
 * frozen clock means buildContext — and every `Date.now() - WINDOW` in it —
 * runs against the real wall clock instead of the pinned one. That is how the
 * first draft of this file produced an empty `done` block and looked like a
 * bug in recentlyDone. Every other test file here already nests it this way.
 */
async function runCron(rig: Rig, at: number): Promise<void> {
  rig.speakQueue.push('נו?');
  await withNow(at, async () => {
    const pending: Promise<unknown>[] = [];
    const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
    await worker.scheduled({} as any, rig.env, ctx);
    await Promise.all(pending);
  });
}

async function say(rig: Rig, text: string, at: number): Promise<void> {
  await withNow(at, async () => {
    const pending: Promise<unknown>[] = [];
    const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
    await worker.fetch(
      new Request('https://x/tg', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text, message_id: 7 } }),
      }),
      rig.env, ctx,
    );
    await Promise.all(pending);
  });
}

/** One named block out of the router prompt, and nothing either side of it. */
function block(system: string, from: string, to: string): string {
  const a = system.indexOf(from);
  const b = system.indexOf(to);
  return a < 0 || b < 0 || b < a ? '' : system.slice(a, b);
}
const routerSystem = (rig: Rig) =>
  rig.geminiCalls.filter((c) => c.kind === 'router').pop()?.system ?? '';

const ACTIVE = ['תזכורות פעילות', 'נתפסו אבל עדיין בלי שעה'] as const;
const FINISHED = ['כבר קרו והסתיימו', 'מטרות מתמשכות'] as const;

// ===========================================================================
section('a reminder that is ringing is not "already finished"');
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'להזמין אוכל ללילה');
  await runCron(rig, DUE + 30_000);

  const row = rig.db.prepare('SELECT status, next_fire_at FROM reminders WHERE id = ?').get(id) as any;
  eq('the row really did flip to done on firing — this is the condition', row.status, 'done');
  eq('with no next fire', row.next_fire_at, null);
  const open = rig.db
    .prepare("SELECT COUNT(*) AS n FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;
  eq('and it is still open, being chased', open.n, 1);

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('אוקיי.');
  await say(rig, 'מה קורה', DUE + 60_000);

  const system = routerSystem(rig);
  const active = block(system, ...ACTIVE);
  const finished = block(system, ...FINISHED);
  check(`the prompt has both blocks — ${JSON.stringify([active.length, finished.length])}`,
    active.length > 0 && finished.length > 0);

  check('it is listed as active, because it is',
    active.includes('להזמין אוכל ללילה'), active);
  check('and NOT as something that already ended',
    !finished.includes('להזמין אוכל ללילה'), finished);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('once he closes it, it IS finished and moves across');
//
// The block exists for a real reason — "ללכת למוסך ב10:30" about a task that
// closed this morning is a reschedule of that row, and without this block the
// only action available to the model is create_reminder. Excluding a ringing
// reminder must not empty it.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'להזמין אוכל ללילה');
  await runCron(rig, DUE + 30_000);

  const inst = rig.db
    .prepare("SELECT id FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;
  rig.db
    .prepare("UPDATE instances SET status = 'done', closed_at = ? WHERE id = ?")
    .run(DUE + 120_000, inst.id);

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('אוקיי.');
  await say(rig, 'מה קורה', DUE + 180_000);

  const system = routerSystem(rig);
  check('now it is in the finished block',
    block(system, ...FINISHED).includes('להזמין אוכל ללילה'),
    block(system, ...FINISHED));
  check('and out of the active one',
    !block(system, ...ACTIVE).includes('להזמין אוכל ללילה'),
    block(system, ...ACTIVE));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('a reminder the bot GAVE UP on is finished, not active');
//
// gave_up closes the instance as 'failed'. There is nothing left waiting for a
// report, so it belongs with the finished ones — the exclusion has to be about
// an OPEN instance, not about having any instance at all.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'להזמין אוכל ללילה');
  await runCron(rig, DUE + 30_000);
  rig.db
    .prepare("UPDATE instances SET status = 'failed', closed_at = ? WHERE reminder_id = ?")
    .run(DUE + 120_000, id);

  const rows = await withNow(DUE + 180_000, () =>
    db.recentlyDone(rig.env, CHAT, DUE - 6 * 3_600_000));
  check('a given-up reminder is still reachable as finished',
    rows.some((r) => r.id === id), JSON.stringify(rows.map((r) => r.id)));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('/list does not call a ringing reminder finished either');
{
  const rig = createRig();
  seedSettings(rig);
  seedReminder(rig, 'להזמין אוכל ללילה');
  await runCron(rig, DUE + 30_000);

  await say(rig, '/list', DUE + 60_000);
  const list = rig.texts()[rig.texts().length - 1] ?? '';
  check(`it is on the list — ${JSON.stringify(list)}`, list.includes('להזמין אוכל ללילה'), list);
  check('and not described as closed', !/נסגרה|הסתיימ/.test(list), list);
  rig.restore();
}

done();
