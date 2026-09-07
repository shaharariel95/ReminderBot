/**
 * Run with `npm run test:v31`.
 *
 * The seventh friends fix, and the first one aimed at why there were six.
 *
 * Production, 07.09.2026 17:26, running 0.30.0 — with the address book correct
 * AND the 0.30.0 addressee flip in place:
 *
 *   17:26:15  him  תזכיר לאמנון עוד שתי דקות לשלוח לשחר הודעה שעבד
 *   17:26:23  bot  מתי?
 *   17:26:29  him  עוד שתי דקות
 *   17:26:40  bot  קבעתי #85 ... 20:28          ← in HIS chat
 *
 * `readWhen` returns {kind:'duration',minutes:2} for that first sentence. The
 * time was four words in. The bot asked for it anyway, and then wrote the
 * answer to the wrong person.
 *
 * ROOT CAUSE, and it is not the addressee this time:
 *
 *   **`friendReminder` is a SECOND create path, and it has missed every rule
 *   the first one follows.**
 *
 * Three of this repository's own written rules, all violated in that one
 * function, each producing one symptom of "friends does not work":
 *
 *   1. "One question, one implementation." The self path resolves time with
 *      `readWhen` + `preferHisWords` — the 0.16.0 precedence flip, his words
 *      beating the model's arithmetic. friendReminder used
 *      `scheduleFromIntent(intent)` alone: pre-0.16.0 behaviour, in a branch
 *      the flip never reached. That is `findNamedTime` wired into one path of
 *      two, for the third time in this repository.  → the "מתי?"
 *   2. "A question written into renderBaseline needs its `questionAsked` arm
 *      in the same edit, or the bot asks and records nothing and his answer
 *      becomes a new reminder." friendReminder answered a missing hour with
 *      `nothing: 'no_time'`, which has no arm.  → #85 in his own chat
 *   3. "The model classifies; code computes." The addressee came from a model
 *      field and nothing else.  → fixed in 0.30.0, and it made 1 and 2 visible
 *      rather than fixing them.
 *
 * So the fix is not another detector. It is: the friend path uses the SAME
 * time resolver, and the question it asks CARRIES the request. The last
 * section here is the guard that matters — it runs one message down both
 * paths and asserts they agree, so the next fix to one of them cannot silently
 * skip the other.
 */
import worker from '../src/index';
import * as db from '../src/db';
import { questionAsked } from '../src/voice';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const HIM = '12345';
const HER = '999';
const TZ = 'Asia/Jerusalem';
const NOW = Date.parse('2026-09-07T17:26:15Z');

