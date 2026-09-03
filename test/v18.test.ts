/**
 * Run with `npm run test:v18`.
 *
 * issues.md §12 — "things that are just bugs". Eight of the eleven were still
 * open after 0.17.1; #2 was a misdiagnosis and is reverted, #4 (the MAX_TOKENS
 * retry) and #9 (the `/error` alias) shipped in 0.15.0.
 *
 * Every one of these is [verified] against a production row or transcript.
 * None of them needs an architecture, and none of them should be dressed up as
 * one — but each is a thing the bot says or does that is not true, and the one
 * rule this codebase is built under is that it must never claim something it
 * did not do.
 */
import worker from '../src/index';
import * as db from '../src/db';
import { buttonsFor } from '../src/buttons';
import { wallToUtc } from '../src/time';
import {
  callbackUpdate, check, createRig, done, eq, section, textUpdate, withNow, type Rig,
} from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

async function post(rig: Rig, update: unknown): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  const req = new Request('https://x/tg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
  await worker.fetch(req, rig.env, ctx);
  await Promise.all(pending);
}

const say = (rig: Rig, text: string) => post(rig, textUpdate(CHAT, text));
const tap = (rig: Rig, data: string) => post(rig, callbackUpdate(CHAT, data));

function seedSettings(rig: Rig, over: Partial<Record<string, unknown>> = {}): void {
  const row = {
    quiet_start_hour: 23, quiet_end_hour: 8, brief_hour: null, closeout_hour: null,
    last_brief_on: null, last_closeout_on: null, ...over,
  } as any;
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(CHAT, TZ, row.quiet_start_hour, row.quiet_end_hour, row.brief_hour,
      row.closeout_hour, row.last_brief_on, row.last_closeout_on);
}

function seedReminder(
  rig: Rig, title: string, dueAt: number | null, schedule: unknown, over: any = {},
): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
    )
    .run(CHAT, title, JSON.stringify(schedule), TZ, dueAt,
      over.status ?? 'scheduled', over.created_at ?? (dueAt ?? Date.now()));
  return Number(r.lastInsertRowid);
}

/** The bot's last message — the reply to what was just said. */
const lastReply = (rig: Rig) => rig.texts()[rig.texts().length - 1] ?? '';

/** Every callback_data on the most recent message that carried a keyboard. */
function lastKeyboard(rig: Rig): string[] {
  for (let i = rig.sent.length - 1; i >= 0; i--) {
    const m: any = rig.sent[i].markup;
    if (m?.inline_keyboard) {
      return m.inline_keyboard.flat().map((b: any) => String(b.callback_data));
    }
  }
  return [];
}

const DUE = wallToUtc(2026, 9, 3, 16, 30, TZ);

