/**
 * Run with `npm run test:when`.
 *
 * Stage 1 of REFACTOR.md: the time seam. One resolver, one union, and refusal
 * as a VALUE rather than as an absence.
 *
 * issues.md §1 counted ten entry points in quickparse.ts that each answer some
 * version of "when did he mean", each deciding independently how to parse,
 * when to refuse, and what refusal means. `readWhen` is the one that decides,
 * and the arm that did not exist anywhere before is `unparsed`: **the parser
 * has to be able to say "there is something here I cannot read", which is a
 * different fact from "there is nothing here".**
 *
 * That distinction is the whole file. `findNamedTime` collapsed four refusals
 * and one silent misread into a single `null`, and the misread is what reached
 * production: "תעביר את 69 ל2.9 ב16:30" resolved to 01.09 — today — because
 * nothing in the pipeline could see the "2.9" at all.
 */
import worker from '../src/index';
import { readWhen, type TimeRef } from '../src/when';
import { wallToUtc, wallString } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const TZ = 'Asia/Jerusalem';
const CHAT = '12345';

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

function seedReminder(rig: Rig, title: string, dueAt: number, at: string): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?, NULL)`,
    )
    .run(CHAT, title, JSON.stringify({ type: 'once', at }), TZ, dueAt, dueAt);
  return Number(r.lastInsertRowid);
}

/** The wall-clock string a resolved instant lands on, for readable assertions. */
function at(ref: TimeRef): string {
  return ref.kind === 'instant' ? wallString(ref.at, TZ) : `<${ref.kind}>`;
}
function why(ref: TimeRef): string {
  return ref.kind === 'ambiguous' ? ref.why : `<${ref.kind}>`;
}

// ---------------------------------------------------------------------------
section('a date he wrote in digits is read, not stepped over');
//
// Production, 01.09.2026 00:08. He asked to move #69 to the 2nd; the reminder
// stayed on the 1st and the bot said "הזזתי … ב-01.09 בשעה 16:30" — a move it
// had not made, to a date he had not named. findNamedTime found "ב16:30",
// found no day word, and defaulted to today. The "2.9" was invisible to every
// regex in the file: TIME_ANCHOR does not count it, CLOCK_RESIDUE does not
// flag it, matchDay does not know it.
//
// Note this is NOT a model failure. It is deterministic code returning a
// confident wrong answer, which rule 2 at the top of quickparse.ts exists to
// forbid — and which findNamedTime was the one path never held to.
{
  const now = wallToUtc(2026, 9, 1, 0, 8, TZ);
  eq('ל2.9 ב16:30 is the second, not today', at(readWhen('תעביר את 69 ל2.9 ב16:30', now, TZ)), '2026-09-02T16:30');
  eq('ב2.9 בשעה 16:30 likewise', at(readWhen('תזכיר לי ב2.9 בשעה 16:30 לנקות פילטר למזגנים', now, TZ)), '2026-09-02T16:30');
  eq('a slash reads the same as a dot', at(readWhen('תעביר את 69 ל2/9 ב16:30', now, TZ)), '2026-09-02T16:30');
  eq('and an explicit year is accepted', at(readWhen('תעביר את 69 ל2.9.2026 ב16:30', now, TZ)), '2026-09-02T16:30');
}

{
  // A date that has gone by this year is next year — the same forward-only
  // reading every other path here uses. Guessing backwards would schedule a
  // reminder into the past, which computeNext then refuses, so the user gets
  // "הזמן הזה כבר עבר" for a date he plainly meant in the future.
  const now = wallToUtc(2026, 9, 1, 0, 8, TZ);
  eq('a date already past rolls to next year', at(readWhen('תעביר את זה ל3.1 ב16:30', now, TZ)), '2027-01-03T16:30');
}

// ---------------------------------------------------------------------------
section('...and one it cannot read is REFUSED, never ignored');
//
// The arm that did not exist. Every one of these used to return null from
// findNamedTime — indistinguishable from "he named no time at all" — or, worse,
// an answer with the unreadable part quietly dropped.
{
  const now = wallToUtc(2026, 9, 1, 10, 0, TZ);
  eq('a month that is not a month', why(readWhen('תעביר את זה ל2.13 ב16:30', now, TZ)), 'unparsed');
  eq('a day that is not a day', why(readWhen('תעביר את זה ל45.9 ב16:30', now, TZ)), 'unparsed');
  // "8.30" with no other clock in the sentence is genuinely ambiguous — 08:30,
  // or the 8th of March? Both readings are live and neither is safe to pick,
  // so it asks. Today it is silently invisible.
  eq('a dotted pair with no clock to disambiguate it', why(readWhen('תזכיר לי בשעה 8.30', now, TZ)), 'unparsed');

  const ref = readWhen('תעביר את זה ל2.13 ב16:30', now, TZ);
  check(
    'the refusal says what it choked on, so the question can name it',
    ref.kind === "ambiguous" && ref.seen.some((s: string) => s.includes('2.13')),
    JSON.stringify(ref),
  );
}

// ---------------------------------------------------------------------------
section('"עוד יומיים ב16:30" — a day offset AND a clock');
//
// Production, 01.09.2026 00:07: this created #69 for **01.09**, two days early.
// Every piece was present and thrown away — parseDuration read 2880 correctly,
// and quickParse and findNamedTime both bailed on countTimeAnchors > 1, so the
// router was left to do the arithmetic and got it wrong.
//
// The unit is what decides. A DAY or a WEEK in front of a clock is an offset
// ("in two days, at half four"); an HOUR or a MINUTE in front of a clock is
// nonsense and stays a plain duration.
{
  const now = wallToUtc(2026, 9, 1, 0, 7, TZ);
  eq('two days at half four', at(readWhen('תזכיר לי עוד יומיים ב16:30 לנקות את הפילטרים', now, TZ)), '2026-09-03T16:30');
  eq('the bare answer form too', at(readWhen('עוד יומיים ב16:30', now, TZ)), '2026-09-03T16:30');
  eq('counted days', at(readWhen('תזכיר לי עוד 3 ימים ב9:00 להתקשר', now, TZ)), '2026-09-04T09:00');
  eq('a week out', at(readWhen('תזכיר לי בעוד שבוע ב20:00', now, TZ)), '2026-09-08T20:00');
  // Counted in WORDS, which is how he actually types it. The first version of
  // DAY_OFFSET matched `\d{1,3}` only, so "עוד שלושה ימים ב10:10" fell through
  // to two-times and was captured with no hour at all — production, 02.09.2026
  // 22:42, reminder #72. `parseRelative` has read Hebrew number words since it
  // was written; this regex simply did not reuse it.
  eq('three days, spelled out', at(readWhen('תזכיר לי עוד שלושה ימים ב10:10 לבדוק משימות', now, TZ)), '2026-09-04T10:10');
  eq('two, spelled out', at(readWhen('תזכיר לי עוד שני ימים ב8:00 לבדוק', now, TZ)), '2026-09-03T08:00');
  // A quantity it cannot read is still a refusal, not a guess at one.
  eq('an unreadable count refuses', why(readWhen('תזכיר לי עוד כמה ימים ב8:00 לבדוק', now, TZ)), 'two-times');
}

{
  // Without a clock it is still just a length of time, exactly as before.
  const now = wallToUtc(2026, 9, 1, 0, 7, TZ);
  const ref = readWhen('תזכיר לי עוד יומיים לנקות את הפילטרים', now, TZ);
  eq('no clock means it stays a duration', ref.kind, 'duration');
  eq('and the length is unchanged', ref.kind === 'duration' ? ref.minutes : -1, 2880);
}

{
  // Hours and minutes are never offsets. "עוד שעתיים ב16:30" is not a thing
  // anybody says, and reading it as "in two days at 16:30" would be an
  // invention; reading it as a duration and ignoring the clock would be the
  // 2.9 bug again. It asks.
  const now = wallToUtc(2026, 9, 1, 10, 0, TZ);
  eq('an hour offset plus a clock is two times, not an offset', why(readWhen('תזכיר לי עוד שעתיים ב16:30', now, TZ)), 'two-times');
}

// ---------------------------------------------------------------------------
section('the refusals that already existed keep their reasons');
//
// findNamedTime had four of these and returned the same `null` for all of
// them, so every caller could only ask the same generic "מתי?". They are
// different facts and the caller can now say which.
{
  const now = wallToUtc(2026, 9, 1, 10, 0, TZ);
  eq('two clock times', why(readWhen('תזכיר לי ב7:00 ואז ב9:00', now, TZ)), 'two-times');
  // A repeat rule must never be flattened into a single instant: that ENDS the
  // recurrence, which is the trap CLAUDE.md records the retime button being
  // fixed for.
  eq('a repeat rule is not an instant', why(readWhen('כל יום ב-8', now, TZ)), 'repeat-rule');
  eq('an hour today that has gone', why(readWhen('היום ב-7:00', now, TZ)), 'past');
  eq('and nothing time-like at all', readWhen('שלום מה נשמע', now, TZ).kind, 'none');
}

// ---------------------------------------------------------------------------
section('everything findNamedTime got right, it still gets right');
//
// The regression floor. These are the shapes the old function resolved
// correctly, and the seam is only worth having if none of them moved.
{
  const now = wallToUtc(2026, 9, 1, 10, 0, TZ);
  eq('tomorrow at a clock time', at(readWhen('תזכיר לי מחר ב16:30 לנקות', now, TZ)), '2026-09-02T16:30');
  eq('a bare clock later today', at(readWhen('בוא נזיז את התזכורת של הבשר ל15:00', now, TZ)), '2026-09-01T15:00');
  eq('a bare clock already past rolls to tomorrow', at(readWhen('תעביר את זה ל9:00', now, TZ)), '2026-09-02T09:00');
  eq('a named weekday', at(readWhen('תעביר את זה ליום חמישי ב8:00', now, TZ)), '2026-09-03T08:00');
  eq('מחרתיים is not מחר with letters after it', at(readWhen('תזכיר לי מחרתיים ב9:00', now, TZ)), '2026-09-03T09:00');

  const rel = readWhen('תזכיר לי עוד חצי שעה', now, TZ);
  eq('a relative push is a duration, not an instant', rel.kind, 'duration');
  eq('half an hour', rel.kind === 'duration' ? rel.minutes : -1, 30);
}

// ---------------------------------------------------------------------------
section('a period word is a guess, and only with the day pinned');
//
// findFutureInstant's rule, kept: "מחר בערב" is 20:00 because it has to be
// something, and that is honest only because voice.ts always states the hour
// it set. A bare "בערב" — tonight? tomorrow? — must still refuse.
{
  const now = wallToUtc(2026, 9, 1, 10, 0, TZ);
  eq('tomorrow evening is 20:00', at(readWhen('תזכיר לי מחר בערב להתכונן', now, TZ)), '2026-09-02T20:00');
  eq('tomorrow morning is 09:00', at(readWhen('תזכיר לי מחר בבוקר להתכונן', now, TZ)), '2026-09-02T09:00');
  eq('a period with no day refuses', readWhen('תזכיר לי בערב להתכונן', now, TZ).kind, 'none');
}

// ---------------------------------------------------------------------------
section('end to end — the two turns from 01.09.2026, through the whole pipeline');
//
// The unit assertions above prove the resolver. These prove the SEAM: that his
// words actually reach the row, past a router that answered with its own
// arithmetic and won.
//
// Precedence is the half that is easy to miss. `scheduleFromIntent(intent) ??
// named` meant the model's computed date beat his sentence every time, so
// fixing readWhen alone would have changed nothing at all on either of these.
{
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 1, 0, 7, TZ);

  // What the model actually returned that night: today, two days early. The
  // sentence says "עוד יומיים", the router said 01.09, and the router won.
  rig.routerQueue.push({
    actions: [
      { action: 'create_reminder', title: 'לנקות את הפילטרים של המזגנים', schedule_type: 'once', once_at: '2026-09-01T16:30' },
    ],
  });
  rig.speakQueue.push('קבעתי.');
  await withNow(now, () => runWebhook(rig, 'תזכיר לי עוד יומיים ב16:30 לנקות את הפילטרים של המזגנים'));

  const row = rig.db.prepare('SELECT title, schedule FROM reminders').get() as any;
  check('the reminder exists', !!row, JSON.stringify(row));
  eq(
    'and it is two days out, not today — his words beat the arithmetic',
    JSON.parse(row.schedule ?? '{}').at,
    '2026-09-03T16:30',
  );
  rig.restore();
}

{
  // "תעביר את 69 ל2.9 ב16:30" — a move to the 2nd, answered "הזזתי … ב-01.09
  // בשעה 16:30". The row never moved, and the bot reported that it had.
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 1, 0, 8, TZ);
  const id = seedReminder(rig, 'לנקות את הפילטרים של המזגנים', wallToUtc(2026, 9, 1, 16, 30, TZ), '2026-09-01T16:30');

  rig.routerQueue.push({
    actions: [{ action: 'reschedule', target_id: id, schedule_type: 'once', once_at: '2026-09-01T16:30' }],
  });
  rig.speakQueue.push('הזזתי.');
  await withNow(now, () => runWebhook(rig, `תעביר את ${id} ל2.9 ב16:30`));

  const row = rig.db.prepare('SELECT schedule FROM reminders WHERE id = ?').get(id) as any;
  eq('it actually moved to the second', JSON.parse(row.schedule ?? '{}').at, '2026-09-02T16:30');
  rig.restore();
}

done();
