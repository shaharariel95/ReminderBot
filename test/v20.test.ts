/**
 * Run with `npm run test:v20`.
 *
 * issues.md §8. `patterns.ts` is a whole file — a mode calculation, a cooldown,
 * three effect kinds, button wiring and its own test suite — and in a month of
 * production use it has produced **nothing**:
 *
 *   55 instances across 46 reminders            1.2 fires per reminder
 *   reminders that ever reached 3+ fires:  2    #63 (5, all done), #69 (3, all skipped)
 *   'הצעתי שינוי' events, all time:        0
 *
 * That is the same shape as the goal check-in bug 0.19.0 closed: a feature
 * switched off silently, with nothing anywhere able to say so. Four causes,
 * three of them fixable without guessing:
 *
 *   1. `behaviourOf` does not count `דילג` AT ALL. Only `ויתרתי` counts as a
 *      failure, so #69 — three fires, never once closed, declined every time —
 *      reads as no evidence whatsoever.
 *   2. `patternFor` is never CALLED on a skip. It hangs off snooze and give-up,
 *      so the clearest "this reminder is not working" signal in the product
 *      never asks the question.
 *   3. MIN_SAMPLE gates `failing`, and it should not. Four is the right floor
 *      for a HABIT claim ("you always push this") and the wrong one for a
 *      count ("you have never once done this"), which FAILURE_FLOOR already
 *      governs. As it stood, abandoned 3 out of 3 was invisible while
 *      abandoned 3 out of 4 was not — and the first is worse.
 *   4. errand identity. Deliberately NOT fixed here — see the last section.
 */
import worker from '../src/index';
import * as db from '../src/db';
import { detectPattern, MIN_SAMPLE, type Behaviour } from '../src/patterns';
import { wallToUtc } from '../src/time';
import { callbackUpdate, check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';
const DAY = 86_400_000;
const NOW = wallToUtc(2026, 9, 4, 9, 0, TZ);

const behaviour = (over: Partial<Behaviour> = {}): Behaviour => ({
  fires: 0, snoozes: 0, dones: 0, failures: 0, skips: 0, doneHours: [], ...over,
});

function seedSettings(rig: Rig): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(CHAT, TZ);
}

async function post(rig: Rig, update: unknown): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.fetch(
    new Request('https://x/tg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify(update),
    }),
    rig.env,
    ctx,
  );
  await Promise.all(pending);
}
const tap = (rig: Rig, data: string) => post(rig, callbackUpdate(CHAT, data));
const lastReply = (rig: Rig) => rig.texts()[rig.texts().length - 1] ?? '';

