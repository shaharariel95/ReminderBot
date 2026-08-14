/**
 * Run with `npm run test:v08`.
 *
 * The 0.7 transcript (10–14.08.2026), turned into failing tests. Each block
 * names the message the owner actually saw, so a regression here is legible
 * without re-reading the chat log.
 *
 * See 0.8-plan.md for the full write-up of what each of these cost him.
 */
import worker from '../src/index';
import { quickParse } from '../src/quickparse';
import { CLAIM } from '../src/validate';
import { renderBaseline } from '../src/voice';
import { buttonsFor } from '../src/buttons';
import { handleSlash } from '../src/slash';
import { NAG_LADDER, buildSystemPrompt } from '../src/persona';
import { describeSchedule, wallToUtc } from '../src/time';
import * as db from '../src/db';
import { callbackUpdate, check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

async function runCallback(rig: Rig, data: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  const req = new Request('https://x/tg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify(callbackUpdate(CHAT, data)),
  });
  await worker.fetch(req, rig.env, ctx);
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
    body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text, message_id: 999 } }),
  });
  await worker.fetch(req, rig.env, ctx);
  await Promise.all(pending);
}

// ---------------------------------------------------------------------------

section('the router prompt is not corrupted');
{
  // 13.08 11:08 "בוא הזיז את התזכורת של הבשר ל15:00" came back asking for a
  // time he had just given. The reschedule rule in the prompt had been sliced
  // in half by a bad edit and the annotate bullet pasted into the wound, so
  // the model was reading "reschedule זה לת-" followed by an unrelated rule.
  const rig = createRig();
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await runWebhook(rig, 'משהו');

  const system = rig.geminiCalls.find((c) => c.kind === 'router')?.system ?? '';
  check('the router was consulted', system.length > 0);
  check(
    'the reschedule rule is a whole sentence',
    system.includes('reschedule זה לתזכורת שעדיין מחכה'),
    'the prompt still contains the truncated "reschedule זה לת-"',
  );
  check(
    'annotate is a bullet of its own',
    /\n- "annotate" —/.test(system),
    'annotate is still spliced into the middle of the reschedule rule',
  );
  check(
    'no orphaned fragment is left behind',
    !/^זכורת שעדיין מחכה/m.test(system),
    'the tail of the sliced word is still sitting on its own line',
  );
  rig.restore();
}

// ---------------------------------------------------------------------------

section('a crashed turn says so instead of saying "נו?"');
{
  // 13.08 11:09. He answered "15:00" and got "נו?" — which is also the bot's
  // name, also the opener of every reminder, and also the opener of every nag.
  // A turn that fell over must not be indistinguishable from being nagged.
  const rig = createRig();
  // Both queues left empty: the rig throws on an unexpected call, which is
  // exactly what a router failure looks like from index.ts's side.
  await runWebhook(rig, 'מה קורה');

  const texts = rig.texts();
  check('he was answered at all', texts.length > 0);
  check(
    'the answer is not a bare "נו?"',
    !texts.some((t) => t.trim() === 'נו?'),
    `got: ${JSON.stringify(texts)}`,
  );
  check(
    'and it tells him something went wrong',
    texts.some((t) => t.includes('נפל לי משהו')),
    `got: ${JSON.stringify(texts)}`,
  );
  rig.restore();
}

section('a turn that half-landed reports both halves');
{
  // The catch in respondToOwner keeps effects that already committed. Until
  // now it reported them as though the turn had completed cleanly, so a
  // reminder that was written and a second intent that threw looked identical
  // to a turn where everything worked.
  const created = renderBaseline(
    [
      { kind: 'reminder_captured', id: 7, title: 'לקנות בשר' },
      { kind: 'nothing', why: 'failed', userText: 'x' },
    ],
    TZ,
  );
  check('the write is still confirmed', created.includes('לקנות בשר'));
  check('and the failure is still owned', created.includes('נפל לי משהו'));
}

// ---------------------------------------------------------------------------

section('an unusable router answer is not mistaken for small talk');
{
  // route() used to return [{action:'chat'}] when the model gave back nothing
  // parseable, so "I got garbage" and "he is chatting" produced the identical
  // reply and neither the log nor the user could tell them apart.
  const rig = createRig();
  rig.routerQueue.push({ actions: [] });
  await runWebhook(rig, 'תעשה משהו עם זה');

  const texts = rig.texts();
  check(
    'it admits it did not understand',
    texts.some((t) => t.includes('לא הבנתי')),
    `got: ${JSON.stringify(texts)}`,
  );
  rig.restore();
}

