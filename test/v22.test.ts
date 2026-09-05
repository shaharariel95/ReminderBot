/**
 * Run with `npm run test:v22`.
 *
 * Production, 04.09.2026, reminder #78 "להזמין אוכל ללילה". Four bot messages
 * about one open task, and only three of them were nags:
 *
 *   13:59  him   תזכיר לי עוד שעה להזמין אוכל ללילה
 *   13:59  bot   קבעתי #78. ב-14:59 נדבר על "להזמין אוכל ללילה".
 *   14:59  bot   נו? להזמין אוכל ללילה.                              <- fired
 *   15:30  bot   נו? ... עדיין מחכה לך מ-14:59.                      <- nag 1
 *   17:31  bot   נו? ... פתוח כבר 152 דקות מ-14:59.                  <- nag 2
 *   21:00  bot   נו? ... פתוח כבר 361 דקות. כמה זמן לוקח לבחור המבורגר?
 *   22:07  him   עשיתי
 *
 * The 21:20 message is the EVENING CLOSE-OUT. closeout_hour is 21 and dailyDue
 * allows two hours of grace, and the persona rewrote a day summary into a nag.
 * Everything about the number is correct — 14:59:03 to 21:20:19 is 361 minutes,
 * and rule 4 rightly passed it. What is wrong is the register:
 *
 *   - the close-out's job is a tally, what is still open, and what is still
 *     AHEAD. It looks backwards over a day. This looked at one task and pushed.
 *   - it bypasses the nag ladder. NAG_BACKOFF_MIN is [30, 120, 360], so after
 *     the 17:31 nag the next was due at 23:31 — inside quiet hours, where it
 *     would have been held. He got the pressure anyway, two hours early,
 *     through a path with no ladder and no ceiling.
 *   - `nag_count` says 2. He received three.
 *
 * The fix is NOT to withhold the number. CLAUDE.md records that being tried on
 * 17.08.2026 and being worse: openSummary carries fired_at, so the model does
 * the subtraction anyway and does it badly. What changes is permission to
 * WEAPONISE it — exactly what the 'replying' stance already does for a turn
 * where he has just answered.
 */
import worker from '../src/index';
import { wallToUtc } from '../src/time';
import { check, createRig, done, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';
const FIRED = wallToUtc(2026, 9, 4, 14, 59, TZ);
// 21:00:43 in production — closeout_hour exactly, which is what makes the
// 361 below the true span from 14:59:03.
const CLOSEOUT = wallToUtc(2026, 9, 4, 21, 0, TZ);

function seedSettings(rig: Rig, over: Record<string, unknown> = {}): void {
  const r = { brief_hour: null, closeout_hour: null, ...over } as any;
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, 23, 9, NULL, ?, ?, NULL, NULL)`,
    )
    .run(CHAT, TZ, r.brief_hour, r.closeout_hour);
}

/** An open instance that fired at 14:59, exactly like #78 at close-out time. */
function seedOpen(rig: Rig, title: string): number {
  const rem = Number(
    rig.db
      .prepare(
        `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
         VALUES (?, ?, ?, ?, NULL, 'done', 1, ?, NULL)`,
      )
      .run(CHAT, title, JSON.stringify({ type: 'once', at: '2026-09-04T14:59' }), TZ, FIRED - 3_600_000)
      .lastInsertRowid,
  );
  rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, due_at)
       VALUES (?, ?, ?, ?, ?, 2, 'open', ?)`,
    )
    .run(rem, CHAT, title, FIRED, CLOSEOUT + 8 * 3_600_000, FIRED);
  return rem;
}

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

async function say(rig: Rig, text: string, at: number): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await withNow(at, () =>
    worker.fetch(
      new Request('https://x/tg', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text, message_id: 9 } }),
      }),
      rig.env,
      ctx,
    ),
  );
  await Promise.all(pending);
}

/** The systemInstruction of the last persona call. */
const lastSpeak = (rig: Rig) =>
  rig.geminiCalls.filter((c) => c.kind === 'speak').pop()?.system ?? '';