function seed(rig: Rig): void {
  for (const c of [HIM, HER]) {
    rig.db
      .prepare(
        `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
          quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
          last_brief_on, last_closeout_on)
         VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(c, TZ);
  }
  rig.db
    .prepare(
      `INSERT INTO friends (chat_id, friend_chat_id, nickname, status, requested_by, created_at)
       VALUES (?,?,'אמנון','accepted',?,0)`,
    )
    .run(HIM, HER, HIM);
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
        body: JSON.stringify({ message: { chat: { id: Number(HIM) }, text, message_id: 21 } }),
      }),
      rig.env, ctx,
    );
    await Promise.all(pending);
  });
}

const rows = (rig: Rig) =>
  rig.db
    .prepare('SELECT id, chat_id, title, next_fire_at, from_chat_id FROM reminders ORDER BY id')
    .all() as any[];

// ===========================================================================
section('the exact turn: the hour was in the sentence, so nothing is asked');
//
// The router returns for_friend and NO time field — which is what it did, and
// which used to be fatal on this path alone.
{
  const rig = createRig({ tz: TZ });
  seed(rig);
  rig.routerQueue.push({
    actions: [
      { action: 'create_reminder', for_friend: 'אמנון', title: 'לשלוח לשחר הודעה שעבד' },
    ],
  });
  rig.speakQueue.push('סגור.');
  await say(rig, 'תזכיר לאמנון עוד שתי דקות לשלוח לשחר הודעה שעבד', NOW);

  const all = rows(rig);
  eq('one row, written straight away', all.length, 1);
  check(`in HER chat — ${JSON.stringify(all[0])}`, all[0]?.chat_id === HER, JSON.stringify(all));
  // Truncated to the minute by computeNext, which is why this is not a bare
  // NOW + 2min: he asked at 17:26:15 and the ring is 17:28:00, not 17:28:15.
  eq('two minutes out, read from his own words',
    all[0]?.next_fire_at, Math.floor((NOW + 2 * 60_000) / 60_000) * 60_000);
  const texts = rig.texts().join(' | ');
  check(`and he was not asked for what he had given — ${texts}`,
    !texts.includes('מתי'), texts);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('when there really is no hour, the question CARRIES the request');
//
// Rule 2. The old `nothing: 'no_time'` armed no slot, so his answer arrived at
// the router as a fresh sentence with no name in it.
{
  const rig = createRig({ tz: TZ });
  seed(rig);
  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', for_friend: 'אמנון', title: 'לשלוח הודעה' }],
  });
  rig.speakQueue.push('מתי?');
  await say(rig, 'תזכיר לאמנון לשלוח הודעה', NOW);

  eq('nothing was written yet', rows(rig).length, 0);
  const slot = db.readAwaiting(
    (rig.db.prepare('SELECT awaiting FROM settings WHERE chat_id = ?').get(HIM) as any)?.awaiting,
    NOW + 1000,
  );
  check(`the slot holds the request — ${JSON.stringify(slot)}`, slot?.k === 'forwhom', JSON.stringify(slot));
  eq('with the addressee', (slot as any)?.c, HER);
  eq('and the errand', (slot as any)?.t, 'לשלוח הודעה');

  // His answer. No name in it — which is the entire point.
  rig.speakQueue.push('סגור.');
  await say(rig, 'עוד שתי דקות', NOW + 14_000);

  const all = rows(rig);
  eq('now one row', all.length, 1);
  check(`and it is HERS, not his — ${JSON.stringify(all[0])}`,
    all[0]?.chat_id === HER, JSON.stringify(all));
  eq('the errand came from the slot, not from his answer', all[0]?.title, 'לשלוח הודעה');
  check('and no model call was needed to work that out',
    rig.geminiCalls.filter((c) => c.kind === 'router').length === 1,
    String(rig.geminiCalls.filter((c) => c.kind === 'router').length));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('an answer that is not an hour is not swallowed by the slot');
//
// "לאמנון" typed at the same question is not a time. It must reach the router
// rather than being read as an answer — otherwise the slot eats every message
// until it expires.
{
  const rig = createRig({ tz: TZ });
  seed(rig);
  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', for_friend: 'אמנון', title: 'לשלוח הודעה' }],
  });
  rig.speakQueue.push('מתי?');
  await say(rig, 'תזכיר לאמנון לשלוח הודעה', NOW);

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await say(rig, 'לאמנון', NOW + 10_000);

  eq('still nothing written', rows(rig).length, 0);
  eq('and the router was asked', rig.geminiCalls.filter((c) => c.kind === 'router').length, 2);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the question has a questionAsked arm at all');
//
// Rule 2, asserted directly rather than through a turn. This is the check that
// would have caught the original bug in review: `nothing: 'no_time'` returns
// null here, and a question that records nothing is the documented way an
// answer becomes a new reminder.
{
  const arm = questionAsked({
    kind: 'friend_needs_time', friend: 'אמנון', to: HER, title: 'לשלוח הודעה',
  } as any);
  check(`friend_needs_time arms a slot — ${JSON.stringify(arm)}`, arm !== null, JSON.stringify(arm));
  eq('of the kind that carries both halves', (arm as any)?.k, 'forwhom');
}

// ---------------------------------------------------------------------------
section('a half-filled slot is forgotten, not half-acted-on');
//
// Nothing writes one today, so no turn can exercise this — it is read back
// from a row written by a future version, or a corrupted one. Asserted
// directly, because the alternative is a slot naming a chat with no errand,
// which would put an untitled row in somebody else's account.
{
  const now = 1_000_000;
  const ok = JSON.stringify({ k: 'forwhom', c: HER, t: 'לקנות חלב', at: now });
  check('a complete slot survives', db.readAwaiting(ok, now + 1000)?.k === 'forwhom', ok);
  for (const [label, raw] of [
    ['no errand', JSON.stringify({ k: 'forwhom', c: HER, at: now })],
    ['empty errand', JSON.stringify({ k: 'forwhom', c: HER, t: '', at: now })],
    ['no chat', JSON.stringify({ k: 'forwhom', t: 'לקנות חלב', at: now })],
    ['empty chat', JSON.stringify({ k: 'forwhom', c: '', t: 'לקנות חלב', at: now })],
  ] as const) {
    eq(`${label} is dropped`, db.readAwaiting(raw, now + 1000), null);
  }
}

// ---------------------------------------------------------------------------
section('THE GUARD: the two create paths resolve time identically');
//
// This is the only test here aimed at the NEXT bug rather than this one.
//
// Every friends failure in this sequence has been the same shape: a fix landed
// on the self path and the friend path kept its own older copy. A test that
// asserts "friends works" cannot catch that — it passes right up until someone
// improves the self path. So this one runs the SAME sentence down BOTH paths
// and asserts they agree on the hour, which is what actually diverged.
//
// If it fails, the two paths have drifted again, and that is the finding —
// whichever of them is now right.
{
  const phrasings: [string, string][] = [
    ['עוד שתי דקות לשלוח הודעה', 'two Hebrew number words'],
    ['עוד 40 דקות לשלוח הודעה', 'digits'],
    ['מחר ב-8 בבוקר לשלוח הודעה', 'an absolute hour tomorrow'],
    ['עוד שעה וחצי לשלוח הודעה', 'a fractional duration'],
  ];

  for (const [tail, label] of phrasings) {
    const mine = createRig({ tz: TZ });
    seed(mine);
    mine.routerQueue.push({ actions: [{ action: 'create_reminder', title: 'לשלוח הודעה' }] });
    mine.speakQueue.push('ok');
    await say(mine, `תזכיר לי ${tail}`, NOW);
    const a = rows(mine)[0];

    const hers = createRig({ tz: TZ });
    seed(hers);
    hers.routerQueue.push({
      actions: [{ action: 'create_reminder', for_friend: 'אמנון', title: 'לשלוח הודעה' }],
    });
    hers.speakQueue.push('ok');
    await say(hers, `תזכיר לאמנון ${tail}`, NOW);
    const b = rows(hers)[0];

    check(
      `${label}: both paths wrote a row — ${JSON.stringify([a?.chat_id, b?.chat_id])}`,
      a?.chat_id === HIM && b?.chat_id === HER,
      JSON.stringify([a, b]),
    );
    eq(`${label}: and agreed on the hour`, b?.next_fire_at, a?.next_fire_at);
    mine.restore();
    hers.restore();
  }
}

done();
