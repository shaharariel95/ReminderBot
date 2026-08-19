/**
 * Run with `npm run test:comprehension`.
 *
 * What the bot KNOWS versus what it can SEE.
 *
 * On 16.08.2026 he asked for a reminder without an hour, the bot captured it
 * as #35 and asked "מתי?", he answered — and got #36 and #37. Three rows for
 * one errand. It reads like a comprehension failure and it is not: the router
 * was never shown #35 at all (`db.listReminders` filters `status='scheduled'`,
 * and a capture is `status='inbox'`), and the question the bot asked was never
 * written down (`voice.reminder_captured` says "תגיד לי מתי" but only
 * `needs_time` and `appointment_offer` were registered as awaiting).
 *
 * A model cannot reschedule a row it has never been shown. These tests are
 * about the view, not the wording.
 */
import worker from '../src/index';
import * as db from '../src/db';
import { check, createRig, eq, done, section, withNow, type Rig } from './harness';

const HIM = '12345';
const TZ = 'Asia/Jerusalem';

/** 16.08.2026 (Sunday) 08:00 local — the morning the transcript came from. */
const NOW = Date.UTC(2026, 7, 16, 5, 0, 0);

async function post(rig: Rig, body: unknown): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  const req = new Request('https://x/tg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
  await worker.fetch(req, rig.env, ctx);
  await Promise.all(pending);
}

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

async function say(rig: Rig, text: string): Promise<void> {
  await post(rig, {
    message: { chat: { id: Number(HIM) }, from: { id: Number(HIM) }, text, message_id: 999 },
  });
}

function reminderRows(rig: Rig): { id: number; title: string; status: string; next_fire_at: number | null }[] {
  return rig.db
    .prepare('SELECT id, title, status, next_fire_at FROM reminders ORDER BY id')
    .all() as any[];
}

function routerCalls(rig: Rig): number {
  return rig.geminiCalls.filter((c) => c.kind === 'router').length;
}

// --------------------------------------------------------------------------
section('a capture registers the question it asks');

/**
 * The whole transcript failure in four lines.
 *
 * Guard removal, per CLAUDE.md: this scenario is defended THREE independent
 * ways once phase 1 lands — the awaiting registration on `reminder_captured`,
 * the inbox rows in `contextBlock`, and `findNamedTime` on the create path.
 * Removing any ONE of them leaves the other two catching it, so proving this
 * test means removing ALL THREE and watching it go red. Removing one and
 * seeing green proves nothing.
 */
async function captureThenAnswer(): Promise<void> {
  const rig = createRig({ tz: TZ });
  await withNow(NOW, async () => {
    // He asks for something with no hour in it. The router has no time to
    // return, so this lands in the inbox and the bot asks "מתי?".
    rig.routerQueue.push({ actions: [{ action: 'create_reminder', title: 'לקבוע טיפול וטסט' }] });
    rig.speakQueue.push('תפסתי. מתי?');
    await say(rig, 'תזכיר לי לקבוע טיפול וטסט');

    const captured = reminderRows(rig);
    eq('one row after the capture', captured.length, 1);
    eq('and it is an inbox row', captured[0]?.status, 'inbox');

    // THE guard. The bot just asked "מתי?" — it has to have written down what
    // it asked about, or the answer below has nothing to attach to.
    const settings = await db.getSettings(rig.env, HIM);
    const awaiting = db.readAwaiting(settings.awaiting);
    check(
      'the capture wrote down the question it asked',
      awaiting !== null,
      'voice.ts says "תגיד לי מתי" — if nothing is registered, his answer is a new reminder',
    );
    eq('and it points at the captured row', (awaiting as any)?.r, captured[0]?.id);

    const callsBefore = routerCalls(rig);

    // He answers. Free text, not a button — the button path already carries
    // the hour in its label and was never the broken one.
    rig.speakQueue.push('סגור, ב-15:00.');
    await say(rig, 'ב-15:00');

    const after = reminderRows(rig);
    eq('answering the question did NOT create a second row', after.length, 1);
    eq('the row he was asked about is now scheduled', after[0]?.status, 'scheduled');
    check(
      'and it actually has a firing time',
      after[0]?.next_fire_at !== null,
      `next_fire_at: ${after[0]?.next_fire_at}`,
    );
    eq(
      'the answer cost no model call — the bot knew what it had asked',
      routerCalls(rig),
      callsBefore,
    );
  });
  rig.restore();
}