// ===========================================================================
section('§1 — a skip is evidence, and behaviourOf was throwing it away');
//
// #69 in production: three fires, zero completions, declined every time. The
// tally read `failures: 0`, because only `ויתרתי` (the ladder running out)
// counted. The one thing he did say — "not this" — was the thing not counted.
{
  const rig = createRig();
  seedSettings(rig);
  const ev = (kind: string, at: number) =>
    rig.db
      .prepare('INSERT INTO events (chat_id, reminder_id, instance_id, kind, detail, at) VALUES (?,?,NULL,?,?,?)')
      .run(CHAT, 7, kind, 'לנקות את הפילטרים', at);

  for (let i = 0; i < 3; i++) {
    ev('צלצלה', NOW - (3 - i) * DAY);
    ev('דילג', NOW - (3 - i) * DAY + 3_600_000);
  }

  const b = await db.behaviourOf(rig.env, CHAT, 7, TZ, NOW - 45 * DAY);
  eq('three fires', b.fires, 3);
  eq('and three skips, counted', b.skips, 3);
  eq('none of them a completion', b.dones, 0);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§3 — "you have never once done this" is a count, not a habit claim');
//
// MIN_SAMPLE is 4 because a HABIT announced off two data points is astrology.
// `failing` is not a habit claim: it is `dones === 0` plus a count of
// abandonments, and FAILURE_FLOOR already governs it. Gating it on MIN_SAMPLE
// as well made "abandoned 3 out of 3" invisible while "abandoned 3 out of 4"
// was not, which is exactly backwards.
{
  const p = detectPattern(behaviour({ fires: 3, skips: 3 }));
  check(
    `three fires, three skips, never closed — got ${p?.kind ?? 'null'}`,
    p?.kind === 'failing',
    JSON.stringify(p),
  );

  const gaveUp = detectPattern(behaviour({ fires: 3, failures: 3 }));
  check('and the ladder running out three times counts the same',
    gaveUp?.kind === 'failing', JSON.stringify(gaveUp));

  const mixed = detectPattern(behaviour({ fires: 3, failures: 1, skips: 2 }));
  check('abandonments add up across both kinds',
    mixed?.kind === 'failing', JSON.stringify(mixed));
}

// ---------------------------------------------------------------------------
section('§3 — and the floors that remain are still floors');
{
  check('two abandonments is still a bad week, not a pattern',
    detectPattern(behaviour({ fires: 3, skips: 2 })) === null);
  check('one completion means it is not "never worked" — the failing arm stays shut',
    detectPattern(behaviour({ fires: 6, skips: 5, dones: 1, doneHours: [9] }))?.kind !== 'failing');
  // The habit claim keeps MIN_SAMPLE. This is the astrology guard and it is
  // the one threshold in the file that is about HIM rather than about a row.
  check(`a push habit still needs ${MIN_SAMPLE} pushes`,
    detectPattern(behaviour({ fires: 3, snoozes: 3, dones: 1, doneHours: [9] })) === null);
  /*
   * The case the MIN_SAMPLE-on-FIRES gate actually guards, and the reason it
   * is not redundant with the snoozes floor beside it: a SINGLE fire can be
   * snoozed four times over. `snoozes >= MIN_SAMPLE` is then satisfied and the
   * ratio is 4.0, so without the fires gate the bot announces "you always push
   * this" off one morning.
   *
   * Found by the red-proof rather than by writing it: deleting the gate left
   * this file green, because every other case here happened to have enough
   * fires. A guard whose removal changes nothing is either dead or untested,
   * and it was the second.
   */
  check('four pushes across ONE fire is one bad morning, not a habit',
    detectPattern(behaviour({ fires: 1, snoozes: 4 })) === null,
    JSON.stringify(detectPattern(behaviour({ fires: 1, snoozes: 4 }))));
  check('with the sample, the push habit is still raised',
    detectPattern(behaviour({ fires: 5, snoozes: 4, dones: 1, doneHours: [9] }))?.kind === 'pushed');
}

// ===========================================================================
section('§2 — declining it is when the question gets asked');
//
// patternFor hangs off snooze and give-up. Skipping — the plainest statement
// that a reminder is not working — never asked anything, so even a corrected
// behaviourOf would have gone unread on the one path that matters most.
{
  const rig = createRig();
  seedSettings(rig);
  const id = Number(
    rig.db
      .prepare(
        `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
         VALUES (?, 'לנקות את הפילטרים', ?, ?, NULL, 'done', 1, ?, NULL)`,
      )
      .run(CHAT, JSON.stringify({ type: 'once', at: '2026-09-04T08:00' }), TZ, NOW - 5 * DAY)
      .lastInsertRowid,
  );
  const ev = (kind: string, at: number) =>
    rig.db
      .prepare('INSERT INTO events (chat_id, reminder_id, instance_id, kind, detail, at) VALUES (?,?,NULL,?,?,?)')
      .run(CHAT, id, kind, 'לנקות את הפילטרים', at);
  // Two fires already declined, plus the one he is about to decline now.
  for (let i = 0; i < 3; i++) ev('צלצלה', NOW - (3 - i) * DAY);
  for (let i = 0; i < 2; i++) ev('דילג', NOW - (3 - i) * DAY + 3_600_000);

  const inst = Number(
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, due_at)
         VALUES (?, ?, 'לנקות את הפילטרים', ?, NULL, 2, 'open', ?)`,
      )
      .run(id, CHAT, NOW - 3_600_000, NOW - 3_600_000).lastInsertRowid,
  );

  await withNow(NOW, () => tap(rig, `x:${inst}`));
  check(
    `the third decline raises the question — ${JSON.stringify(lastReply(rig))}`,
    /אף פעם|לא עבד|למחוק|להוריד|לא עבדה/.test(lastReply(rig)),
    lastReply(rig),
  );
  const offered = rig.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE reminder_id = ? AND kind = 'הצעתי שינוי'")
    .get(id) as any;
  eq('and the cooldown is recorded, so it is asked once', offered.n, 1);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§2 — and a reminder that is working is left alone');
//
// The guard that keeps this from becoming the noise it exists to reduce.
// #63 in production: five fires, five completions. Nothing to say.
{
  const rig = createRig();
  seedSettings(rig);
  const id = Number(
    rig.db
      .prepare(
        `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
         VALUES (?, 'לקחת תרופה', ?, ?, NULL, 'done', 1, ?, NULL)`,
      )
      .run(CHAT, JSON.stringify({ type: 'daily', time: '08:00' }), TZ, NOW - 9 * DAY)
      .lastInsertRowid,
  );
  const ev = (kind: string, at: number) =>
    rig.db
      .prepare('INSERT INTO events (chat_id, reminder_id, instance_id, kind, detail, at) VALUES (?,?,NULL,?,?,?)')
      .run(CHAT, id, kind, 'לקחת תרופה', at);
  for (let i = 0; i < 5; i++) {
    ev('צלצלה', NOW - (5 - i) * DAY);
    ev('נסגרה', NOW - (5 - i) * DAY + 600_000);
  }

  const inst = Number(
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, due_at)
         VALUES (?, ?, 'לקחת תרופה', ?, NULL, 0, 'open', ?)`,
      )
      .run(id, CHAT, NOW - 600_000, NOW - 600_000).lastInsertRowid,
  );

  await withNow(NOW, () => tap(rig, `x:${inst}`));
  const offered = rig.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE reminder_id = ? AND kind = 'הצעתי שינוי'")
    .get(id) as any;
  eq('one skip on something he closes every day says nothing', offered.n, 0);
  rig.restore();
}