// ---------------------------------------------------------------------------

section('the write-claim validator knows the softer claims too');
{
  // 13.08 11:08 shipped "קלטתי לגבי הבשר." with nothing written. It reads as
  // an acknowledgement that something was recorded, which is the one thing
  // this pipeline exists to prevent.
  check('קלטתי is a write claim', CLAIM.test('קלטתי לגבי הבשר.'));
  check('סימנתי is a write claim', CLAIM.test('סימנתי שסיימת.'));
  check('עדכנתי is a write claim', CLAIM.test('עדכנתי לך את זה.'));
  check('הזזתי is a write claim', CLAIM.test('הזזתי את זה לחמש.'));
  // The invariant from validate.ts: nothing voice.ts emits for a non-WROTE
  // effect may be in here, or the baseline fails its own validator.
  check('שמתי לב is still not a claim', !CLAIM.test('שמתי לב שלא ענית.'));
  check('קלטת is still not a claim', !CLAIM.test('קלטת מה אמרתי?'));
}

// ---------------------------------------------------------------------------

section('asking to move a reminder does not create a second one');
{
  // quickparse's ASKED gate matches the bare word "תזכורת", and quickParse
  // only ever returns create_reminder. "תזיז את התזכורת של הבשר ב15:00" was
  // therefore one letter away from silently creating a duplicate — he wrote
  // "ל15:00" on 13.08 and only the unrecognised ל saved him.
  const now = Date.UTC(2026, 7, 13, 8, 0);
  for (const text of [
    'תזיז את התזכורת של הבשר ב15:00',
    'תעביר את התזכורת של הבשר ב-15:00',
    'תמחק את התזכורת ב8 בבוקר',
    'תבטל את התזכורת של מחר ב9',
  ]) {
    const got = quickParse(text, now, TZ);
    check(`"${text}" is not a create`, got === null, `got: ${JSON.stringify(got)}`);
  }

  // ...and the gate must not have swallowed the thing it exists for.
  const real = quickParse('תזכיר לי לקנות בשר מחר ב10', now, TZ);
  check('a real request still fast-paths', real?.action === 'create_reminder');
  eq('with the right title', real?.title, 'לקנות בשר');
}

section('"ל-15:00" is a time, not noise');
{
  // The natural Hebrew way to name a new time when moving something. Nothing
  // anywhere understood it, so every "תזיז את זה ל-8" lost its hour.
  const now = Date.UTC(2026, 7, 13, 8, 0); // 11:00 local
  const got = quickParse('תזכיר לי לקנות בשר ל15:00', now, TZ);
  check('the hour was read', got?.action === 'create_reminder', `got: ${JSON.stringify(got)}`);
  check('and it is 15:00', String(got?.once_at ?? '').endsWith('T15:00'), `got: ${got?.once_at}`);
  eq('and it is not in the title', got?.title, 'לקנות בשר');
}

// ---------------------------------------------------------------------------

section('a model that never answers does not become silence');
{
  // 13.08 11:04. His longest message of the week — three tasks reported done —
  // got no reply at all, ever. Every Gemini fetch was a bare fetch() with no
  // signal, so a hung call has no bound: ctx.waitUntil is killed by the
  // Worker's wall clock WITHOUT throwing, handleUpdate's catch never runs, and
  // TURN_FAILED never sends. Silence is the one answer this bot must not give.
  const rig = createRig();
  rig.env.GEMINI_TIMEOUT_MS = '150';
  rig.env.GEMINI_BUDGET_MS = '400';
  rig.geminiHang = true;

  // Raced, not awaited: without a timeout in the implementation this hangs
  // forever, and a hung suite is not a failing test.
  const marker = Symbol('never finished');
  const result = await Promise.race([
    runWebhook(rig, 'החזרתי את הראוטר וסיימתי עם מחסני תאורה').then(() => 'finished'),
    new Promise((r) => setTimeout(() => r(marker), 5000)),
  ]);

  check('the turn ended instead of hanging', result === 'finished');
  const texts = rig.texts();
  check(
    'and he was told, rather than left with nothing',
    texts.some((t) => t.includes('נפל לי משהו')),
    `got: ${JSON.stringify(texts)}`,
  );
  rig.restore();
}