// --------------------------------------------------------------------------
section('the router can see what the bot already captured');

/**
 * Asserted on the RENDERED shape, not on the title alone. The router prompt is
 * full of worked examples, so a substring check on a bare Hebrew word passes
 * with the whole context block deleted — the trap the friends tests hit.
 */
async function inboxIsVisibleToTheRouter(): Promise<void> {
  const rig = createRig({ tz: TZ });
  await withNow(NOW, async () => {
    rig.routerQueue.push({ actions: [{ action: 'create_reminder', title: 'לקבוע טיפול וטסט' }] });
    rig.speakQueue.push('תפסתי. מתי?');
    await say(rig, 'תזכיר לי לקבוע טיפול וטסט');

    const id = reminderRows(rig)[0]?.id;

    // A turn that reaches the router, so we can read what it was shown. The
    // awaiting slot is cleared by a message that is plainly not an hour.
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');
    await say(rig, 'מה נשמע');

    const system = rig.geminiCalls.filter((c) => c.kind === 'router').pop()?.system ?? '';
    check(
      'the captured row is rendered in the prompt with its id',
      system.includes(`#${id}`),
      'the router cannot reschedule a row it has never been shown — it can only create another',
    );
    check(
      'and it is labelled as awaiting an hour, not as scheduled',
      /בלי שעה|inbox|ממתין/.test(system),
      `an inbox row shown as if it were scheduled is a different lie. prompt tail: ${system.slice(-400)}`,
    );
  });
  rig.restore();
}

// --------------------------------------------------------------------------
section('an hour he already said is not asked for again');

/**
 * `reschedule` calls findNamedTime on his own sentence before giving up
 * (effects.ts:613); `create_reminder` does not (effects.ts:368). Same
 * question, two answers — the shape CLAUDE.md records being burned by twice
 * with asksForNewReminder.
 */
async function createReadsTheHourInTheSentence(): Promise<void> {
  const rig = createRig({ tz: TZ });
  await withNow(NOW, async () => {
    // Driven through applyIntent directly, NOT through the webhook.
    //
    // The first version of this test sent "תזכיר לי מחר ב-15:00 לקבוע טיפול"
    // down the webhook and passed on the day it was written — because
    // quickparse resolves that sentence itself and `create_reminder` in
    // effects.ts never runs. It was green while guarding nothing, which is
    // worse than absent: it counts as coverage. The router path is reached
    // only when quickparse bails, so the guard has to be exercised where it
    // actually lives.
    // Built here rather than exporting buildContext purely for a test — the
    // create path reads settings (for tz) and nothing else on this branch.
    const ctx: any = {
      settings: await db.getSettings(rig.env, HIM),
      stats: { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 },
      reminders: [], goals: [], open: [], friends: [], nowLabel: 'עכשיו',
    };
    const { applyIntent } = await import('../src/effects');

    const effects = await applyIntent(
      rig.env,
      HIM,
      ctx,
      // The router returning a create with no time at all, which is what it
      // demonstrably does — and precisely why `reschedule` stopped trusting it
      // and started re-reading the sentence itself (effects.ts:613).
      { action: 'create_reminder', title: 'לקבוע טיפול וטסט' } as any,
      'תזכיר לי לקבוע טיפול וטסט מחר ב-15:00',
    );

    const rows = reminderRows(rig);
    eq('one row', rows.length, 1);
    eq(
      'scheduled from the hour in his own sentence, not captured and asked about',
      rows[0]?.status,
      'scheduled',
    );
    check(
      'and it reports a write, not a question',
      effects.some((e) => e.kind === 'reminder_created' || e.kind === 'reminder_scheduled'),
      `effects: ${effects.map((e) => e.kind).join(', ')}`,
    );
  });
  rig.restore();
}

