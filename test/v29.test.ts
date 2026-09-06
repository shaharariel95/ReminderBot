/**
 * Run with `npm run test:v29`.
 *
 * The accepter gets to choose what he calls the person he just accepted.
 *
 * `db.matchFriend` is exact-match on purpose — guessing puts a message in a
 * stranger's chat, and that rule is not up for negotiation. But it means the
 * name in the book has to be a name the owner of that book would actually
 * type, and on the ACCEPTER's side it never was: `acceptFriend` writes the
 * reverse edge from `requester_name`, which is the requester's Telegram
 * profile string, or failing that the raw chat_id.
 *
 * Measured against a two-brother book:
 *
 *   book=[אחי]      typed "אחי"   → אחי    the requester's side: he chose it
 *   book=[Shahar]   typed "שחר"   → NULL   the accepter's side: he never did
 *   book=[bro]      typed "אחי"   → NULL
 *
 * So one direction of every friendship in this bot works and the other does
 * not, and the failure is silent in the way that matters: `friend_unknown`
 * is a polite refusal, so it reads as "this feature does not work" rather
 * than as "rename the row".
 *
 * And the documented repair was a catch-22. `/friend <name> <new>` resolves
 * <name> through matchFriend first, so renaming the name he cannot type
 * required typing it. `/friends` and a copy-paste was the only way through,
 * and nothing said so.
 *
 * The fix is the one this codebase reaches for everywhere else: ASK. The
 * accept is already a message in his chat, so it can carry the question, and
 * the answer goes through the awaiting slot that exists for exactly this.
 *
 * Note what is NOT changed. `acceptFriend` still writes the provisional name,
 * because an unanswered question must leave a working edge rather than a
 * blank one — the question refines it, it is not load-bearing. And
 * matchFriend still refuses to guess.
 */
import worker from '../src/index';
import { handleSlash } from '../src/slash';
import { encode } from '../src/buttons';
import * as db from '../src/db';
import { check, createRig, done, eq, section, type Rig } from './harness';

const HIM = '12345';
const HER = '999';

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

