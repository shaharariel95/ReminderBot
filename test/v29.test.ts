/**
 * Run with `npm run test:v29`.
 *
 * The friends feature, and why fixing it six times did not fix it.
 *
 * Production, 07.09.2026, running 0.29.0 — with the address book CORRECT
 * (`friends` holds 5909964664 → 701531870 nicknamed "אמנון", accepted, both
 * edges present) and every previous fix in place:
 *
 *   19:21  him  תזכיר לאמנון עוד שתי דקות "לשלוח לשחר שעבד"
 *   19:22  bot  קבעתי #83: "לשלוח לשחר שעבדೊ" — פעם אחת ב-07.09 בשעה 19:23.
 *   19:23  bot  נו? לשלוח לשחר שעבדo.          ← rang in HIS chat
 *
 * `reminders` #83: `chat_id = 5909964664`, `from_chat_id = NULL`. `events`
 * #240: `נקבעה`. It was written to him, and he was told it was set, and the
 * only thing wrong with the sentence is who it was about.
 *
 * ROOT CAUSE, and it is not a new bug — it is the same bug the last six fixes
 * each addressed one downstream consequence of:
 *
 *   **The addressee is decided by the model, and by nothing else.**
 *
 * `applyIntent` routes to a friend if and only if `intent.for_friend` is set.
 * The router prompt spends five lines on that field, including the sentence
 * "אסור לך להשמיט for_friend... זה הכי גרוע" — the prompt names this exact
 * failure as the worst one available and there is no code behind it. This
 * repository's first rule is that a rule which matters lives in code.
 *
 * And the deterministic answer WAS ALREADY COMPUTED. `namesSomeoneElse`
 * returns true for that message (verified against the production text). It is
 * used to make quickparse bail, and then its answer is thrown away the moment
 * the router returns — so the one component that knew the message was
 * addressed to somebody else had no say in where the row went.
 *
 * That is precisely the shape `preferHisWords` fixed for TIME in 0.16.0: code
 * computed the right answer, the model's answer won anyway, and the fix was a
 * precedence flip rather than a better prompt. `friendFromHisWords` is the
 * same flip for the addressee — it FILLS a gap and never overrides, exactly
 * like `preferHisWords`, and it hands the name to `matchFriend`, which is
 * still the only thing allowed to decide whether a name resolves.
 *
 * Two things it deliberately does NOT do, both from CLAUDE.md:
 *   - it does not read the name from anywhere in the sentence. `namesSomeoneElse`
 *     over-refuses on purpose and returns true for "תזכיר לי לקנות מתנה לדנה",
 *     which is HIS errand. The name has to be in the addressee position.
 *   - it does not resolve near-misses. `matchFriend` is exact and returns null
 *     on a tie, because sending to the wrong friend is a message in a
 *     stranger's chat that he cannot see to correct.
 */
import worker from '../src/index';
import { friendFromHisWords, titleFromHisWords } from '../src/effects';
import { handleSlash } from '../src/slash';
import * as db from '../src/db';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const HIM = '12345';
const HER = '999';
const TZ = 'Asia/Jerusalem';

function seedFriend(rig: Rig, nickname = 'אמנון'): void {
  rig.db
    .prepare(
      `INSERT INTO friends (chat_id, friend_chat_id, nickname, status, requested_by, created_at)
       VALUES (?,?,?,'accepted',?,0)`,
    )
    .run(HIM, HER, nickname, HIM);
  rig.db
    .prepare(
      `INSERT INTO friends (chat_id, friend_chat_id, nickname, status, requested_by, created_at)
       VALUES (?,?,'שחר','accepted',?,0)`,
    )
    .run(HER, HIM, HIM);
}

function seedSettings(rig: Rig, chat: string): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(chat, TZ);
}

async function say(rig: Rig, text: string, at: number): Promise<void> {
  await withNow(at, async () => {
    const pending: Promise<unknown>[] = [];
    const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
    await worker.fetch(
      new Request('https://x/tg', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({ message: { chat: { id: Number(HIM) }, text, message_id: 11 } }),
      }),
      rig.env, ctx,
    );
    await Promise.all(pending);
  });
}