// --------------------------------------------------------------------------
section('"על מה להזכיר?" is a question too');

/**
 * The SECOND live instance of the same bug phase 1 fixed for captures.
 * `voice.ts:54` has always asked "על מה להזכיר?" when a create arrives with no
 * title, and nothing registered it — so on 16.08.2026 the bot asked, he
 * answered "על זה", and the answer went to the router with no idea what it was
 * answering. He got "אין לי משימה פתוחה שמתאימה לזה".
 */
async function untitledCreateAsksAndRemembers(): Promise<void> {
  const rig = createRig({ tz: TZ });
  await withNow(NOW, async () => {
    // "תזכיר לי עוד שעה" — an hour, no subject. quickparse produces exactly
    // this shape (title falls back to UNTITLED_TITLE).
    rig.speakQueue.push('קבעתי. על מה?');
    await say(rig, 'תזכיר לי עוד שעה');

    const rows = reminderRows(rig);
    eq('the reminder exists', rows.length, 1);
    check('but it has no real title yet', rows[0]?.title === 'תזכורת', `title: ${rows[0]?.title}`);

    const settings = await db.getSettings(rig.env, HIM);
    const awaiting = db.readAwaiting(settings.awaiting);
    check(
      'the bot wrote down that it asked what this is about',
      (awaiting as any)?.k === 'title',
      `voice.ts asks "על מה להזכיר?" — without a slot his answer is a new reminder. got: ${JSON.stringify(awaiting)}`,
    );
    eq('pointing at the row it just made', (awaiting as any)?.r, rows[0]?.id);

    // He answers the question. Not a new request — an answer.
    rig.speakQueue.push('סגור.');
    await say(rig, 'לקבוע טיפול וטסט');

    const after = reminderRows(rig);
    eq('answering did not create a second reminder', after.length, 1);
    eq('the row he was asked about got the title', after[0]?.title, 'לקבוע טיפול וטסט');
    check(
      'and it kept its hour',
      after[0]?.next_fire_at !== null,
      'renaming must not drop the schedule',
    );
  });
  rig.restore();
}

// --------------------------------------------------------------------------
section('a bare "remind me in an hour" while a task is open');

/**
 * A reminder fired and is waiting for a report. He types "תזכיר לי עוד שעה".
 * That is a snooze of the thing being chased, not a brand-new empty reminder —
 * but quickparse answers it with zero context and cannot know a task is open.
 *
 * The fix is NOT to make quickparse guess. It is rule 2 of that file: bail, and
 * let the router — which is shown open instances — decide. A titleless create
 * is precisely the partial parse the rule exists to refuse.
 */
async function titlelessCreateDefersWhenSomethingIsOpen(): Promise<void> {
  const { quickParse } = await import('../src/quickparse');

  const alone = quickParse('תזכיר לי עוד שעה', NOW, TZ, [], false);
  check(
    'with nothing open it still answers, at no model cost',
    alone !== null && alone.action === 'create_reminder',
    `a chat with no open task has no other reading. got: ${JSON.stringify(alone)}`,
  );

  const chased = quickParse('תזכיר לי עוד שעה', NOW, TZ, [], true);
  check(
    'with a task open it bails to the router instead of guessing',
    chased === null,
    `"עוד שעה" with a reminder already ringing is a snooze; filing an empty new reminder loses the report. got: ${JSON.stringify(chased)}`,
  );

  // The bail must be about the MISSING SUBJECT, not about anything being open.
  const titled = quickParse('תזכיר לי עוד שעה לקנות חלב', NOW, TZ, [], true);
  check(
    'a create that names its subject is unaffected',
    titled !== null && titled.action === 'create_reminder',
    `he said what it is about, so there is nothing to defer. got: ${JSON.stringify(titled)}`,
  );
}

// --------------------------------------------------------------------------
section('a day plus a part of the day is a time');