section('a question the bot asks can be answered by tapping');
{
  // needs_task_choice rendered "איזו מהן? #22 ... #24" and expected him to
  // type an id. Every question except reminder_captured was a dead end.
  const open = [
    { id: 22, title: 'לקנות בשר' },
    { id: 24, title: 'להחזיר ראוטר' },
  ] as any;
  const rows = buttonsFor([{ kind: 'needs_task_choice', action: 'complete', open }], TZ);
  check('the choice has buttons', !!rows && rows.length > 0);
  check(
    'one per candidate',
    rows?.flat().length === 2,
    `got ${rows?.flat().length} buttons`,
  );
  check(
    'labelled with the task, not the number alone',
    !!rows?.flat().some((b) => b.text.includes('לקנות בשר')),
  );
}

// ---------------------------------------------------------------------------

section('a failure leaves something to read afterwards');
{
  // Every failure went to console.error and nowhere else, and Workers Logs is
  // off. When a reminder did not arrive there was literally nothing to look at
  // — which is why 13.08 08:00 and 14.08 10:00 are still unexplained.
  const rig = createRig();
  await runWebhook(rig, 'משהו'); // both queues empty: the router throws

  const out = (await handleSlash(rig.env, CHAT, '/errors')) ?? '';
  check('the failure is on the record', out.includes('route/apply'), `got: ${out}`);
  check('with what he had sent', out.includes('משהו'), `got: ${out}`);
  check(
    'a guest cannot read the owner\'s failures',
    (await handleSlash(rig.env, '999', '/errors')) === null,
  );
  rig.restore();
}

section('/diag can answer "did the cron run?"');
{
  const rig = createRig();
  const now = wallToUtc(2026, 8, 13, 10, 0, TZ);
  await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-13T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3, next_fire_at: now,
  });
  rig.speakQueue.push('נו? הבשר.');
  await withNow(now, () => runCron(rig));

  // Same pinned clock as the tick: /diag counts TODAY, and 'today' has to mean
  // the same day the cron ran or the query looks in an empty window.
  const out = (await withNow(now, () => handleSlash(rig.env, CHAT, '/diag'))) ?? '';
  check('the last tick is reported', /טיק אחרון/.test(out), `got: ${out}`);
  check('and what it fired', /צלצלו היום: 1/.test(out), `got: ${out}`);
  rig.restore();
}

section('/why answers what happened to one reminder');
{
  // The command that would have settled "why did #18 never fire" in ten
  // seconds instead of by reading a chat export.
  const rig = createRig();
  const fireAt = wallToUtc(2026, 8, 13, 10, 0, TZ);
  const id = await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-13T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3, next_fire_at: fireAt,
  });
  rig.speakQueue.push('נו? הבשר.');
  await withNow(fireAt, () => runCron(rig));

  const out = (await handleSlash(rig.env, CHAT, `/why ${id}`)) ?? '';
  check('it names the reminder', out.includes('לקנות בשר'), `got: ${out}`);
  check('and says it fired', /צלצלה/.test(out), `got: ${out}`);
  check('with the time it happened', /10:00/.test(out), `got: ${out}`);

  const missing = (await handleSlash(rig.env, CHAT, '/why 9999')) ?? '';
  check('an unknown id says so', missing.length > 0 && !missing.includes('לקנות בשר'));
  rig.restore();
}

section('a reminder that fired but never reached him is recorded as such');
{
  // "Marked delivered but never received" is the original bug this project
  // exists to fix, and until now the only trace was a console.log.
  const rig = createRig();
  const fireAt = wallToUtc(2026, 8, 13, 10, 0, TZ);
  await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-13T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3, next_fire_at: fireAt,
  });
  rig.speakQueue.push('נו? הבשר.');
  rig.telegramDown = true;
  await withNow(fireAt, () => runCron(rig));
  rig.telegramDown = false;

  const out = (await withNow(fireAt, () => handleSlash(rig.env, CHAT, '/diag'))) ?? '';
  check('the failed delivery is visible', /לא נמסרו: 1/.test(out), `got: ${out}`);
  rig.restore();
}

// ---------------------------------------------------------------------------

