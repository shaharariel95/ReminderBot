/**
 * Run with `npm run test:bot`.
 *
 * End-to-end reproductions of the four reported failures. Each block names the
 * symptom the owner actually saw, so a regression here is legible without
 * re-deriving the bug.
 */
import worker, { STRANGER_ASK } from '../src/index';
import { quickParse } from '../src/quickparse';
import { buildSystemPrompt } from '../src/persona';
import { wallToUtc } from '../src/time';
import { callbackUpdate, check, createRig, deployed, done, eq, section, withNow, type Rig } from './harness';
import type { Settings, Stats } from '../src/types';
import * as db from '../src/db';
import { applyIntent } from '../src/effects';
import { handleSlash } from '../src/slash';
import { modelLadder } from '../src/gemini';
import { VERSION } from '../src/version';
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
    // A real Telegram message always carries a message_id — handleUpdate's
    // instant reaction (Task 12) is keyed off it, so a fixture without one
    // would silently skip the reaction on every webhook test.
    body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text, message_id: 999 } }),
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
  // brief_hour/closeout_hour default to NULL — i.e. OFF — rather than to the
  // schema defaults of 08:00/21:00. Otherwise every cron test in this file
  // would additionally send a morning brief or an evening close-out depending
  // on what time of day the suite happened to run, and half of them would
  // start failing at 08:01. Tests that want those messages ask for them.
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
                             quiet_start_hour, quiet_end_hour, next_checkin_at,
                             brief_hour, closeout_hour, last_brief_on, last_closeout_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      (over.brief_hour ?? null) as any,
      (over.closeout_hour ?? null) as any,
      (over.last_brief_on ?? null) as any,
      (over.last_closeout_on ?? null) as any,
    );
}

function seedReminder(rig: Rig, title: string, dueAt: number, schedule = '{"type":"once","at":"2099-01-01T07:05"}', chatId = CHAT): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?)`,
    )
    .run(chatId, title, schedule, TZ, dueAt, Date.now());
  return Number(r.lastInsertRowid);
}

function reminders(rig: Rig): { id: number; title: string; schedule: string; next_fire_at: number | null; active: number }[] {
  return rig.db.prepare('SELECT id, title, schedule, next_fire_at, active FROM reminders').all() as any;
}

/** An already-open instance, so a 'complete' intent has something to close. */
function seedInstance(rig: Rig, reminderId: number, title: string, firedAt: number, chatId = CHAT): number {
  const r = rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status) VALUES (?, ?, ?, ?, 'open')`,
    )
    .run(reminderId, chatId, title, firedAt);
  return Number(r.lastInsertRowid);
}

function instances(rig: Rig): { id: number; status: string }[] {
  return rig.db.prepare('SELECT id, status FROM instances').all() as any;
}

/** A Telegram update carrying a photo with a caption from the owner. The
 *  harness's fetch stub answers getPhotoBase64's getFile + file-download hops
 *  with a fake JPEG, so this reaches applyPhoto with a real (non-null) image
 *  instead of short-circuiting. */