/** Just the elapsed block, so an assertion cannot match some other paragraph. */
function elapsedBlock(system: string): string {
  const from = system.indexOf('כמה זמן זה כבר פתוח');
  if (from < 0) return '';
  const rest = system.slice(from);
  const to = rest.indexOf('\n\n##');
  return to < 0 ? rest : rest.slice(0, to);
}

// ===========================================================================
section('the close-out is a summary, and is told so');
{
  const rig = createRig();
  seedSettings(rig, { closeout_hour: 21 });
  seedOpen(rig, 'להזמין אוכל ללילה');

  rig.speakQueue.push('סיכום.');
  await withNow(CLOSEOUT, () => runCron(rig));

  const block = elapsedBlock(lastSpeak(rig));
  check(`the elapsed block is still there — ${JSON.stringify(block)}`, block.length > 0);
  check(
    'the number is NOT withheld — that was tried on 17.08.2026 and is worse',
    /361 דקות/.test(block),
    block,
  );
  check(
    'and the turn is told it is a summary rather than a nag',
    /סיכום/.test(block),
    block,
  );
  check(
    'not the reply note, which would claim he had just answered',
    !/ענה לך עכשיו/.test(block),
    block,
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the morning brief is a summary too');
//
// Same shape, other end of the day: something open overnight gives the brief
// the identical elapsed number and the identical temptation.
{
  const rig = createRig();
  seedSettings(rig, { brief_hour: 9 });
  const rem = seedOpen(rig, 'להזמין אוכל ללילה');
  // Push the nag clock past the brief. Without this the tick nags FIRST, and
  // 0.18.0's `!chasing` guard then correctly holds the brief back — so the
  // message this section inspected was the nag, and the assertion was about
  // the wrong turn entirely.
  rig.db.prepare('UPDATE instances SET next_nag_at = ? WHERE reminder_id = ?')
    .run(wallToUtc(2026, 9, 6, 12, 0, TZ), rem);

  rig.speakQueue.push('בוקר.');
  await withNow(wallToUtc(2026, 9, 5, 9, 30, TZ), () => runCron(rig));

  const block = elapsedBlock(lastSpeak(rig));
  check(`the brief is told the same thing — ${JSON.stringify(block)}`,
    block.length > 0 && /סיכום/.test(block), block);
  rig.restore();
}

// ===========================================================================
section('a NAG is still allowed to chase — that is what it is for');
//
// The guard must not blunt the ladder. The whole reason the elapsed block
// exists is so a nag can state a true number instead of guessing one.
{
  const rig = createRig();
  seedSettings(rig);
  const rem = seedOpen(rig, 'להזמין אוכל ללילה');
  // Due for its next nag right now.
  rig.db.prepare('UPDATE instances SET next_nag_at = ? WHERE reminder_id = ?')
    .run(FIRED + 60_000, rem);

  rig.speakQueue.push('נו?');
  await withNow(FIRED + 152 * 60_000, () => runCron(rig));

  const block = elapsedBlock(lastSpeak(rig));
  check(`the nag still gets the number — ${JSON.stringify(block)}`,
    /152 דקות/.test(block), block);
  check('and is NOT told to hold back', !/סיכום/.test(block), block);
  check('nor told he just answered', !/ענה לך עכשיו/.test(block), block);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('and a reply still gets the reply note, not the summary one');
//
// Three stances, three different things to say about the same number. Sharing
// a sentence between any two of them puts a false claim in the prompt — which
// is exactly what "הוא ישן אז" did for the granted-minutes discount in 0.18.0.
{
  const rig = createRig();
  seedSettings(rig);
  seedOpen(rig, 'להזמין אוכל ללילה');

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('אוקיי.');
  await say(rig, 'מה קורה', FIRED + 152 * 60_000);

  const block = elapsedBlock(lastSpeak(rig));
  check(`the reply note is the one shown — ${JSON.stringify(block)}`,
    /ענה לך עכשיו/.test(block), block);
  check('and not the summary note', !/סיכום/.test(block), block);
  rig.restore();
}

done();