section('an answer to the bot\'s own question is understood as one');
{
  // The 13.08 failure, end to end. He asked to move the meat reminder, the
  // router lost the hour, the bot asked "מתי?" — and then answered his "15:00"
  // with "נו?". The hour was never applied and the reminder never moved.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 13, 11, 8, TZ);
  const id = await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-13T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3,
    next_fire_at: wallToUtc(2026, 8, 13, 10, 0, TZ),
  });

  // Turn one: the router resolves the reminder but brings back no time.
  rig.routerQueue.push({ actions: [{ action: 'reschedule', target_id: id }] });
  rig.speakQueue.push('מתי לשים לך את זה?');
  await withNow(now, () => runWebhook(rig, 'בוא הזיז את התזכורת של הבשר'));
  check('it asks for the hour', rig.texts().length === 1, `got ${JSON.stringify(rig.texts())}`);

  // Turn two: a bare time, and nothing else.
  rig.speakQueue.push('#' + id + ' הוזז ל-15:00.');
  await withNow(now + 60_000, () => runWebhook(rig, '15:00'));

  const routerCalls = rig.geminiCalls.filter((c) => c.kind === 'router').length;
  eq('the answer never reached the router', routerCalls, 1);

  const rem = await db.getReminder(rig.env, id);
  eq(
    'and the reminder actually moved',
    rem?.next_fire_at,
    wallToUtc(2026, 8, 13, 15, 0, TZ),
  );
  check(
    'he was not answered with "נו?"',
    !rig.texts().some((t) => t.trim() === 'נו?'),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  rig.restore();
}

section('a stale question does not swallow an unrelated message');
{
  // The slot has to expire, or "15:00" typed an hour later — about something
  // else entirely — silently retimes whatever the bot last asked about.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 13, 11, 8, TZ);
  const id = await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-13T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3,
    next_fire_at: wallToUtc(2026, 8, 13, 10, 0, TZ),
  });
  rig.routerQueue.push({ actions: [{ action: 'reschedule', target_id: id }] });
  rig.speakQueue.push('מתי?');
  await withNow(now, () => runWebhook(rig, 'תזיז את הבשר'));

  // Two hours later.
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await withNow(now + 2 * 3_600_000, () => runWebhook(rig, '15:00'));

  eq(
    'the stale question let go and the router was asked',
    rig.geminiCalls.filter((c) => c.kind === 'router').length,
    2,
  );
  const rem = await db.getReminder(rig.env, id);
  eq('and nothing was moved', rem?.next_fire_at, wallToUtc(2026, 8, 13, 10, 0, TZ));
  rig.restore();
}

// ---------------------------------------------------------------------------

section('the nag ladder backs off instead of drumming');
{
  // 13.08: 10:01, 10:22, 10:42, 11:04. Four interruptions in one hour about
  // one kilo of meat. Every gap was the same 20 minutes, so the fourth ping
  // arrived with exactly as much force as the first and no more information.
  const rig = createRig();
  const fireAt = wallToUtc(2026, 8, 13, 10, 0, TZ);
  await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-13T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3, next_fire_at: fireAt,
  });

  rig.speakQueue.push('נו? הבשר.');
  await withNow(fireAt, () => runCron(rig));
  const first = rig.db.prepare('SELECT next_nag_at, fired_at FROM instances').get() as any;
  eq('the first nag waits half an hour', first.next_nag_at - first.fired_at, 30 * 60_000);

  rig.speakQueue.push('נו? עדיין.');
  await withNow(Number(first.next_nag_at), () => runCron(rig));
  const second = rig.db.prepare('SELECT next_nag_at, nag_count FROM instances').get() as any;
  eq('one nag has been sent', second.nag_count, 1);
  eq(
    'and the next one is two hours out, not twenty minutes',
    second.next_nag_at - Number(first.next_nag_at),
    120 * 60_000,
  );
  rig.restore();
}

section('the bot does not tell him why he went quiet');
{
  // "הימנעות קלאסית דרך שתיקה." — he could have been driving, in a meeting,
  // or already at the butcher. Inferring a motive from silence is a claim
  // about him the bot cannot back up, which is the same class of failure as
  // claiming a write that never happened.
  const ladder = Object.values(NAG_LADDER).join(' ');
  check(
    'the ladder does not instruct it to name an avoidance pattern',
    !/הימנעות/.test(ladder),
    `got: ${ladder}`,
  );
  const prompt = buildSystemPrompt(
    { intensity: 3 } as any, {} as any, 'עכשיו', '(אין)', '(אין)', '(אין)',
  );
  check(
    'and the persona is told not to guess at his reasons',
    /לא יודע למה|אל תנחש למה|בלי לנחש/.test(prompt),
    'nothing in the persona forbids inventing a motive for silence',
  );
}

