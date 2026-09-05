/**
 * Run with `npm run test:v24`.
 *
 * One invariant, stated for the first time: **every unprompted message the bot
 * sends leaves a row in `events`, filed under the right row.**
 *
 * `events` is the life story of a reminder and the thing `/why` prints;
 * `/diag` counts it over a day. Both are how a "why is this bot talking to me"
 * question gets answered. Two ways they were lying:
 *
 *   1. THREE unprompted message kinds wrote nothing at all — morning_brief,
 *      evening_closeout and checkin_goal. Production 04.09.2026: reminder #78
 *      drew four bot messages after it fired and `events` recorded three, so
 *      `/diag` said "נדנודים: 2" on a day he had received three pressure
 *      messages (0.22.0 fixed the close-out's REGISTER and named this gap as
 *      still open).
 *
 *   2. `instance_superseded` — added in 0.21.0 — carries an INSTANCE id and is
 *      not in ID_IS_INSTANCE, so recordEvents files it as `reminder_id`. The
 *      0.21.0 test could not see it: a fresh rig gives the first reminder and
 *      the first instance both id 1, so `WHERE reminder_id = 1` matched either
 *      way. This file forces the ids apart, which is the only way to tell.
 */
import worker from '../src/index';
import * as db from '../src/db';
import { applyIntent } from '../src/effects';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Context } from '../src/brain';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';
const FIRED = wallToUtc(2026, 9, 4, 14, 59, TZ);
const CLOSEOUT = wallToUtc(2026, 9, 4, 21, 0, TZ);

function seedSettings(rig: Rig, over: Record<string, unknown> = {}): void {
  const r = { brief_hour: null, closeout_hour: null, checkins: 0, next_checkin_at: null, ...over } as any;
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, ?, 2, 23, 9, ?, ?, ?, NULL, NULL)`,
    )
    .run(CHAT, TZ, r.checkins, r.next_checkin_at, r.brief_hour, r.closeout_hour);
}

function seedOpen(rig: Rig, title: string): number {
  const rem = Number(
    rig.db
      .prepare(
        `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
         VALUES (?, ?, ?, ?, NULL, 'done', 1, ?, NULL)`,
      )
      .run(CHAT, title, JSON.stringify({ type: 'once', at: '2026-09-04T14:59' }), TZ, FIRED - 3_600_000)
      .lastInsertRowid,
  );
  rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, due_at)
       VALUES (?, ?, ?, ?, ?, 2, 'open', ?)`,
    )
    .run(rem, CHAT, title, FIRED, CLOSEOUT + 8 * 3_600_000, FIRED);
  return rem;
}

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

const events = (rig: Rig) =>
  rig.db.prepare('SELECT kind, reminder_id, instance_id FROM events ORDER BY id').all() as any[];

// ===========================================================================
section('§2 — a superseded ring is filed under the INSTANCE, not the reminder');
//
// The 0.21.0 bug, and the reason its own test could not see it. A fresh rig
// numbers the first reminder 1 and the first instance 1, so `reminder_id = 1`
// is true whichever id was written. Six burnt instance rows put them apart.
{
  const rig = createRig();
  seedSettings(rig);
  const rem = Number(
    rig.db
      .prepare(
        `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
         VALUES (?, 'לנקות את הפילטרים', ?, ?, NULL, 'done', 1, ?, NULL)`,
      )
      .run(CHAT, JSON.stringify({ type: 'once', at: '2026-09-04T14:59' }), TZ, FIRED - 3_600_000)
      .lastInsertRowid,
  );
  for (let i = 0; i < 6; i++) {
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status, closed_at, due_at)
         VALUES (?, ?, 'ישן', ?, 'done', ?, ?)`,
      )
      .run(rem, CHAT, FIRED - (10 + i) * 86_400_000, FIRED - (10 + i) * 86_400_000, FIRED - (10 + i) * 86_400_000);
  }
  const inst = Number(
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, due_at)
         VALUES (?, ?, 'לנקות את הפילטרים', ?, ?, 1, 'open', ?)`,
      )
      .run(rem, CHAT, FIRED, FIRED + 1_800_000, FIRED).lastInsertRowid,
  );
  check(`the ids are genuinely apart — reminder ${rem}, instance ${inst}`, rem !== inst);

  const ctx: Context = {
    settings: await db.getSettings(rig.env, CHAT),
    stats: await db.stats(rig.env, CHAT),
    reminders: await db.listReminders(rig.env, CHAT),
    goals: [], open: await db.openInstances(rig.env, CHAT), nowLabel: '',
  };
  const effects = await withNow(CLOSEOUT, () =>
    applyIntent(rig.env, CHAT, ctx,
      { action: 'reschedule', target_id: rem, schedule_type: 'once', once_at: '2026-09-10T16:30' },
      'תעביר את זה'),
  );
  await withNow(CLOSEOUT, () => db.recordEvents(rig.env, CHAT, effects as any));

  const row = events(rig).find((e) => e.kind === 'נדחק');
  check(`the supersede was recorded — ${JSON.stringify(events(rig).map((e) => e.kind))}`, !!row);
  eq('under the instance it actually closed', row?.instance_id, inst);
  eq('and NOT as a reminder id it never was', row?.reminder_id, rem);
  rig.restore();
}

