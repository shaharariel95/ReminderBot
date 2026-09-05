/**
 * Run with `npm run test:v21`.
 *
 * issues.md §5 and the second half of §4, which turn out to be one event.
 *
 * When an ABSOLUTE retime lands on a reminder that is currently ringing, the
 * open instance is superseded — `db.closeInstance(ringing.id, 'skipped')`,
 * inside the reschedule branch, best-effort, emitting nothing. Two consequences,
 * both live in production:
 *
 *   1. **It leaves no trace.** effects are the write log and `sendOutcome` is
 *      the one point every path converges on, so a write with no effect gets no
 *      `events` row and no `/why` line. Reminder #69, straight out of the
 *      database:
 *
 *        instance 53  skipped  0 'דילג' events     <- superseded
 *        instance 54  skipped  0 'דילג' events     <- superseded
 *        instance 55  skipped  1 'דילג' event      <- he tapped "לא היום"
 *
 *      `/why 69` shows two rings that appear never to have closed at all.
 *
 *   2. **It is filed under the same word as a decline**, and `missStreak`
 *      counts every 'skipped' row as a miss — its own comment says "from the
 *      outside they are the same fact: it isn't happening". That is true of
 *      "לא היום" and false of a supersede: he MOVED it, which is the opposite
 *      of neglect. #69's three rows put missStreak at exactly MISS_THRESHOLD,
 *      so the next fire would have carried
 *
 *        "3 פעמים ברצף שזה לא קורה. אולי השעה לא נכונה, אולי זה לא באמת חשוב לך"
 *
 *      — a claim about HIM, two thirds of whose evidence is the bot's own
 *      tidy-up after he engaged with it.
 */
import { readFileSync } from 'node:fs';
import worker from '../src/index';
import * as db from '../src/db';
import { applyIntent } from '../src/effects';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Context } from '../src/brain';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';
const FIRED = wallToUtc(2026, 9, 3, 16, 30, TZ);
const NOW = wallToUtc(2026, 9, 3, 17, 0, TZ);

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

function seedRinging(rig: Rig, title: string): { reminder: number; instance: number } {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
       VALUES (?, ?, ?, ?, NULL, 'done', 1, ?, NULL)`,
    )
    .run(CHAT, title, JSON.stringify({ type: 'once', at: '2026-09-03T16:30' }), TZ, FIRED);
  const reminder = Number(r.lastInsertRowid);
  const i = rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, due_at)
       VALUES (?, ?, ?, ?, ?, 1, 'open', ?)`,
    )
    .run(reminder, CHAT, title, FIRED, FIRED + 1_800_000, FIRED);
  return { reminder, instance: Number(i.lastInsertRowid) };
}

async function ctxFor(rig: Rig): Promise<Context> {
  return {
    settings: await db.getSettings(rig.env, CHAT),
    stats: await db.stats(rig.env, CHAT),
    reminders: await db.listReminders(rig.env, CHAT),
    goals: [],
    open: await db.openInstances(rig.env, CHAT),
    nowLabel: 'עכשיו',
  };
}

async function say(rig: Rig, text: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.fetch(
    new Request('https://x/tg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text, message_id: 5 } }),
    }),
    rig.env,
    ctx,
  );
  await Promise.all(pending);
}

// ===========================================================================
section('§5 — a write with no effect leaves no history');
//
// The supersede closes a real row. events is the life story of a reminder and
// /why is what prints it; a close that never reaches sendOutcome is a chapter
// missing from the only record there is.
{
  const rig = createRig();
  seedSettings(rig);
  const { reminder, instance } = seedRinging(rig, 'לנקות את הפילטרים של המזגנים');

  const result = await withNow(NOW, async () =>
    applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'reschedule', target_id: reminder, schedule_type: 'once', once_at: '2026-09-04T16:30' },
      'תעביר את זה למחר ב16:30',
    ),
  );

  const closed = rig.db.prepare('SELECT status FROM instances WHERE id = ?').get(instance) as any;
  check(
    `the ring really was closed — ${closed.status}`,
    closed.status !== 'open',
    JSON.stringify(closed),
  );
  check(
    `and the turn says so, so sendOutcome can record it — ${JSON.stringify(result.map((e) => e.kind))}`,
    result.some((e) => e.kind === 'instance_superseded'),
    JSON.stringify(result),
  );
  check('the move itself is still reported',
    result.some((e) => e.kind === 'reminder_retimed'), JSON.stringify(result));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§5 — end to end, the event reaches /why');
{
  const rig = createRig();
  seedSettings(rig);
  const { reminder, instance } = seedRinging(rig, 'לנקות את הפילטרים');

  rig.routerQueue.push({
    actions: [{ action: 'reschedule', target_id: reminder, schedule_type: 'once', once_at: '2026-09-04T16:30' }],
  });
  rig.speakQueue.push(new Error('persona down — ship the baseline'));
  await withNow(NOW, () => say(rig, 'תעביר את זה למחר ב16:30'));

  const events = rig.db
    .prepare('SELECT kind FROM events WHERE reminder_id = ? ORDER BY id')
    .all(reminder) as any[];
  const kinds = events.map((e) => e.kind);
  check(`the supersede has its own word in events — ${JSON.stringify(kinds)}`,
    kinds.some((k) => k !== 'הוזזה' && k !== 'צלצלה'), JSON.stringify(kinds));
  check('and it is NOT filed as דילג, which is him declining',
    !kinds.includes('דילג'), JSON.stringify(kinds));

  await withNow(NOW + 1000, () => say(rig, `/why ${reminder}`));
  const why = rig.texts()[rig.texts().length - 1] ?? '';
  check(`/why can account for the ring — ${JSON.stringify(why)}`,
    why.includes('הוזזה') && /נדחק|גובר|הוחלף|בוטל/.test(why), why);
  eq('the instance is superseded, not skipped',
    (rig.db.prepare('SELECT status FROM instances WHERE id = ?').get(instance) as any).status,
    'superseded');
  rig.restore();
}