section('a goal that has been ignored three times stops asking daily');
{
  // "להגיד לאישתי משהו יפה" was raised five times in four days, every one
  // recycling the identical progress note. stalestGoal returns the only active
  // goal every time, markGoalCheckin only bumps a timestamp, and nothing
  // anywhere noticed that nobody had answered.
  const rig = createRig();
  const id = await db.addGoal(rig.env, CHAT, 'להגיד לאישתי משהו יפה', null);
  const t0 = wallToUtc(2026, 8, 13, 9, 0, TZ);

  // Three check-ins in a row, none of them answered.
  for (let i = 0; i < 3; i++) await withNow(t0, () => db.markGoalCheckin(rig.env, id));

  const soon = await db.stalestGoal(rig.env, CHAT, t0 + 6 * 3_600_000);
  check('six hours later it holds its tongue', soon === null, `got: ${soon?.title}`);

  const later = await db.stalestGoal(rig.env, CHAT, t0 + 72 * 3_600_000);
  check('three days later it may ask again', later?.id === id);

  // ...and answering it resets the patience entirely.
  await db.recordGoalProgress(rig.env, id, 'שלחתי לה');
  const afterAnswer = await db.stalestGoal(rig.env, CHAT, t0 + 7 * 3_600_000);
  check('once he answers, it is a live goal again', afterAnswer?.id === id);
  rig.restore();
}

section('a goal check-in can be closed with one tap');
{
  // It had no buttons at all, so the only way to stop it was to keep ignoring
  // it — which is exactly what produced five identical messages.
  const rows = buttonsFor(
    [{
      kind: 'checkin_goal', id: 3, title: 'להגיד לאישתי משהו יפה', why: null,
      lastProgress: null, lastProgressAt: null, lastCheckinAt: null,
    }],
    TZ,
  );
  check('the check-in has buttons', !!rows && rows.flat().length >= 2);
  check(
    'including a way to be rid of it',
    !!rows?.flat().some((b) => b.data.t === 'gdrop'),
  );
}

// ---------------------------------------------------------------------------

section('the commands work in Hebrew, with and without a slash');
{
  const rig = createRig();
  await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-13T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3,
    next_fire_at: wallToUtc(2026, 8, 13, 10, 0, TZ),
  });

  const slashed = (await handleSlash(rig.env, CHAT, '/רשימה')) ?? '';
  check('/רשימה is /list', slashed.includes('לקנות בשר'), `got: ${slashed}`);

  // The real friction is not the slash — it is switching keyboard layout to
  // type "list". A bare Hebrew word has to work too, and must cost no model
  // call at all.
  const bare = (await handleSlash(rig.env, CHAT, 'רשימה')) ?? '';
  check('and so is a bare "רשימה"', bare.includes('לקנות בשר'), `got: ${bare}`);

  const help = (await handleSlash(rig.env, CHAT, 'עזרה')) ?? '';
  check('"עזרה" reaches /help', help.includes('/list'), `got: ${help.slice(0, 60)}`);
  rig.restore();
}