/**
 * "תזכיר לי מחר בערב" — a pinned day and a named part of it, no digits —
 * parsed to NOTHING before 17.08.2026. Verified by running it: quickParse
 * returned null for "מחר בערב", "בשני בערב" and "מחר בבוקר" alike, so the
 * commonest vague phrasing in the language cost a model call and usually came
 * back as a titleless capture and a question about an hour he had already
 * roughly given.
 *
 * The resolution already existed — findFutureInstant + PERIOD_HOUR, written for
 * the appointment-offer path — and was simply never consulted when he asked
 * directly. This wires it into the create path behind findNamedTime.
 *
 * The guess is honest because voice.ts ALWAYS states the hour it set, so he
 * reads back "20:00" and can move it. No hedge is added: a hedge would live in
 * the rewrite, and speak() is licensed to rephrase, so it could be dropped
 * silently. An hour that is always spoken cannot be.
 */
async function dayPlusPeriodResolves(): Promise<void> {
  const rig = createRig({ tz: TZ });
  await withNow(NOW, async () => {
    const ctx: any = {
      settings: await db.getSettings(rig.env, HIM),
      stats: { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 },
      reminders: [], goals: [], open: [], friends: [], nowLabel: 'עכשיו',
    };
    const { applyIntent } = await import('../src/effects');

    // The router does what it does with these: a title, and no time at all.
    const effects = await applyIntent(
      rig.env, HIM, ctx,
      { action: 'create_reminder', title: 'להתכונן לטיפול' } as any,
      'תזכיר לי מחר בערב להתכונן לטיפול',
    );

    const rows = reminderRows(rig);
    eq('one row', rows.length, 1);
    eq('scheduled rather than captured', rows[0]?.status, 'scheduled');
    check(
      'and it landed in the evening of the day he named',
      effects.some((e) => e.kind === 'reminder_created' || e.kind === 'reminder_scheduled'),
      `effects: ${effects.map((e) => e.kind).join(', ')}`,
    );

    // 17.08 is "tomorrow" from NOW (16.08). PERIOD_HOUR puts ערב at 20:00.
    const { wallParts } = await import('../src/time');
    const p = wallParts(rows[0]!.next_fire_at!, TZ);
    eq('on the right day', p.day, 17);
    eq('at the conventional evening hour', p.hour, 20);
  });
  rig.restore();
}

// --------------------------------------------------------------------------
section('a part of the day with NO day is still refused');

/**
 * The guess is bounded by the day being pinned. "בערב" alone could be tonight,
 * tomorrow, or the evening of whatever he is talking about — three different
 * reminders, and picking one is the confident wrong answer rule 2 forbids.
 */
async function bareperiodStillRefuses(): Promise<void> {
  const rig = createRig({ tz: TZ });
  await withNow(NOW, async () => {
    const ctx: any = {
      settings: await db.getSettings(rig.env, HIM),
      stats: { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 },
      reminders: [], goals: [], open: [], friends: [], nowLabel: 'עכשיו',
    };
    const { applyIntent } = await import('../src/effects');
    const effects = await applyIntent(
      rig.env, HIM, ctx,
      { action: 'create_reminder', title: 'להתכונן' } as any,
      'תזכיר לי בערב להתכונן',
    );
    check(
      'no day named means no guess — it is captured and asked about',
      effects.some((e) => e.kind === 'reminder_captured'),
      `effects: ${effects.map((e) => e.kind).join(', ')}`,
    );
  });
  rig.restore();
}

// --------------------------------------------------------------------------
section('when it happens is not when to ring');

/**
 * "קבעתי טיפול + טסט ליום שלישי ב-8:30. תזכיר לי בשני בערב."
 *
 * Two times, two different jobs: Tuesday 08:30 is when the APPOINTMENT is,
 * Monday 20:00 is when to RING. `Intent` had once_at, in_minutes and time —
 * three ways to say when to ring, and no way at all to say when the thing
 * happens (types.ts) — so the appointment was simply dropped, every time, in
 * any phrasing. It is the one genuinely unrepresentable thing in the transcript.
 *
 * This is also the only change here that touches the safety chain, so the
 * checks below deliberately cover the whole of it: stored, spoken at creation,
 * spoken WHEN IT FIRES (the moment it earns its keep), and — the step that
 * fails silently — swept into facts so validate.ts rule 1 does not discard a
 * truthful rewrite for repeating an hour the prompt handed it.
 */