// ---------------------------------------------------------------------------
section('§12.1 — a reminder finished five minutes ago is "recently done"');
//
// `recentlyDone` filters `created_at >= sinceMs`: the CREATION date, not the
// completion date. The block exists so that "ללכת למוסך ב10:30" about a task
// that fired and closed this morning routes as a reschedule of that row
// instead of making the model recover an id it was never shown. A reminder set
// last week and closed ten minutes ago is exactly the case it is for, and is
// exactly the case it misses.
{
  const rig = createRig();
  seedSettings(rig);
  const weekAgo = DUE - 7 * 86_400_000;
  const id = seedReminder(rig, 'ללכת למוסך', null, { type: 'once', at: '2026-08-27T08:20' }, {
    status: 'done', created_at: weekAgo,
  });
  rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status, closed_at, due_at)
       VALUES (?, ?, 'ללכת למוסך', ?, 'done', ?, ?)`,
    )
    .run(id, CHAT, DUE - 3_600_000, DUE - 600_000, DUE - 3_600_000);

  const rows = await withNow(DUE, () => db.recentlyDone(rig.env, CHAT, DUE - 6 * 3_600_000));
  check(
    'closed ten minutes ago, created a week ago — it is in the window',
    rows.some((r) => r.id === id),
    JSON.stringify(rows.map((r) => r.id)),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.1 — and something closed long ago is still out of it');
//
// The other half. Widening the window by dropping the filter entirely would
// pass the test above and put every reminder he has ever closed into every
// router prompt — the §9 failure mode, in the other direction.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'משהו ישן', null, { type: 'once', at: '2026-08-27T08:20' }, {
    status: 'done', created_at: DUE - 600_000,
  });
  rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status, closed_at, due_at)
       VALUES (?, ?, 'משהו ישן', ?, 'done', ?, ?)`,
    )
    .run(id, CHAT, DUE - 9 * 86_400_000, DUE - 8 * 86_400_000, DUE - 9 * 86_400_000);

  const rows = await withNow(DUE, () => db.recentlyDone(rig.env, CHAT, DUE - 6 * 3_600_000));
  check(
    'closed eight days ago — out, whatever created_at says',
    !rows.some((r) => r.id === id),
    JSON.stringify(rows.map((r) => r.id)),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.3 — a reschedule to the hour it already has is not a move');
//
// `rename` guards `to === rem.title`. `reschedule` has no equivalent, so
// retimeReminder returns true for an UPDATE that changed nothing, and the turn
// emits reminder_retimed — "שיניתי" — plus a `הוזזה` row in events. The whole
// observability story is that events is the life of a reminder; a move that
// did not happen is a false line in it.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לדבר עם הביטוח', DUE, { type: 'once', at: '2026-09-03T16:30' });

  rig.routerQueue.push({
    actions: [{ action: 'reschedule', target_id: id, schedule_type: 'once', once_at: '2026-09-03T16:30' }],
  });
  rig.speakQueue.push(new Error('persona down — ship the baseline verbatim'));
  await withNow(DUE - 3_600_000, () => say(rig, 'תעביר את זה ל-16:30'));

  const moved = rig.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE reminder_id = ? AND kind = 'הוזזה'")
    .get(id) as any;
  eq('no הוזזה event for a move that did not happen', moved.n, 0);
  check(
    'and the reply does not claim one',
    !/שיניתי|הזזתי/.test(lastReply(rig)),
    lastReply(rig),
  );
  check('it still says something', lastReply(rig).length > 0, JSON.stringify(rig.texts()));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.3 — a real move is still reported as one');
//
// The guard above must be equality, not a blanket suppression.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לדבר עם הביטוח', DUE, { type: 'once', at: '2026-09-03T16:30' });

  rig.routerQueue.push({
    actions: [{ action: 'reschedule', target_id: id, schedule_type: 'once', once_at: '2026-09-03T18:00' }],
  });
  rig.speakQueue.push(new Error('persona down'));
  await withNow(DUE - 3_600_000, () => say(rig, 'תעביר את זה ל-18:00'));

  const moved = rig.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE reminder_id = ? AND kind = 'הוזזה'")
    .get(id) as any;
  eq('a genuine retime still writes its event', moved.n, 1);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.5 — "לא היום" on a one-off does not promise a tomorrow');
//
// voice.ts says `"X" ירדה להיום. בלי כישלון.` for every skip alike. On a
// recurring reminder that is exactly right — tomorrow's dose is already
// scheduled. On a one-off there is no tomorrow: the row is already status
// 'done' with next_fire_at NULL, so "ירדה **להיום**" promises a return the
// errand will never make, and the task is gone.
//
// Production 03.09.2026 17:45: #69 skipped, never seen again.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים של המזגנים', DUE, {
    type: 'once', at: '2026-09-03T16:30',
  });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 30_000, () => runCron(rig));
  const inst = rig.db
    .prepare("SELECT id FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;
  check('it really did fire', !!inst, 'no open instance');

  await withNow(DUE + 60_000, () => tap(rig, `x:${inst.id}`));
  check(
    'a one-off that was skipped is not described as coming back today',
    !lastReply(rig).includes('ירדה להיום'),
    lastReply(rig),
  );
  check('and the errand is still named', lastReply(rig).includes('לנקות את הפילטרים'), lastReply(rig));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.5 — a recurring skip keeps the wording it had');
//
// "ירדה להיום. בלי כישלון." is TRUE about a daily reminder and is the reason
// skipping is a first-class option rather than a failure. The fix must not
// take it away from the case it was written for.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לקחת תרופה', DUE, { type: 'daily', time: '16:30' });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 30_000, () => runCron(rig));
  const inst = rig.db
    .prepare("SELECT id FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;

  await withNow(DUE + 60_000, () => tap(rig, `x:${inst.id}`));
  check(
    'a daily reminder really does come back tomorrow, and still says so',
    lastReply(rig).includes('ירדה להיום'),
    lastReply(rig),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.6 — a ringing reminder offers "מחר"');
//
// The keyboard is `עשיתי · עוד 10 דק׳ · לא היום`. "Move it to tomorrow" is the
// deferral he actually reached for twice in two days, and both times it cost a
// model call, a question and a second message. The `tomorrow` callback already
// exists and already does the right thing — it was only ever wired to the
// evening close-out.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים של המזגנים', DUE, {
    type: 'once', at: '2026-09-03T16:30',
  });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 30_000, () => runCron(rig));
  const inst = rig.db
    .prepare("SELECT id FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;

  const keys = lastKeyboard(rig);
  check(`the fire keyboard offers מחר — ${JSON.stringify(keys)}`, keys.includes(`m:${inst.id}`));
  check('and still offers all three it had', ['d', 's', 'x'].every((p) =>
    keys.some((k) => k.startsWith(`${p}:${inst.id}`))), JSON.stringify(keys));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.6 — and the button moves it, from the fire message');
//
// buttonsFor is one function and index.ts is another; a keyboard that offers a
// callback the handler mishandles is worse than no button.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים', DUE, { type: 'once', at: '2026-09-03T16:30' });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 30_000, () => runCron(rig));
  const inst = rig.db
    .prepare("SELECT id FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;

  await withNow(DUE + 60_000, () => tap(rig, `m:${inst.id}`));
  const row = rig.db.prepare('SELECT status, next_fire_at FROM reminders WHERE id = ?').get(id) as any;
  eq('it is scheduled again', row.status, 'scheduled');
  eq(
    'for the same hour tomorrow',
    row.next_fire_at,
    wallToUtc(2026, 9, 4, 16, 30, TZ),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.7 — a nag does not charge him for the hour it granted');
//
// 18:03, chat B: "93 דקות ש… פתוחה" — he had snoozed it to 18:02 an hour
// earlier, at the bot's own invitation. facts.addElapsed already discounts
// quiet hours, for exactly this reason: counting his sleep as avoidance is a
// claim about HIM. Time the bot itself agreed to give him is the same claim
// with the bot's own signature on it.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים', DUE, { type: 'once', at: '2026-09-03T16:30' });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 30_000, () => runCron(rig));
  const inst = rig.db
    .prepare("SELECT id FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;

  // He pushes it an hour. The bot says yes.
  await withNow(DUE + 60_000, () => tap(rig, `s:${inst.id}:60`));

  // An hour and a minute later the nag lands: 63 minutes on the wall clock,
  // 60 of them granted.
  rig.speakQueue.push('נו?');
  await withNow(DUE + 63 * 60_000, () => runCron(rig));

  const speak = rig.geminiCalls.filter((c) => c.kind === 'speak').pop();
  const block = (speak?.system ?? '').match(/כמה זמן זה כבר פתוח[^#]*/)?.[0] ?? '';
  check(`the elapsed block exists — ${JSON.stringify(block)}`, block.length > 0);
  check(
    'and it does not hand him the hour he was given as time he wasted',
    !/\b6[0-9] דקות/.test(block),
    block,
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.8 — the brief does not land on top of a reminder');
//
// Chat B, 01.09 08:00:41 and 08:00:55: the morning brief and a nag, fourteen
// seconds apart, naming the same two tasks. Same tick, no coordination.
//
// A hold, not a cancellation — exactly like the quiet-hours guard beside it.
// markDailySent runs inside the sender, so the day stays unmarked and the next
// tick picks it up.
{
  const rig = createRig();
  seedSettings(rig, { brief_hour: 16, quiet_start_hour: 23, quiet_end_hour: 6 });
  seedReminder(rig, 'לקחת תרופה', DUE, { type: 'once', at: '2026-09-03T16:30' });

  rig.speakQueue.push('נו?', 'בוקר טוב');
  rig.speakQueue.push('נו?');
  await withNow(DUE + 30_000, () => runCron(rig));

  const texts = rig.texts();
  check(
    `only the reminder went out on the tick that fired it — ${JSON.stringify(texts)}`,
    texts.length === 1,
  );

  // And the brief still arrives, on the next quiet tick.
  rig.speakQueue.push('בוקר טוב');
  await withNow(DUE + 90_000, () => runCron(rig));
  check(
    `the brief is held, not cancelled — ${JSON.stringify(rig.texts())}`,
    rig.texts().length === 2,
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.10 — editing a message does not create a second reminder');
//
// handleUpdate reads `update.message ?? update.edited_message` and runs the
// full pipeline on either. Editing "מחר ב8" to "מחר ב9" is one errand and two
// rows, and the second one is the one he did not ask for.
{
  const rig = createRig();
  seedSettings(rig);

  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', title: 'ללכת למוסך', schedule_type: 'once', once_at: '2026-09-04T08:00' }],
  });
  rig.speakQueue.push('קבעתי.');
  await withNow(DUE, () => say(rig, 'תזכיר לי מחר ב8 ללכת למוסך'));

  const before = (rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any).n;
  eq('one reminder from the message', before, 1);

  const calls = rig.geminiCalls.length;
  await withNow(DUE + 20_000, () =>
    post(rig, { edited_message: { chat: { id: Number(CHAT) }, text: 'תזכיר לי מחר ב9 ללכת למוסך', message_id: 999 } }),
  );

  const after = (rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any).n;
  eq('and still one after the edit', after, 1);
  eq('the edit did not cost a model call either', rig.geminiCalls.length, calls);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.11 — a snooze with no duration asks rather than inventing 30');
//
// "לא יקרה היום, בוא ננסה שוב מחר" → the router returned `snooze` with no
// minutes → parseDuration found none → the hardcoded 30 spoke for him:
// "דחיתי … ב-30 דקות". This is the exact failure the comment above that line
// documents. parseDuration closed the "עוד שעה" case; nothing closed the
// "tomorrow" case, and nothing can — the honest answer to a deferral with no
// length is to ask how long.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים', DUE, { type: 'once', at: '2026-09-03T16:30' });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 30_000, () => runCron(rig));
  const inst = rig.db
    .prepare("SELECT id, next_nag_at FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;

  rig.routerQueue.push({ actions: [{ action: 'snooze', target_id: inst.id }] });
  rig.speakQueue.push(new Error('persona down — ship the baseline'));
  await withNow(DUE + 60_000, () => say(rig, 'לא יקרה היום, בוא ננסה שוב מחר'));

  check(
    'it does not report a length he never gave',
    !/30 דקות/.test(lastReply(rig)),
    lastReply(rig),
  );
  check('it asks instead', /מתי/.test(lastReply(rig)), lastReply(rig));

  const after = rig.db
    .prepare('SELECT next_nag_at FROM instances WHERE id = ?')
    .get(inst.id) as any;
  eq('and nothing was written', after.next_nag_at, inst.next_nag_at);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§12.11 — a snooze that DOES carry a length still snoozes');
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים', DUE, { type: 'once', at: '2026-09-03T16:30' });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 30_000, () => runCron(rig));
  const inst = rig.db
    .prepare("SELECT id FROM instances WHERE reminder_id = ? AND status = 'open'")
    .get(id) as any;

  rig.routerQueue.push({ actions: [{ action: 'snooze', target_id: inst.id }] });
  rig.speakQueue.push(new Error('persona down'));
  await withNow(DUE + 60_000, () => say(rig, 'דחה את זה בעוד שעה'));

  check('"בעוד שעה" is a length, read off his own words', /60 דקות/.test(lastReply(rig)), lastReply(rig));
  rig.restore();
}

done();