async function runWebhook(rig: Rig, text: string, chatId = HIM): Promise<void> {
  await post(rig, {
    message: { chat: { id: Number(chatId) }, from: { id: Number(chatId) }, text, message_id: 999 },
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

async function twoUsers(rig: Rig): Promise<void> {
  await db.setAllowedChats(rig.env, [HER]);
  await db.getSettings(rig.env, HIM);
  await db.getSettings(rig.env, HER);
}

const lastTo = (rig: Rig, chat: string) =>
  [...rig.sent].reverse().find((s) => s.chat_id === chat)?.text ?? '';

// ===========================================================================
section('accepting asks the accepter what to call him');
//
// HIM requests, under the Telegram profile name "Shahar". HER accepts. Before
// this, HER's book silently held "Shahar" and she was done — with a name she
// would never type.
{
  const rig = createRig();
  await twoUsers(rig);
  await handleSlash(rig.env, HIM, `/friend ${HER} דנה`, 'Shahar');
  await runCallback(rig, encode({ t: 'facc', from: HIM }), HER);

  check(
    'she is asked what to call him',
    /איך תקרא לו|איך לקרוא לו/.test(lastTo(rig, HER)),
    `she got: ${lastTo(rig, HER)}`,
  );

  const slot = db.readAwaiting((await db.getSettings(rig.env, HER)).awaiting);
  eq('and the question is recorded', slot?.k, 'fname');

  // The provisional name still lands, so an unanswered question leaves a
  // usable edge rather than a blank one.
  eq(
    'the edge exists meanwhile, under the provisional name',
    (await db.friendEdge(rig.env, HER, HIM))?.nickname,
    'Shahar',
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('her answer is the name, and it is the name that resolves');
{
  const rig = createRig();
  await twoUsers(rig);
  await handleSlash(rig.env, HIM, `/friend ${HER} דנה`, 'Shahar');
  await runCallback(rig, encode({ t: 'facc', from: HIM }), HER);

  // Assert the slot is OPEN first. Without this, "the slot is cleared" below
  // passes on a slot that was never set — vacuity mode 7, and it did exactly
  // that on the first run of this file.
  eq(
    'the slot is open before she answers',
    db.readAwaiting((await db.getSettings(rig.env, HER)).awaiting)?.k,
    'fname',
  );

  await runWebhook(rig, 'אחי', HER);

  eq(
    'the edge is renamed to what she typed',
    (await db.friendEdge(rig.env, HER, HIM))?.nickname,
    'אחי',
  );
  // The whole point: this is the lookup that used to return null.
  check(
    'and that name now resolves',
    db.matchFriend(await db.friendsOf(rig.env, HER), 'אחי')?.friend_chat_id === HIM,
    'matchFriend still cannot find him',
  );
  eq(
    'the slot is cleared',
    db.readAwaiting((await db.getSettings(rig.env, HER)).awaiting),
    null,
  );
  // No model call: the answer to the bot's own question is applied by code,
  // exactly as `time` and `title` are.
  eq('and it cost no router call', rig.geminiCalls.filter((c) => c.kind === 'router').length, 0);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('an open naming question does not eat a real request');
//
// The same guard `title` uses, and for the same reason: if she opens a new
// request instead of answering, taking it as a nickname loses the request AND
// writes a nonsense name. asksForNewReminder is the one gate that decides
// this, in both places.
{
  const rig = createRig();
  await twoUsers(rig);
  await handleSlash(rig.env, HIM, `/friend ${HER} דנה`, 'Shahar');
  await runCallback(rig, encode({ t: 'facc', from: HIM }), HER);

  // It has to reach the router, which is the proof it was not eaten here.
  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', title: 'לקנות חלב', schedule_type: 'once', time: '09:00' }],
  });
  rig.speakQueue.push('רשמתי.');
  await runWebhook(rig, 'תזכיר לי מחר לקנות חלב', HER);

  eq(
    'the provisional name is untouched',
    (await db.friendEdge(rig.env, HER, HIM))?.nickname,
    'Shahar',
  );
  check(
    'and a reminder was actually taken',
    (await db.listReminders(rig.env, HER)).length + (await db.listInbox(rig.env, HER)).length > 0,
    'the request was swallowed as a nickname',
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('/rename repairs a friendship that is already misnamed');
//
// The edges that exist today were named before any of this, so the fix has to
// reach them too. With ONE friend there is nothing to disambiguate, so it asks
// the same question rather than inventing a selection UI.
{
  const rig = createRig();
  await twoUsers(rig);
  await db.requestFriend(rig.env, HIM, HER, 'דנה');
  await db.acceptFriend(rig.env, HER, HIM, 'Shahar');

  const said = (await handleSlash(rig.env, HER, '/rename', 'Dana')) ?? '';
  check('it asks', /איך תקרא לו|איך לקרוא לו/.test(said), `got: ${said}`);
  eq(
    'and records the question',
    db.readAwaiting((await db.getSettings(rig.env, HER)).awaiting)?.k,
    'fname',
  );

  await runWebhook(rig, 'אחי', HER);
  eq(
    'her answer renames it',
    (await db.friendEdge(rig.env, HER, HIM))?.nickname,
    'אחי',
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('with more than one friend it lists them instead of guessing');
//
// matchFriend returns null on a tie and this must not be the one place that
// breaks that rule: picking for her is a message in the wrong chat.
{
  const rig = createRig();
  await db.setAllowedChats(rig.env, [HER, '777']);
  await db.getSettings(rig.env, HIM);
  await db.getSettings(rig.env, HER);
  await db.getSettings(rig.env, '777');
  await db.requestFriend(rig.env, HIM, HER, 'דנה');
  await db.acceptFriend(rig.env, HER, HIM, 'Shahar');
  await db.requestFriend(rig.env, '777', HER, 'דנה');
  await db.acceptFriend(rig.env, HER, '777', 'Amnon');

  const said = (await handleSlash(rig.env, HER, '/rename', 'Dana')) ?? '';
  check('both names are shown', /Shahar/.test(said) && /Amnon/.test(said), `got: ${said}`);
  eq(
    'and nothing is asked, because there is nothing to answer',
    db.readAwaiting((await db.getSettings(rig.env, HER)).awaiting),
    null,
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the slot validates like every other arm');
//
// readAwaiting is exhaustive with a `never` default precisely so a new arm
// cannot be written and read back as null forever. A malformed one must still
// be refused rather than trusted.
{
  const now = Date.now();
  eq(
    'a good one reads back',
    db.readAwaiting(JSON.stringify({ k: 'fname', c: HIM, at: now }), now)?.k,
    'fname',
  );
  eq(
    'one with no chat id is refused',
    db.readAwaiting(JSON.stringify({ k: 'fname', at: now }), now),
    null,
  );
  eq(
    'and a stale one is gone',
    db.readAwaiting(JSON.stringify({ k: 'fname', c: HIM, at: now - 31 * 60_000 }), now),
    null,
  );
}

done();
