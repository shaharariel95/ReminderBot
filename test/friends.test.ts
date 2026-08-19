/**
 * Run with `npm run test:friends`.
 *
 * Reminders you set for somebody else. Two people, two chats, one bot — so
 * every check here is really the same question asked from both sides: did the
 * row land in the RIGHT chat, and did the person it landed on agree to it.
 *
 * The rule from CLAUDE.md applies with more force than usual: a false claim
 * about a write is bad, and a false claim about a write in someone ELSE'S
 * account is worse, because he cannot check it.
 */
import worker from '../src/index';
import { quickParse } from '../src/quickparse';
import { validate } from '../src/validate';
import { buildFacts } from '../src/facts';
import { renderBaseline } from '../src/voice';
import { handleSlash } from '../src/slash';
import { applyIntent } from '../src/effects';
import { decode, encode } from '../src/buttons';
import { wallToUtc } from '../src/time';
import type { Context } from '../src/brain';
import type { Effect, Settings, Stats } from '../src/types';
import * as db from '../src/db';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const HIM = '12345';
const HER = '999';
const TZ = 'Asia/Jerusalem';

function factsCtx(): Context {
  return {
    settings: {
      chat_id: HIM, tz: TZ, intensity: 2, muted_until: null, off_limits: null,
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

/** A text message, with the sender's Telegram first name attached. */
async function runWebhook(rig: Rig, text: string, chatId = HIM, firstName?: string): Promise<void> {
  await post(rig, {
    message: {
      chat: { id: Number(chatId) },
      from: { id: Number(chatId), ...(firstName ? { first_name: firstName } : {}) },
      text,
      message_id: 999,
    },
  });
}

async function runCallback(rig: Rig, data: string, chatId: string): Promise<void> {
  await post(rig, {
    callback_query: {
      id: 'cb1',
      from: { id: Number(chatId) },
      message: { message_id: 555, chat: { id: Number(chatId) } },
      data,
    },
  });
}

/** Two people the bot is allowed to talk to. */
async function twoUsers(rig: Rig): Promise<void> {
  await db.setAllowedChats(rig.env, [HER]);
  await db.getSettings(rig.env, HIM);
  await db.getSettings(rig.env, HER);
}

/** Both of them, already friends, without going through the flow. */
async function befriended(rig: Rig, hisName = 'דנה', herName = 'שחר'): Promise<void> {
  await twoUsers(rig);
  await db.requestFriend(rig.env, HIM, HER, hisName);
  await db.acceptFriend(rig.env, HER, HIM, herName);
}

// ---------------------------------------------------------------------------

section('a user can find out his own id');
{
  const rig = createRig();
  const out = (await handleSlash(rig.env, HIM, '/id')) ?? '';
  check('the id is in the answer', out.includes(HIM), `got: ${out}`);
  // A number with no explanation is a number nobody does anything with. The
  // whole point of knowing it is handing it to somebody else.
  check('and what it is for', /חבר|friend|\/friend/.test(out), `got: ${out}`);

  // Not owner-only: the id a guest needs is his own, and he is the only one
  // who can read it.
  const guest = (await handleSlash(rig.env, HER, '/id')) ?? '';
  check('a guest can read his own too', guest.includes(HER), `got: ${guest}`);
  check('and is not shown the owner\'s', !guest.includes(HIM), `got: ${guest}`);
  rig.restore();
}

section('a friend request is a question, not a grant');
{
  const rig = createRig();
  await twoUsers(rig);

  const out = (await handleSlash(rig.env, HIM, `/friend ${HER} דנה`, 'שחר')) ?? '';
  check('he is told it went out', out.length > 0, `got: ${out}`);
  // The one thing it must not say. Until she taps yes he cannot write a single
  // row into her chat, and wording that implies otherwise is the same class of
  // false claim as "קבעתי" with nothing saved.
  check(
    'and not told they are friends',
    !/הוספתי|חברים עכשיו|אפשר לשלוח לו/.test(out),
    `got: ${out}`,
  );

  const edge = await db.friendEdge(rig.env, HIM, HER);
  eq('the row is pending', edge?.status, 'pending');
  eq('and there is no row on her side yet', await db.friendEdge(rig.env, HER, HIM), null);
  eq('so she is nobody he can write to', (await db.friendsOf(rig.env, HIM)).length, 0);

  check(
    'she was actually asked',
    rig.sent.some((s) => s.chat_id === HER && /דנה|שחר|חבר/.test(s.text ?? '')),
    `sent: ${JSON.stringify(rig.sent.map((s) => [s.chat_id, s.text]))}`,
  );
  check(
    'with a way to answer',
    rig.sent.some((s) => s.chat_id === HER && !!s.markup),
    'she got a question with no button on it',
  );
  rig.restore();
}

section('a friend request cannot be aimed at a stranger');
{
  // Anyone who is not already allowed to use the bot gets exactly the silence
  // greetStranger gives them. A friend request is a message the bot sends on
  // somebody's say-so, and the guest list is the only thing bounding who can
  // be made to receive one.
  const rig = createRig();
  await db.getSettings(rig.env, HIM);
  const out = (await handleSlash(rig.env, HIM, '/friend 777 מישהו', 'שחר')) ?? '';
  check('he is told it did not go', /לא מכיר|לא רשום/.test(out), `got: ${out}`);
  eq('nothing was written', await db.friendEdge(rig.env, HIM, '777'), null);
  check(
    'and the stranger was not messaged',
    !rig.sent.some((s) => s.chat_id === '777'),
    'the bot messaged a chat it does not know on a stranger\'s say-so',
  );
  rig.restore();
}

section('yes makes it mutual; no makes it nothing');
{
  const rig = createRig();
  await twoUsers(rig);
  await handleSlash(rig.env, HIM, `/friend ${HER} דנה`, 'שחר');

  await runCallback(rig, encode({ t: 'facc', from: HIM }), HER);

  eq('his edge is accepted', (await db.friendEdge(rig.env, HIM, HER))?.status, 'accepted');
  // Both edges, or her reminder arrives in his chat from a number he has no
  // name for — see migrations/013.
  const hers = await db.friendEdge(rig.env, HER, HIM);
  eq('and hers exists too', hers?.status, 'accepted');
  eq('named after the name he messages under', hers?.nickname, 'שחר');
  check(
    'he was told she said yes',
    rig.sent.some((s) => s.chat_id === HIM && /דנה/.test(s.text ?? '')),
    `sent: ${JSON.stringify(rig.sent.map((s) => [s.chat_id, s.text]))}`,
  );
  rig.restore();

  // ...and the other answer.
  const rig2 = createRig();
  await twoUsers(rig2);
  await handleSlash(rig2.env, HIM, `/friend ${HER} דנה`, 'שחר');
  await runCallback(rig2, encode({ t: 'frej', from: HIM }), HER);

  eq('a refusal is remembered', (await db.friendEdge(rig2.env, HIM, HER))?.status, 'declined');
  eq('she is still nobody he can write to', (await db.friendsOf(rig2.env, HIM)).length, 0);

  // A refusal that can be reset by asking again is not a refusal. Same rule a
  // denied stranger gets in `pending`.
  const askedHerBefore = rig2.sent.filter((s) => s.chat_id === HER && !!s.markup).length;
  const again = (await handleSlash(rig2.env, HIM, `/friend ${HER} דנה`, 'שחר')) ?? '';
  eq('and asking again changes nothing', (await db.friendEdge(rig2.env, HIM, HER))?.status, 'declined');
  eq(
    'she is not asked a second time',
    rig2.sent.filter((s) => s.chat_id === HER && !!s.markup).length,
    askedHerBefore,
  );
  check('and he is told why', /לא אשאל/.test(again), `got: ${again}`);
  rig2.restore();
}

section('only the person asked can answer');
{
  // The callback path is unauthenticated inbound. A guessed payload must not
  // be able to accept a friendship on somebody else's behalf, because the
  // thing it grants is the right to write into their chat.
  const rig = createRig();
  await twoUsers(rig);
  await handleSlash(rig.env, HIM, `/friend ${HER} דנה`, 'שחר');

  // He taps his own request. Nobody said yes.
  await runCallback(rig, encode({ t: 'facc', from: HIM }), HIM);
  eq('it is still pending', (await db.friendEdge(rig.env, HIM, HER))?.status, 'pending');
  rig.restore();
}

section('a reminder for a friend lands in her chat, not his');
{
  const rig = createRig();
  await befriended(rig);

  const ctx: Context = {
    ...factsCtx(),
    settings: await db.getSettings(rig.env, HIM),
    friends: await db.friendsOf(rig.env, HIM),
  };
  const effects = await withNow(wallToUtc(2026, 8, 15, 9, 0, TZ), () =>
    applyIntent(
      rig.env, HIM, ctx,
      {
        action: 'create_reminder', title: 'לקנות חלב', for_friend: 'דנה',
        schedule_type: 'once', once_at: '2026-08-15T18:00',
      },
      'תזכיר לדנה לקנות חלב ב-18:00',
    ),
  );

  eq('one effect', effects.length, 1);
  eq('and it says whose it is', effects[0].kind, 'friend_reminder_created');

  const row: any = rig.db.prepare('SELECT * FROM reminders').get();
  eq('the row belongs to her', row?.chat_id, HER);
  eq('and remembers who set it', String(row?.from_chat_id), HIM);
  eq('he has none of his own', (await db.listReminders(rig.env, HIM)).length, 0);
  eq('she has one', (await db.listReminders(rig.env, HER)).length, 1);
  rig.restore();
}

section('a reminder cannot be set for someone who has not said yes');
{
  const rig = createRig();
  await twoUsers(rig);
  // Asked, never answered.
  await db.requestFriend(rig.env, HIM, HER, 'דנה');

  const ctx: Context = {
    ...factsCtx(),
    settings: await db.getSettings(rig.env, HIM),
    // Pending, so db.friendsOf hands back nothing — which is the point.
    friends: await db.friendsOf(rig.env, HIM),
  };
  const effects = await withNow(wallToUtc(2026, 8, 15, 9, 0, TZ), () =>
    applyIntent(
      rig.env, HIM, ctx,
      {
        action: 'create_reminder', title: 'לקנות חלב', for_friend: 'דנה',
        schedule_type: 'once', once_at: '2026-08-15T18:00',
      },
      'תזכיר לדנה לקנות חלב ב-18:00',
    ),
  );

  eq('nothing was written into her chat', (await db.listReminders(rig.env, HER)).length, 0);
  // And not silently turned into one of his own either: he asked for a thing
  // to happen to somebody else, and a reminder in HIS chat is a different
  // thing that he would then also have to go and delete.
  eq('nor into his', (await db.listReminders(rig.env, HIM)).length, 0);
  // Was `nothing: 'unknown_friend'` until 17.08.2026. A dedicated effect now,
  // because the wording has to carry the name he used and the names on file —
  // see the script-mismatch section below, which is what made this feature
  // look broken end to end.
  eq('he is told why', effects[0]?.kind, 'friend_unknown');
  const pendingLine = renderBaseline(effects, TZ);
  check(
    'and that a request she has not answered does not count',
    /לא אושרה|לא נחשבת/.test(pendingLine),
    `a pending row is not consent, and he needs to know that is the state: ${pendingLine}`,
  );
  rig.restore();
}

section('when two friends could be meant, it asks');
{
  const rig = createRig();
  await db.setAllowedChats(rig.env, [HER, '777']);
  for (const id of [HIM, HER, '777']) await db.getSettings(rig.env, id);
  await db.requestFriend(rig.env, HIM, HER, 'דנה כהן');
  await db.acceptFriend(rig.env, HER, HIM, 'שחר');
  await db.requestFriend(rig.env, HIM, '777', 'דנה לוי');
  await db.acceptFriend(rig.env, '777', HIM, 'שחר');

  const friends = await db.friendsOf(rig.env, HIM);
  eq('both are friends', friends.length, 2);
  // Marking the wrong errand is a claim he did something he did not; sending a
  // reminder to the wrong person is a message in the wrong chat. Same answer.
  eq('and "דנה" names neither of them', db.matchFriend(friends, 'דנה'), null);
  eq('while a full name still resolves', db.matchFriend(friends, 'דנה לוי')?.friend_chat_id, '777');
  rig.restore();
}

section('when it fires, she is told who set it');
{
  const rig = createRig();
  await befriended(rig, 'דנה', 'שחר');
  const at = wallToUtc(2026, 8, 15, 18, 0, TZ);
  await db.addReminder(rig.env, {
    chat_id: HER, title: 'לקנות חלב', notes: null,
    schedule: JSON.stringify({ type: 'once', at: '2026-08-15T18:00' }),
    tz: TZ, requires_proof: 0, proof_type: 'any',
    nag_interval_min: 20, max_nags: 3, next_fire_at: at, event_at: null,
    from_chat_id: HIM,
  });

  // The persona call is failed on purpose so the deterministic baseline is
  // what she receives: this test is about what voice.ts says, and a rewrite
  // would be asserting on the rig's queue instead.
  rig.speakQueue.push(new Error('test: no persona this turn'));
  await withNow(at, () => runCron(rig));

  const hers = rig.sent.filter((s) => s.chat_id === HER).map((s) => s.text ?? '');
  check('it reached her', hers.some((t) => t.includes('לקנות חלב')), `sent: ${JSON.stringify(hers)}`);
  // "נו? לקנות חלב." from nobody is a reminder she never set and cannot place.
  // The name is the difference between a reminder and a wrong number.
  check(
    'and it says who it is from',
    hers.some((t) => t.includes('שחר')),
    `sent: ${JSON.stringify(hers)}`,
  );
  check('and did not go to him', !rig.sent.some((s) => s.chat_id === HIM), 'it fired into the wrong chat');
  rig.restore();
}

section('"תזכיר לדנה" is not a reminder for himself');
{
  // quickparse answers the common phrasings without a model call, and every
  // one of them assumes the reminder is HIS. "תזכיר ל" + a name it has never
  // heard of is exactly the confident wrong answer rule 2 of that file exists
  // to refuse: the router is the only thing that knows who דנה is.
  const now = wallToUtc(2026, 8, 15, 9, 0, TZ);
  const mine = quickParse('תזכיר לי לקנות חלב ב-18:00', now, TZ);
  eq('his own still fast-paths', mine?.action, 'create_reminder');

  const hers = quickParse('תזכיר לדנה לקנות חלב ב-18:00', now, TZ, ['דנה']);
  eq('hers goes to the router', hers, null);

  // And the guard is about the friend, not about the letter ל: a task whose
  // SUBJECT starts with ל must still fast-path, or every "תזכיר לי לקנות"
  // in the file starts costing a model call.
  const infinitive = quickParse('תזכיר לי ללכת לדואר ב-18:00', now, TZ, ['דנה']);
  eq('an infinitive is not a name', infinitive?.action, 'create_reminder');
}

section('the router is told who his friends are');
{
  const rig = createRig();
  await befriended(rig);
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await runWebhook(rig, 'מה נשמע');

  const system = rig.geminiCalls.find((c) => c.kind === 'router')?.system ?? '';
  // Checked as the QUOTED entry friendsSummary renders, not as a bare "דנה".
  // The prompt's own rule spells out the example "תזכיר לדנה לקנות חלב", so a
  // substring check on the name alone passes with the context block deleted
  // entirely — which is precisely how a test gets counted as coverage while
  // guarding nothing.
  check(
    'the friend is named in the prompt',
    system.includes('"דנה"'),
    'the router cannot route to a name it has never been shown',
  );
  check('and the field is documented', system.includes('for_friend'), `prompt: ${system.slice(0, 200)}`);
  rig.restore();
}

section('the model may say it set one for her — and only when it did');
{
  const ctx = factsCtx();
  const at = wallToUtc(2026, 8, 15, 18, 0, TZ);
  const effects: Effect[] = [
    { kind: 'friend_reminder_created', id: 4, title: 'לקנות חלב', at, friend: 'דנה', to: HER, schedule: { type: 'once', at: '2026-08-15T18:00' }, requiresProof: false },
  ];
  const facts = buildFacts(ctx, effects, TZ);
  const baseline = renderBaseline(effects, TZ);

  check('the baseline names her', baseline.includes('דנה'), `got: ${baseline}`);
  // The whole pipeline in one assertion: voice.ts writes it, and validate.ts
  // must not then throw away its own baseline for saying her name.
  eq('and passes its own validator', validate(baseline, facts, baseline).ok, true);
  eq(
    'a rewrite may name her too',
    validate('קבעתי לדנה: "לקנות חלב" ב-18:00.', facts, baseline).ok,
    true,
  );

  // ...but not when nothing was written for anybody.
  const nothing: Effect[] = [{ kind: 'nothing', why: 'chat', userText: 'מה נשמע' }];
  const bare = buildFacts(ctx, nothing, TZ);
  eq(
    'and may not claim it out of nowhere',
    validate('קבעתי לדנה תזכורת.', bare, renderBaseline(nothing, TZ)).ok,
    false,
  );
}

section('a friendship can be ended, from either side');
{
  const rig = createRig();
  await befriended(rig);
  eq('friends to start with', (await db.friendsOf(rig.env, HIM)).length, 1);

  const out = (await handleSlash(rig.env, HER, '/unfriend שחר')) ?? '';
  check('she is told', out.length > 0, `got: ${out}`);
  eq('he is gone from her book', (await db.friendsOf(rig.env, HER)).length, 0);
  // Both directions. Leaving his edge behind leaves him able to write
  // reminders into a chat that has just removed him.
  eq('and she from his', (await db.friendsOf(rig.env, HIM)).length, 0);
  rig.restore();
}

section('the buttons survive a round trip');
{
  eq('accept', decode(encode({ t: 'facc', from: '12345' })), { t: 'facc', from: '12345' });
  eq('decline', decode(encode({ t: 'frej', from: '999' })), { t: 'frej', from: '999' });
  // A chat_id is digits. Anything else in that slot is a corrupted payload,
  // and acting on it would mean writing on the strength of a mangled string.
  eq('and a mangled one is refused', decode('facc:not-a-chat'), null);
}

// ---------------------------------------------------------------------------
section('a friend named in a script the address book does not use');

/**
 * The bug that made this feature look broken end to end.
 *
 * The reverse edge created at acceptance is named after the requester's
 * TELEGRAM PROFILE name (db.acceptFriend) — whatever script that person set. In
 * production it was "amnon". He speaks Hebrew and types "תזכיר לאמנון".
 * matchFriend lowercases and compares, and no amount of lowercasing bridges
 * Latin and Hebrew, so the name never resolved.
 *
 * That alone was survivable. What made it SILENT was the router prompt: "if
 * the name is not in the list, do not set for_friend at all". The friend
 * intent was dropped, the reminder was written for HIM, and the bot confirmed
 * it — a true sentence about a write he never asked for. Production had 47
 * reminders and 0 cross-chat.
 *
 * The refusal itself is correct and must not change: guessing across scripts
 * puts a message in a stranger's chat, which he cannot see to correct.
 */
{
  const rig = createRig();
  await twoUsers(rig);
  // His book holds the Telegram-derived Latin name.
  await db.requestFriend(rig.env, HIM, HER, 'amnon');
  await db.acceptFriend(rig.env, HER, HIM, 'שחר');

  const friends = await db.friendsOf(rig.env, HIM);
  check('the book has him under the Latin name', friends.some((f) => f.nickname === 'amnon'), JSON.stringify(friends));
  eq('and the Hebrew spelling resolves to nobody', db.matchFriend(friends, 'אמנון'), null);

  const ctx: any = { ...factsCtx(), friends };
  const effects = await applyIntent(
    rig.env, HIM, ctx,
    { action: 'create_reminder', title: 'להגיד לי שהפיצר עובד', for_friend: 'אמנון',
      schedule_type: 'once', in_minutes: 2 } as any,
    'תזכיר לאמנון להגיד לי שהפיצר עובד עוד שתי דקות',
  );

  check(
    'it refuses rather than guessing which friend',
    !effects.some((e) => e.kind === 'friend_reminder_created'),
    `effects: ${effects.map((e) => e.kind).join(', ')}`,
  );
  check(
    'and it does NOT quietly file the reminder for himself',
    !effects.some((e) => e.kind === 'reminder_created' || e.kind === 'reminder_captured'),
    'a friend request silently becoming a self-reminder is how 47 reminders produced 0 cross-chat writes',
  );

  // The dead end has to be correctable in ONE message. "run /friends" is a
  // second action, and nothing ever told him the stored name was in Latin.
  const line = renderBaseline(effects, 'Asia/Jerusalem');
  check('it names the name he actually used', line.includes('אמנון'), line);
  check('and the name the book really holds', line.includes('amnon'), line);
  check(
    'and how to fix it in one command',
    line.includes('/friend'),
    `he cannot discover the script mismatch on his own: ${line}`,
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the router is told to report a name it does not recognise');

/**
 * The half that made the bug SILENT rather than merely broken.
 *
 * The rule used to read "if the name is not in the list, do not set for_friend
 * at all" — a safety rule with a wrong outcome: the friend intent vanished and
 * the reminder was written for HIM, confirmed cheerfully, with no error row
 * anywhere. Production: 47 reminders, 0 cross-chat.
 *
 * Asserted on the rendered instruction rather than on a name, because the
 * prompt's own worked examples contain friend names — a substring check on
 * "אמנון" would pass with the whole rule deleted.
 */
{
  const rig = createRig();
  await twoUsers(rig);
  await db.requestFriend(rig.env, HIM, HER, 'amnon');
  await db.acceptFriend(rig.env, HER, HIM, 'שחר');
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await runWebhook(rig, 'מה נשמע');

  const system = rig.geminiCalls.find((c) => c.kind === 'router')?.system ?? '';
  check(
    'it is told to report the name exactly as he wrote it',
    /בדיוק את השם שהוא כתב/.test(system),
    'without this the friend intent is dropped and silently becomes a reminder for himself',
  );
  check(
    'and told outright not to omit it for an unknown name',
    /אסור לך להשמיט for_friend/.test(system),
    `prompt tail: ${system.slice(-600)}`,
  );
  // The rule failed on 17.08.2026 not because it was missing but because it
  // CONTRADICTED its neighbours: "the exact name from the list" and "a reminder
  // in the wrong chat cannot be undone" sat on either side of it and won. The
  // model needs to know why reporting an unknown name is safe, or the warning
  // beats the instruction every time.
  check(
    'and told why that is safe — the code chooses, not the model',
    /אני מחפש את השם ברשימה בעצמי/.test(system),
    `prompt tail: ${system.slice(-600)}`,
  );
  check(
    'while the old contradicting demand is gone',
    !/השם המדויק מהרשימה/.test(system),
    '"only a name from the list" and "report any name" cannot both be in the prompt',
  );
  // The HARD guarantee, not the polite one.
  //
  // Asking the model to leave `why` alone is a request, and this codebase
  // already records prompt-only rules not holding (brain.ts asks it to preserve
  // "#28" with nothing behind it). responseSchema drives constrained decoding,
  // so a property that is absent from the schema CANNOT be emitted at all.
  //
  // Every one of the five route/apply failures on 15-17.08.2026 carried a long
  // `why` — including two plain reschedules with no friend in them. It was
  // never a friends bug; it was any turn where the model rambled into a field
  // that only create_goal has ever read.
  const props = rig.geminiCalls.find((c) => c.kind === 'router')?.schema
    ?.properties?.actions?.items?.properties ?? {};
  check(
    'the router schema cannot express `why` at all',
    !('why' in props),
    `still present, so the model may still fill it: ${Object.keys(props).join(', ')}`,
  );
  check(
    'and a goal keeps its reason, via note',
    'note' in props,
    Object.keys(props).join(', '),
  );
  rig.restore();
}

done();