// ===========================================================================
section('§4 — a feature that produces nothing has to be able to say so');
//
// This is the whole lesson of the goal backoff, one file over: patterns.ts had
// been inert for a month and no reader anywhere could have shown it. /diag
// already names blocked models for exactly this reason — a stale model id is
// otherwise invisible.
{
  const rig = createRig();
  seedSettings(rig);
  rig.db
    .prepare('INSERT INTO events (chat_id, reminder_id, instance_id, kind, detail, at) VALUES (?,?,NULL,?,?,?)')
    .run(CHAT, 7, 'הצעתי שינוי', 'לנקות את הפילטרים', NOW - 3_600_000);

  await withNow(NOW, () =>
    post(rig, { message: { chat: { id: Number(CHAT) }, text: '/diag', message_id: 1 } }),
  );
  const diag = rig.texts().join('\n');
  check(`/diag reports pattern activity — ${JSON.stringify(diag.slice(0, 400))}`,
    /דפוס|הצעות/.test(diag), diag);
  rig.restore();
}

// ===========================================================================
section('§8 — errand identity is deliberately NOT merged');
//
// #56 "לנקות פילטרים למזגנים" and #69 "לנקות את הפילטרים של המזגנים" are one
// errand under two ids, and merging them would give patterns.ts the sample it
// never gets from 1.2 fires per reminder. It is still the wrong trade.
//
// Every count this file produces is quoted back at him — "דחית את X 6 מתוך 7"
// — and the whole reason patterns.ts states counts rather than motives is that
// a count is CHECKABLE. A merged history is a count about a row he cannot open
// and verify, which is the one property that made counting safe. Over-merging
// is the same failure as matchFriend resolving a near-miss: it writes into a
// place its caller cannot see.
//
// So: two similar titles stay two histories, and neither reaches the floor.
// The honest fix is fewer duplicate rows, not fuzzier arithmetic over them.
{
  const a = detectPattern(behaviour({ fires: 2, skips: 2 }));
  const b = detectPattern(behaviour({ fires: 2, skips: 2 }));
  check('two halves of one errand stay below the floor separately',
    a === null && b === null, JSON.stringify([a, b]));
  check('and would have crossed it merged — which is exactly what is refused',
    detectPattern(behaviour({ fires: 4, skips: 4 }))?.kind === 'failing');
}

done();
