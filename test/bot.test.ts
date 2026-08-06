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
import { callbackUpdate, check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Settings, Stats } from '../src/types';
import * as db from '../src/db';
import { applyIntent } from '../src/effects';
import type { Context } from '../src/brain';

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

async function runUpdate(rig: Rig, update: unknown): Promise<void> {
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

/** An already-open instance, so a 'complete' intent has something to close. */
function seedInstance(rig: Rig, reminderId: number, title: string, firedAt: number): number {
  const r = rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status) VALUES (?, ?, ?, ?, 'open')`,
    )
    .run(reminderId, CHAT, title, firedAt);
  return Number(r.lastInsertRowid);
}

function instances(rig: Rig): { id: number; status: string }[] {
  return rig.db.prepare('SELECT id, status FROM instances').all() as any;
}

async function buildTestContext(rig: Rig): Promise<Context> {
  const [settings, stats, rems, goals, open] = await Promise.all([
    db.getSettings(rig.env, CHAT),
    db.stats(rig.env, CHAT),
    db.listReminders(rig.env, CHAT),
    db.listGoals(rig.env, CHAT),
    db.openInstances(rig.env, CHAT),
  ]);
  return { settings, stats, reminders: rems, goals, open, nowLabel: 'עכשיו' };
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
    // Check-ins on and due right now, no goals on file, only a reminder. The
    // general check-in (Task 6, Step 6) is gone on purpose: with nothing to
    // ask about, the bot stays silent instead of manufacturing a topic out of
    // a reminder that already has its own alarm.
    const rig = createRig();
    seedSettings(rig, { checkins_enabled: 1, next_checkin_at: Date.now() - 1000, quiet_start_hour: 0, quiet_end_hour: 0 });
    seedReminder(rig, 'להתקשר לרואה חשבון', Date.now() + 86_400_000);

    await runCron(rig);

    check(
      'no goal means no unprompted message, even with a reminder on file',
      rig.texts().length === 0,
      `sent=${JSON.stringify(rig.texts())}`,
    );
    rig.restore();
  }
  {
    // With a real goal on file, the check-in fires and is grounded in it.
    const rig = createRig();
    seedSettings(rig, { checkins_enabled: 1, next_checkin_at: Date.now() - 1000, quiet_start_hour: 0, quiet_end_hour: 0 });
    await db.addGoal(rig.env, CHAT, 'לפתוח תיק מסחר', null);

    // The fake speak() response echoes the goal, so a check on the sent text
    // is a real assertion, not a tautology — it fails if the real title never
    // made it into what was queued/sent.
    rig.speakQueue.push('נו, מה איתה עם לפתוח תיק מסחר?');
    await runCron(rig);

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check('an unprompted check-in was attempted', !!speakCall);
    // The system prompt is persona+context (buildSystemPrompt) followed by
    // "## מה שקרה עכשיו" (this turn's baseline). The checkin_goal baseline
    // itself quotes the goal title too, so checking the whole system string
    // would still pass even if goalsSummary(ctx) stopped listing goals
    // entirely — exactly the "told to use only what's listed, but nothing is
    // listed" bug this block is named after. Isolate the persona/context
    // portion the router and persona actually see.
    const personaSection = speakCall?.system.split('## מה שקרה עכשיו')[0] ?? '';
    check(
      'the persona context lists the actual goal, so it cannot invent one',
      personaSection.includes('לפתוח תיק מסחר'),
      `the goal never reaches the persona's goal list; persona section: ${personaSection.slice(-400)}`,
    );
    check(
      'the sent message is grounded in the real goal',
      rig.texts().join('\n').includes('לפתוח תיק מסחר'),
      `sent=${JSON.stringify(rig.texts())}`,
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
    // The router recognises the request but pins no time. It is no longer
    // dropped — it is captured to the inbox, never left scheduled or lost.
    rig.routerQueue.push({ actions: [{ action: 'create_reminder', title: 'לקנות חלב' }] });
    rig.speakQueue.push('תפסתי, בלי שעה.');
    await runWebhook(rig, 'תזכיר לי לקנות חלב מתישהו');

    const inboxItems = await db.listInbox(rig.env, CHAT);
    eq(
      'the request was captured to the inbox instead of being lost',
      inboxItems.map((i) => i.title),
      ['לקנות חלב'],
    );
    const row = reminders(rig)[0];
    check(
      'the capture is not scheduled to fire',
      row !== undefined && row.next_fire_at === null,
      `row=${JSON.stringify(row)}`,
    );
    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check(
      'the situation says it was captured, not scheduled',
      !!speakCall && speakCall.system.includes('תפסתי') && !speakCall.system.includes('קבעתי'),
      `speak system prompt tail: ${speakCall?.system.slice(-400)}`,
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

  section('effects — what comes back is what the database did');
  {
    const rig = createRig();
    seedSettings(rig);
    const ctx = await buildTestContext(rig);

    const created = await applyIntent(rig.env, CHAT, ctx, {
      action: 'create_reminder', title: 'לרוץ', schedule_type: 'once', in_minutes: 30,
    }, 'תזכיר לי עוד חצי שעה לרוץ');
    eq('one effect', created.length, 1);
    eq('kind', created[0].kind, 'reminder_created');
    check('carries the real row id', created[0].kind === 'reminder_created' && created[0].id > 0);

    const row = reminders(rig)[0];
    check(
      'the effect time matches the stored row exactly',
      created[0].kind === 'reminder_created' && created[0].at === row.next_fire_at,
    );

    const nothing = await applyIntent(rig.env, CHAT, ctx, {
      action: 'create_reminder', title: 'משהו',
    }, 'תזכיר לי משהו');
    eq('a timeless create captures to the inbox', nothing[0].kind, 'reminder_captured');
    rig.restore();
  }

  section('model cascade — a rate-limited primary falls to the fallback');
  {
    const rig = createRig();
    seedSettings(rig);
    rig.env.GEMINI_MODEL = 'gemini-3.5-flash';
    rig.env.GEMINI_MODEL_FALLBACK = 'gemini-3.5-flash-lite';
    rig.downModels.add('gemini-3.5-flash');
    rig.speakQueue.push('נו? לאכול.');

    await runWebhook(rig, 'תזכיר לי עוד 5 דקות לאכול');

    check('the primary was tried', rig.modelsCalled.includes('gemini-3.5-flash'));
    check('the fallback was used', rig.modelsCalled.includes('gemini-3.5-flash-lite'),
      `models called: ${rig.modelsCalled.join(', ')}`);
    check('the user still got a message', rig.texts().length > 0);
    eq('usage was recorded for the model that worked',
      await db.usageToday(rig.env, 'gemini-3.5-flash-lite'), 1);
    rig.restore();
  }

  section('quota priority — check-ins yield the budget before reminders do');
  {
    const rig = createRig();
    seedSettings(rig, { checkins_enabled: 1, next_checkin_at: Date.now() - 1000,
                        quiet_start_hour: 0, quiet_end_hour: 0 });
    rig.db.prepare(
      'INSERT INTO goals (chat_id, title, status, checkin_count, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run(CHAT, 'לפתוח תיק מסחר', 'active', Date.now());
    rig.env.GEMINI_SOFT_LIMIT = '2';
    for (let i = 0; i < 3; i++) await db.recordUsage(rig.env, rig.env.GEMINI_MODEL);

    const before = rig.geminiCalls.length;
    await runCron(rig);
    eq('a low-priority check-in skips the model past the soft limit',
      rig.geminiCalls.length, before);
    check('but the user still hears about the goal',
      rig.texts().join('').includes('תיק מסחר'), `sent: ${rig.texts().join(' | ')}`);
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

  // ------------------------------------------------------------------------
  section('THE INVARIANT — model down, user still gets a correct message');
  {
    const cases: { label: string; send: string; router?: unknown }[] = [
      { label: 'a timed reminder', send: 'תזכיר לי עוד 5 דקות לאכול' },
      { label: 'a timeless capture', send: 'תזכיר לי לקנות חלב',
        router: { actions: [{ action: 'create_reminder', title: 'לקנות חלב' }] } },
      { label: 'plain chat', send: 'מה קורה',
        router: { actions: [{ action: 'chat' }] } },
    ];
    for (const c of cases) {
      const rig = createRig();
      seedSettings(rig);
      if (c.router) rig.routerQueue.push(c.router);
      // The router (when used) succeeds and the write it triggers actually
      // happens — the failure is specifically in *voicing* the result.
      // rig.geminiDown would 429 the router too and never touch routerQueue,
      // which tests the wrong thing: the router-driven cases would take the
      // same "broken router" fallback path as a genuinely down router,
      // instead of exercising route()'s success path with speak() down.
      rig.speakQueue.push(new Error('rate limited'));
      await runWebhook(rig, c.send);
      if (c.router) {
        check(`${c.label}: the router was actually consulted`,
          rig.geminiCalls.some((g) => g.kind === 'router'),
          `router never called; geminiCalls=${JSON.stringify(rig.geminiCalls.map((g) => g.kind))}`);
      }
      check(`${c.label}: something correct was sent`, rig.texts().join('').trim().length > 0,
        `sent nothing. texts=${JSON.stringify(rig.texts())}`);
      rig.restore();
    }
  }

  section('a lying model is discarded, the truth ships');
  {
    const rig = createRig();
    seedSettings(rig);
    // The clock is pinned so "5 minutes from now" is 14:05 and can never
    // coincide with the invented time below. Without this the test flakes once
    // a day, at 23:42.
    await withNow(wallToUtc(2026, 8, 4, 14, 0, TZ), async () => {
      // quickparse bypasses the router; speak invents a time that never existed.
      rig.speakQueue.push('קבעתי לך ל-23:47, אל תתלונן.');
      await runWebhook(rig, 'תזכיר לי עוד 5 דקות לאכול');
    });
    const out = rig.texts().join('\n');
    check('the invented time never reaches the user', !out.includes('23:47'), `sent: ${out}`);
    check('the real confirmation does', out.includes('לאכול'), `sent: ${out}`);
    rig.restore();
  }

  section('a phantom confirmation is discarded');
  {
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('רשמתי לך, סגור.');
    await runWebhook(rig, 'מה קורה');
    const out = rig.texts().join('\n');
    check('"רשמתי" never reaches the user when nothing was written',
      !out.includes('רשמתי'), `sent: ${out}`);
    eq('and nothing was written', reminders(rig).length, 0);
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('a Telegram failure on one send must not abort the rest of the tick');
  {
    // sendOutcome's actual send used to sit outside its own try. One 429 on
    // the first due reminder threw out of sendOutcome, out of the `for` loop
    // in tick, and out of tick itself — after setNextFire/createInstance for
    // that reminder had already committed. Every remaining due reminder that
    // tick, nag, give-up, and check-in got skipped, silently, for one send
    // failure that had nothing to do with them.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'משימה א', Date.now() - 2000);
    seedReminder(rig, 'משימה ב', Date.now() - 1000);
    rig.telegramDown = true;

    await runCron(rig);

    check(
      'both due reminders got an instance — the loop did not abort after the first send failed',
      instances(rig).length === 2,
      `instances=${JSON.stringify(instances(rig))}`,
    );
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('effects already committed survive a later write failing');
  {
    // The old catch block OVERWROTE `effects` with a generic capture whenever
    // an intent threw partway through a multi-intent turn — discarding
    // whatever had already committed (here: closing the open instance) and
    // telling the user only about the fallback capture. That is a false
    // account of what the database did, from the one function whose entire
    // job is to prevent exactly that.
    const rig = createRig();
    seedSettings(rig);
    const reminderId = seedReminder(rig, 'לקפל כביסה', Date.now() + 3_600_000);
    const instId = seedInstance(rig, reminderId, 'לקפל כביסה', Date.now() - 1000);

    rig.routerQueue.push({
      actions: [
        { action: 'complete', target_id: instId },
        { action: 'create_reminder', title: 'לתלות', schedule_type: 'once', in_minutes: 60 },
      ],
    });
    // Target the second intent's write specifically — addReminder's INSERT,
    // identifiable by the literal 'scheduled' status it writes (addInboxItem,
    // the fallback this failure triggers, writes 'inbox' instead, to the same
    // table). Matching by SQL text rather than call position means this test
    // stays correct however many unrelated writes (e.g. usage tracking) land
    // earlier in the same turn.
    rig.dbFailOn = /INSERT INTO reminders[\s\S]*'scheduled'/;

    // No relative/absolute time phrase quickparse recognises, so this falls
    // through to the (mocked) router above instead of being fast-pathed.
    const text = 'סיימתי, ותזכיר לי כמו תמיד';
    await runWebhook(rig, text);

    const closed = instances(rig).find((i) => i.id === instId);
    check(
      'the instance closed by the first intent is not rolled back or hidden',
      closed?.status === 'done',
      `instance=${JSON.stringify(closed)}`,
    );
    check(
      'no reminder row was created for the intent whose write failed',
      !reminders(rig).some((r) => r.title === 'לתלות'),
      `reminders=${JSON.stringify(reminders(rig))}`,
    );
    const inbox = await db.listInbox(rig.env, CHAT);
    eq(
      'the whole message was captured to the inbox as a fallback, once',
      inbox.map((i) => i.title),
      [text],
    );

    const out = rig.texts().join('\n');
    check(
      'the user is told about the real completion, not only the fallback capture',
      out.includes('נסגר') && out.includes('לקפל כביסה'),
      `sent: ${out}`,
    );
    check('the fallback capture is also mentioned', out.includes('תפסתי'), `sent: ${out}`);
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('buttons — a tap closes the task with no model call');
  {
    const rig = createRig();
    seedSettings(rig);
    const rid = seedReminder(rig, 'לרוץ', Date.now() - 1000);
    rig.speakQueue.push('נו? לרוץ.');
    await runCron(rig);
    const inst = rig.db.prepare("SELECT id FROM instances WHERE status='open'").get() as any;
    check('an open instance exists', !!inst);

    const before = rig.geminiCalls.length;
    await runUpdate(rig, callbackUpdate(CHAT, `d:${inst.id}`));

    check('the spinner was answered', rig.methods().includes('answerCallbackQuery'));
    check('the buttons were removed', rig.methods().some((m) => m.startsWith('editMessage')));
    eq('no model call was made', rig.geminiCalls.length, before);
    const row = rig.db.prepare('SELECT status FROM instances WHERE id = ?').get(inst.id) as any;
    eq('the instance is done', row.status, 'done');
    rig.restore();
  }

  section('buttons — double tap is a no-op, not a double count');
  {
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לרוץ', Date.now() - 1000);
    rig.speakQueue.push('נו?');
    await runCron(rig);
    const inst = rig.db.prepare("SELECT id FROM instances WHERE status='open'").get() as any;

    await runUpdate(rig, callbackUpdate(CHAT, `d:${inst.id}`));
    const streakAfterFirst = (await db.stats(rig.env, CHAT)).currentStreak;
    // Pins the absolute value: a no-op handleCallback would leave this at 0
    // on both reads and the comparison below would pass vacuously.
    eq('the first tap actually moved the streak', streakAfterFirst, 1);

    const messagesBeforeSecondTap = rig.methods().filter((m) => m === 'sendMessage').length;
    await runUpdate(rig, callbackUpdate(CHAT, `d:${inst.id}`));
    eq('streak did not move on the second tap',
      (await db.stats(rig.env, CHAT)).currentStreak, streakAfterFirst);
    // "No double count" and "no second reply" are separate guarantees — an
    // ungated closeInstance would still show streak=1 (same row, same
    // consecutive-done count) but would send a second confirmation message.
    eq('the second tap sent no message',
      rig.methods().filter((m) => m === 'sendMessage').length, messagesBeforeSecondTap);
    rig.restore();
  }

  section('buttons — a tap from anyone else is ignored');
  {
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לרוץ', Date.now() - 1000);
    rig.speakQueue.push('נו?');
    await runCron(rig);
    const inst = rig.db.prepare("SELECT id FROM instances WHERE status='open'").get() as any;

    const textsBefore = rig.texts().length;
    await runUpdate(rig, callbackUpdate(CHAT, `d:${inst.id}`, '99999'));
    const row = rig.db.prepare('SELECT status FROM instances WHERE id = ?').get(inst.id) as any;
    eq('a stranger cannot close a task', row.status, 'open');
    check('no spinner answer to a stranger', !rig.methods().includes('answerCallbackQuery'));
    eq('no message sent to a stranger tap', rig.texts().length, textsBefore);

    // The from.id check and the chat.id check are independent clauses —
    // varying only fromId (above) leaves an unchecked chat.id clause green.
    // A foreign chat.id with the owner's own from.id must be rejected too.
    await runUpdate(rig, callbackUpdate('77777', `d:${inst.id}`, CHAT));
    const row2 = rig.db.prepare('SELECT status FROM instances WHERE id = ?').get(inst.id) as any;
    eq('a foreign chat_id cannot close a task even with the owner\'s from_id', row2.status, 'open');

    // The fail-closed guarantee: an unset OWNER_CHAT_ID must not turn into
    // "anyone with a non-empty id is authorised". Unlike handleUpdate, which
    // deliberately enters setup mode and replies with the chat id when
    // OWNER_CHAT_ID is unset, handleCallback must reject silently — a tap is
    // not the place to announce the bot is unconfigured to whoever tapped it.
    // (This is carried entirely by the chatId-equality clause, not a
    // standalone "!env.OWNER_CHAT_ID" check — see the comment in
    // handleCallback: that clause would be a provable tautology given
    // chatId is guaranteed non-empty here, so no input can isolate it. This
    // case still pins the product-level guarantee end to end.)
    rig.env.OWNER_CHAT_ID = '';
    await runUpdate(rig, callbackUpdate(CHAT, `d:${inst.id}`));
    const row3 = rig.db.prepare('SELECT status FROM instances WHERE id = ?').get(inst.id) as any;
    eq('an unset OWNER_CHAT_ID rejects the callback instead of authorising it', row3.status, 'open');
    check('no spinner answer when OWNER_CHAT_ID is unset', !rig.methods().includes('answerCallbackQuery'));
    eq('no setup-mode reply is sent on the callback path either', rig.texts().length, textsBefore);
    rig.env.OWNER_CHAT_ID = CHAT;

    rig.restore();
  }

  section('buttons — retime does not resurrect a cancelled reminder');
  {
    const rig = createRig();
    seedSettings(rig);
    const rid = seedReminder(rig, 'לשלם ארנונה', Date.now() + 3_600_000);
    await db.deleteReminder(rig.env, CHAT, rid);
    const before = rig.db.prepare('SELECT status, active, next_fire_at FROM reminders WHERE id = ?').get(rid) as any;
    eq('the reminder is cancelled before the tap', before.status, 'cancelled');

    await runUpdate(rig, callbackUpdate(CHAT, `r:${rid}:09:00`));

    const after = rig.db.prepare('SELECT status, active, next_fire_at FROM reminders WHERE id = ?').get(rid) as any;
    eq('a stale retime button does not un-cancel the reminder', after.status, 'cancelled');
    eq('and does not re-arm it', after.active, 0);
    check('no confirmation is sent for a no-op retime', rig.texts().length === 0,
      `sent=${JSON.stringify(rig.texts())}`);
    rig.restore();
  }

  section('buttons are attached where they are useful');
  {
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לרוץ', Date.now() - 1000);
    rig.speakQueue.push('נו? לרוץ.');
    await runCron(rig);
    const sent = rig.sent.filter((s) => s.method === 'sendMessage');
    check('a fired reminder carries done/snooze/skip',
      sent.some((s) => JSON.stringify(s.markup ?? '').includes('"d:')),
      `markup: ${JSON.stringify(sent.map((s) => s.markup))}`);
    rig.restore();
  }
  {
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'create_reminder', title: 'לקנות חלב' }] });
    rig.speakQueue.push('תפסתי.');
    await runWebhook(rig, 'תזכיר לי לקנות חלב');
    const sent = rig.sent.filter((s) => s.method === 'sendMessage');
    check('an inbox capture offers scheduling slots',
      sent.some((s) => JSON.stringify(s.markup ?? '').includes('"p:')),
      `markup: ${JSON.stringify(sent.map((s) => s.markup))}`);
    rig.restore();
  }

  done();
}

main();