section('a bare Hebrew command never reaches the model');
{
  const rig = createRig();
  // Nothing queued: any model call at all throws and the turn falls into the
  // failure path, which is exactly what this asserts against.
  await runWebhook(rig, 'רשימה');
  eq('no model was consulted', rig.geminiCalls.length, 0);
  check(
    'and he got the list, not an apology',
    !rig.texts().some((t) => t.includes('נפל לי משהו')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  rig.restore();
}

section('an unknown slash command does not burn a model call');
{
  // "/רשימה" typed before this existed fell straight through to the router as
  // chat text: one Gemini call, and almost certainly "נו?" back.
  const rig = createRig();
  const out = await handleSlash(rig.env, CHAT, '/nosuchthing');
  check('the owner is told it does not exist', !!out && out.includes('/help'), `got: ${out}`);
  // A guest must still fall through silently, or the reply becomes a way to
  // probe which commands exist.
  const guest = await handleSlash(rig.env, '999', '/diag');
  check('a guest still learns nothing', guest === null);
  rig.restore();
}

// ---------------------------------------------------------------------------

section('"יש לי מחר ב-9 אימון" gets offered a reminder');
{
  // The bot only ever reacted to "תזכיר לי X בשעה Y". A stated appointment —
  // by far the more natural way to say it — did nothing at all: quickparse
  // bails at the ASKED gate, and the router's create_reminder rule says "הוא
  // מבקש", which a statement is not.
  //
  // The fix must NOT be to loosen that gate. Rule 1 exists because "אני הולך
  // עוד 20 דקות" once became a reminder titled "אני הולך". So this offers
  // instead of writing: a question with one tap on it, and nothing in the
  // database until he takes it.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 13, 18, 0, TZ);
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('רגע — מחר ב-09:00 אימון. לשים לך תזכורת?');
  await withNow(now, () => runWebhook(rig, 'יש לי מחר ב9 בבוקר אימון'));

  const before = rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any;
  eq('nothing was written on his behalf', Number(before.n), 0);

  const markup: any = rig.sent.find((s) => s.markup)?.markup;
  check('but he was offered one', !!markup, `sent: ${JSON.stringify(rig.texts())}`);
  const button = markup?.inline_keyboard?.[0]?.[0];
  check('with the hour on the button', String(button?.text ?? '').includes('09:00'), `got: ${button?.text}`);

  // ...and taking it creates the real thing.
  await withNow(now + 1000, () => runCallback(rig, String(button.callback_data)));
  const row = rig.db.prepare('SELECT title, next_fire_at FROM reminders').get() as any;
  check('the tap wrote it', !!row, 'no reminder was created');
  check('with his own words as the title', String(row?.title ?? '').includes('אימון'), `got: ${row?.title}`);
  eq('at the hour offered', Number(row?.next_fire_at), wallToUtc(2026, 8, 14, 9, 0, TZ));
  rig.restore();
}

section('an offer is not made when something is already on the books');
{
  const rig = createRig();
  const now = wallToUtc(2026, 8, 13, 18, 0, TZ);
  await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'אימון', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-14T09:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3,
    next_fire_at: wallToUtc(2026, 8, 14, 9, 0, TZ),
  });
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await withNow(now, () => runWebhook(rig, 'יש לי מחר ב9 בבוקר אימון'));
  check(
    'it keeps quiet about a reminder he already has',
    !rig.sent.some((s) => s.markup),
    'offered a duplicate',
  );
  rig.restore();
}

// ---------------------------------------------------------------------------

section('the brief does not call this morning "yesterday"');
{
  // "ועוד 1 פתוחות מאתמול" was printed for anything open at all — including a
  // reminder that fired two minutes before the brief. Small, but it is a false
  // statement about when something happened, which is the one thing this
  // codebase exists to prevent.
  const open = [
    { id: 9, reminder_id: 1, chat_id: CHAT, title: 'לקנות בשר', fired_at: Date.now(),
      next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null },
  ] as any;
  const text = renderBaseline([{ kind: 'morning_brief', rows: [], openCount: 1 }], TZ);
  check('it does not claim they are from yesterday', !text.includes('מאתמול'), `got: ${text}`);
  check('but it still says something is open', /פתוח/.test(text), `got: ${text}`);
  void open;
}

section('a one-off schedule is not shown as an ISO timestamp');
{
  // "/list" printed "פעם אחת ב-2026-08-14T10:00" directly above a perfectly
  // formatted "הבא: יום ו׳, 14.08.2026, 10:00".
  const out = describeSchedule({ type: 'once', at: '2026-08-14T10:00' });
  check('no T-separated machine format leaks out', !out.includes('T10:00'), `got: ${out}`);
  check('and it still says when', out.includes('10:00') && out.includes('14'), `got: ${out}`);
}

section('the daily counters roll over at his midnight, not UTC');
{
  // usageToday keyed on toISOString(), so "היום" reset at 03:00 Israel time.
  // 00:30 local on the 14th is 21:30 UTC on the 13th.
  const justAfterLocalMidnight = wallToUtc(2026, 8, 14, 0, 30, TZ);
  const rig = createRig();
  await withNow(justAfterLocalMidnight, async () => {
    await db.recordUsage(rig.env, 'test-model');
    eq('the call counts against today', await db.usageToday(rig.env, 'test-model'), 1);
  });
  // ...and an hour before local midnight is a different day.
  await withNow(wallToUtc(2026, 8, 13, 23, 0, TZ), async () => {
    eq('yesterday is a separate bucket', await db.usageToday(rig.env, 'test-model'), 0);
  });
  rig.restore();
}

done();