function photoUpdate(caption: string): unknown {
  return {
    message: {
      chat: { id: Number(CHAT) },
      caption,
      photo: [{ file_id: 'test-photo', file_size: 1000 }],
      message_id: 999,
    },
  };
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
    // These used to be fast-pathed into ONE-OFF reminders that rang once and
    // switched themselves off, because the guard meant to catch them used a
    // `\b` that can never match before a Hebrew letter. They are now parsed as
    // recurring rules outright rather than merely detected and routed — but the
    // property under test is unchanged and is the one that matters: a request
    // that repeats must never be stored as a schedule that does not.
    const now = Date.now();
    for (const [phrase, type] of [
      ['תזכיר לי כל בוקר ב-7:05 לקום', 'daily'],
      ['תזכיר לי כל יום ב-22:30 לקחת כדור', 'daily'],
      ['תזכיר לי כל שני ב-20:00 להוציא זבל', 'weekly'],
      ['תזכיר לי כל ערב ב-21:00 ללמוד', 'daily'],
    ] as const) {
      const got = quickParse(phrase, now, TZ);
      check(
        `"${phrase}" is never turned into a one-off`,
        got === null || got.schedule_type === type,
        `quickparse produced ${JSON.stringify(got)}`,
      );
      check(
        `"${phrase}" carries no one-shot fields`,
        got === null || (got.once_at === undefined && got.in_minutes === undefined),
        `quickparse produced ${JSON.stringify(got)}`,
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
  awaiting: null,
  brief_hour: 8, closeout_hour: 21, last_brief_on: null, last_closeout_on: null,
    display_name: null,
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
    // Scoped to the baseline half of the system prompt, not the whole thing —
    // the persona half is static and now names "קבעתי" explicitly (rule 2 of
    // "אמת לפני אופי"), so an unscoped .system.includes('קבעתי') would fail on
    // that static text regardless of what this turn's baseline actually says.
    // A missing marker (baselineSection undefined) must fail loudly, not pass
    // through an `?? ''` that vacuously satisfies the negative half.
    const baselineSection = speakCall?.system.split('## מה שקרה עכשיו')[1];
    check(
      'the situation says it was captured, not scheduled',
      baselineSection !== undefined &&
        baselineSection.includes('תפסתי') &&
        !baselineSection.includes('קבעתי'),
      `baseline section: ${baselineSection?.slice(0, 400) ?? '(no "## מה שקרה עכשיו" marker found)'}`,
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

    const due = await db.dueReminders(rig.env, Date.now() + 86_400_000, [CHAT]);
    eq('inbox items never fire', due.length, 0);

    const at = Date.now() + 3_600_000;
    await db.scheduleInboxItem(rig.env, id, at, JSON.stringify({ type: 'once', at: '2099-01-01T10:00' }));
    eq('the inbox is empty once scheduled', (await db.listInbox(rig.env, CHAT)).length, 0);
    eq('and it is now due-able', (await db.dueReminders(rig.env, at, [CHAT])).length, 1);
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
    // Attributed to CHAT. Since migration 012 the soft limit is measured
    // against his OWN usage rather than the shared total — a guest burning the
    // day's calls used to switch off the owner's check-ins silently. Recording
    // these unattributed would now leave his budget untouched and the check-in
    // would (correctly) go out, so the seeding has to name him.
    for (let i = 0; i < 3; i++) await db.recordUsage(rig.env, rig.env.GEMINI_MODEL, CHAT);

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

  section('more than one person can use the bot, and only the ones invited');
  const OTHER = '99999';
  {
    // Until now the only user was whoever OWNER_CHAT_ID named, and everyone
    // else got silence. The allowlist keeps that as the default — an unknown
    // chat is still ignored — but lets the owner let someone in without a
    // redeploy.
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');

    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'שלום', message_id: 1 } });
    // A stranger now gets the onboarding question (see the section above) and
    // nothing else. What matters here is what they still cannot reach: the
    // router, the persona, and any of the owner's data.
    eq('a stranger reaches no model at all', rig.geminiCalls.length, 0);
    eq('and gets exactly the onboarding line, not an answer to what they said',
      rig.texts(), [STRANGER_ASK]);
    rig.restore();
  }
  {
    const rig = createRig();
    seedSettings(rig);
    await db.setAllowedChats(rig.env, [OTHER]);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');

    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'שלום', message_id: 1 } });
    // Asserted on the REAL reply, not merely on "something was sent". A guest
    // who fell through to onboarding also gets a message, so `length > 0`
    // passes whether or not they were actually let in.
    check('an invited chat gets a real answer, not the onboarding line',
      rig.texts().includes('נו?') && !rig.texts().includes(STRANGER_ASK),
      rig.texts().join(' | '));
    check('in their own chat, not the owner\'s',
      rig.sent.every((s) => s.chat_id === undefined || String(s.chat_id) === OTHER),
      JSON.stringify(rig.sent.map((s) => s.chat_id)));
    rig.restore();
  }
  {
    // The owner is allowed unconditionally. If the meta row is missing, junk,
    // or someone deletes themselves out of it, the bot must fall back to
    // exactly what it did before this feature existed — not lock everyone out.
    const rig = createRig();
    seedSettings(rig);
    await db.setAllowedChats(rig.env, [OTHER]);   // owner deliberately absent
    const allowed = await db.allowedChats(rig.env);
    check('the owner is always on the list', allowed.has(CHAT), [...allowed].join(','));
    rig.db.prepare("UPDATE meta SET value = '' WHERE key = 'allowed_chats'").run();
    check('an empty list still leaves the owner in',
      (await db.allowedChats(rig.env)).has(CHAT), '');
    rig.restore();
  }
  {
    // Revoking has to actually revoke — including the button path, which is a
    // separate door into the same writes.
    const rig = createRig();
    seedSettings(rig);
    await db.setAllowedChats(rig.env, [OTHER]);
    const remId = seedReminder(rig, 'לרוץ', Date.now() + 3_600_000, undefined, OTHER);
    const instId = seedInstance(rig, remId, 'לרוץ', Date.now() - 1000, OTHER);
    await db.setAllowedChats(rig.env, []);

    await runUpdate(rig, callbackUpdate(OTHER, `d:${instId}`, OTHER));
    const row = rig.db.prepare('SELECT status FROM instances WHERE id = ?').get(instId) as any;
    eq('a revoked chat cannot close a task by tapping', row.status, 'open');
    rig.restore();
  }
  {
    // /allow, /deny and /diag are the owner's, not every user's. /diag in
    // particular prints the API key length and the discarded rewrite texts.
    const rig = createRig();
    seedSettings(rig);
    await db.setAllowedChats(rig.env, [OTHER]);

    // Answered, not ignored — and answered with the SAME sentence a command
    // that does not exist gets, which is what keeps the two indistinguishable.
    // Returning null used to mean the message fell through to the router, and
    // on 09.08.2026 a guest's /diag came back as an improvised "הכל עובד"
    // health report from the persona. See handleSlash's OWNER_ONLY gate.
    const unknown = await handleSlash(rig.env, OTHER, '/xyzzy');
    eq('a guest cannot invite anyone', await handleSlash(rig.env, OTHER, `/allow 123`), unknown);
    eq('nor read /diag', await handleSlash(rig.env, OTHER, '/diag'), unknown);
    check('and what he gets back discloses nothing',
      !String(unknown).includes('GEMINI') && String(unknown).includes('/help'), String(unknown));
    check('the owner can invite',
      ((await handleSlash(rig.env, CHAT, '/allow 123')) ?? '').includes('123'), '');
    check('and the invitation sticks',
      (await db.allowedChats(rig.env)).has('123'), '');
    check('and can revoke',
      ((await handleSlash(rig.env, CHAT, '/deny 123')) ?? '').length > 0, '');
    check('which sticks too', !(await db.allowedChats(rig.env)).has('123'), '');
    rig.restore();
  }

  section('a stranger is asked who they are, once, and then goes quiet again');
  {
    // Silence was safe but useless: someone the owner actually wanted to add
    // had no way to say so, and the owner had to dig their chat_id out of
    // `wrangler tail`. So an unknown chat gets asked for a name — exactly
    // once — and then goes back to being ignored until the owner decides.
    //
    // This is the one place the bot talks to someone it does not know, so it
    // is bounded hard: two replies per chat, ever, and never an echo of what
    // they wrote.
    const rig = createRig();
    seedSettings(rig);

    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'היי', message_id: 1 } });
    const first = rig.sent.filter((s) => String(s.chat_id) === OTHER);
    eq('the first message gets exactly one reply', first.length, 1);
    check('which asks for a name', (first[0].text ?? '').includes('שם'), first[0].text);
    eq('and nothing is said to the owner yet',
      rig.sent.filter((s) => String(s.chat_id) === CHAT).length, 0);
    eq('no model was consulted', rig.geminiCalls.length, 0);

    rig.sent.length = 0;
    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'דנה', message_id: 2 } });
    const named = rig.sent.filter((s) => String(s.chat_id) === OTHER);
    eq('answering with a name gets one acknowledgement', named.length, 1);
    const toOwner = rig.sent.filter((s) => String(s.chat_id) === CHAT).map((s) => s.text ?? '');
    check('and the owner is told, by name and id, without being made to go looking',
      toOwner.some((t) => t.includes('דנה') && t.includes(OTHER)), JSON.stringify(toOwner));

    rig.sent.length = 0;
    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'נו?', message_id: 3 } });
    eq('every message after that is silence again', rig.sent.length, 0);
    rig.restore();
  }
  {
    // The owner reviews by name, because that is the thing they recognise.
    const rig = createRig();
    seedSettings(rig);
    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'היי', message_id: 1 } });
    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'דנה', message_id: 2 } });

    const list = await handleSlash(rig.env, CHAT, '/pending');
    check('/pending shows the name and the id', (list ?? '').includes('דנה') && (list ?? '').includes(OTHER), list ?? '');
    eq('a guest cannot read it',
      await handleSlash(rig.env, OTHER, '/pending'),
      await handleSlash(rig.env, OTHER, '/xyzzy'));

    const ok = await handleSlash(rig.env, CHAT, '/allow דנה');
    check('approving by name works', (ok ?? '').includes('דנה'), ok ?? '');
    check('and they are actually in', (await db.allowedChats(rig.env)).has(OTHER), '');
    check('and no longer pending', !(await db.listPending(rig.env)).some((p) => p.chat_id === OTHER), '');
    rig.restore();
  }
  {
    // Denying has to be permanent, or the next message re-opens the whole
    // conversation and the owner gets asked again forever.
    const rig = createRig();
    seedSettings(rig);
    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'היי', message_id: 1 } });
    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'דנה', message_id: 2 } });
    await handleSlash(rig.env, CHAT, '/deny דנה');

    rig.sent.length = 0;
    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'ובכל זאת', message_id: 3 } });
    eq('a denied chat is never prompted again', rig.sent.length, 0);
    check('and cannot get in', !(await db.allowedChats(rig.env)).has(OTHER), '');
    rig.restore();
  }
  {
    // The cost of talking to strangers at all: someone can point a hundred
    // accounts at it. Past the cap the bot goes back to saying nothing, which
    // is exactly what it did before this feature existed.
    const rig = createRig();
    seedSettings(rig);
    for (let i = 0; i < db.PENDING_MAX; i++) {
      await runUpdate(rig, { message: { chat: { id: 800000 + i }, text: 'היי', message_id: 1 } });
    }
    rig.sent.length = 0;
    await runUpdate(rig, { message: { chat: { id: 999111 }, text: 'היי', message_id: 1 } });
    eq('the queue is capped and the extra stranger gets nothing', rig.sent.length, 0);
    rig.restore();
  }
  {
    // A photo or sticker with no text is not a name. Storing '' would leave a
    // nameless row the owner cannot act on, and re-prompting would be a loop.
    const rig = createRig();
    seedSettings(rig);
    await runUpdate(rig, { message: { chat: { id: Number(OTHER) }, text: 'היי', message_id: 1 } });
    rig.sent.length = 0;
    await runUpdate(rig, {
      message: { chat: { id: Number(OTHER) }, photo: [{ file_id: 'x', file_size: 1 }], message_id: 2 },
    });
    eq('a message with no text is ignored rather than stored as a name', rig.sent.length, 0);
    check('and they are still waiting to be named',
      (await db.listPending(rig.env)).some((p) => p.chat_id === OTHER && !p.name), '');
    rig.restore();
  }

  section('one person\'s reminders never reach another person\'s chat');
  {
    // The bug this exists to close. dueReminders/dueNags read the WHOLE table
    // with no chat filter, and tick() then sent everything to
    // env.OWNER_CHAT_ID — so the moment a second person had a row, their task
    // titles would arrive in the owner's chat.
    const rig = createRig();
    seedSettings(rig);
    await db.setAllowedChats(rig.env, [OTHER]);
    seedReminder(rig, 'הדבר הפרטי של מישהו אחר', Date.now() - 1000, undefined, OTHER);
    rig.geminiDown = true;

    await runCron(rig);

    const toOwner = rig.sent.filter((s) => String(s.chat_id) === CHAT).map((s) => s.text ?? '');
    const toOther = rig.sent.filter((s) => String(s.chat_id) === OTHER).map((s) => s.text ?? '');
    check('it is delivered to the person it belongs to',
      toOther.some((t) => t.includes('הדבר הפרטי')), JSON.stringify(rig.sent));
    check('and never to the owner',
      !toOwner.some((t) => t.includes('הדבר הפרטי')), JSON.stringify(toOwner));
    rig.restore();
  }
  {
    // A reminder belonging to a chat that is no longer allowed must not fire
    // anywhere — and must not consume the LIMIT 25 that real users need.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'של מישהו שהוסר', Date.now() - 1000, undefined, OTHER);
    seedReminder(rig, 'לרוץ', Date.now() - 1000, undefined, CHAT);
    rig.geminiDown = true;

    await runCron(rig);

    const all = rig.texts().join('\n');
    check('the owner still gets theirs', all.includes('לרוץ'), all);
    check('the revoked chat gets nothing', !all.includes('הוסר'), all);
    rig.restore();
  }
  {
    // Why the chat filter is in the SQL and not in JS afterwards.
    //
    // dueReminders carries LIMIT 25. A revoked chat's rows stay in the table
    // and stay due forever, and they sort ahead of everyone else's — so with
    // the filter applied after the query, a single removed user with 25 stale
    // reminders fills the whole page every minute and nobody else's reminder
    // ever fires again. Filtering in SQL means those rows are never selected.
    const rig = createRig();
    seedSettings(rig);
    for (let i = 0; i < 25; i++) {
      seedReminder(rig, `ישן ${i}`, Date.now() - 5000, undefined, OTHER);
    }
    seedReminder(rig, 'לרוץ', Date.now() - 1000, undefined, CHAT);
    rig.geminiDown = true;

    await runCron(rig);

    check('a revoked chat cannot starve the page and block a real reminder',
      rig.texts().join('\n').includes('לרוץ'), rig.texts().join(' | '));
    rig.restore();
  }
  {
    // One user's tick blowing up must not swallow another's reminders. Each
    // chat is its own failure domain, for the same reason one failed send
    // never aborts the rest of a tick.
    const rig = createRig();
    seedSettings(rig);
    await db.setAllowedChats(rig.env, [OTHER]);
    seedReminder(rig, 'לרוץ', Date.now() - 1000, undefined, CHAT);
    seedReminder(rig, 'לשחות', Date.now() - 1000, undefined, OTHER);
    rig.geminiDown = true;
    // Break the first chat's turn specifically.
    rig.dbFailOn = /INSERT INTO instances/;

    await runCron(rig);

    check('the other chat is still served when one chat throws',
      rig.texts().join('\n').includes('לשחות'), rig.texts().join(' | '));
    rig.restore();
  }

  section('a deploy announces itself, exactly once');
  {
    // "Did that actually ship?" is otherwise answered by poking the bot and
    // guessing from its behaviour. The Worker cannot be told it was deployed,
    // so it works it out: the version in the code is compared against the last
    // one the database saw, and a difference means new code is running.
    const rig = createRig();
    seedSettings(rig);
    deployed(rig);

    await runCron(rig);
    check('the first tick after a deploy says so, with the version',
      rig.texts().some((t) => t.includes(VERSION)), rig.texts().join(' | '));
    eq('and it costs no model call — this is plumbing, not personality',
      rig.geminiCalls.length, 0);

    rig.sent.length = 0;
    await runCron(rig);
    eq('every tick after that is silent', rig.texts().length, 0);
    rig.restore();
  }
  {
    // The version the database saw is older than the code: that is a deploy,
    // and the point of the whole thing.
    const rig = createRig();
    seedSettings(rig);
    deployed(rig, '0.4');

    await runCron(rig);
    check('an older stored version announces the new one',
      rig.texts().some((t) => t.includes(VERSION)), rig.texts().join(' | '));
    rig.restore();
  }
  {
    // Claimed before sent, deliberately. A send that fails loses one
    // announcement; a send that succeeds before the claim is written would
    // announce the same deploy every minute forever.
    const rig = createRig();
    seedSettings(rig);
    deployed(rig);
    rig.telegramDown = true;
    await runCron(rig);   // must not throw
    rig.telegramDown = false;
    rig.sent.length = 0;

    await runCron(rig);
    eq('a failed announcement is not retried into a loop', rig.texts().length, 0);
    rig.restore();
  }
  {
    // A deploy is his own doing, so it is not an unprompted message and quiet
    // hours do not apply — he is awake, he just pushed.
    const rig = createRig();
    seedSettings(rig, { quiet_start_hour: 0, quiet_end_hour: 23 });
    deployed(rig);
    await runCron(rig);
    check('quiet hours do not suppress it',
      rig.texts().some((t) => t.includes(VERSION)), rig.texts().join(' | '));
    rig.restore();
  }

  section('/diag reports the running version');
  {
    const rig = createRig();
    seedSettings(rig);
    const diag = await handleSlash(rig.env, CHAT, '/diag');
    check('the version is in /diag', (diag ?? '').includes(VERSION), diag ?? '');
    rig.restore();
  }

  section('THE OTHER INVARIANT — an inbound message is never met with silence');
  {
    // sendOutcome is carefully guarded; everything before it was not. On
    // 10.08.2026 a photo captioned "הנה הנה נוסע עכשיו" got no reply at all,
    // and the only paths that can do that are the ones OUTSIDE handleUpdate's
    // try: buildContext, addMessage, recentMessages. A throw in any of them
    // unwinds to `job.catch(console.error)` in fetch() and the turn ends —
    // the user reported in and heard nothing back.
    //
    // Silence is the worst possible answer here. It is indistinguishable from
    // the bot being down, and it lands precisely when he has done the thing
    // and is waiting to be told it counted.
    const rig = createRig();
    seedSettings(rig);
    rig.dbFailOn = /INSERT INTO messages/; // the first write of the turn
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');

    await runWebhook(rig, 'סיימתי');

    check('he still hears something back',
      rig.texts().length > 0, `sent nothing; methods: ${rig.methods().join(', ')}`);
    check('and it does not pretend anything happened',
      !/רשמתי|קבעתי|נסגר|סגרתי/.test(rig.texts().join('\n')), rig.texts().join('\n'));
    rig.restore();
  }
  {
    // Same guarantee on the photo path specifically — that is where it broke.
    const rig = createRig();
    seedSettings(rig);
    const remId = seedReminder(rig, 'לעבור במשק 27', Date.now() - 3_600_000);
    seedInstance(rig, remId, 'לעבור במשק 27', Date.now() - 3_600_000);
    rig.dbFailOn = /INSERT INTO messages/;

    await runUpdate(rig, photoUpdate('הנה הנה נוסע עכשיו'));

    check('a photo that breaks the turn still gets an answer',
      rig.texts().length > 0, `sent nothing; methods: ${rig.methods().join(', ')}`);
    rig.restore();
  }
  {
    // The guarantee must not become a second reply on the happy path.
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו? מה קורה.');
    await runWebhook(rig, 'מה קורה');
    eq('a turn that works answers exactly once', rig.texts().length, 1);
    rig.restore();
  }

  section('a discarded rewrite leaves evidence, not just a tally');
  {
    // /diag reported "תשובות שנפסלו היום: 3" on 10.08.2026 and that was the
    // entire record: the reason lived for one line in a console.warn, and the
    // discarded text was never written down anywhere. Three rewrites in one
    // day is a rate worth fixing, and a bare count gives you nothing to fix.
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('רשמתי לך, סגור.');
    await runWebhook(rig, 'מה קורה');

    const rows = await db.recentRejections(rig.env, CHAT, 5);
    eq('the rejection was recorded', rows.length, 1);
    check('with the reason the validator gave',
      /רשמתי/.test(rows[0]?.reason ?? ''), JSON.stringify(rows[0]));
    check('and the text that was thrown away, so it can be read back',
      (rows[0]?.text ?? '').includes('רשמתי לך, סגור.'), JSON.stringify(rows[0]));
    check('and what the turn was actually doing when it happened',
      (rows[0]?.effects ?? '').includes('nothing'), JSON.stringify(rows[0]));

    // The daily counter /diag already showed must keep working — this adds a
    // record, it does not replace the tally.
    eq('the daily counter still counts it', await db.usageToday(rig.env, '_rejections'), 1);
    rig.restore();
  }
  {
    // The point of storing them is reading them back, and /diag is where you
    // look. A count you cannot act on is what we already had.
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('קבעתי לך ל-23:47.');
    await runWebhook(rig, 'מה קורה');

    const diag = await handleSlash(rig.env, CHAT, '/diag');
    check('/diag names the reason', /23:47|invented time/.test(diag ?? ''), diag ?? '');
    rig.restore();
  }
  {
    // A rewrite that passes must not leave a row. If every turn logged one,
    // the table would say nothing at all.
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו? מה קורה איתך.');
    await runWebhook(rig, 'מה קורה');

    eq('an accepted rewrite records nothing',
      (await db.recentRejections(rig.env, CHAT, 5)).length, 0);
    rig.restore();
  }
  {
    // Unbounded, this table grows forever on the busiest possible day — the
    // one where the model is misbehaving. Newest first, oldest dropped.
    const rig = createRig();
    seedSettings(rig);
    for (let i = 0; i < db.REJECTION_KEEP + 5; i++) {
      await db.recordRejection(rig.env, CHAT, `reason ${i}`, `text ${i}`, 'nothing');
    }
    const rows = await db.recentRejections(rig.env, CHAT, 500);
    eq('the log is capped', rows.length, db.REJECTION_KEEP);
    check('and it is the newest that survive',
      rows[0].reason === `reason ${db.REJECTION_KEEP + 4}`, JSON.stringify(rows[0]));
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
  section('a multi-item tick sees its own earlier writes — Finding 2');
  {
    // tick() used to build one `ctx` up front and reuse it, unrefreshed,
    // across every send in the `due` loop — even though the first due
    // reminder's own db.createInstance had, by the time the second reminder's
    // message was built, already opened an instance the persona's "מצב נוכחי"
    // block should be able to see. Two due reminders in one tick: the second
    // reminder's system prompt must show the first reminder's instance as
    // open, not describe the tick as it stood before either fired.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'משימה א', Date.now() - 2000);
    seedReminder(rig, 'משימה ב', Date.now() - 1000);
    rig.speakQueue.push('נו? שתי משימות: משימה א, משימה ב.');

    await runCron(rig);

    const speakCalls = rig.geminiCalls.filter((c) => c.kind === 'speak');
    // Reminders coming due together are now one message, so the shape of the
    // staleness question changed: instead of "does the SECOND send see the
    // first's write", it is "does the single send see BOTH". Same invariant,
    // stronger form — every instance is committed before the context is built.
    eq('due reminders in one tick are spoken once, not once each', speakCalls.length, 1);

    const openSection = (system: string) =>
      system.split('משימות פתוחות שנשלחו אליו')[1]?.split('המטרות המתמשכות')[0] ?? '';
    const open = openSection(speakCalls[0]?.system ?? '');

    check(
      "the send's context already shows the FIRST reminder's instance as open — not stale from before this tick's writes",
      open.includes('משימה א'),
      `open section: ${open}`,
    );
    check(
      "and the SECOND one's too — both were committed before the context was built",
      open.includes('משימה ב'),
      `open section: ${open}`,
    );
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('two reminders due at the same time arrive as one message, with buttons for each');
  {
    // The reported shape: 07:00 with "take food" and "throw out the rubbish"
    // used to be two near-identical pings seconds apart, and buttonsFor used
    // `.find()`, so only the first task was actually actionable.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לקחת אוכל', Date.now() - 2000);
    seedReminder(rig, 'לזרוק זבל', Date.now() - 1000);
    rig.geminiDown = true; // force the deterministic baseline, so this pins voice.ts

    await runCron(rig);

    const texts = rig.texts();
    eq('one message, not one per reminder', texts.length, 1);
    check('it names both tasks', texts[0].includes('לקחת אוכל') && texts[0].includes('לזרוק זבל'),
      `got: ${texts[0]}`);

    const markup = JSON.stringify(
      rig.sent.find((s) => s.method === 'sendMessage')?.markup ?? null,
    );
    const openIds = instances(rig).map((i: any) => i.id);
    eq('both reminders produced an instance', openIds.length, 2);
    for (const id of openIds) {
      check(`instance ${id} has its own "done" button`, markup.includes(`"d:${id}"`), markup);
    }
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('what he told you about himself reaches the prompt, and outlives the conversation');
  {
    // The whole point of the table. A note stored today has to still be in the
    // system prompt after the messages that produced it have been pruned away,
    // otherwise it is just conversation history under another name.
    const rig = createRig();
    seedSettings(rig);
    await db.addProfileNote(rig.env, CHAT, 'אני קם ב-6 כל בוקר');
    await db.addProfileNote(rig.env, CHAT, 'יום שלישי זה יום ארוך בעבודה');
    rig.speakQueue.push('סבבה.');

    await runWebhook(rig, 'תזכיר לי עוד 5 דקות לאכול');

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check('the first note is in the system prompt',
      speakCall?.system.includes('אני קם ב-6 כל בוקר') === true, speakCall?.system.slice(0, 200));
    check('and so is the second',
      speakCall?.system.includes('יום שלישי זה יום ארוך בעבודה') === true, '');
    rig.restore();
  }
  {
    // ...but only when there is something to say. An empty profile must not
    // leave an empty heading in the prompt inviting the model to fill it.
    const rig = createRig();
    seedSettings(rig);
    rig.speakQueue.push('סבבה.');
    await runWebhook(rig, 'תזכיר לי עוד 5 דקות לאכול');

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check('no profile section at all when nothing is on file',
      speakCall?.system.includes('מה שאתה יודע עליו') === false, '');
    rig.restore();
  }
  {
    // Button taps never consult the model, so they must not pay for the read.
    const rig = createRig();
    seedSettings(rig);
    await db.addProfileNote(rig.env, CHAT, 'אני קם ב-6');
    const remId = seedReminder(rig, 'לרוץ', Date.now() + 3_600_000);
    const instId = seedInstance(rig, remId, 'לרוץ', Date.now() - 1000);
    rig.sql.length = 0;

    await runUpdate(rig, callbackUpdate(CHAT, `d:${instId}`));

    eq('a button tap does not read the profile',
      rig.sql.filter((s) => /FROM profile/.test(s)).length, 0);
    rig.restore();
  }

  section('a task that was ARRANGING something offers the thing itself');
  {
    // The whole point of "לדבר על המוסך לוודא שאני מגיע בבוקר של יום חמישי
    // לטיפול וטסט" was the Thursday appointment. He closed it Monday morning
    // and /list that evening had nothing for Thursday at all. The bot watched
    // the entire arrangement happen and never noticed the appointment inside
    // the sentence it had been holding for a day.
    const MONDAY = wallToUtc(2026, 8, 10, 10, 26, TZ);
    const rig = createRig();
    seedSettings(rig);
    const title = 'לדבר על המוסך לוודא שאני מגיע בבוקר של יום חמישי לטיפול וטסט';
    const remId = seedReminder(rig, title, MONDAY - 3_600_000);
    const instId = seedInstance(rig, remId, title, MONDAY - 3_600_000);

    await withNow(MONDAY, async () => {
      rig.routerQueue.push({ actions: [{ action: 'complete', target_id: instId }] });
      // A speak-only failure, not geminiDown: the router still has to run for
      // the completion to be routed at all. sendOutcome falls back to the
      // baseline, so the assertions below read voice.ts's real wording.
      rig.speakQueue.push(new Error('speak down'));
      await runWebhook(rig, 'דברתי עם המוסך, הכל טוב');
    });

    const out = rig.texts().join('\n');
    // Asserted on the resolved DATE, not on "חמישי": the title contains that
    // word, so the obvious check passes whether or not anything noticed it.
    // Only the offer can produce 13.08.2026.
    check('it works out which Thursday and says so', out.includes('13.08.2026'), out);
    check('and asks rather than announcing — nothing was written',
      /\?/.test(out) && !/קבעתי/.test(out), out);
    eq('no second reminder exists until he says yes', reminders(rig).length, 1);

    // The offer is only worth anything if there is a way to take it.
    const markup = JSON.stringify(rig.sent.map((s) => s.markup));
    check('with a button carrying the follow-up', markup.includes('"f:'), markup);
    rig.restore();
  }
  {
    // Tapping it is what commits, and the row must land on the day the label
    // promised — Thursday the 13th at 09:00, not "some time Thursday".
    const MONDAY = wallToUtc(2026, 8, 10, 10, 26, TZ);
    const rig = createRig();
    seedSettings(rig);
    const title = 'לדבר על המוסך לוודא שאני מגיע בבוקר של יום חמישי לטיפול וטסט';
    const remId = seedReminder(rig, title, MONDAY - 3_600_000);
    const instId = seedInstance(rig, remId, title, MONDAY - 3_600_000);

    await withNow(MONDAY, async () => {
      await runUpdate(rig, callbackUpdate(CHAT, `f:${instId}`));
    });

    const rows = rig.db.prepare('SELECT title, next_fire_at FROM reminders ORDER BY id').all() as any[];
    eq('the follow-up now exists', rows.length, 2);
    eq('on the Thursday the offer named',
      rows[1].next_fire_at, wallToUtc(2026, 8, 13, 9, 0, TZ));
    rig.restore();
  }
  {
    // He already has something that morning. Offering it again is noise, and
    // noise is how a good prompt gets muted.
    const MONDAY = wallToUtc(2026, 8, 10, 10, 26, TZ);
    const rig = createRig();
    seedSettings(rig);
    const title = 'לדבר על המוסך לוודא שאני מגיע בבוקר של יום חמישי לטיפול וטסט';
    const remId = seedReminder(rig, title, MONDAY - 3_600_000);
    const instId = seedInstance(rig, remId, title, MONDAY - 3_600_000);
    seedReminder(rig, 'מוסך', wallToUtc(2026, 8, 13, 9, 30, TZ));

    await withNow(MONDAY, async () => {
      rig.routerQueue.push({ actions: [{ action: 'complete', target_id: instId }] });
      rig.speakQueue.push(new Error('speak down'));
      await runWebhook(rig, 'דברתי עם המוסך');
    });

    check('nothing is offered when that slot is already covered',
      !rig.texts().join('\n').includes('לשים לך תזכורת גם'), rig.texts().join('\n'));
    rig.restore();
  }
  {
    // An ordinary task names no appointment, and must not sprout a question.
    const rig = createRig();
    seedSettings(rig);
    const remId = seedReminder(rig, 'לרוץ', Date.now() - 3_600_000);
    const instId = seedInstance(rig, remId, 'לרוץ', Date.now() - 3_600_000);
    rig.routerQueue.push({ actions: [{ action: 'complete', target_id: instId }] });
    rig.speakQueue.push(new Error('speak down'));
    await runWebhook(rig, 'סיימתי');
    eq('a plain completion is still just a completion',
      rig.texts().join('\n').trim(), 'נסגר: "לרוץ". רצף 1.');
    rig.restore();
  }

  section('a reminder note outlives the conversation that produced it');
  {
    // "מה איבדת שם?" → "בשר אחי". The next morning's brief managed to say
    // "תביא את הבשר" only because that exchange was still in the recent-message
    // window. Messages get pruned; the note is on the row, and this is the
    // check that it actually reaches the prompt from there.
    const rig = createRig();
    seedSettings(rig);
    const remId = seedReminder(rig, 'לעבור במשק 27', Date.now() + 3_600_000);
    await db.annotateReminder(rig.env, remId, 'בשר');
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');

    await runWebhook(rig, 'מה קורה');

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check('the note is in the system prompt, attached to its reminder',
      /לעבור במשק 27[^\n]*בשר/.test(speakCall?.system ?? ''),
      (speakCall?.system.split('\n').find((l) => l.includes('משק 27')) ?? 'no such line'));
    rig.restore();
  }
  {
    // A reminder with no note must not sprout an empty "הערה:" — an empty
    // field in a prompt is an invitation to fill it in.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לעבור במשק 27', Date.now() + 3_600_000);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');
    await runWebhook(rig, 'מה קורה');

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check('no empty note field when there is nothing to say',
      !/הערה:\s*($|\n)/.test(speakCall?.system ?? ''), '');
    rig.restore();
  }

  section('how long a task has been open is told to the model, not left to arithmetic');
  {
    // The other half of validate.ts's rule 4. On 10.08.2026 the bot announced
    // "שעה וחצי אתה גורר את הטלפון למוסך" thirty minutes in — it was handed a
    // start time ("עדיין פתוחה מ-09:00") and a wall clock and asked to
    // subtract, and it got it wrong. The validator can now catch that, but a
    // caught rewrite is a discarded rewrite: the fix is to stop making it
    // guess. Nothing in the prompt stated the span until this line.
    const rig = createRig();
    seedSettings(rig);
    // Pinned to the middle of the afternoon rather than left on the real
    // clock. facts.addElapsed now discounts quiet hours from the span, so a
    // bare `Date.now() - 90m` gives a different answer depending on what time
    // of day the suite happens to run — 90 at lunchtime, less at 08:30.
    const noon = wallToUtc(2026, 8, 26, 14, 0, TZ);
    const remId = seedReminder(rig, 'לדבר על המוסך', noon - 90 * 60_000);
    seedInstance(rig, remId, 'לדבר על המוסך', noon - 90 * 60_000);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');

    await withNow(noon, async () => {
      await runWebhook(rig, 'מה קורה');
    });

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    check('the true elapsed span is in the system prompt',
      /90 דקות/.test(speakCall?.system ?? ''), speakCall?.system.slice(-400));
    rig.restore();
  }
  {
    // Nothing open means no span to state, and an empty heading in the prompt
    // is an invitation to invent one.
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');
    await runWebhook(rig, 'מה קורה');

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    // Matched on the heading, not on the words "כמה זמן" — persona.ts rule 4
    // uses that phrase for something unrelated, and asserting on it would make
    // this check pass or fail for reasons that have nothing to do with elapsed
    // time.
    check('no elapsed section at all when nothing is open',
      speakCall?.system.includes('כבר פתוח') === false, speakCall?.system.slice(-300));
    rig.restore();
  }

  section('/remember and /profile work without the model');
  {
    const rig = createRig();
    seedSettings(rig);

    await runWebhook(rig, '/remember אני קם ב-6 כל בוקר');
    await runWebhook(rig, '/remember אני קם ב-6 כל בוקר');
    await runWebhook(rig, '/profile');

    eq('no model call for any of it', rig.geminiCalls.length, 0);
    const texts = rig.texts();
    check('the first is stored', texts[0].includes('רשמתי'), texts[0]);
    check('the second is recognised as already known, not stored again',
      texts[1].includes('כבר אצלי'), texts[1]);
    const rows = rig.db.prepare('SELECT COUNT(*) c FROM profile').get() as any;
    eq('one row, not two', rows.c, 1);
    check('and /profile lists it', texts[2].includes('אני קם ב-6 כל בוקר'), texts[2]);
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('a turn does not pay for the same answer twice');
  {
    // Conversation history was read once to give the router context and then
    // AGAIN inside sendOutcome, a moment later, from the same table for the
    // same chat with nothing written in between. A duplicate query is invisible
    // to every other kind of assertion — the answer it returns is correct, just
    // paid for twice — so this counts the statements directly.
    const rig = createRig();
    seedSettings(rig);
    rig.speakQueue.push('סבבה.');

    await runWebhook(rig, 'תזכיר לי עוד 5 דקות לאכול');

    const historyReads = rig.sql.filter((s) => /SELECT role, text FROM messages/.test(s));
    eq('conversation history is read once per turn, not twice', historyReads.length, 1);

    // Pruning a 200-row table used to happen on every turn — a write, on the
    // user's latency path, to delete almost always nothing. It moved to the
    // cron, so answering a message must now do none at all.
    const prunes = rig.sql.filter((s) => /DELETE FROM messages/.test(s));
    eq('answering a message does no housekeeping', prunes.length, 0);
    rig.restore();
  }
  {
    // ...but it must still actually happen. 04:00 local, once a day.
    const rig = createRig();
    seedSettings(rig);
    await withNow(wallToUtc(2026, 8, 7, 4, 0, TZ), async () => {
      await runCron(rig);
    });
    eq('the cron prunes at 04:00',
      rig.sql.filter((s) => /DELETE FROM messages/.test(s)).length, 1);
    rig.restore();
  }
  {
    const rig = createRig();
    seedSettings(rig);
    await withNow(wallToUtc(2026, 8, 7, 4, 1, TZ), async () => {
      await runCron(rig);
    });
    eq('and not on every other tick of the day',
      rig.sql.filter((s) => /DELETE FROM messages/.test(s)).length, 0);
    rig.restore();
  }
  {
    // The cron and button paths have no history in hand, so they must still
    // read it — "pass it in" must not become "silently send none".
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לקום', Date.now() - 1000);
    rig.speakQueue.push('נו? לקום.');

    await runCron(rig);

    const historyReads = rig.sql.filter((s) => /SELECT role, text FROM messages/.test(s));
    eq('a caller with no history in hand still reads it', historyReads.length, 1);
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('the hour-correction button fixes the hour without ending a recurrence');
  {
    // "כל יום ב-7" is ambiguous, so it offers [לא, 19:00]. That button used to
    // write a `once` schedule unconditionally — one tap and a daily habit
    // became a single reminder tomorrow evening, silently. Correcting the HOUR
    // must never change the KIND.
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לרוץ', Date.now() + 3_600_000, '{"type":"daily","time":"07:00"}');

    await runUpdate(rig, callbackUpdate(CHAT, `r:${id}:19:00`));

    const after = reminders(rig).find((r) => r.id === id)!;
    const schedule = JSON.parse(after.schedule);
    eq('it is still a daily reminder', schedule.type, 'daily');
    eq('and the hour is the corrected one', schedule.time, '19:00');
    rig.restore();
  }
  {
    // A weekly rule keeps its days as well as its type.
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לשלם', Date.now() + 3_600_000, '{"type":"weekly","time":"09:00","days":[1,3]}');

    await runUpdate(rig, callbackUpdate(CHAT, `r:${id}:21:00`));

    const schedule = JSON.parse(reminders(rig).find((r) => r.id === id)!.schedule);
    eq('still weekly', schedule.type, 'weekly');
    eq('same days', JSON.stringify(schedule.days), '[1,3]');
    eq('corrected hour', schedule.time, '21:00');
    rig.restore();
  }
  {
    // And a genuine one-off still behaves exactly as before.
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לרוץ', Date.now() + 3_600_000);

    await runUpdate(rig, callbackUpdate(CHAT, `r:${id}:19:00`));

    const schedule = JSON.parse(reminders(rig).find((r) => r.id === id)!.schedule);
    eq('a one-off stays a one-off', schedule.type, 'once');
    check('pointing at the corrected hour', String(schedule.at).endsWith('T19:00'), schedule.at);
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('the per-minute governor spends its last calls on routing, not on wording');
  {
    // The free tier limits requests per MINUTE, and the old guard counted per
    // DAY — so it never fired and a burst just ate 429s. With one call left,
    // the reminder must still be created; only the personality is sacrificed.
    const rig = createRig();
    seedSettings(rig);
    // Budget 10/minute, 7 already spent. Routing (ceiling 10) still fits at 8;
    // wording (ceiling 7, being decorative) does not. The numbers are chosen so
    // that a call is refused ONLY because of the decorative discount — with a
    // flat ceiling both would go through, which is exactly the regression this
    // pins.
    const frozen = wallToUtc(2026, 8, 7, 12, 0, TZ);
    rig.env.GEMINI_RPM = '10';
    // Every rung, not just the primary. The window is per MODEL, so with a
    // ladder underneath it a decorative call refused at the top simply drops a
    // tier and gets its wording from the next model down — which is correct,
    // and is the whole point of the ladder. What this section pins is the
    // DISCOUNT: with the same 7 spent everywhere, routing (ceiling 10) still
    // fits and wording (ceiling 7) does not. Seeding one model would pin the
    // ladder's length instead, and pass for the wrong reason.
    for (const m of modelLadder(rig.env)) {
      rig.db
        .prepare('INSERT INTO rate_window (bucket, calls) VALUES (?, 7)')
        .run(`${new Date(frozen).toISOString().slice(0, 16)}|${m}`);
    }

    rig.routerQueue.push({
      actions: [{ action: 'create_reminder', title: 'לרוץ', schedule_type: 'daily', time: '07:00' }],
    });
    rig.speakQueue.push('this must never be reached');

    await withNow(frozen, async () => {
      // "כל יומיים" is a repeat in DAYS, which quickparse deliberately refuses
      // to express — so this genuinely reaches the router. (A phrase quickparse
      // handles itself would make this test vacuous: no model call to squeeze.)
      await runWebhook(rig, 'תזכיר לי כל יומיים לשלם');
    });

    const kinds = rig.geminiCalls.map((c) => c.kind);
    check('the router was still consulted', kinds.includes('router'), JSON.stringify(kinds));
    check('but the decorative speak call was dropped', !kinds.includes('speak'), JSON.stringify(kinds));
    eq('the reminder exists — the write survived the squeeze', reminders(rig).length, 1);
    check('and he was still told, in the deterministic voice',
      rig.texts().join('\n').includes('לרוץ'), JSON.stringify(rig.texts()));
    rig.restore();
  }


  section('a call that was refused does not spend the minute it never used');
  {
    /**
     * `withinRateWindow` increments FIRST and decides second. So a decorative
     * call turned away at the 70% ceiling had already consumed a slot against
     * the FULL limit — and with a ladder underneath, one speak() attempt walks
     * every rung and burns one slot per model without making a single HTTP
     * request. Those slots come straight out of the budget `route()` is
     * measured against, and route() is the call that must never be dropped.
     *
     * Asserted on the counter rather than on behaviour: the counter IS the
     * bug, and a behavioural assertion here would depend on how deep the
     * ladder happens to be.
     */
    const rig = createRig();
    seedSettings(rig);
    const frozen = wallToUtc(2026, 8, 7, 12, 0, TZ);
    const minute = new Date(frozen).toISOString().slice(0, 16);
    const model = modelLadder(rig.env)[0];

    // Ceiling 10 for routing, 7 for decorative. Seven already spent, so the
    // next decorative call is over its ceiling and the next routing call is
    // not — the same arithmetic as the section above.
    rig.env.GEMINI_RPM = '10';
    // Every rung, for the reason the section above spells out: the window is
    // per MODEL, so seeding only the primary would let the call drop a tier
    // and succeed, and the test would be measuring the ladder's depth.
    for (const m of modelLadder(rig.env)) {
      rig.db.prepare('INSERT INTO rate_window (bucket, calls) VALUES (?, 7)').run(`${minute}|${m}`);
    }

    await withNow(frozen, async () => {
      const { generate } = await import('../src/gemini');
      // Decorative, and over its ceiling on every rung, so nothing is sent.
      await generate(rig.env, {
        system: 's', contents: [{ role: 'user', parts: [{ text: 'x' }] }], decorative: true,
      }).catch(() => {});

      eq('nothing actually went out', rig.geminiCalls.length, 0);
      eq(
        'and the minute is exactly where it was before',
        await db.rateWindowNow(rig.env, model),
        7,
      );

      // The point of all of it: routing still has its slots.
      rig.routerQueue.push({ actions: [{ action: 'chat' }] });
      rig.speakQueue.push('נו?');
      await runWebhook(rig, 'תזכיר לי כל יומיים לשלם');
      check(
        'so the router is still consulted afterwards',
        rig.geminiCalls.some((c) => c.kind === 'router'),
        JSON.stringify(rig.geminiCalls.map((c) => c.kind)),
      );
    });
    rig.restore();
  }

// --------------------------------------------------------------------------
section('a reminder that comes due during a chill is deferred, not consumed');

/**
 * `if (muted) continue` sat AFTER createInstance, so during a chill:
 *
 *  - the instance opened and the schedule advanced
 *  - no message went out, and sendOutcome never ran, so no צלצלה event either
 *  - `if (muted) return` then skipped every nag for the duration
 *
 * When the chill lifted, next_nag_at was long past and the first thing he
 * heard about that reminder was `נו? "X" עדיין פתוחה מ-08:00` — a nag for
 * something he was never sent. A one-off was worse still: computeNext returns
 * null, setNextFire marks it 'done', and the reminder was simply gone.
 *
 * An instance means "he was told, and we are waiting to hear back". If he was
 * not told there is nothing to wait for and nothing to nag about, so the fire
 * is deferred instead. Chill is bounded (72h at most), so a deferred row
 * cannot sit due forever.
 */
async function chillDefersRatherThanSwallows(): Promise<void> {
  const rig = createRig();
  const fireAt = wallToUtc(2026, 8, 7, 9, 0, TZ);
  seedSettings(rig);
  // seedSettings has no muted_until column, so set it directly.
  rig.db.prepare('UPDATE settings SET muted_until = ? WHERE chat_id = ?').run(fireAt + 2 * 3_600_000, CHAT);
  seedReminder(rig, 'לרוץ', fireAt);

  // The minute it comes due — mid-chill.
  await withNow(fireAt + 30_000, async () => {
    await runCron(rig);
  });

  eq('nothing was sent during the chill', rig.sent.length, 0);
  eq(
    'and no instance was opened for a message he never got',
    (rig.db.prepare('SELECT count(*) AS n FROM instances').get() as any).n,
    0,
  );
  const still = rig.db.prepare('SELECT status, next_fire_at FROM reminders WHERE id = 1').get() as any;
  eq('the reminder is still scheduled, not quietly consumed', still.status, 'scheduled');
  eq('and still due at the same moment', still.next_fire_at, fireAt);

  // The chill lifts.
  rig.speakQueue.push('נו? לרוץ.');
  await withNow(fireAt + 3 * 3_600_000, async () => {
    await runCron(rig);
  });

  const texts = rig.texts().join('\n');
  check('once it lifts he gets the REMINDER', texts.includes('לרוץ'), JSON.stringify(rig.texts()));
  check(
    'and not a nag about a message he never received',
    !texts.includes('עדיין פתוחה'),
    JSON.stringify(rig.texts()),
  );
  eq(
    'now there is an instance, because now he has actually been told',
    (rig.db.prepare('SELECT count(*) AS n FROM instances').get() as any).n,
    1,
  );
  rig.restore();
}

  await chillDefersRatherThanSwallows();

  section('a used-up minute stops calling the model at all');
  {
    const rig = createRig();
    seedSettings(rig);
    rig.env.GEMINI_RPM = '0.5'; // below 1: even the first non-decorative call is over
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });

    await runWebhook(rig, 'תזכיר לי כל יומיים לשלם');
    eq('no request was made to the model', rig.geminiCalls.length, 0);
    check('and the bot still answered', rig.texts().length > 0, JSON.stringify(rig.texts()));
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('the morning brief lists today, once, and only once');
  {
    const rig = createRig();
    // 08:40 local, inside the brief hour's grace window.
    const morning = wallToUtc(2026, 8, 7, 8, 40, TZ);
    seedSettings(rig, { brief_hour: 8 });
    seedReminder(rig, 'לרוץ', wallToUtc(2026, 8, 7, 17, 0, TZ));
    seedReminder(rig, 'להתקשר לרואה חשבון', wallToUtc(2026, 8, 7, 19, 30, TZ));
    // Tomorrow — must not appear in today's brief.
    seedReminder(rig, 'משהו של מחר', wallToUtc(2026, 8, 8, 9, 0, TZ));
    rig.geminiDown = true;

    await withNow(morning, async () => {
      await runCron(rig);
      const text = rig.texts().join('\n');
      check('the brief names both of today\'s reminders',
        text.includes('לרוץ') && text.includes('להתקשר לרואה חשבון'), text);
      check('and states their times', text.includes('17:00') && text.includes('19:30'), text);
      check('tomorrow is not in it', !text.includes('משהו של מחר'), text);

      const before = rig.texts().length;
      await runCron(rig);
      eq('a second tick the same morning sends nothing more', rig.texts().length, before);
    });
    rig.restore();
  }

  section('a brief hours late is dropped, not delivered as "בוקר" in the afternoon');
  {
    const rig = createRig();
    seedSettings(rig, { brief_hour: 8 });
    seedReminder(rig, 'לרוץ', wallToUtc(2026, 8, 7, 17, 0, TZ));
    rig.geminiDown = true;

    // 14:00 — the worker was down all morning. Sending now would open with
    // "בוקר" six hours late, which is worse than skipping the day.
    await withNow(wallToUtc(2026, 8, 7, 14, 0, TZ), async () => {
      await runCron(rig);
      eq('nothing is sent outside the grace window', rig.texts().length, 0);
    });
    rig.restore();
  }

  section('the evening close-out reports the day and offers one tap per miss');
  {
    const rig = createRig();
    const evening = wallToUtc(2026, 8, 7, 21, 10, TZ);
    seedSettings(rig, { closeout_hour: 21 });
    // The reminder already fired at 19:00 and its instance is still open, so
    // its next firing is tomorrow — seeding it as still due would make it fire
    // again during this very tick and put another message ahead of the
    // close-out.
    const remId = seedReminder(rig, 'לזרוק זבל', wallToUtc(2026, 8, 8, 19, 0, TZ));
    const openId = seedInstance(rig, remId, 'לזרוק זבל', wallToUtc(2026, 8, 7, 19, 0, TZ));
    // One task closed earlier today, so the tally has something to report.
    const doneRem = seedReminder(rig, 'לרוץ', wallToUtc(2026, 8, 8, 7, 0, TZ));
    const doneInst = seedInstance(rig, doneRem, 'לרוץ', wallToUtc(2026, 8, 7, 7, 0, TZ));
    rig.db.prepare("UPDATE instances SET status='done', closed_at=? WHERE id=?")
      .run(wallToUtc(2026, 8, 7, 7, 30, TZ), doneInst);
    rig.geminiDown = true;

    await withNow(evening, async () => {
      await runCron(rig);
      const text = rig.texts().join('\n');
      check('it names what is still open', text.includes('לזרוק זבל'), text);
      check('and counts what was closed', text.includes('1'), text);

      const markup = JSON.stringify(rig.sent.map((s) => s.markup ?? null));
      check('the still-open task has a one-tap "tomorrow" button',
        markup.includes(`m:${openId}`), markup);
    });
    rig.restore();
  }

  section('a task the bot gave up on is still named at the end of the day');
  {
    // The hole this closes: gave_up writes status='failed', openInstances only
    // returns 'open', and every other reader of 'failed' treats it as a number.
    // A task ignored three times stopped existing — the exact failure a nagging
    // bot is supposed to prevent.
    const rig = createRig();
    const evening = wallToUtc(2026, 8, 7, 21, 10, TZ);
    seedSettings(rig, { closeout_hour: 21 });
    const remId = seedReminder(rig, 'לרוץ', wallToUtc(2026, 8, 8, 7, 0, TZ));
    const instId = seedInstance(rig, remId, 'לרוץ', wallToUtc(2026, 8, 7, 7, 0, TZ));
    rig.db.prepare("UPDATE instances SET status='failed', closed_at=? WHERE id=?")
      .run(wallToUtc(2026, 8, 7, 8, 0, TZ), instId);
    rig.geminiDown = true;

    await withNow(evening, async () => {
      await runCron(rig);
      const text = rig.texts().join('\n');
      check('the close-out names it', text.includes('לרוץ'), text);

      const markup = JSON.stringify(rig.sent.map((s) => s.markup ?? null));
      check('and offers the same one-tap way back', markup.includes(`m:${instId}`), markup);
    });
    rig.restore();
  }

  section('"tomorrow" works on a task already given up on, not just an open one');
  {
    // closeIfOpen returns false for an instance that is already closed. Gating
    // the whole branch on it made the button a silent no-op for precisely the
    // tasks with no other way back.
    const rig = createRig();
    seedSettings(rig);
    const firedAt = wallToUtc(2026, 8, 7, 7, 0, TZ);
    const remId = seedReminder(rig, 'לרוץ', firedAt);
    const instId = seedInstance(rig, remId, 'לרוץ', firedAt);
    rig.db.prepare("UPDATE instances SET status='failed', closed_at=? WHERE id=?")
      .run(wallToUtc(2026, 8, 7, 8, 0, TZ), instId);

    await withNow(wallToUtc(2026, 8, 7, 21, 10, TZ), async () => {
      await runUpdate(rig, callbackUpdate(CHAT, `m:${instId}`));
    });

    eq('the reminder is re-armed for the same time tomorrow',
      reminders(rig).find((r) => r.id === remId)?.next_fire_at,
      wallToUtc(2026, 8, 8, 7, 0, TZ));
    eq('and the failed instance is left as the record of what happened',
      instances(rig).find((i) => i.id === instId)?.status, 'failed');
    rig.restore();
  }

  section('a reminder that keeps being missed says so when it fires');
  {
    const rig = createRig();
    seedSettings(rig);
    const remId = seedReminder(rig, 'לרוץ', Date.now() - 1000);
    // Three prior firings, none of them ever closed as done.
    for (const [n, status] of [[1, 'failed'], [2, 'skipped'], [3, 'failed']] as const) {
      const i = seedInstance(rig, remId, 'לרוץ', Date.now() - n * 86_400_000);
      rig.db.prepare('UPDATE instances SET status=?, closed_at=? WHERE id=?')
        .run(status, Date.now() - n * 86_400_000 + 3600_000, i);
    }
    rig.geminiDown = true;

    await runCron(rig);

    const text = rig.texts().join('\n');
    check('the run is named', text.includes('3'), text);
    check('alongside the task itself', text.includes('לרוץ'), text);
    rig.restore();
  }
  {
    // A single past miss must not trigger it — a bad day is not a pattern.
    const rig = createRig();
    seedSettings(rig);
    const remId = seedReminder(rig, 'לרוץ', Date.now() - 1000);
    const i = seedInstance(rig, remId, 'לרוץ', Date.now() - 86_400_000);
    rig.db.prepare("UPDATE instances SET status='failed', closed_at=? WHERE id=?")
      .run(Date.now() - 80_000_000, i);
    rig.geminiDown = true;

    await runCron(rig);
    eq('one miss reads exactly like any other reminder',
      rig.texts().join('\n').trim(), 'נו? לרוץ.');
    rig.restore();
  }
  {
    // A 'done' in the middle resets the run — otherwise the bot would accuse
    // him of a streak he had already broken.
    const rig = createRig();
    seedSettings(rig);
    const remId = seedReminder(rig, 'לרוץ', Date.now() - 1000);
    for (const [n, status] of [[1, 'failed'], [2, 'done'], [3, 'failed'], [4, 'failed']] as const) {
      const i = seedInstance(rig, remId, 'לרוץ', Date.now() - n * 86_400_000);
      rig.db.prepare('UPDATE instances SET status=?, closed_at=? WHERE id=?')
        .run(status, Date.now() - n * 86_400_000 + 3600_000, i);
    }
    rig.geminiDown = true;

    await runCron(rig);
    eq('the run counts back only as far as the last success',
      rig.texts().join('\n').trim(), 'נו? לרוץ.');
    rig.restore();
  }

  section('"tomorrow" on a miss moves a one-off, but never breaks a recurring rule');
  {
    const rig = createRig();
    seedSettings(rig);
    const firedAt = wallToUtc(2026, 8, 7, 19, 0, TZ);
    const onceId = seedReminder(rig, 'לזרוק זבל', firedAt);
    const onceInst = seedInstance(rig, onceId, 'לזרוק זבל', firedAt);

    await withNow(wallToUtc(2026, 8, 7, 21, 10, TZ), async () => {
      await runUpdate(rig, callbackUpdate(CHAT, `m:${onceInst}`));
    });

    eq('the missed instance is closed, not left hanging',
      instances(rig).find((i) => i.id === onceInst)?.status, 'skipped');
    eq('and the one-off reminder now points at the same time tomorrow',
      reminders(rig).find((r) => r.id === onceId)?.next_fire_at,
      wallToUtc(2026, 8, 8, 19, 0, TZ));
  }
  {
    // The dangerous case: overwriting a daily rule with a one-off would end
    // the recurrence silently. The tap must close the instance and stop there.
    const rig = createRig();
    seedSettings(rig);
    const firedAt = wallToUtc(2026, 8, 7, 19, 0, TZ);
    const dailySchedule = '{"type":"daily","time":"19:00"}';
    const dailyId = seedReminder(rig, 'לקחת כדור', wallToUtc(2026, 8, 8, 19, 0, TZ), dailySchedule);
    const dailyInst = seedInstance(rig, dailyId, 'לקחת כדור', firedAt);

    await withNow(wallToUtc(2026, 8, 7, 21, 10, TZ), async () => {
      await runUpdate(rig, callbackUpdate(CHAT, `m:${dailyInst}`));
    });

    eq('the instance is still closed', instances(rig).find((i) => i.id === dailyInst)?.status, 'skipped');
    eq('but the daily rule is untouched',
      reminders(rig).find((r) => r.id === dailyId)?.schedule, dailySchedule);
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

  section('ambiguous hour — commits, then one tap fixes it');
  {
    const rig = createRig();
    seedSettings(rig);
    rig.speakQueue.push('קבעתי.');
    await runWebhook(rig, 'תזכיר לי ב-11 להתקשר');
    const row = reminders(rig)[0];
    check('a reminder was created immediately', !!row);
    const sent = rig.sent.filter((s) => s.method === 'sendMessage');
    check('the correction button is offered',
      sent.some((s) => JSON.stringify(s.markup ?? '').includes('"r:')),
      `markup: ${JSON.stringify(sent.map((s) => s.markup))}`);

    rig.speakQueue.push('שיניתי.');
    await runUpdate(rig, callbackUpdate(CHAT, `r:${row.id}:23:00`));
    const after = reminders(rig)[0];
    check('the time moved to the other reading',
      after.next_fire_at !== row.next_fire_at, `before=${row.next_fire_at} after=${after.next_fire_at}`);
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

  // ------------------------------------------------------------------------
  section('aliveness — typing, pacing, reactions');
  {
    const { pacingDelay } = await import('../src/telegram');
    const short = pacingDelay(10, () => 0.5);
    const long = pacingDelay(120, () => 0.5);
    check(`a short line pauses at least 900ms (${short})`, short >= 900);
    check(`a long line pauses longer than a short one (${long} > ${short})`, long > short);
    check(`pauses are capped at 5s (${long})`, long <= 5000);

    // Pin the floor and ceiling at both extremes, not just two mid-range
    // lengths — an empty chunk must still floor at 900ms, and an absurdly
    // long one must still ceiling at 5000ms.
    const empty = pacingDelay(0, () => 0.5);
    eq('len=0 still floors at 900ms', empty, 900);
    const huge = pacingDelay(10_000, () => 0.5);
    eq('a very long line still ceilings at 5000ms', huge, 5000);

    // The jitter band itself, away from the clamps: at len=50 (base
    // 700+50*45=2950ms) rand=0 and rand=1 give exactly 0.8x and 1.2x, both
    // inside [900, 5000], so this pins the jitter arithmetic rather than the
    // floor/ceiling.
    const jitterLow = pacingDelay(50, () => 0);
    const jitterHigh = pacingDelay(50, () => 1);
    eq('rand=0 gives the low end of the jitter band (0.8x base)', jitterLow, Math.round(2950 * 0.8));
    eq('rand=1 gives the high end of the jitter band (1.2x base)', jitterHigh, Math.round(2950 * 1.2));
  }
  {
    // Nothing observes sendBurst's actual delay values unless a test looks:
    // rig.burstDelays records what sendBurst requested from env.__burstSleep
    // instead of discarding it, so a regression in BURST_BUDGET_MS's clamping
    // arithmetic (total pacing exceeding 15s) would show up here.
    const { sendBurst } = await import('../src/telegram');
    const rig = createRig();
    const chunks = ['א'.repeat(500), 'ב'.repeat(500), 'ג'.repeat(500), 'ד'.repeat(500)];
    await sendBurst(rig.env, CHAT, chunks.join('\n\n'));
    eq('three gaps were paced (four chunks)', rig.burstDelays.length, 3);
    check('every requested delay lands within pacingDelay\'s [900, 5000] bounds',
      rig.burstDelays.every((d) => d >= 900 && d <= 5000),
      `delays: ${JSON.stringify(rig.burstDelays)}`);
    const total = rig.burstDelays.reduce((a, b) => a + b, 0);
    check(`total requested pacing never exceeds the 15s burst budget (${total}ms)`,
      total <= 15_000,
      `delays: ${JSON.stringify(rig.burstDelays)}`);
    rig.restore();
  }
  {
    const rig = createRig();
    seedSettings(rig);
    rig.speakQueue.push('קבעתי.');
    await runWebhook(rig, 'תזכיר לי עוד 5 דקות לאכול');
    check('the user message got an instant reaction',
      rig.methods().includes('setMessageReaction'),
      `methods: ${rig.methods().join(', ')}`);
    // rig.sent and rig.geminiCalls are separate logs; timeline interleaves
    // both so "before the model was consulted" is a real ordering check,
    // not an assumption from reading the code.
    const reactIdx = rig.timeline.indexOf('tg:setMessageReaction');
    const speakIdx = rig.timeline.indexOf('gemini:speak');
    check('the reaction fires before the model is consulted',
      reactIdx !== -1 && speakIdx !== -1 && reactIdx < speakIdx,
      `timeline: ${rig.timeline.join(', ')}`);
    rig.restore();
  }
  {
    // Cron has no incoming user message, so there is nothing to react to —
    // and no reaction should be attempted on that path.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לרוץ', Date.now() - 1000);
    rig.speakQueue.push('נו? לרוץ.');
    await runCron(rig);
    check('a cron-fired reminder never reacts',
      !rig.methods().includes('setMessageReaction'),
      `methods: ${rig.methods().join(', ')}`);
    rig.restore();
  }
  {
    // withTyping must return promptly once fn() settles — measured with a
    // real elapsed-time assertion, not inferred from reading the code. The
    // brief's own withTyping sets `live = false` but that does not interrupt
    // an in-flight setTimeout, so a naive version blocks here for up to
    // intervalMs after fn() has already resolved. A large gap between
    // intervalMs and fnDelayMs makes that failure mode unmistakable: the
    // correct version finishes near fnDelayMs, the buggy one near intervalMs.
    const { withTyping } = await import('../src/telegram');
    const rig = createRig();
    seedSettings(rig);
    const fnDelayMs = 50;
    const intervalMs = 300;
    const start = Date.now();
    await withTyping(rig.env, CHAT, () => new Promise((r) => setTimeout(r, fnDelayMs)), intervalMs);
    const elapsed = Date.now() - start;
    check(`withTyping returns promptly after fn() settles (${elapsed}ms for a ${fnDelayMs}ms fn, ${intervalMs}ms interval)`,
      elapsed < intervalMs / 2,
      `elapsed=${elapsed}ms — a slow return means stopping the heartbeat isn't cancelling its pending timer`);
    rig.restore();
  }
  {
    // The heartbeat must actually re-fire during a long call, not just once
    // up front — otherwise Telegram's ~5s indicator expiry still shows dead
    // air on any reply slower than that.
    const { withTyping } = await import('../src/telegram');
    const rig = createRig();
    seedSettings(rig);
    const intervalMs = 15;
    await withTyping(rig.env, CHAT, () => new Promise((r) => setTimeout(r, intervalMs * 4)), intervalMs);
    const beats = rig.methods().filter((m) => m === 'sendChatAction').length;
    check(`the heartbeat re-fires more than once for a call longer than the interval (${beats} beats)`,
      beats > 1,
      `methods: ${rig.methods().join(', ')}`);
    rig.restore();
  }
  {
    // Keyboard placement must survive the sendBurst rewrite: still attached
    // only to the final chunk of a multi-message burst.
    const { sendBurst } = await import('../src/telegram');
    const rig = createRig();
    const marker = { inline_keyboard: [[{ text: 'x', callback_data: 'x' }]] };
    const chunks = await sendBurst(rig.env, CHAT, 'חלק א\n\nחלק ב\n\nחלק ג', marker);
    eq('all three chunks were sent', chunks.length, 3);
    const sent = rig.sent.filter((s) => s.method === 'sendMessage');
    eq('three messages went out', sent.length, 3);
    check('only the last chunk carries the keyboard',
      !sent[0].markup && !sent[1].markup && JSON.stringify(sent[2].markup) === JSON.stringify(marker),
      `markup: ${JSON.stringify(sent.map((s) => s.markup))}`);
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('photo verdicts — the tone note reaches the model');
  {
    // Task 6 refactored applyPhoto down to Effect[] only, which silently
    // dropped the per-verdict tone note that used to reach speak() on both
    // the accept and reject paths. Task 13 restored it. Nothing guarded that
    // restoration before this block — a future refactor could drop it again
    // exactly as quietly.
    const rig = createRig();
    seedSettings(rig);
    const reminderId = seedReminder(rig, 'לקפל כביסה', Date.now() + 3_600_000);
    const instId = seedInstance(rig, reminderId, 'לקפל כביסה', Date.now() - 1000);

    rig.routerQueue.push({ actions: [{ action: 'complete', target_id: instId }] });
    rig.routerQueue.push({ verdict: 'accepted', reason: 'רואים כביסה מקופלת בסלסלה' });
    rig.speakQueue.push('כל הכבוד.');

    await runUpdate(rig, photoUpdate('סיימתי'));

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    const toneSection = speakCall?.system.split('## הנחיית טון לתשובה הזאת')[1];
    check(
      'an accepted photo carries its own tone note into the rewrite',
      toneSection !== undefined && toneSection.includes('תן קרדיט אמיתי וקצר'),
      `tone section: ${toneSection?.slice(0, 200) ?? '(no "## הנחיית טון" heading found — toneNote is undefined)'}`,
    );
    rig.restore();
  }
  {
    const rig = createRig();
    seedSettings(rig);
    const reminderId = seedReminder(rig, 'לקפל כביסה', Date.now() + 3_600_000);
    const instId = seedInstance(rig, reminderId, 'לקפל כביסה', Date.now() - 1000);

    rig.routerQueue.push({ actions: [{ action: 'complete', target_id: instId }] });
    rig.routerQueue.push({ verdict: 'rejected', reason: 'זו תמונה של חתול, לא של כביסה' });
    rig.speakQueue.push('זה לא זה.');

    await runUpdate(rig, photoUpdate('סיימתי'));

    const speakCall = rig.geminiCalls.find((c) => c.kind === 'speak');
    const toneSection = speakCall?.system.split('## הנחיית טון לתשובה הזאת')[1];
    check(
      'a rejected photo carries its own tone note into the rewrite',
      toneSection !== undefined && toneSection.includes('תעיר לו על הניסיון'),
      `tone section: ${toneSection?.slice(0, 200) ?? '(no "## הנחיית טון" heading found — toneNote is undefined)'}`,
    );
    rig.restore();
  }

  // ------------------------------------------------------------------------
  section('persona — the prompt matches its new job');
  {
    const settings: Settings = {
      chat_id: CHAT, tz: TZ, intensity: 2, muted_until: null, off_limits: null,
      checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
      next_checkin_at: null,
  awaiting: null,
  brief_hour: 8, closeout_hour: 21, last_brief_on: null, last_closeout_on: null,
    display_name: null,
    };
    const stats: Stats = { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 };
    const p = buildSystemPrompt(settings, stats, 'עכשיו', '  (אין)', '  (אין)', '  (אין)');

    check('it is told it may not add facts', p.includes('אל תוסיף'));
    check('it is told the rewrite will be discarded if it does', p.includes('תיזרק'));
    check('the burst length rule allows a single message', p.includes('הודעה אחת'));
    // The "no unconditional confirmation rule survives" tombstone already
    // lives in the BUG-1 section above — same phrase, same buildSystemPrompt
    // call shape. Not repeated here to avoid two copies of one tombstone.
  }

  done();
}

main();