// ===========================================================================
section('§4 — moving it is not neglecting it');
//
// missStreak counts every 'skipped' row, and its comment justifies that by
// saying a decline and a give-up are "the same fact from the outside". A
// supersede is not: he moved it, which is engagement. #69's two superseded
// rings plus one genuine decline put the counter at MISS_THRESHOLD exactly.
{
  const rig = createRig();
  seedSettings(rig);
  const { reminder } = seedRinging(rig, 'לנקות את הפילטרים');
  const addClosed = (status: string, proof: string | null, at: number) =>
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, proof, closed_at, due_at)
         VALUES (?, ?, 'לנקות את הפילטרים', ?, NULL, 0, ?, ?, ?, ?)`,
      )
      .run(reminder, CHAT, at, status, proof, at + 60_000, at);

  // #69's actual history: two superseded rings, then one real "לא היום".
  addClosed('superseded', null, FIRED - 2 * 86_400_000);
  addClosed('superseded', null, FIRED - 86_400_000);
  addClosed('skipped', 'כפתור', FIRED - 3_600_000);

  const streak = await db.missStreak(rig.env, reminder);
  eq('only the decline counts against him', streak, 1);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§4 — and a real run of misses still counts');
//
// The guard must not blunt the thing missStreak exists for. Three declines in
// a row is exactly the case missNote was written for.
{
  const rig = createRig();
  seedSettings(rig);
  const { reminder } = seedRinging(rig, 'לנקות את הפילטרים');
  for (let i = 3; i >= 1; i--) {
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, proof, closed_at, due_at)
         VALUES (?, ?, 'לנקות את הפילטרים', ?, NULL, 0, 'skipped', 'כפתור', ?, ?)`,
      )
      .run(reminder, CHAT, FIRED - i * 86_400_000, FIRED - i * 86_400_000 + 60_000, FIRED - i * 86_400_000);
  }
  eq('three declines running is still three', await db.missStreak(rig.env, reminder), 3);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§4 — cancelling a reminder does not retro-blame him either');
//
// deleteReminder closes any open instance the same way the supersede did, and
// for the same reason: the row is gone, and he did not decline anything.
{
  const rig = createRig();
  seedSettings(rig);
  const { reminder, instance } = seedRinging(rig, 'לנקות את הפילטרים');
  await withNow(NOW, () => db.deleteReminder(rig.env, CHAT, reminder));
  eq('the open instance is superseded, not skipped',
    (rig.db.prepare('SELECT status FROM instances WHERE id = ?').get(instance) as any).status,
    'superseded');
  eq('so it is not held against the reminder', await db.missStreak(rig.env, reminder), 0);
  rig.restore();
}

// ===========================================================================
section('§4 — the day tally does not report a supersede as a skip');
//
// dayTally feeds the evening close-out. A ring the bot tidied away after he
// moved something is not a thing he skipped today.
{
  const rig = createRig();
  seedSettings(rig);
  const { reminder } = seedRinging(rig, 'לנקות את הפילטרים');
  const { from, to } = { from: FIRED - 3_600_000, to: FIRED + 8 * 3_600_000 };
  // A different due_at from the ringing instance seeded above: migration 017's
  // (reminder_id, due_at) index is unique, which is what stops two overlapping
  // ticks opening one dose twice.
  rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, proof, closed_at, due_at)
       VALUES (?, ?, 'לנקות את הפילטרים', ?, NULL, 0, 'superseded', NULL, ?, ?)`,
    )
    .run(reminder, CHAT, FIRED + 3_600_000, FIRED + 3_660_000, FIRED + 3_600_000);

  const tally = await db.dayTally(rig.env, CHAT, from, to);
  eq('nothing was skipped today', tally.skipped, 0);
  eq('nothing was done either', tally.done, 0);
  eq('and nothing failed', tally.failed, 0);
  rig.restore();
}

// ===========================================================================
section('§4 — the backfill rule is the one the data actually supports');
//
// Historical rows cannot be re-derived from status alone, but they can from
// `proof`: closeIfOpen stamps 'כפתור' or 'נדחה למחר' on every genuine decline,
// and both the supersede and deleteReminder leave it NULL. Verified against
// production before it was written — 3 'כפתור', 1 'נדחה למחר', 2 NULL, and the
// two NULLs are instances 53 and 54, exactly the ones with no דילג event.
{
  const rig = createRig();
  seedSettings(rig);
  const { reminder } = seedRinging(rig, 'לנקות את הפילטרים');
  const add = (proof: string | null, at: number) =>
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, proof, closed_at, due_at)
         VALUES (?, ?, 'x', ?, NULL, 0, 'skipped', ?, ?, ?)`,
      )
      .run(reminder, CHAT, at, proof, at + 1000, at);
  add(null, FIRED - 3 * 86_400_000);
  add('כפתור', FIRED - 2 * 86_400_000);
  add('נדחה למחר', FIRED - 86_400_000);

  // The REAL migration file, not a copy of its SQL. A test that retypes the
  // statement proves SQLite works; running the artifact proves the artifact
  // does, and it is the artifact that gets pointed at production.
  rig.db.exec(readFileSync('migrations/019_superseded_instances.sql', 'utf8'));
  const rows = rig.db
    .prepare("SELECT status, COUNT(*) AS n FROM instances WHERE reminder_id = ? GROUP BY status")
    .all(reminder) as any[];
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  eq('the un-proofed close becomes superseded', by.superseded, 1);
  eq('both button taps stay skipped', by.skipped, 2);
  rig.restore();
}

done();