// ===========================================================================
section('§1 — the evening close-out leaves a record');
//
// 04.09.2026: #78 drew four bot messages after it fired; events recorded three.
// /diag said "נדנודים: 2" on a day he had had three pressure messages.
{
  const rig = createRig();
  seedSettings(rig, { closeout_hour: 21 });
  seedOpen(rig, 'להזמין אוכל ללילה');

  rig.speakQueue.push('סיכום.');
  await withNow(CLOSEOUT, () => runCron(rig));

  const kinds = events(rig).map((e) => e.kind);
  check(`the close-out is in the record — ${JSON.stringify(kinds)}`,
    kinds.some((k) => /סיכום|ערב/.test(k)), JSON.stringify(kinds));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§1 — and so does the morning brief');
{
  const rig = createRig();
  seedSettings(rig, { brief_hour: 9 });
  const rem = seedOpen(rig, 'להזמין אוכל ללילה');
  // Past the nag, so the brief is what goes out — see 0.18.0's !chasing guard.
  rig.db.prepare('UPDATE instances SET next_nag_at = ? WHERE reminder_id = ?')
    .run(wallToUtc(2026, 9, 6, 12, 0, TZ), rem);

  rig.speakQueue.push('בוקר.');
  await withNow(wallToUtc(2026, 9, 5, 9, 30, TZ), () => runCron(rig));

  const kinds = events(rig).map((e) => e.kind);
  check(`the brief is in the record — ${JSON.stringify(kinds)}`,
    kinds.some((k) => /בוקר|סיכום/.test(k)), JSON.stringify(kinds));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§1 — a daily message is about the CHAT, not about a reminder');
//
// It names several reminders or none. Filing it under one of them would put a
// line in that reminder's /why story that is not about it — which is the same
// mistake as the superseded ring above, in the other direction.
{
  const rig = createRig();
  seedSettings(rig, { closeout_hour: 21 });
  const rem = seedOpen(rig, 'להזמין אוכל ללילה');

  rig.speakQueue.push('סיכום.');
  await withNow(CLOSEOUT, () => runCron(rig));

  const daily = events(rig).filter((e) => /סיכום|ערב|בוקר/.test(e.kind));
  check(`a daily row exists — ${JSON.stringify(events(rig).map((e) => e.kind))}`, daily.length > 0);
  check('and carries no reminder id',
    daily.every((e) => e.reminder_id === null), JSON.stringify(daily));

  await withNow(CLOSEOUT + 1000, async () => {
    const pending: Promise<unknown>[] = [];
    const c: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
    await worker.fetch(
      new Request('https://x/tg', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text: `/why ${rem}`, message_id: 3 } }),
      }),
      rig.env, c,
    );
    await Promise.all(pending);
  });
  const why = rig.texts()[rig.texts().length - 1] ?? '';
  check(`/why shows the reminder's own story only — ${JSON.stringify(why)}`,
    !/סיכום ערב/.test(why), why);
  rig.restore();
}

// ===========================================================================
section('§1 — a goal check-in is recorded, and its GOAL id is not a reminder id');
//
// The trap in the naive fix. checkin_goal carries `id: goal.id`, and
// recordEvents' default branch reads `e.id` as a reminder id — so adding this
// kind without saying where its id belongs would file a goal's number into
// some unrelated reminder's history.
{
  const rig = createRig();
  seedSettings(rig, { checkins: 1, next_checkin_at: FIRED - 1000 });
  // Deliberately NO open instance: maybeCheckIn is gated on `ctx.open.length`,
  // and correctly — an unprompted question about a goal while a task is
  // ringing is the noise the whole check-in budget exists to avoid.
  rig.db
    .prepare(
      `INSERT INTO goals (chat_id, title, why, status, checkin_count, last_checkin_at, created_at)
       VALUES (?, 'להגיד לאישתי משהו יפה', NULL, 'active', 0, NULL, ?)`,
    )
    .run(CHAT, FIRED - 30 * 86_400_000);

  rig.speakQueue.push('נו?', 'ומה עם המטרה?');
  await withNow(FIRED + 60_000, () => runCron(rig));

  const rows = events(rig).filter((e) => /מטרה|צ׳ק|בדיקה/.test(e.kind));
  check(`the check-in is recorded — ${JSON.stringify(events(rig).map((e) => e.kind))}`,
    rows.length > 0);
  check('and its goal id is not filed as a reminder id',
    rows.every((e) => e.reminder_id === null), JSON.stringify(rows));
  rig.restore();
}

// ===========================================================================
section('§1 — /diag accounts for what he actually received');
{
  const rig = createRig();
  seedSettings(rig, { closeout_hour: 21 });
  seedOpen(rig, 'להזמין אוכל ללילה');

  rig.speakQueue.push('סיכום.');
  await withNow(CLOSEOUT, () => runCron(rig));

  await withNow(CLOSEOUT + 1000, async () => {
    const pending: Promise<unknown>[] = [];
    const c: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
    await worker.fetch(
      new Request('https://x/tg', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text: '/diag', message_id: 4 } }),
      }),
      rig.env, c,
    );
    await Promise.all(pending);
  });
  /*
   * The LAST message only, and matched on the label rather than on a word.
   *
   * Joining every text was how this first passed with the line deleted: the
   * close-out sent moments earlier is the persona's own "סיכום.", so a regex
   * looking for "סיכום" anywhere in the transcript matched the thing being
   * counted instead of the count.
   */
  const diag = rig.texts()[rig.texts().length - 1] ?? '';
  check(`/diag names the daily messages — ${JSON.stringify(diag.slice(0, 600))}`,
    /הודעות יומיות/.test(diag), diag);
  check('and counts the one that went out',
    /ערב 1/.test(diag), diag);
  rig.restore();
}

done();