const NOW = Date.parse('2026-09-07T16:21:38Z');
const rows = (rig: Rig) =>
  rig.db.prepare('SELECT id, chat_id, title, from_chat_id FROM reminders').all() as any[];

// ===========================================================================
section('the router drops for_friend — the row still does not land on him');
//
// The exact production turn. The router is given a create_reminder with NO
// for_friend, which is what it actually returned.
{
  const rig = createRig({ tz: TZ });
  seedSettings(rig, HIM);
  seedSettings(rig, HER);
  seedFriend(rig);

  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', title: 'לשלוח לשחר שעבד', in_minutes: 2 }],
  });
  rig.speakQueue.push('סידרתי.');
  await say(rig, 'תזכיר לאמנון עוד שתי דקות "לשלוח לשחר שעבד"', NOW);

  const all = rows(rig);
  eq('exactly one row was written', all.length, 1);
  check(`and it is in HER chat, not his — ${JSON.stringify(all[0])}`,
    all[0]?.chat_id === HER, JSON.stringify(all));
  eq('stamped with the sender so she knows who set it', String(all[0]?.from_chat_id), HIM);
  check('the errand travelled, without the addressing',
    all[0]?.title?.includes('לשלוח'), JSON.stringify(all[0]));
}

// ---------------------------------------------------------------------------
section('...and without the ל, which is how he actually typed the second one');
//
// 19:23, the same evening: "תזכיר אמנון לשלוח הודעה ב19:25" became #84 in HIS
// chat, titled with the whole command. Neither existing gate sees this one —
// `namesSomeoneElse` requires a ל before the name and `addressesSomeoneElse`
// requires one after the verb — so quickparse did not even bail.
//
// Anchoring to the ADDRESS BOOK is what makes the bare form safe: only an
// exact nickname matches, so "תזכיר לקנות חלב" cannot trip it.
{
  const rig = createRig({ tz: TZ });
  seedSettings(rig, HIM);
  seedSettings(rig, HER);
  seedFriend(rig);

  // The title is the one production actually stored for #84: the whole
  // command, addressing included. titleFromHisWords allows it — every letter
  // is his and it does not grow — so what she would have been shown at 19:25
  // is an instruction aimed at somebody else.
  rig.routerQueue.push({
    actions: [
      { action: 'create_reminder', title: 'תזכיר אמנון לשלוח הודעה', once_at: '2026-09-07T19:25' },
    ],
  });
  rig.speakQueue.push('אוקיי.');
  await say(rig, 'תזכיר אמנון לשלוח הודעה ב19:25', NOW);

  const all = rows(rig);
  eq('one row', all.length, 1);
  check(`in her chat — ${JSON.stringify(all[0])}`, all[0]?.chat_id === HER, JSON.stringify(all));
  check(`and the addressing is not what she is shown — ${all[0]?.title}`,
    !String(all[0]?.title).includes('אמנון'), String(all[0]?.title));
  check('the errand survived it', String(all[0]?.title).includes('לשלוח הודעה'),
    String(all[0]?.title));
}

// ---------------------------------------------------------------------------
section('when the router DID name somebody, it wins — this only fills a gap');
//
// The `preferHisWords` exclusion, and the safer direction of the two. Naming
// the addressee is classification and that is the model's job; a router that
// names an unknown person reaches `friend_unknown` and REFUSES, whereas his
// words resolving to a known friend would write. So the model's answer is
// allowed to be the more conservative one.
{
  const rig = createRig({ tz: TZ });
  seedSettings(rig, HIM);
  seedSettings(rig, HER);
  seedFriend(rig);

  rig.routerQueue.push({
    actions: [
      { action: 'create_reminder', title: 'לקנות חלב', for_friend: 'רותי', in_minutes: 5 },
    ],
  });
  rig.speakQueue.push(new Error('persona down'));
  await say(rig, 'תזכיר לאמנון לקנות חלב', NOW);

  eq('the router named somebody unknown, so nothing was written', rows(rig).length, 0);
  const texts = rig.texts().join(' | ');
  check(`and his words did not quietly overrule it — ${texts}`,
    !texts.includes('קבעתי'), texts);
}

