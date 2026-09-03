/**
 * Run with `npm run test:ringing`.
 *
 * issues.md §4, the engagement half: **a reminder that is ringing has to stay
 * findable.**
 *
 * `reminders.status` answers three different questions with one enum —
 * lifecycle (does the row exist), schedule (will it ring again) and, by
 * implication, engagement (is it finished). `setNextFire(id, null)` flips a
 * `once` reminder to 'done' the moment it FIRES, so for the whole window in
 * which the bot is actively chasing him the row reads as finished, and five
 * separate consumers misread it at once.
 *
 * Production, 02.09.2026, #69 ringing and nagged twice:
 *
 *   19:15  bot   דחיתי את "לנקות את הפילטרים של המזגנים" ב-30 דקות — 19:45.
 *   19:17  him   מחר ב16:30
 *   19:17  bot   אין לי תזכורת כזאת.
 *   19:38  him   תזיז את תזכורת 69 למחר ב16:30      ← the same request, with the id
 *   19:38  bot   שזז. מחר ב-16:30 נדבר על הפילטרים.
 *
 * Twenty-one minutes and an id he should never have had to supply. `/list` was
 * empty the whole time, and the persona was being told "זו הרשימה המלאה — מה
 * שלא כאן, לא קיים" about the very task it was nagging him over.
 */
import worker from '../src/index';
import { remindersSummary, type Context } from '../src/brain';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

async function say(rig: Rig, text: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
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
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(CHAT, TZ);
}

function seedReminder(rig: Rig, title: string, dueAt: number, at: string): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?, NULL)`,
    )
    .run(CHAT, title, JSON.stringify({ type: 'once', at }), TZ, dueAt, dueAt);
  return Number(r.lastInsertRowid);
}

/** Fire it, exactly as the cron would, so `status` really is 'done'. */
async function fire(rig: Rig, at: number): Promise<void> {
  rig.speakQueue.push('נו?');
  await withNow(at, () => runCron(rig));
}

/**
 * Just the "תזכורות פעילות" block out of the router prompt.
 *
 * Asserting against the whole system prompt is how three of these first passed
 * without the fix: the fired reminder is ALSO rendered by `doneSummary`
 * ("כבר נסגרה") a few lines down, and its title is in `openSummary` too, so a
 * bare `system.includes('#1 "…"')` was green against the exact bug it was
 * written for. The block boundary is the assertion.
 */
function activeBlock(system: string | undefined): string {
  const from = (system ?? '').indexOf('תזכורות פעילות');
  const to = (system ?? '').indexOf('נתפסו אבל עדיין בלי שעה');
  return from < 0 || to < 0 ? '' : (system ?? '').slice(from, to);
}

/** The bot's last message — the reply to what was just said, not the whole day. */
function lastReply(rig: Rig): string {
  return rig.texts()[rig.texts().length - 1] ?? '';
}

const DUE = wallToUtc(2026, 9, 3, 16, 30, TZ);

// ---------------------------------------------------------------------------
section('a reminder that has fired is still a reminder');
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים של המזגנים', DUE, '2026-09-03T16:30');
  await fire(rig, DUE + 30_000);

  const row = rig.db.prepare('SELECT status, next_fire_at FROM reminders WHERE id = ?').get(id) as any;
  eq('the row really did go to done — this is the condition, not a mock', row.status, 'done');
  eq('and it really has no next fire', row.next_fire_at, null);

  // /list is what he reached for at 19:17 and it was empty.
  await withNow(DUE + 60_000, () => say(rig, '/list'));
  check(
    'and /list still shows it while he is being chased about it',
    lastReply(rig).includes('לנקות את הפילטרים'),
    lastReply(rig),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('"מחר ב16:30" resolves it without him supplying the id');
//
// The 19:17 turn. The router answers `reschedule` with no target_id — which is
// the honest thing for it to do, since the id was in none of the lists it was
// shown — and resolveReminder's single-reminder fallback then found nothing,
// because ctx.reminders was empty.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים של המזגנים', DUE, '2026-09-03T16:30');
  await fire(rig, DUE + 30_000);

  rig.routerQueue.push({
    actions: [{ action: 'reschedule', schedule_type: 'once', once_at: '2026-09-04T16:30' }],
  });
  rig.speakQueue.push('הזזתי.');
  await withNow(DUE + 60_000, () => say(rig, 'מחר ב16:30'));

  const row = rig.db.prepare('SELECT status, schedule FROM reminders WHERE id = ?').get(id) as any;
  check(
    'he is not told the reminder does not exist',
    !rig.texts().some((t) => t.includes('אין לי תזכורת כזאת')),
    JSON.stringify(rig.texts()),
  );
  eq('it moved', JSON.parse(row.schedule).at, '2026-09-04T16:30');
  eq('and it is scheduled again', row.status, 'scheduled');
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the router is shown the id, so it can name it');
//
// The other half of the same fix: `remindersSummary` is the block both the
// router AND the persona read, and it is followed by the line "זו הרשימה
// המלאה — מה שלא כאן, לא קיים". While #69 was being nagged, that sentence was
// false about the one task the bot was talking about.
{
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לנקות את הפילטרים של המזגנים', DUE, '2026-09-03T16:30');
  await fire(rig, DUE + 30_000);

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 60_000, () => say(rig, 'מה המצב'));

  const router = rig.geminiCalls.find((c) => c.kind === 'router');
  check('the router was consulted', !!router, JSON.stringify(rig.geminiCalls.map((c) => c.kind)));
  check(
    `it can see #${id} in the ACTIVE block, not just the finished one`,
    activeBlock(router?.system).includes(`#${id} "לנקות את הפילטרים של המזגנים"`),
    activeBlock(router?.system),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('what must NOT come back');
{
  // A reminder he cancelled stays cancelled, even if an instance is somehow
  // still open against it. retimeReminder and renameReminder both exclude
  // 'cancelled' in their WHERE clause; a list that resurrects the row would
  // put a reminder he deliberately deleted back in front of the model.
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'ללכת למוסך', DUE, '2026-09-03T16:30');
  await fire(rig, DUE + 30_000);
  rig.db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(id);

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 60_000, () => say(rig, 'מה המצב'));

  const router = rig.geminiCalls.find((c) => c.kind === 'router');
  check(
    'a cancelled reminder is not resurrected by its own open instance',
    !activeBlock(router?.system).includes(`#${id} "ללכת למוסך"`),
    activeBlock(router?.system),
  );
  rig.restore();
}

