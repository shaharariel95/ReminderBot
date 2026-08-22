/**
 * Run with `npm run test:v08`.
 *
 * The 0.7 transcript (10–14.08.2026), turned into failing tests. Each block
 * names the message the owner actually saw, so a regression here is legible
 * without re-reading the chat log.
 *
 * Each block below carries its own write-up, because the plan document that
 * used to hold them is not part of this repository.
 */
import worker from '../src/index';
import { quickParse } from '../src/quickparse';
import { CLAIM, validate } from '../src/validate';
import { buildFacts } from '../src/facts';
import type { Effect, Settings, Stats } from '../src/types';
import type { Context } from '../src/brain';
import { renderBaseline } from '../src/voice';
import { buttonsFor } from '../src/buttons';
import { handleSlash } from '../src/slash';
import { NAG_LADDER, buildSystemPrompt } from '../src/persona';
import { describeSchedule, wallToUtc } from '../src/time';
import * as db from '../src/db';
import { callbackUpdate, check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

/** Bare context for the pure validator checks — no rig, no database. */
function factsCtx(): Context {
  return {
    settings: {
      chat_id: CHAT, tz: TZ, intensity: 2, muted_until: null, off_limits: null,
      checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
      next_checkin_at: null, awaiting: null, brief_hour: 8, closeout_hour: 21,
      last_brief_on: null, last_closeout_on: null,
    } as Settings,
    stats: { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 } as Stats,
    reminders: [], goals: [], open: [], nowLabel: 'עכשיו',
  };
}

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

section('"the reminder" is a reference, never a request for a new one');
{
  // 14.08 23:23, in production: "בוא הזיז את התזכורת של הבשר ל15:00" created a
  // THIRD reminder titled "בוא הזיז את ה של הבשר" — the mangled "ה" being what
  // is left of "התזכורת" after cleanTitle strips the noun out of the title.
  //
  // The gate asked the wrong question. ASKED looked for the bare NOUN
  // "תזכורת" anywhere in the sentence, and "התזכורת" — definite, *the*
  // reminder — is a reference to one that already exists. A blocklist of move
  // verbs was then bolted on to subtract what the gate should never have let
  // in, and it could not possibly be complete: "הזיז" is not "הזז" and not
  // "תזיז", and Hebrew has more forms where those came from.
  //
  // None of the cases below name a verb this file knows. They are all refused
  // for the same reason: the definite article.
  const now = Date.UTC(2026, 7, 13, 8, 0);
  for (const text of [
    'בוא הזיז את התזכורת של הבשר ל15:00',
    'תזיז את התזכורת של הבשר ב15:00',
    'תעביר את התזכורת של הבשר ב-15:00',
    'תמחק את התזכורת ב8 בבוקר',
    'תבטל את התזכורת של מחר ב9',
    // Written with a colon on purpose: "ל-9" parses as no time at all, so it
    // would be refused whatever the gate did, and would prove nothing.
    'תקדים את התזכורת ל-09:00',
    'אולי כדאי שנשנה את התזכורת ל-11:00',
  ]) {
    const got = quickParse(text, now, TZ);
    check(`"${text}" is not a create`, got === null, `got: ${JSON.stringify(got)}`);
  }

  // A request verb AND a definite reference in the same sentence. This is the
  // one shape where the definite-article rule is doing the work on its own —
  // "תזכיר" opens the gate, and only ABOUT_EXISTING closes it again. Without
  // this case the two halves of asksForNewReminder cover each other and
  // neither is actually proved.
  eq(
    'a request verb does not license a definite reference',
    quickParse('תזכיר לי להזיז את התזכורת של הבשר ל15:00', now, TZ),
    null,
  );

  // ...and the gate must not have swallowed the thing it exists for.
  const real = quickParse('תזכיר לי לקנות בשר מחר ב10', now, TZ);
  check('a real request still fast-paths', real?.action === 'create_reminder');
  eq('with the right title', real?.title, 'לקנות בשר');
}

section('the 14.08 production turn, end to end');
{
  // Verbatim from the chat. Two messages, exactly as he sent them: create the
  // reminder, then ask to move it. Before this, the second message created a
  // THIRD reminder called "בוא הזיז את ה של הבשר" and the reply claimed
  // "הזזתי" about it.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 14, 23, 23, TZ);

  rig.speakQueue.push('קבעתי "ללכת לקנות בשר" ל-15.08 ב-10:00.');
  await withNow(now, () => runWebhook(rig, 'תזכיר לי ללכת לקנות בשר מחר ב10 בבוקר'));
  eq(
    'the first message makes one reminder',
    Number((rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any).n),
    1,
  );
  const id = (rig.db.prepare('SELECT id FROM reminders').get() as any).id;

  // The move now reaches the router instead of the fast path.
  rig.routerQueue.push({
    actions: [{ action: 'reschedule', target_id: id, schedule_type: 'once', once_at: '2026-08-15T15:00' }],
  });
  rig.speakQueue.push('הזזתי את "ללכת לקנות בשר" ל-15:00.');
  await withNow(now + 30_000, () => runWebhook(rig, 'בוא הזיז את התזכורת של הבשר ל15:00'));

  eq(
    'and the move does NOT make a second one',
    Number((rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any).n),
    1,
  );
  const row = rig.db.prepare('SELECT next_fire_at, title FROM reminders').get() as any;
  eq('the meat moved to 15:00', Number(row.next_fire_at), wallToUtc(2026, 8, 15, 15, 0, TZ));
  eq('and kept its name', row.title, 'ללכת לקנות בשר');
  check(
    'nothing is titled with his instruction',
    !rig.texts().some((t) => t.includes('בוא הזיז')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  rig.restore();
}

section('a move that names its hour lands in one turn');
{
  // 14.08 23:42 took two exchanges: the router returned a reschedule with no
  // time, the bot asked "מתי לשים את...", and the awaiting slot caught the
  // "15:00" that followed. Correct, but a round trip he should not have to
  // spend — he had already said the hour, in the same sentence.
  //
  // Exactly the move parseDuration already makes for snooze: read the number
  // off his own words when the router leaves the field empty.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 14, 23, 42, TZ);
  const id = await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'ללכת לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-15T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3,
    next_fire_at: wallToUtc(2026, 8, 15, 10, 0, TZ), event_at: null,
  });

  rig.routerQueue.push({ actions: [{ action: 'reschedule', target_id: id }] });
  rig.speakQueue.push('הזזתי את "ללכת לקנות בשר" ל-15:00.');
  await withNow(now, () => runWebhook(rig, 'בוא נזיז את התזכורת של הבשר ל15:00'));

  const rem = await db.getReminder(rig.env, id);
  eq('it moved on the first ask', rem?.next_fire_at, wallToUtc(2026, 8, 15, 15, 0, TZ));
  check(
    'and he was not asked for an hour he had already given',
    !rig.texts().some((t) => t.includes('מתי')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  rig.restore();
}

section('...but it still asks when the hour is genuinely missing');
{
  const rig = createRig();
  const now = wallToUtc(2026, 8, 14, 23, 42, TZ);
  const seed = () =>
    db.addReminder(rig.env, {
      chat_id: CHAT, title: 'ללכת לקנות בשר', notes: null,
      schedule: JSON.stringify({ type: 'once', at: '2026-08-15T10:00' }),
      tz: TZ, requires_proof: 0, proof_type: 'any',
      nag_interval_min: 20, max_nags: 3,
      next_fire_at: wallToUtc(2026, 8, 15, 10, 0, TZ), event_at: null,
    });
  const id = await seed();

  rig.routerQueue.push({ actions: [{ action: 'reschedule', target_id: id }] });
  rig.speakQueue.push('מתי לשים את זה?');
  await withNow(now, () => runWebhook(rig, 'בוא נזיז את התזכורת של הבשר'));
  check(
    'no hour in the sentence means it asks',
    rig.texts().some((t) => t.includes('מתי')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  const untouched = await db.getReminder(rig.env, id);
  eq('and moves nothing', untouched?.next_fire_at, wallToUtc(2026, 8, 15, 10, 0, TZ));
  rig.restore();
}

section('a recurrence is never silently flattened into one fire');
{
  // "תעביר את זה לכל יום ב-8" is a repeat rule. If the router did not express
  // it as one, reading "8" off the sentence and writing a single 08:00 fire
  // would END the recurrence — the same trap the retime button was fixed for.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 14, 23, 42, TZ);
  const id = await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'לרוץ', notes: null,
    schedule: JSON.stringify({ type: 'daily', time: '07:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3,
    next_fire_at: wallToUtc(2026, 8, 15, 7, 0, TZ), event_at: null,
  });
  rig.routerQueue.push({ actions: [{ action: 'reschedule', target_id: id }] });
  rig.speakQueue.push('מתי?');
  await withNow(now, () => runWebhook(rig, 'תעביר את הריצה לכל יום ב8'));

  const rem = await db.getReminder(rig.env, id);
  eq('the daily rule is intact', JSON.parse(rem?.schedule ?? '{}').type, 'daily');
  check(
    'and it asked rather than guessing',
    rig.texts().some((t) => t.includes('מתי')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  rig.restore();
}

section('a slow model drops a tier instead of killing the turn');
{
  // /errors on 15.08 00:00 showed five straight "The operation was aborted due
  // to timeout" against route/apply, going back two hours. The timeout added in
  // 0.8 bounded the call correctly and then threw — and nothing caught it, so
  // one slow request ended the whole turn.
  //
  // Every OTHER transient condition already degrades: 429, 503 and 404 drop a
  // tier, RECITATION and MAX_TOKENS retry. A timeout is the same kind of
  // problem and was the only one treated as fatal. The fallback model — which
  // is faster, and is there for exactly this — was never even asked.
  const rig = createRig();
  rig.env.GEMINI_MODEL = 'gemini-3.5-flash';
  rig.env.GEMINI_MODEL_FALLBACK = 'gemini-3.5-flash-lite';
  rig.env.GEMINI_TIMEOUT_MS = '150';
  rig.env.GEMINI_BUDGET_MS = '2000';
  rig.hangModels.add('gemini-3.5-flash');

  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', title: 'לקנות בשר', schedule_type: 'once', once_at: '2026-08-15T10:00' }],
  });
  rig.speakQueue.push('קבעתי לך.');

  const marker = Symbol('hung');
  const outcome = await Promise.race([
    withNow(wallToUtc(2026, 8, 14, 23, 59, TZ), () => runWebhook(rig, 'תזכיר לי לקנות בשר מחר ב10')).then(() => 'done'),
    new Promise((r) => setTimeout(() => r(marker), 6000)),
  ]);
  eq('the turn finished', outcome, 'done');

  check('the slow model was tried', rig.modelsCalled.includes('gemini-3.5-flash'));
  check(
    'and the fallback picked it up',
    rig.modelsCalled.includes('gemini-3.5-flash-lite'),
    `models called: ${rig.modelsCalled.join(', ')}`,
  );
  check(
    'so he got his reminder, not an apology',
    !rig.texts().some((t) => t.includes('נפל לי משהו')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  eq(
    'and it was actually written',
    Number((rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any).n),
    1,
  );
  rig.restore();
}

section('a failed turn does not capture a message about an existing reminder');
{
  // 14.08 23:59: the router timed out on "בוא נזיז את התזכורת של הבשר ל15:00"
  // and the catch-block fallback answered "תפסתי #30." — capturing his MOVE
  // request as a brand-new inbox item.
  //
  // Same defect as the one just fixed in quickparse, in its twin: the fallback
  // decided "this looks like a reminder request" with a bare-noun regex, and
  // "התזכורת" satisfied it. Two gates asking the same question had to be
  // fixed twice; now they share one answer.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 14, 23, 59, TZ);
  await db.addReminder(rig.env, {
    chat_id: CHAT, title: 'ללכת לקנות בשר', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-15T10:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3,
    next_fire_at: wallToUtc(2026, 8, 15, 10, 0, TZ), event_at: null,
  });
  const before = Number((rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any).n);

  // Queues empty: the router throws, exactly as a timeout does.
  await withNow(now, () => runWebhook(rig, 'בוא נזיז את התזכורת של הבשר ל15:00'));

  eq(
    'nothing new was captured',
    Number((rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any).n),
    before,
  );
  check(
    'and it did not claim to have caught anything',
    !rig.texts().some((t) => t.includes('תפסתי')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  check(
    'it owned the failure instead',
    rig.texts().some((t) => t.includes('נפל לי משהו')),
    `got: ${JSON.stringify(rig.texts())}`,
  );

  // ...but a genuine request still survives a broken router. That fallback
  // exists so a capture is never lost to an outage, and it must keep working.
  rig.restore();
  const rig2 = createRig();
  await withNow(now, () => runWebhook(rig2, 'תזכיר לי לקנות פחמים'));
  check(
    'a real request is still caught when the router is down',
    rig2.texts().some((t) => t.includes('תפסתי')),
    `got: ${JSON.stringify(rig2.texts())}`,
  );
  rig2.restore();
}

section('claiming a MOVE when it created something is still a lie');
{
  // The second half of what he saw on 14.08: the bot said
  // "הזזתי את ... ל-15:00" about a row it had just CREATED. Rule 2 passed it,
  // because rule 2 only ever asked whether SOMETHING was written — never
  // which kind of something. So any turn that wrote anything licensed any
  // write verb, and a create could be reported as a move.
  //
  // Worth fixing on its own account: with quickparse now refusing the message,
  // this exact sentence cannot recur — but the hole it went through is still
  // there for every other write.
  const at = wallToUtc(2026, 8, 15, 15, 0, TZ);
  const created: Effect[] = [
    { kind: 'reminder_created', id: 27, title: 'ללכת לקנות בשר', at,
      schedule: { type: 'once', at: '2026-08-15T15:00' }, requiresProof: false },
  ];
  const retimed: Effect[] = [{ kind: 'reminder_retimed', id: 27, title: 'ללכת לקנות בשר', at }];

  const f = (effects: Effect[]) => buildFacts(factsCtx(), effects, TZ);
  const say = 'הזזתי את "ללכת לקנות בשר" ל-15:00.';

  check(
    'a create cannot be reported as a move',
    !validate(say, f(created), renderBaseline(created, TZ)).ok,
    'the validator let a create claim a move',
  );
  check(
    'but a real move can',
    validate(say, f(retimed), renderBaseline(retimed, TZ)).ok,
    validate(say, f(retimed), renderBaseline(retimed, TZ)).reason,
  );
  check(
    'and a create can still say it created',
    validate('קבעתי לך את זה.', f(created), renderBaseline(created, TZ)).ok,
  );
  check(
    'a create cannot claim a cancellation either',
    !validate('ביטלתי את זה.', f(created), renderBaseline(created, TZ)).ok,
  );
}

section('a move verb inside a real request is still a real request');
{
  // The reason a verb blocklist is not merely incomplete but wrong. "הזיז" is
  // a SUBSTRING of "להזיז", so the obvious patch — adding the form he actually
  // typed — would have broken every one of these the moment it shipped. What
  // he is asking to be reminded OF is none of the parser's business.
  const now = Date.UTC(2026, 7, 13, 8, 0);
  const cases: [string, string][] = [
    ['תזכיר לי להזיז את הארון מחר ב8', 'להזיז את הארון'],
    ['תזכיר לי לבטל את המנוי מחר ב9', 'לבטל את המנוי'],
    ['תזכיר לי למחוק את הגיבויים מחר ב10', 'למחוק את הגיבויים'],
    ['תזכיר לי להעביר כסף מחר ב11', 'להעביר כסף'],
  ];
  for (const [text, title] of cases) {
    const got = quickParse(text, now, TZ);
    check(`"${text}" still fast-paths`, got?.action === 'create_reminder', `got: ${JSON.stringify(got)}`);
    eq('  with his words intact', got?.title, title);
  }
}

section('placing a reminder is a request; operating on one is not');
{
  const now = Date.UTC(2026, 7, 13, 8, 0);
  // An indefinite "תזכורת" behind a placement verb is still a create.
  const placed = quickParse('שים לי תזכורת מחר ב8', now, TZ);
  check('"שים לי תזכורת" creates', placed?.action === 'create_reminder', `got: ${JSON.stringify(placed)}`);
  // But the bare noun on its own no longer opens the gate. This is the change:
  // the noun says what he is talking ABOUT, not what he is asking FOR.
  eq('a bare noun with a verb of its own does not', quickParse('תמחק תזכורת ב8', now, TZ), null);
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
  // Refused, not ignored — and refused with the SAME sentence a nonexistent
  // command gets, so the reply cannot be used to probe which commands are
  // real. Returning null used to mean falling through to the ROUTER, which on
  // 09.08.2026 answered a guest's /diag with an invented health report.
  const refusal = await handleSlash(rig.env, '999', '/errors');
  check(
    'a guest cannot read the owner\'s failures',
    !String(refusal).includes('route/apply') && !String(refusal).includes('משהו'),
    String(refusal),
  );
  eq(
    'and the refusal is indistinguishable from a command that does not exist',
    refusal,
    await handleSlash(rig.env, '999', '/xyzzy'),
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
    nag_interval_min: 20, max_nags: 3, next_fire_at: now, event_at: null,
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
    nag_interval_min: 20, max_nags: 3, next_fire_at: fireAt, event_at: null,
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
    nag_interval_min: 20, max_nags: 3, next_fire_at: fireAt, event_at: null,
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
    next_fire_at: wallToUtc(2026, 8, 13, 10, 0, TZ), event_at: null,
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
    next_fire_at: wallToUtc(2026, 8, 13, 10, 0, TZ), event_at: null,
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
    nag_interval_min: 20, max_nags: 3, next_fire_at: fireAt, event_at: null,
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
    next_fire_at: wallToUtc(2026, 8, 13, 10, 0, TZ), event_at: null,
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
  // A guest gets the identical sentence, which is what stops the reply from
  // being a way to probe which commands exist. It used to return null and fall
  // through to the ROUTER instead — see handleSlash's OWNER_ONLY gate.
  const guest = await handleSlash(rig.env, '999', '/diag');
  eq('a guest still learns nothing', guest, await handleSlash(rig.env, '999', '/nosuchthing'));
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
    next_fire_at: wallToUtc(2026, 8, 14, 9, 0, TZ), event_at: null,
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

// ---------------------------------------------------------------------------

section('three errands in one message are three things to tick off');
{
  // 12.08 21:49: "תזכיר לי להחזיר ראוטר, לקנות מחבת לטבון,ללכת למחסני תאורה
  // מחר ב8 בבוקר" became ONE row with a comma-spliced title. On the 13th he
  // wrote "זה שלוש משימות, החזרתי את הראוטר ואני עכשיו קונה מחבת, וסיימתי עם
  // מחסני תאורה" and there was no way to represent any of that.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 12, 21, 49, TZ);
  rig.speakQueue.push('רשמתי לך.');
  await withNow(now, () =>
    runWebhook(rig, 'תזכיר לי להחזיר ראוטר, לקנות מחבת לטבון,ללכת למחסני תאורה מחר ב8 בבוקר'),
  );

  const rem = rig.db.prepare('SELECT id, title FROM reminders').get() as any;
  check('one reminder, not three', !!rem);
  const items = rig.db
    .prepare('SELECT title, done_at FROM reminder_items WHERE reminder_id = ? ORDER BY position')
    .all(rem.id) as any[];
  eq('but three items under it', items.length, 3);
  check('in his own words', String(items[0].title).includes('ראוטר'), `got: ${items[0]?.title}`);
  check('and the last one survived the missing space', String(items[2].title).includes('תאורה'));
  rig.restore();
}

section('a list that is not three errands is left alone');
{
  // Over-splitting is worse than not splitting: it turns one task into a
  // checklist he did not ask for. The infinitive ל is the signal — "errand,
  // errand, errand" has it repeatedly, a shopping list does not.
  const rig = createRig();
  const now = wallToUtc(2026, 8, 12, 21, 49, TZ);
  rig.speakQueue.push('רשמתי.');
  await withNow(now, () => runWebhook(rig, 'תזכיר לי לקנות חלב, ביצים ולחם מחר ב8'));
  const n = rig.db.prepare('SELECT COUNT(*) AS n FROM reminder_items').get() as any;
  eq('no items were invented', Number(n.n), 0);
  rig.restore();
}

section('the items can be ticked off one at a time');
{
  const rig = createRig();
  const created = wallToUtc(2026, 8, 12, 21, 49, TZ);
  rig.speakQueue.push('רשמתי לך.');
  await withNow(created, () =>
    runWebhook(rig, 'תזכיר לי להחזיר ראוטר, לקנות מחבת לטבון,ללכת למחסני תאורה מחר ב8 בבוקר'),
  );

  const fireAt = wallToUtc(2026, 8, 13, 8, 0, TZ);
  rig.speakQueue.push('נו? שלושת הדברים.');
  await withNow(fireAt, () => runCron(rig));

  const fired = rig.sent.filter((s) => s.markup).pop();
  const rows: any[] = (fired?.markup as any)?.inline_keyboard ?? [];
  const itemButtons = rows.flat().filter((b: any) => String(b.callback_data).startsWith('i:'));
  eq('one button per errand', itemButtons.length, 3);

  // Tick the router off. The task stays open — two errands are still out there.
  await withNow(fireAt + 60_000, () => runCallback(rig, String(itemButtons[0].callback_data)));
  const inst = rig.db.prepare("SELECT status FROM instances").get() as any;
  eq('the task is still open', inst.status, 'open');
  const doneCount = rig.db
    .prepare('SELECT COUNT(*) AS n FROM reminder_items WHERE done_at IS NOT NULL')
    .get() as any;
  eq('but one errand is closed', Number(doneCount.n), 1);

  // Tick the other two — the last one closes the whole thing.
  await withNow(fireAt + 120_000, () => runCallback(rig, String(itemButtons[1].callback_data)));
  await withNow(fireAt + 180_000, () => runCallback(rig, String(itemButtons[2].callback_data)));
  const closed = rig.db.prepare('SELECT status FROM instances').get() as any;
  eq('the last errand closes the task', closed.status, 'done');
  rig.restore();
}

section('telling it what you did closes just that errand');
{
  // The message that got no reply at all on 13.08 11:04.
  const rig = createRig();
  const created = wallToUtc(2026, 8, 12, 21, 49, TZ);
  rig.speakQueue.push('רשמתי לך.');
  await withNow(created, () =>
    runWebhook(rig, 'תזכיר לי להחזיר ראוטר, לקנות מחבת לטבון,ללכת למחסני תאורה מחר ב8 בבוקר'),
  );
  const fireAt = wallToUtc(2026, 8, 13, 8, 0, TZ);
  rig.speakQueue.push('נו?');
  await withNow(fireAt, () => runCron(rig));

  const itemId = (
    rig.db.prepare('SELECT id FROM reminder_items ORDER BY position').get() as any
  ).id;
  rig.routerQueue.push({ actions: [{ action: 'complete_item', item_id: itemId }] });
  rig.speakQueue.push('ראוטר סגור.');
  await withNow(fireAt + 3 * 3_600_000, () => runWebhook(rig, 'החזרתי את הראוטר'));

  const row = rig.db
    .prepare('SELECT done_at FROM reminder_items WHERE id = ?')
    .get(itemId) as any;
  check('the router is marked done', row.done_at !== null);
  const inst = rig.db.prepare('SELECT status FROM instances').get() as any;
  eq('and the other two keep it open', inst.status, 'open');
  check(
    'he was actually answered',
    rig.texts().length > 0 && !rig.texts().some((t) => t.includes('נפל לי משהו')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  rig.restore();
}

section('when two errands fit equally well, it asks instead of guessing');
{
  // Marking the wrong errand is a claim that he did something he did not.
  // Asking costs one exchange; guessing costs the one rule this bot has.
  const rig = createRig();
  const created = wallToUtc(2026, 8, 12, 21, 0, TZ);
  rig.speakQueue.push('רשמתי.');
  await withNow(created, () => runWebhook(rig, 'תזכיר לי לקנות לחם, לקנות חלב מחר ב8'));
  eq(
    'two errands were split out',
    Number((rig.db.prepare('SELECT COUNT(*) AS n FROM reminder_items').get() as any).n),
    2,
  );

  const fireAt = wallToUtc(2026, 8, 13, 8, 0, TZ);
  rig.speakQueue.push('נו?');
  await withNow(fireAt, () => runCron(rig));

  // No item_id, and his words fit both errands exactly as well.
  rig.routerQueue.push({ actions: [{ action: 'complete_item' }] });
  rig.speakQueue.push('על מה מהם?');
  await withNow(fireAt + 60_000, () => runWebhook(rig, 'לקנות'));

  const done = rig.db
    .prepare('SELECT COUNT(*) AS n FROM reminder_items WHERE done_at IS NOT NULL')
    .get() as any;
  eq('nothing was marked on a guess', Number(done.n), 0);
  check(
    'and he was asked which',
    rig.texts().some((t) => t.includes('על מה')),
    `got: ${JSON.stringify(rig.texts())}`,
  );
  rig.restore();
}

section('/list shows which errands are still open');
{
  const rig = createRig();
  const created = wallToUtc(2026, 8, 12, 21, 49, TZ);
  rig.speakQueue.push('רשמתי.');
  await withNow(created, () =>
    runWebhook(rig, 'תזכיר לי להחזיר ראוטר, לקנות מחבת לטבון,ללכת למחסני תאורה מחר ב8 בבוקר'),
  );
  const itemId = (rig.db.prepare('SELECT id FROM reminder_items ORDER BY position').get() as any).id;
  await db.completeItem(rig.env, itemId);

  const out = (await handleSlash(rig.env, CHAT, '/list')) ?? '';
  check('the done one is ticked', out.includes('✓ להחזיר ראוטר'), `got: ${out}`);
  check('the open ones are not', out.includes('☐ לקנות מחבת לטבון'), `got: ${out}`);
  rig.restore();
}

section('the router is told what the items are');
{
  // It cannot return an item_id it was never shown.
  const rig = createRig();
  const created = wallToUtc(2026, 8, 12, 21, 49, TZ);
  rig.speakQueue.push('רשמתי.');
  await withNow(created, () =>
    runWebhook(rig, 'תזכיר לי להחזיר ראוטר, לקנות מחבת לטבון,ללכת למחסני תאורה מחר ב8 בבוקר'),
  );
  // Items are listed under the OPEN task, which is the only context where
  // "החזרתי את הראוטר" can mean anything — so the reminder has to have fired.
  const fireAt = wallToUtc(2026, 8, 13, 8, 0, TZ);
  rig.speakQueue.push('נו?');
  await withNow(fireAt, () => runCron(rig));

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await withNow(fireAt + 60_000, () => runWebhook(rig, 'מה נשמע'));

  const system = rig.geminiCalls.filter((c) => c.kind === 'router').pop()?.system ?? '';
  const openBlock = system.slice(system.indexOf('משימות פתוחות'));
  check(
    'the items are listed under the open task',
    openBlock.includes('ראוטר'),
    'the router cannot see the items',
  );
  check('with their ids', /item:\d+/.test(openBlock), 'no item ids in the prompt');
  check('and their state', /☐/.test(openBlock), 'no open/done marker on the items');
  rig.restore();
}

// ---------------------------------------------------------------------------

section('a mutation says which row it touched');
{
  // "נקבע. מחר ב-10:00." gave him nothing to point at, so "תזיז את זה ל-15"
  // had no referent and every follow-up had to re-describe the task.
  const at = wallToUtc(2026, 8, 14, 10, 0, TZ);
  const created = renderBaseline(
    [{ kind: 'reminder_created', id: 23, title: 'לקנות בשר', at,
       schedule: { type: 'once', at: '2026-08-14T10:00' }, requiresProof: false }],
    TZ,
  );
  check('a new reminder carries its number', created.includes('#23'), `got: ${created}`);

  const moved = renderBaseline([{ kind: 'reminder_retimed', id: 23, title: 'לקנות בשר', at }], TZ);
  check('and so does a move', moved.includes('#23'), `got: ${moved}`);

  // Nags and fires deliberately do NOT — an id in the middle of being chased
  // reads like a ticketing system, and he already knows what it is about.
  const nag = renderBaseline(
    [{ kind: 'nagged', instanceId: 9, title: 'לקנות בשר', since: at, round: 1 }],
    TZ,
  );
  check('a nag stays clean', !nag.includes('#'), `got: ${nag}`);
}

// ---------------------------------------------------------------------------

section('usage is counted per chat, not just in total');
{
  // 11.08 12:35 /diag said "תשובות שנפסלו היום: 1" with nothing listed
  // underneath. The counter was global — keyed (day, model) with no chat — and
  // the listing beneath it was per-chat, so the rejection belonged to נתנאל and
  // the owner had a number he could not reconcile with anything.
  const rig = createRig();
  const GUEST = '999';
  await withNow(wallToUtc(2026, 8, 13, 12, 0, TZ), async () => {
    await db.recordUsage(rig.env, 'test-model', CHAT);
    await db.recordUsage(rig.env, 'test-model', CHAT);
    await db.recordUsage(rig.env, 'test-model', GUEST);

    eq('his own calls are his own', await db.usageTodayFor(rig.env, 'test-model', CHAT), 2);
    eq("the guest's are separate", await db.usageTodayFor(rig.env, 'test-model', GUEST), 1);
    // The API key is shared, so the total still has to be available — it is
    // what protects the key, and it is a different question from "who used it".
    eq('and the total is still the total', await db.usageToday(rig.env, 'test-model'), 3);
  });
  rig.restore();
}

section('/diag separates his usage from everyone else\'s');
{
  const rig = createRig();
  const at = wallToUtc(2026, 8, 13, 12, 0, TZ);
  await withNow(at, async () => {
    await db.recordUsage(rig.env, 'gemini-3.5-flash-lite', CHAT);
    await db.recordUsage(rig.env, 'gemini-3.5-flash-lite', '999');
    await db.recordRejection(rig.env, '999', 'invented time', 'שטויות', 'nothing');
  });

  const out = (await withNow(at, () => handleSlash(rig.env, CHAT, '/diag'))) ?? '';
  check('his own count is shown', /שלך/.test(out), `got: ${out}`);
  check('and so is the shared total', /בסך הכל/.test(out), `got: ${out}`);
  // The number and the list under it must now agree: the guest's rejection is
  // not his, and /diag must not show him a 1 he cannot explain.
  check(
    'a rejection that was not his is not counted as his',
    /נפסלו היום: 0/.test(out),
    `got: ${out}`,
  );
  rig.restore();
}

section('a guest cannot spend the owner\'s check-in budget');
{
  // GEMINI_SOFT_LIMIT gated unprompted check-ins on the GLOBAL counter, so a
  // second person burning the day's calls silently switched off the owner's.
  const rig = createRig();
  rig.env.GEMINI_SOFT_LIMIT = '3';
  const at = wallToUtc(2026, 8, 13, 12, 0, TZ);
  await withNow(at, async () => {
    for (let i = 0; i < 5; i++) await db.recordUsage(rig.env, 'gemini-3.5-flash-lite', '999');
    eq('the guest is over budget', await db.usageTodayFor(rig.env, 'gemini-3.5-flash-lite', '999'), 5);
    eq('the owner has spent nothing', await db.usageTodayFor(rig.env, 'gemini-3.5-flash-lite', CHAT), 0);
  });

  // The owner's check-in still gets the model. getSettings first: the row is
  // created on read, and an UPDATE before it exists silently changes nothing.
  await db.getSettings(rig.env, CHAT);
  await db.addGoal(rig.env, CHAT, 'לפתוח תיק מסחר', null);
  await db.setCheckins(rig.env, CHAT, true, 2);
  rig.db.prepare('UPDATE settings SET next_checkin_at = ? WHERE chat_id = ?').run(at - 1000, CHAT);
  rig.speakQueue.push('נו, מה עם תיק המסחר?');
  await withNow(at, () => runCron(rig));

  check(
    'so his check-in still gets the model',
    rig.geminiCalls.some((c) => c.kind === 'speak'),
    'the guest starved the owner out of his own budget',
  );
  rig.restore();
}

done();