async function eventTimeIsSeparateFromRingTime(): Promise<void> {
  const rig = createRig({ tz: TZ });
  await withNow(NOW, async () => {
    const ctx: any = {
      settings: await db.getSettings(rig.env, HIM),
      stats: { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 },
      reminders: [], goals: [], open: [], friends: [], nowLabel: 'עכשיו',
    };
    const { applyIntent } = await import('../src/effects');

    const effects = await applyIntent(
      rig.env, HIM, ctx,
      {
        action: 'create_reminder',
        title: 'להתכונן לטיפול + טסט',
        schedule_type: 'once',
        once_at: '2026-08-17T20:00',      // ring Monday evening
        event_at: '2026-08-18T08:30',     // the appointment itself
      } as any,
      'קבעתי טיפול וטסט ליום שלישי ב-8:30, תזכיר לי בשני בערב',
    );

    const row = rig.db.prepare('SELECT * FROM reminders').get() as any;
    check('the ring time is Monday evening', row.next_fire_at !== null, 'no fire time');
    check(
      'and the appointment is stored separately, not merged into it',
      row.event_at !== null && row.event_at !== row.next_fire_at,
      `next_fire_at=${row.next_fire_at} event_at=${row.event_at}`,
    );

    const { wallParts } = await import('../src/time');
    eq('appointment day', wallParts(row.event_at, TZ).day, 18);
    eq('appointment hour', wallParts(row.event_at, TZ).hour, 8);
    eq('appointment minute', wallParts(row.event_at, TZ).minute, 30);

    // The baseline must SAY it, or the hour exists only in the database and the
    // persona may not mention it without inventing a time.
    const { renderBaseline } = await import('../src/voice');
    const line = renderBaseline(effects, TZ);
    check(
      'the creation message states when the appointment is',
      line.includes('08:30'),
      `a stored-but-unspoken event hour is invisible. baseline: ${line}`,
    );

    // THE silent one. facts.times is built from next_fire_at / schedule.time /
    // fired_at / effect at|until|since — an event hour is none of those, so
    // without a sweep validate.ts rule 1 finds 08:30 outside the allow-list and
    // throws away the entire rewrite. It shows up as a rejection count in
    // /diag, never as an error.
    const { buildFacts } = await import('../src/facts');
    const facts = buildFacts(ctx, effects, TZ);
    check(
      'and the event hour is allowed to be repeated by the persona',
      facts.times.includes('08:30'),
      `rule 1 would discard a truthful rewrite mentioning it. times: ${JSON.stringify(facts.times)}`,
    );

    // The moment it earns its keep. A reminder to PREPARE that does not say
    // what it is preparing for has sent him to go and look it up.
    const firedLine = renderBaseline(
      [{
        kind: 'reminder_fired', id: 1, title: 'להתכונן לטיפול + טסט',
        instanceId: 1, requiresProof: false, eventAt: row.event_at,
      } as any],
      TZ,
    );
    check(
      'and the fired reminder says when the appointment is',
      firedLine.includes('08:30'),
      `fired: ${firedLine}`,
    );
    const firedFacts = buildFacts(ctx, [{
      kind: 'reminder_fired', id: 1, title: 'x', instanceId: 1,
      requiresProof: false, eventAt: row.event_at,
    } as any], TZ);
    check(
      'and the validator will allow the persona to repeat it there too',
      firedFacts.times.includes('08:30'),
      `times: ${JSON.stringify(firedFacts.times)}`,
    );
  });
  rig.restore();
}

// --------------------------------------------------------------------------
section('the bot does not nag someone who is talking to it');

