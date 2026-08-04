/**
 * Run with `npm run test:bot`.
 *
 * End-to-end reproductions of the four reported failures. Each block names the
 * symptom the owner actually saw, so a regression here is legible without
 * re-deriving the bug.
 */
import worker from '../src/index';
import { quickParse } from '../src/quickparse';
import { buildSystemPrompt } from '../src/persona';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Settings, Stats } from '../src/types';
import * as db from '../src/db';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

async function runWebhook(rig: Rig, text: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  const req = new Request('https://x/tg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text } }),
  });
  await worker.fetch(req, rig.env, ctx);
  await Promise.all(pending);
}

function seedSettings(rig: Rig, over: Partial<Settings> = {}): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
                             quiet_start_hour, quiet_end_hour, next_checkin_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      CHAT,
      TZ,
      2,
      over.checkins_enabled ?? 0,
      2,
      over.quiet_start_hour ?? 23,
      over.quiet_end_hour ?? 8,
      (over.next_checkin_at ?? null) as any,
    );
}

function seedReminder(rig: Rig, title: string, dueAt: number, schedule = '{"type":"once","at":"2099-01-01T07:05"}'): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?)`,
    )
    .run(CHAT, title, schedule, TZ, dueAt, Date.now());
  return Number(r.lastInsertRowid);
}

function reminders(rig: Rig): { id: number; title: string; schedule: string; next_fire_at: number | null; active: number }[] {
  return rig.db.prepare('SELECT id, title, schedule, next_fire_at, active FROM reminders').all() as any;
}

// ===========================================================================

async function main() {
  // ------------------------------------------------------------------------
  section('BUG 3a — a reminder must arrive even when Gemini is unavailable');
  {
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לקום', Date.now() - 1000);

    rig.geminiDown = true;
    await runCron(rig);

    check(
      'the user is told about the due reminder even with the model down',
      rig.texts().length > 0,
      `nothing was sent; the reminder was consumed silently. sent=${JSON.stringify(rig.texts())}`,
    );
    check(
      'the fallback message names the task',
      rig.texts().join('\n').includes('לקום'),
      `sent=${JSON.stringify(rig.texts())}`,
    );

    const after = reminders(rig).find((r) => r.id === id)!;
    check(
      'the reminder is not left both undelivered and deactivated',
      rig.texts().length > 0 || after.next_fire_at !== null,
      `next_fire_at=${after.next_fire_at} active=${after.active} sent=${rig.texts().length}`,
    );
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('BUG 3b — Hebrew recurring reminders must not become one-shot');
  {
    const now = Date.now();
    for (const phrase of [
      'תזכיר לי כל בוקר ב-7:05 לקום',
      'תזכיר לי כל יום ב-22:30 לקחת כדור',
      'תזכיר לי כל שני ב-20:00 להוציא זבל',
      'תזכיר לי כל ערב ב-21:00 ללמוד',
    ]) {
      const got = quickParse(phrase, now, TZ);
      check(
        `"${phrase}" falls through to the router instead of a one-off`,
        got === null,
        `quickparse turned a recurring request into ${JSON.stringify(got)}`,
      );
    }
  }

  // ------------------------------------------------------------------------
  section('BUG 4 — unprompted messages must be grounded in real reminders');
  {
    const rig = createRig();
    // Check-ins on and due right now, no goals on file, one real reminder.
    seedSettings(rig, { checkins_enabled: 1, next_checkin_at: Date.now() - 1000, quiet_start_hour: 0, quiet_end_hour: 0 });
    seedReminder(rig, 'להתקשר לרואה חשבון', Date.now() + 86_400_000);

    rig.speakQueue.push('נו?');
    await runCron(rig);

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check('an unprompted check-in was attempted', !!speakCall);
    check(
      'the persona is shown his actual reminders, so it cannot invent a task',
      !!speakCall && speakCall.system.includes('להתקשר לרואה חשבון'),
      'the reminder list never reaches speak(); the model is told "only use what is listed" ' +
        'while nothing is listed, so it makes something up',
    );
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('BUG 1 — never claim a reminder was created when it was not');
  {
    const settings: Settings = {
      chat_id: CHAT, tz: TZ, intensity: 2, muted_until: null, off_limits: null,
      checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
      next_checkin_at: null,
    };
    const stats: Stats = { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 };
    const prompt = buildSystemPrompt(settings, stats, 'עכשיו', '  (אין)', '  (אין)', '  (אין)');
    check(
      'the persona has no unconditional "the reminder is already set" rule',
      !prompt.includes('היא כבר נקבעה'),
      'persona.ts tells the model that if he asked for a reminder it "has already been set" — ' +
        'unconditionally, regardless of what the system actually did',
    );
  }
  {
    const rig = createRig();
    seedSettings(rig);
    // The router recognises the request but pins no time, so nothing is written.
    rig.routerQueue.push({ actions: [{ action: 'create_reminder', title: 'לקנות חלב' }] });
    rig.speakQueue.push('מתי?');
    await runWebhook(rig, 'תזכיר לי לקנות חלב מתישהו');

    eq('no reminder row was created', reminders(rig).length, 0);
    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check(
      'the persona is told in the situation that nothing was created',
      !!speakCall && speakCall.system.includes('לא נוצרה'),
      `speak system prompt: ${speakCall?.system.slice(-400)}`,
    );
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('BUG 2 — two reminders from a single message');
  {
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({
      actions: [
        { action: 'create_reminder', title: 'לאכול', schedule_type: 'once', in_minutes: 5 },
        { action: 'create_reminder', title: 'להתקשר לאמא', schedule_type: 'once', in_minutes: 60 },
      ],
    });
    rig.speakQueue.push('רשום.');
    await runWebhook(rig, 'תזכיר לי עוד 5 דקות לאכול ובעוד שעה להתקשר לאמא');

    const rows = reminders(rig);
    eq('both reminders were created', rows.length, 2);
    eq(
      'both titles are stored',
      rows.map((r) => r.title).sort(),
      ['לאכול', 'להתקשר לאמא'].sort(),
    );
    rig.restore();
  }
  {
    // The fast path must not swallow a two-reminder message and create one
    // mangled row from it.
    const got = quickParse('תזכיר לי עוד 5 דקות לאכול ובעוד שעה להתקשר לאמא', Date.now(), TZ);
    check(
      'quickparse defers a message containing two time phrases to the router',
      got === null,
      `quickparse produced a single reminder: ${JSON.stringify(got)}`,
    );
  }

  // ------------------------------------------------------------------------
  section('scheduling — the promise the whole bot rests on');
  {
    // The owner's exact report: set at night for 07:05 the next morning.
    const rig = createRig();
    seedSettings(rig);
    const tuesday2252 = wallToUtc(2026, 8, 4, 22, 52, TZ);

    await withNow(tuesday2252, async () => {
      rig.speakQueue.push('קבעתי ל-07:05.');
      await runWebhook(rig, 'תזכיר לי מחר ב-7:05 לקום');
    });

    const row = reminders(rig)[0];
    const expected = wallToUtc(2026, 8, 5, 7, 5, TZ);
    eq('stored for 07:05 the next morning', row?.next_fire_at, expected);

    // One minute early: nothing yet.
    await withNow(expected - 60_000, async () => {
      await runCron(rig);
    });
    eq('nothing fires a minute early', rig.texts().length, 1);

    // 07:05 itself, inside quiet hours — a reminder he asked for still rings.
    await withNow(expected, async () => {
      rig.speakQueue.push('נו? לקום.');
      await runCron(rig);
    });
    eq('it fires at 07:05 even though quiet hours run to 08:00', rig.texts().length, 2);
    check('the message is about the right task', rig.texts()[1].includes('לקום'));

    // And it does not fire a second time.
    await withNow(expected + 120_000, async () => {
      await runCron(rig);
    });
    eq('a one-off does not fire twice', rig.texts().length, 2);
    rig.restore();
  }
  {
    // A daily reminder must survive its own firing.
    const rig = createRig();
    seedSettings(rig);
    const day1 = wallToUtc(2026, 8, 5, 7, 5, TZ);
    seedReminder(rig, 'לקחת כדור', day1, '{"type":"daily","time":"07:05"}');

    await withNow(day1, async () => {
      rig.speakQueue.push('נו? כדור.');
      await runCron(rig);
    });
    eq('the daily reminder fired', rig.texts().length, 1);

    const row = reminders(rig)[0];
    eq('it rescheduled itself for tomorrow', row.next_fire_at, wallToUtc(2026, 8, 6, 7, 5, TZ));
    eq('and stayed active', row.active, 1);
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('inbox — a captured item with no time is never lost');
  {
    const rig = createRig();
    seedSettings(rig);
    const id = await db.addInboxItem(rig.env, CHAT, 'לקנות חלב', TZ);
    const items = await db.listInbox(rig.env, CHAT);
    eq('the item is in the inbox', items.map((i) => i.title), ['לקנות חלב']);

    const due = await db.dueReminders(rig.env, Date.now() + 86_400_000);
    eq('inbox items never fire', due.length, 0);

    const at = Date.now() + 3_600_000;
    await db.scheduleInboxItem(rig.env, id, at, JSON.stringify({ type: 'once', at: '2099-01-01T10:00' }));
    eq('the inbox is empty once scheduled', (await db.listInbox(rig.env, CHAT)).length, 0);
    eq('and it is now due-able', (await db.dueReminders(rig.env, at)).length, 1);
    rig.restore();
  }

  section('usage — per-model call counting');
  {
    const rig = createRig();
    await db.recordUsage(rig.env, 'gemini-2.5-flash');
    await db.recordUsage(rig.env, 'gemini-2.5-flash');
    await db.recordUsage(rig.env, 'gemini-2.5-flash-lite');
    eq('flash counted twice', await db.usageToday(rig.env, 'gemini-2.5-flash'), 2);
    eq('flash-lite counted once', await db.usageToday(rig.env, 'gemini-2.5-flash-lite'), 1);
    eq('unknown model is zero', await db.usageToday(rig.env, 'nope'), 0);
    rig.restore();
  }

  done();
}

main();