// ---------------------------------------------------------------------------
section('"תזכיר לי" is always his, even with her name later in the sentence');
//
// The reason this reads the ADDRESSEE POSITION and not the whole message.
// `namesSomeoneElse` returns TRUE for this text — it matches "לדנה" anywhere
// and is documented as over-refusing — so using it as the backstop would file
// his own errand in her chat, which is the failure this whole area exists to
// prevent, arrived at from the opposite direction.
{
  const rig = createRig({ tz: TZ });
  seedSettings(rig, HIM);
  seedSettings(rig, HER);
  seedFriend(rig, 'דנה');

  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', title: 'לקנות מתנה לדנה', in_minutes: 60 }],
  });
  rig.speakQueue.push('רשום.');
  await say(rig, 'תזכיר לי לקנות מתנה לדנה', NOW);

  const all = rows(rig);
  eq('one row', all.length, 1);
  check(`and it is HIS — ${JSON.stringify(all[0])}`, all[0]?.chat_id === HIM, JSON.stringify(all));
}

// ---------------------------------------------------------------------------
section('it FILLS a gap and never overrides — same rule as preferHisWords');
{
  const friends = [
    { chat_id: HIM, friend_chat_id: HER, nickname: 'אמנון', status: 'accepted' } as any,
  ];
  eq('the model said nothing, so his words are read',
    friendFromHisWords('תזכיר לאמנון לשלוח הודעה', friends), 'אמנון');
  eq('a message that names nobody in the book yields nothing',
    friendFromHisWords('תזכיר לי לקנות חלב', friends), null);
  eq('and an errand that merely starts with ל is not a person',
    friendFromHisWords('תזכיר לקנות חלב', friends), null);
}

// ---------------------------------------------------------------------------
section('a name the book does not hold is still a refusal, never a self-write');
//
// friendFromHisWords only ever produces a name that is already in the book, so
// this path is unchanged: the model names somebody unknown, matchFriend returns
// null, and friendReminder refuses. What must never happen is the refusal
// degrading into a row in his own chat.
{
  const rig = createRig({ tz: TZ });
  seedSettings(rig, HIM);
  seedFriend(rig);

  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', title: 'לקנות חלב', for_friend: 'רותי', in_minutes: 5 }],
  });
  // The persona is failed on purpose so the DETERMINISTIC baseline ships. A
  // stubbed rewrite would be asserting on the fixture: the first draft queued
  // "מי?" and the check passed or failed on that string rather than on what
  // voice.ts actually says about an unresolvable name.
  rig.speakQueue.push(new Error('persona down'));
  await say(rig, 'תזכיר לרותי לקנות חלב', NOW);

  eq('nothing was written anywhere', rows(rig).length, 0);
  const texts = rig.texts().join(' | ');
  check(`and he is told which names exist — ${texts}`, texts.includes('אמנון'), texts);
}