{
  // A CLOSED instance does not keep its reminder alive. Once he has reported
  // it, "done" means done, and a finished errand must drop out of the list the
  // persona is told is complete — otherwise every reminder he ever closed
  // accumulates in the prompt.
  const rig = createRig();
  seedSettings(rig);
  const id = seedReminder(rig, 'לקחת אוכל', DUE, '2026-09-03T16:30');
  await fire(rig, DUE + 30_000);
  rig.db.prepare("UPDATE instances SET status = 'done', closed_at = ? WHERE reminder_id = ?").run(DUE + 45_000, id);

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 60_000, () => say(rig, 'מה המצב'));

  const router = rig.geminiCalls.find((c) => c.kind === 'router');
  check(
    'a closed instance releases its reminder',
    !activeBlock(router?.system).includes(`#${id} "לקחת אוכל"`),
    activeBlock(router?.system),
  );
  rig.restore();
}

{
  // And a recurring reminder, which stays 'scheduled' across its own firing,
  // must appear EXACTLY ONCE — it is in both lists now, and a duplicate row
  // in the prompt is how the model comes to believe there are two of them.
  const rig = createRig();
  seedSettings(rig);
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?, NULL)`,
    )
    .run(CHAT, 'לקחת תרופה', JSON.stringify({ type: 'daily', time: '16:30' }), TZ, DUE, DUE);
  const id = Number(r.lastInsertRowid);
  await fire(rig, DUE + 30_000);

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await withNow(DUE + 60_000, () => say(rig, 'מה המצב'));

  const router = rig.geminiCalls.find((c) => c.kind === 'router');
  const hits = (activeBlock(router?.system).match(new RegExp(`#${id} "לקחת תרופה"`, 'g')) ?? []).length;
  eq('a still-scheduled reminder is listed once, not twice', hits, 1);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('remindersSummary says it is waiting, rather than "לא מתוזמן"');
//
// The row has no next_fire_at — it already rang. Rendering that as
// "הבא: לא מתוזמן" is technically true and reads as broken, right next to an
// openSummary line saying the same task is open and being nagged.
{
  const ctx = {
    settings: { chat_id: CHAT, tz: TZ },
    open: [{ id: 5, reminder_id: 69, title: 'לנקות את הפילטרים של המזגנים' }],
    reminders: [
      {
        id: 69,
        title: 'לנקות את הפילטרים של המזגנים',
        schedule: JSON.stringify({ type: 'once', at: '2026-09-03T16:30' }),
        tz: TZ,
        next_fire_at: null,
        notes: null,
        event_at: null,
        requires_proof: 0,
      },
    ],
  } as unknown as Context;

  const out = remindersSummary(ctx);
  check('it does not read as unscheduled', !out.includes('לא מתוזמן'), out);
  check('it says what is actually true of it', out.includes('צלצלה'), out);
}

done();