/**
 * "למה לקח לך 69 דקות להבין מתי זה?" — fired at a COOPERATIVE answer, while he
 * was actively working through the conversation. Two separate mechanisms put
 * it there, and both are fixed here.
 *
 * (1) The elapsed-minutes block. speak() is handed "this has been open N
 *     minutes" whenever anything is open, including on a turn where he just
 *     replied. That block exists to give a NAG a true number instead of an
 *     invented one; on a reply it is an invitation to editorialise about how
 *     long he took, which is what it did.
 *
 * (2) Nags themselves, arriving mid-conversation.
 *
 * The fix for (2) is deliberately NOT to push next_nag_at forward on every
 * inbound message: next_nag_at drives nag_count and gave_up, so deferring it on
 * unrelated chatter would leave the instance open forever and quietly stop it
 * being a reminder. It uses deferNag — the same "defer without burning a round"
 * the quiet-hours branch has always used — bounded to a short window, so the
 * ladder resumes on its own the moment he goes quiet.
 */
async function noNagWhileTalking(): Promise<void> {
  const rig = createRig({ tz: TZ });
  const fireAt = Date.UTC(2026, 7, 16, 6, 0, 0); // 09:00 local
  await withNow(fireAt - 60_000, async () => {
    rig.db.prepare(
      `INSERT INTO reminders (chat_id, title, notes, schedule, tz, requires_proof, proof_type,
        nag_interval_min, max_nags, next_fire_at, event_at, status, active, created_at)
       VALUES (?, 'לקבוע טיפול', NULL, ?, ?, 0, 'any', 20, 3, ?, NULL, 'scheduled', 1, ?)`,
    ).run(HIM, JSON.stringify({ type: 'once', at: '2026-08-16T09:00' }), TZ, fireAt, Date.now());
  });

  // It fires.
  await withNow(fireAt + 1000, async () => {
    rig.speakQueue.push('נו? לקבוע טיפול.');
    await runCron(rig);
  });
  const inst = rig.db.prepare('SELECT * FROM instances').get() as any;
  check('a task is open and being chased', !!inst, 'no instance');

  // He replies. Not an answer to anything — he is simply present.
  await withNow(fireAt + 120_000, async () => {
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('אוקיי.');
    await say(rig, 'רגע אני בודק');
  });

  // The nag comes due while he is mid-conversation.
  rig.db.prepare('UPDATE instances SET next_nag_at = ? WHERE id = ?').run(fireAt + 150_000, inst.id);
  const before = rig.sent.length;
  await withNow(fireAt + 160_000, async () => {
    await runCron(rig);
  });
  eq('no nag is sent while he is mid-conversation', rig.sent.length, before);

  const held = rig.db.prepare('SELECT * FROM instances WHERE id = ?').get(inst.id) as any;
  eq(
    'and the round is NOT burned — nag_count drives gave_up',
    held.nag_count,
    inst.nag_count,
  );
  check('the task is still open, not abandoned', held.status === 'open', `status: ${held.status}`);

  // He goes quiet. The ladder resumes on its own — the defer is bounded, not
  // indefinite, which is the whole difference from pushing next_nag_at on
  // every message.
  const before2 = rig.sent.length;
  await withNow(fireAt + 60 * 60_000, async () => {
    rig.speakQueue.push('נו? עדיין פתוח.');
    await runCron(rig);
  });
  check(
    'once he stops talking the nag arrives',
    rig.sent.length > before2,
    'a bounded defer that never resumes is just a broken reminder',
  );
  rig.restore();
}

// --------------------------------------------------------------------------
section('elapsed time is a nagging device, not conversation');