// ---------------------------------------------------------------------------
section('a script he never typed is stripped, whatever script it is');
//
// #83's stored title is "לשלוח לשחר שעבדೊ" — the last codepoint is U+0CCA,
// KANNADA VOWEL SIGN OO. CLAUDE.md claims "any SCRIPT absent from his message
// is stripped from a model-supplied title". The code only ever knew Latin:
//
//   if (!/[A-Za-z]/.test(userText) && /[A-Za-z]/.test(out)) ...
//
// so a Kannada vowel sign walked past it, past cutSelfRepeat and past the
// filler cut, and "extraction cannot grow" did not fire because the title is
// shorter than the message. It was then read back to him twice.
//
// The replacement is an ALLOW-list (Hebrew and Latin), not another block-list.
// A block-list of scripts has the same shape as FILLER_RUN's characters, and
// issues.md §3 already argued that class of guard does not converge.
{
  const his = 'תזכיר לאמנון עוד שתי דקות "לשלוח לשחר שעבד"';
  eq('the Kannada sign is gone',
    titleFromHisWords('לשלוח לשחר שעבדೊ', his), 'לשלוח לשחר שעבד');
  eq('and so is anything else he did not write in',
    titleFromHisWords('לשלוח מסמך κείμενο', his), 'לשלוח מסמך');
  eq('Hebrew he did not literally type still survives — rewording is allowed',
    titleFromHisWords('לשגר הודעה לשחר', his), 'לשגר הודעה לשחר');
  eq('Latin survives when he used Latin',
    titleFromHisWords('לפתוח pr', 'תזכיר לי לפתוח pr'), 'לפתוח pr');
  eq('and is still cut when he did not',
    titleFromHisWords('לשלוח note', his), 'לשלוח');
  // The exemption, and the reason this is not a blanket script filter: an
  // emoji he typed himself is HIS, and stripping it would be the
  // over-correction. Same shape as the conditional Latin cut above.
  eq('a character he typed himself survives, whatever script it is',
    titleFromHisWords('לשלוח לשחר 🐟', 'תזכיר לי לשלוח לשחר 🐟'), 'לשלוח לשחר 🐟');
  eq('but the same character invented by the model does not',
    titleFromHisWords('לשלוח לשחר 🐟', 'תזכיר לי לשלוח לשחר'), 'לשלוח לשחר');
}

// ---------------------------------------------------------------------------
section('/rename with one friend takes the new name directly');
//
// 19:22: `/rename אחי` answered "אין לי \"אחי\" ברשימה. יש: \"אמנון\"".
//
// With exactly ONE friend there is nothing to disambiguate — the comment above
// the handler says so — but the shortcut was only wired to the NO-argument
// form. One argument fell through to matchFriend, which read it as "which
// friend", found nothing, and refused. The repair for a name he could not type
// still required typing it, which is the same bug 0.29.0 was written to fix,
// surviving in the neighbouring branch.
{
  const rig = createRig({ tz: TZ });
  seedFriend(rig);
  const out = (await handleSlash(rig.env, HIM, '/rename אחי')) ?? '';
  check(`it renamed rather than refused — ${out}`, !out.includes('אין לי'), out);
  check('and says the new name', out.includes('אחי'), out);
  const f = await db.friendsOf(rig.env, HIM);
  eq('the edge really moved', f[0]?.nickname, 'אחי');
  rig.restore();
}

// ---------------------------------------------------------------------------
section('...but with two friends it still lists rather than guessing');
{
  const rig = createRig({ tz: TZ });
  seedFriend(rig);
  rig.db
    .prepare(
      `INSERT INTO friends (chat_id, friend_chat_id, nickname, status, requested_by, created_at)
       VALUES (?,?,'רותי','accepted',?,0)`,
    )
    .run(HIM, '777', HIM);
  const out = (await handleSlash(rig.env, HIM, '/rename אחי')) ?? '';
  check(`it refuses to pick — ${out}`, out.includes('אמנון') && out.includes('רותי'), out);
  const f = await db.friendsOf(rig.env, HIM);
  check('and nothing was renamed', f.every((x) => x.nickname !== 'אחי'),
    JSON.stringify(f.map((x) => x.nickname)));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('renaming the one friend by his current name still asks');
//
// `/rename אמנון` with one friend is genuinely ambiguous — "rename אמנון to
// what?" or "rename him to אמנון?" — so the existing question stays. The
// one-friend shortcut only fires when the word is NOT the name he already has.
{
  const rig = createRig({ tz: TZ });
  seedFriend(rig);
  const out = (await handleSlash(rig.env, HIM, '/rename אמנון')) ?? '';
  check(`it asks for the new name — ${out}`, out.includes('איך תקרא'), out);
  rig.restore();
}

done();