async function elapsedOnlyWhenChasing(): Promise<void> {
  const rig = createRig({ tz: TZ });
  const fireAt = Date.UTC(2026, 7, 16, 6, 0, 0);
  await withNow(fireAt - 60_000, async () => {
    rig.db.prepare(
      `INSERT INTO reminders (chat_id, title, notes, schedule, tz, requires_proof, proof_type,
        nag_interval_min, max_nags, next_fire_at, event_at, status, active, created_at)
       VALUES (?, 'לקבוע טיפול', NULL, ?, ?, 0, 'any', 20, 3, ?, NULL, 'scheduled', 1, ?)`,
    ).run(HIM, JSON.stringify({ type: 'once', at: '2026-08-16T09:00' }), TZ, fireAt, Date.now());
  });
  await withNow(fireAt + 1000, async () => {
    rig.speakQueue.push('נו? לקבוע טיפול.');
    await runCron(rig);
  });

  // An hour later he answers. He is cooperating, not ignoring.
  await withNow(fireAt + 69 * 60_000, async () => {
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('בסדר.');
    await say(rig, 'ביום שלישי בבוקר');
  });

  const persona = rig.geminiCalls.filter((c) => c.kind === 'speak').pop()?.system ?? '';
  // The number STAYS. Withholding it was tried first and is worse: openSummary
  // still carries fired_at, so the model can still subtract, and without a true
  // span it does so badly — the 10.08.2026 "שעה וחצי at thirty minutes" bug,
  // which costs a discarded rewrite every time rule 4 catches it.
  check(
    'the true span is still given, so the model never has to do the arithmetic',
    /כמה זמן זה כבר פתוח/.test(persona),
    'removing it reintroduces the bug bot.test.ts:1309 guards',
  );
  check(
    'but the persona is told not to use it against him on a reply turn',
    /רקע בלבד/.test(persona) && /אל תנקר/.test(persona),
    'this block produced "למה לקח לך 69 דקות" aimed at a cooperative answer',
  );
  rig.restore();
}

// --------------------------------------------------------------------------
section('the router may reword him, not invent letters');

/**
 * Production, 17.08.2026: "תזכיר לאמנון לדבר עם שחר עוד שתי דקות" came back
 * with the title "לדבר עם שחרy", and on the next try "לדבר עם שחרyil" — hex
 * 79 69 6C, stray Latin appended to correct Hebrew. His message contained no
 * Latin anywhere.
 *
 * Nothing downstream could catch it. validate.ts compares the REPLY against
 * the effect, so a title corrupted before the effect exists is reported
 * faithfully and quoted back to him for as long as the reminder lives.
 */
async function titleUsesOnlyHisScript(): Promise<void> {
  const { titleFromHisWords } = await import('../src/effects');

  eq(
    'the exact production corruption is removed',
    titleFromHisWords('לדבר עם שחרyil', 'תזכיר לאמנון לדבר עם שחר עוד שתי דקות'),
    'לדבר עם שחר',
  );
  eq(
    'and the single-letter version that preceded it',
    titleFromHisWords('לדבר עם שחרy', 'תזכיר לאמנון לדבר עם שחר עוד שתי דקות'),
    'לדבר עם שחר',
  );

  // Rewording is the router's JOB — dropping "תזכיר לאמנון" from the front is
  // correct and must survive. Only an invented SCRIPT is stripped.
  eq(
    'a rewording that uses only his letters is untouched',
    titleFromHisWords('לדבר עם שחר', 'תזכיר לאמנון לדבר עם שחר עוד שתי דקות'),
    'לדבר עם שחר',
  );
  // His own Latin is his. This must not become a general character filter.
  eq(
    'Latin he actually typed is kept',
    titleFromHisWords('לשלוח email לדני', 'תזכיר לי לשלוח email לדני מחר'),
    'לשלוח email לדני',
  );
  eq(
    'an English message keeps its English',
    titleFromHisWords('buy milk', 'remind me to buy milk tomorrow'),
    'buy milk',
  );
  // Button and cron paths have no message to compare against, so they are
  // left alone rather than being silently emptied.
  eq('no source text means no judgement', titleFromHisWords('anything', ''), 'anything');
}

await titleUsesOnlyHisScript();
await captureThenAnswer();
await inboxIsVisibleToTheRouter();
await createReadsTheHourInTheSentence();
await untitledCreateAsksAndRemembers();
await titlelessCreateDefersWhenSomethingIsOpen();
await dayPlusPeriodResolves();
await bareperiodStillRefuses();
await eventTimeIsSeparateFromRingTime();
await noNagWhileTalking();
await elapsedOnlyWhenChasing();
done();
