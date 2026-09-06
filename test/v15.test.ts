/**
 * Run with `npm run test:v15`.
 *
 * Stage 0 of the refactor in REFACTOR.md: "keep the promise". Nothing here is
 * architecture — it is the seven changes that stood between the bot and
 * actually ringing, each pinned to the production evidence in issues.md.
 *
 * The through-line: every one of these failures was VISIBLE and none of them
 * was legible. The cron missed 12% of its minutes and said so as a timestamp;
 * a truncated response arrived as HTTP 200 with text in it; the ladder was
 * inverted in a config file nobody re-read. Stage 0 is about making the
 * machine say what is happening to it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/index';
import * as db from '../src/db';
import { modelLadder } from '../src/gemini';
import { handleSlash } from '../src/slash';
import { buildFacts } from '../src/facts';
import { titleFromHisWords } from '../src/effects';
import { renderBaseline } from '../src/voice';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Context } from '../src/brain';
import type { Effect } from '../src/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
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

function seedSettings(rig: Rig, over: Record<string, unknown> = {}): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(CHAT, TZ, (over.quiet_start_hour ?? 23) as any, (over.quiet_end_hour ?? 8) as any);
}

function seedReminder(rig: Rig, title: string, dueAt: number, at: string): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?, NULL)`,
    )
    .run(CHAT, title, JSON.stringify({ type: 'once', at }), TZ, dueAt, dueAt - 3_600_000);
  return Number(r.lastInsertRowid);
}

function errorRows(rig: Rig): { stage: string; message: string }[] {
  return rig.db.prepare('SELECT stage, message FROM errors').all() as any[];
}

// ---------------------------------------------------------------------------
section('0.1 — the ladder leads with a model that has been MEASURED');
//
// This section originally asserted the opposite, and issues.md §12.2 was a
// misdiagnosis. It read `usage` for 30.08–02.09, saw every call going to
// 3.5-flash and 3.5-flash-lite while 3.7 and 3.6 sat unreached, and called
// that an inverted ladder — "routing is being done by the weakest model
// configured". The evidence for "weakest" was the version number and nothing
// else.
//
// 0.16.0 promoted them and production answered inside forty minutes:
//
//   /diag probe   HTTP 200 in 4049ms, then HTTP 503 in 9059ms
//   22:27 turn    18.9s to route, invocation died before sending
//   22:43 turn    "gemini exhausted every tier (gemini-3.5-flash timed out
//                 after 635ms)" — 3.7 and 3.6 each burned the full 12s
//                 per-call timeout, leaving the model that actually works
//                 635 milliseconds
//
// 12 + 12 = the entire turn. Two reminders lost, one of them filed as inbox
// junk. Meanwhile the thing §12.2 blamed on model quality — the runaway
// `title` — happens on every rung, because it is a schema problem (§3).
//
// "Never reached" is what a working ladder looks like when the first two rungs
// are fast and reliable. The lower rungs are CAPACITY (a separate per-minute
// quota each), not a queue of better answers waiting to be let in.
//
// Asserted against the real wrangler.toml, because the change was config and a
// fixture would have been green throughout.
{
  const toml = readFileSync(join(HERE, '..', 'wrangler.toml'), 'utf8');
  const readVar = (name: string) =>
    new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];
  const env: any = {
    GEMINI_MODEL: readVar('GEMINI_MODEL'),
    GEMINI_MODEL_FALLBACK: readVar('GEMINI_MODEL_FALLBACK'),
    GEMINI_MODELS: readVar('GEMINI_MODELS'),
  };
  const ladder = modelLadder(env);

  // The guard that matters: whatever leads has to be something with a
  // production track record, not the highest version number available.
  check(
    'the primary is a model measured fast in production',
    ladder[0]?.startsWith('gemini-3.5'),
    ladder.join(' · '),
  );
  // ...and the deep ladder is still deep. Capacity was never the thing that
  // was wrong, and losing it would cost a busy minute the fallbacks it needs.
  for (const m of ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']) {
    check(`${m} is still a rung`, ladder.includes(m), ladder.join(' · '));
  }
  check('every rung is distinct', new Set(ladder).size === ladder.length, ladder.join(' · '));
}

// ---------------------------------------------------------------------------
section('0.11 — a tier with no time left is not called');
//
// From the same 22:43 failure. The error the user was shown blamed a model
// that never had a chance: "gemini-3.5-flash timed out after 635ms". It did
// not time out in any meaningful sense — it was handed the scraps of a budget
// two slower models had already spent, and a round trip that cannot complete
// is worth less than the honest report that the budget is gone.
//
// CLAUDE.md already states this rule for the ladder budget ("the second tier
// inherits a scrap of time and is not worth calling"); the turn budget added
// in 0.16.1 re-created exactly the condition it warns about.
{
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 2, 22, 43, TZ);
  // Less than one attempt's worth for the whole turn.
  rig.env.GEMINI_TURN_BUDGET_MS = '500';

  await withNow(now, () => runWebhook(rig, 'תבטל את 72'));

  eq('no doomed round trip is made', rig.geminiCalls.length, 0);
  check(
    'and he is told something rather than nothing',
    rig.texts().length > 0,
    JSON.stringify(rig.texts()),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('0.12 — a title that repeats itself is a scratchpad');
//
// Mop number four would have been another character added to FILLER_RUN, and
// issues.md §3 is explicit that this cannot work: bound `title` and the spill
// moves to `note`; add "/" and it comes back as "->".
//
//   #71  "ללכת לישון / : ללכת לישון"
//   #72  "לבדוק משימות חדשות - (, : 'לבדוק משימות חדשות') -> "לבדוק..."
//   #13  "ללכת למוסךTrimmed to: ללכת למוסך והוא לא אמר משהו אחר. ללכת למוסך…"
//
// So this is not another character. Every one of them REPEATS THE ERRAND —
// the model writes the answer, then writes it again while deliberating. That
// is structural, it is the same signal in all three, and no real errand
// contains its own opening clause twice.
//
// Still a mop, and still not the fix. The fix is the discriminated union in
// Stage 4, which removes the field the deliberation lands in.
{
  eq(
    'the second copy and everything after it goes',
    titleFromHisWords('ללכת לישון / : ללכת לישון', 'תזכיר לי עוד יומיים ב9:30 ללכת לישון'),
    'ללכת לישון',
  );
  eq(
    'including when the spill is long and punctuated',
    titleFromHisWords(
      'לבדוק משימות חדשות - (, : \'לבדוק משימות חדשות\') -> "לבדוק משימות חדשות", "',
      'תזכיר לי עוד שלושה ימים ב10:10 לבדוק משימות חדשות',
    ),
    'לבדוק משימות חדשות',
  );
  // The guard that keeps it from eating real errands: two DIFFERENT errands
  // that merely start alike are not a repeat, and a comma list is the shape
  // splitIntoItems depends on.
  eq(
    'a real list of errands is untouched',
    titleFromHisWords('להחזיר ראוטר, לקנות מחבת, ללכת למחסני תאורה', 'תזכיר לי מחר להחזיר ראוטר, לקנות מחבת, ללכת למחסני תאורה'),
    'להחזיר ראוטר, לקנות מחבת, ללכת למחסני תאורה',
  );
  // And if HE repeated himself, the repetition is his and stays.
  eq(
    'his own repetition is his',
    titleFromHisWords('לקנות חלב לקנות חלב', 'תזכיר לי לקנות חלב לקנות חלב'),
    'לקנות חלב לקנות חלב',
  );
}

// ---------------------------------------------------------------------------
section('0.2 — a truncated response is retried, not shipped as an answer');
//
// issues.md §12.4. `MAX_TOKENS` has been in RETRYABLE the whole time. It was
// unreachable: `if (text) return text` fires before `finishReason` is ever
// read, and a runaway that ran out of room has text in it — just not text that
// parses. So every one of errors #13–#17 died on the first attempt, with two
// retries and four ladder rungs sitting unused, and the catch-block filed his
// sentence as an inbox row.
//
// "מחר ב7:30 - ללכת למוסך" is the real message behind errors #13, and it is
// used here because it has no "תזכיר" in it: asksForNewReminder refuses, so
// quickparse bails and the ROUTER is what gets called. A message quickparse
// can answer never reaches the model at all and would test nothing.
{
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 3, 9, 0, TZ);

  rig.truncate = 1; // the first router call runs out of room mid-string
  rig.routerQueue.push({
    actions: [
      { action: 'create_reminder', title: 'ללכת למוסך', schedule_type: 'once', once_at: '2026-09-04T07:30' },
    ],
  });
  rig.speakQueue.push('קבעתי. המוסך לא יבוא אליך.');

  await withNow(now, () => runWebhook(rig, 'מחר ב7:30 - ללכת למוסך'));

  const rows = rig.db.prepare("SELECT title, status FROM reminders").all() as any[];
  const errs = errorRows(rig);

  check('the turn survived the truncation', errs.length === 0, JSON.stringify(errs));
  eq('exactly one reminder was written', rows.length, 1);
  eq('and it is the real one, not his raw sentence', rows[0]?.title, 'ללכת למוסך');
  eq('scheduled, not filed in the inbox', rows[0]?.status, 'scheduled');
  // Exactly two: the truncation and the one retry that answered. Red at 1
  // (no retry happened) and red above 2 (the ladder is being burned on a
  // condition one wider attempt clears).
  eq(
    'the retry cost one extra call and no more',
    rig.geminiCalls.filter((c) => c.kind === 'router').length,
    2,
  );
  rig.restore();
}

// A truncation with no schema is a different question and must NOT change:
// a persona rewrite that got cut off is still Hebrew, and the caller already
// has a validator and a baseline behind it.
{
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 3, 9, 0, TZ);
  seedReminder(rig, 'לקחת אוכל', now - 60_000, '2026-09-03T08:59');

  rig.truncate = 1; // hits speak(), which has no responseSchema
  await withNow(now, () => runCron(rig));

  check(
    'a cut-off persona line still ships something',
    rig.texts().some((t) => t.includes('לקחת אוכל')),
    JSON.stringify(rig.texts()),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('0.3 — /diag says the scheduler is dead, instead of printing a timestamp');
//
// issues.md §7. On 02.09 at 20:36 he ran /diag and got
// `טיק אחרון: יום ד׳, 02.09.2026, 20:08` — rendered in the same voice as
// `d1: תקין ✓`, twenty-eight minutes into a total cron outage. The one command
// written to detect this failure showed it to him and let him scroll past.
{
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 2, 20, 36, TZ);

  rig.db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(now - 28 * 60_000));
  rig.speakQueue.push('probe');

  const out = (await withNow(now, () => handleSlash(rig.env, CHAT, '/diag'))) ?? '';

  check('the age is stated, not just the hour', /28 דקות/.test(out), out);
  // Matched on the wording slash.ts actually emits ("הקרון לא רץ!" /
  // "מעולם לא רץ!"). It used to read /לא רץ|מת|תקוע/, and the last two
  // alternatives never matched anything this bot has ever said — they were
  // guesses at synonyms. `מת` then started matching "סכיMת הראוטר" when 0.27.0
  // added a schema line to /diag, so the healthy-tick assertion below failed
  // over a word that has nothing to do with the cron. A regex alternative that
  // matches no real output is not extra safety; it is an unexploded false
  // positive waiting for the next line added to the same message.
  check('and it is called out as a failure', /לא רץ/.test(out), out);
  rig.restore();
}

{
  // The other direction. A healthy tick must not cry wolf — the cron drops a
  // minute here and there routinely (13 gaps of 3-5 minutes in the 24h sample),
  // and an alarm that is wrong every hour is one he learns to scroll past just
  // the same.
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 2, 20, 36, TZ);
  rig.db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(now - 90_000));
  rig.speakQueue.push('probe');

  const out = (await withNow(now, () => handleSlash(rig.env, CHAT, '/diag'))) ?? '';
  check('a ninety-second-old tick raises nothing', !/לא רץ/.test(out), out);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('0.4 — a tick is a claim, so two of them cannot both do the work');
//
// issues.md §7a. `tick` reads due rows, then writes. Two ticks that interleave
// between the read and the write both fire. Nothing has surfaced it because
// ticks currently UNDER-run rather than overlap — but 0.5 adds a second
// trigger and an opportunistic catch-up, which is exactly what makes it
// reachable. Idempotency is the precondition, not a nicety.
{
  const rig = createRig();
  const t = wallToUtc(2026, 9, 3, 9, 0, TZ);

  eq('the first claim of a window wins', await db.claimTick(rig.env, t, 30_000), true);
  eq('a second one, moments later, loses', await db.claimTick(rig.env, t + 1_000, 30_000), false);
  eq(
    'and the next real minute wins again',
    await db.claimTick(rig.env, t + 60_000, 30_000),
    true,
  );
  eq('the stamp is the winning claim', await db.lastTick(rig.env), t + 60_000);
  rig.restore();
}

{
  // And the tick actually honours it. Proved by what the loser does NOT do:
  // it must not even reach the due-reminders read, or it has already raced.
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 3, 9, 0, TZ);
  seedReminder(rig, 'לקחת אוכל', now - 60_000, '2026-09-03T08:59');
  rig.speakQueue.push('נו?');

  await withNow(now, () => runCron(rig));
  const after = rig.sql.length;
  await withNow(now, () => runCron(rig));
  const second = rig.sql.slice(after);

  check(
    'the losing tick never reads the due list',
    !second.some((s) => /FROM reminders/.test(s)),
    JSON.stringify(second),
  );
  eq('one fire, one instance', (rig.db.prepare('SELECT COUNT(*) AS n FROM instances').get() as any).n, 1);
  rig.restore();
}

{
  // The structural half: even if two ticks did both get through, the database
  // refuses the second instance for the same due slot. Belt as well as braces,
  // because the claim is a policy and this is an invariant.
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 3, 9, 0, TZ);
  const id = seedReminder(rig, 'לקחת אוכל', now - 60_000, '2026-09-03T08:59');
  const reminder = rig.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;

  const first = await db.createInstance(rig.env, reminder, now, now + 60_000, now - 60_000);
  const again = await db.createInstance(rig.env, reminder, now, now + 60_000, now - 60_000);

  check('the first instance opens', typeof first === 'number', String(first));
  eq('the duplicate is refused, not written', again, null);
  eq(
    'one row for one due slot',
    (rig.db.prepare('SELECT COUNT(*) AS n FROM instances').get() as any).n,
    1,
  );

  // A genuinely different due slot is a different dose and must still open —
  // "a daily reminder he never closed should still ring tomorrow".
  const tomorrow = now + 86_400_000;
  const next = await db.createInstance(rig.env, reminder, tomorrow, tomorrow + 60_000, tomorrow - 60_000);
  check("tomorrow's dose is not a duplicate", typeof next === 'number', String(next));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('0.5 — one dropped schedule entry is not a missed reminder');
//
// issues.md §7. Cloudflare invoked the Worker on 1251 of ~1420 minutes in the
// 24h sample. The trigger is registered and correct; the platform simply skips
// minutes, and on 01.09 it skipped eighty of them in a row — #69 was due at
// 16:30 and `instances.fired_at` says 17:50:39.
{
  const toml = readFileSync(join(HERE, '..', 'wrangler.toml'), 'utf8');
  const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? '';
  const list = [...crons.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check('there is more than one schedule entry', list.length > 1, JSON.stringify(list));
  check('the every-minute one is still there', list.includes('* * * * *'), JSON.stringify(list));
}

{
  // The webhook catches up too. He is talking to the bot, which means the
  // Worker is demonstrably alive — so a tick that the platform skipped can be
  // run off the back of his message rather than waiting for the next minute
  // that happens to arrive.
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 3, 9, 0, TZ);
  seedReminder(rig, 'לקחת אוכל', now - 30 * 60_000, '2026-09-03T08:30');
  rig.db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(now - 30 * 60_000));

  rig.speakQueue.push('נו?', 'בסדר');
  await withNow(now, () => runWebhook(rig, 'מה קורה'));

  eq(
    'the overdue reminder fired off the back of his message',
    (rig.db.prepare('SELECT COUNT(*) AS n FROM instances').get() as any).n,
    1,
  );
  rig.restore();
}

{
  // ...and only when the cron has actually gone quiet. A fresh tick means the
  // scheduler is doing its job, and every inbound message must not become a
  // second one.
  //
  // The tick is NINETY SECONDS old, which is the only interval that isolates
  // this guard. Anything under TICK_CLAIM_GAP_MS is also refused by the claim
  // in db.claimTick, so a 20-second-old tick would pass this assertion with
  // CATCHUP_AFTER_MS deleted and prove nothing — two guards, one bug, and
  // removing either alone is not evidence. Ninety seconds is past the claim
  // gap and short of the catch-up threshold, so the only thing standing
  // between this rig and a stray fire is the staleness check itself.
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 3, 9, 0, TZ);
  seedReminder(rig, 'לקחת אוכל', now - 30 * 60_000, '2026-09-03T08:30');
  rig.db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(now - 90_000));

  rig.speakQueue.push('בסדר');
  await withNow(now, () => runWebhook(rig, 'מה קורה'));

  eq(
    'a healthy cron is left to do its own job',
    (rig.db.prepare('SELECT COUNT(*) AS n FROM instances').get() as any).n,
    0,
  );
  rig.restore();
}

{
  // A cron that has NEVER run is a misconfiguration, not a stall, and the
  // webhook must not quietly prop it up. This started life the other way round
  // — "never ticked at all is the strongest possible reason to tick" — and
  // three unrelated tests immediately began firing reminders mid-conversation,
  // which is what a freshly deployed Worker would have done to him for the
  // sixty seconds before its first cron arrived.
  //
  // /diag already says "מעולם לא רץ!" for this. A bot that limps — answering
  // when spoken to, silent the rest of the day — hides the one fact that
  // explains it.
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 3, 9, 0, TZ);
  seedReminder(rig, 'לקחת אוכל', now - 30 * 60_000, '2026-09-03T08:30');
  // No last_tick row at all.

  rig.speakQueue.push('בסדר');
  await withNow(now, () => runWebhook(rig, 'מה קורה'));

  eq(
    'a scheduler that never started is not caught up from a webhook',
    (rig.db.prepare('SELECT COUNT(*) AS n FROM instances').get() as any).n,
    0,
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('0.6 — a late reminder says it is late');
//
// issues.md §7. On 01.09 #69 was due at 16:30 and rang at 17:50. It opened
// "נו? לנקות את הפילטרים של המזגנים" — word for word what it would have said
// on time. That is a false claim about WHEN, which is the same class the whole
// pipeline exists to prevent, arriving through the one door nobody guarded.
{
  const rig = createRig();
  seedSettings(rig);
  const due = wallToUtc(2026, 9, 1, 16, 30, TZ);
  const now = due + 80 * 60_000;
  seedReminder(rig, 'לנקות את הפילטרים של המזגנים', due, '2026-09-01T16:30');

  // The baseline is what is under test, so the persona is taken out of the way.
  rig.speakQueue.push(new Error('test: persona unavailable'));
  await withNow(now, () => runCron(rig));

  const text = rig.texts().join('\n');
  check('it still names the errand', /הפילטרים/.test(text), text);
  check('it says the hour it was meant to ring', /16:30/.test(text), text);
  check('and admits it is late', /איחרתי|באיחור/.test(text), text);
  rig.restore();
}

{
  // On time, it must say none of that. A reminder that apologises every
  // morning for a minute of jitter is noise, and the cron drops single minutes
  // routinely.
  const rig = createRig();
  seedSettings(rig);
  const due = wallToUtc(2026, 9, 1, 16, 30, TZ);
  seedReminder(rig, 'לנקות את הפילטרים של המזגנים', due, '2026-09-01T16:30');

  rig.speakQueue.push(new Error('test: persona unavailable'));
  await withNow(due + 40_000, () => runCron(rig));

  const text = rig.texts().join('\n');
  check('no apology for forty seconds', !/איחרתי|באיחור/.test(text), text);
  rig.restore();
}

{
  // The hour has to be in facts.ts too, or validate rule 1 discards any
  // rewrite that repeats what the baseline itself just said — silently, as a
  // counter in /diag. CLAUDE.md states this rule; event_at is the last field
  // that had to learn it.
  const due = wallToUtc(2026, 9, 1, 16, 30, TZ);
  const ctx = {
    settings: { chat_id: CHAT, tz: TZ, quiet_start_hour: 23, quiet_end_hour: 8 },
    stats: {}, reminders: [], goals: [], open: [], nowLabel: '',
  } as unknown as Context;
  const fired: Effect = {
    kind: 'reminder_fired',
    id: 1,
    title: 'לנקות את הפילטרים של המזגנים',
    instanceId: 1,
    requiresProof: false,
    dueAt: due,
    lateBy: 80,
  } as Effect;

  const facts = buildFacts(ctx, [fired], TZ);
  check('the scheduled hour is allow-listed', facts.times.includes('16:30'), JSON.stringify(facts.times));
  check(
    'and the baseline states it',
    renderBaseline([fired], TZ).includes('16:30'),
    renderBaseline([fired], TZ),
  );
}

// ---------------------------------------------------------------------------
section('0.7 — /error is /errors');
//
// issues.md §12.9. He typed it on 30.08, got "אין פקודה כזאת", and retyped.
{
  const rig = createRig();
  seedSettings(rig);
  const singular = await handleSlash(rig.env, CHAT, '/error');
  const plural = await handleSlash(rig.env, CHAT, '/errors');
  check('the singular is not rejected', !/אין פקודה כזאת/.test(singular ?? ''), String(singular));
  eq('it is the same command', singular, plural);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('0.8 — a TURN is bounded, not just each call inside it');
//
// Found in production by deploying 0.16.0, which is the only way it could have
// been found. Chat A, 02.09.2026 22:27:39, "תזכיר לי עוד יומיים ב9:30 בבוקר
// ללכת לישון":
//
//   reminder 71 written at 22:27:58 — 18.9 seconds to route
//   fires 04.09 09:30                — CORRECT, Stage 1 working
//   messages: his row, and no bot row after it
//   errors:   nothing
//
// He got silence. Not a wrong answer, not an apology — nothing. And no catch
// ran anywhere, which is the signature CLAUDE.md already describes: an
// overrun kills ctx.waitUntil WITHOUT throwing, so every `.catch` in the file
// is bypassed and the turn evaporates.
//
// The arithmetic was there all along and nothing had ever reached it: route()
// gets a 30-second ladder budget and speak() then gets its OWN fresh 30, so a
// single turn could legitimately spend a minute before anything was sent.
// `thinkingLevel: 'high'` on the router (also 0.16.0) is what finally made
// routing slow enough to walk into it.
//
// So the budget belongs to the TURN. speak() is the half that must give way —
// it is decorative by definition, and voice.ts output is already shippable.
{
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 2, 22, 27, TZ);
  // A turn whose whole allowance is already gone by the time routing returns.
  rig.env.GEMINI_TURN_BUDGET_MS = '0';

  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', title: 'ללכת לישון', schedule_type: 'once', once_at: '2026-09-04T09:30' }],
  });
  // Deliberately NOT queueing a speak reply. If the persona is consulted at
  // all the rig throws "queue empty", so this assertion cannot pass by luck.

  await withNow(now, () => runWebhook(rig, 'תזכיר לי עוד יומיים ב9:30 בבוקר ללכת לישון'));

  eq(
    'the persona is skipped once the turn is out of time',
    rig.geminiCalls.filter((c) => c.kind === 'speak').length,
    0,
  );
  check(
    'and he is answered anyway, in voice.ts words',
    rig.texts().some((t) => t.includes('ללכת לישון')),
    JSON.stringify(rig.texts()),
  );
  eq('the reminder itself still landed', (rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any).n, 1);
  rig.restore();
}

{
  // The other direction: a turn with time left still gets its personality.
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 2, 22, 27, TZ);

  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', title: 'ללכת לישון', schedule_type: 'once', once_at: '2026-09-04T09:30' }],
  });
  rig.speakQueue.push('קבעתי. לך לישון.');
  await withNow(now, () => runWebhook(rig, 'תזכיר לי עוד יומיים ב9:30 בבוקר ללכת לישון'));

  eq(
    'an ordinary turn still consults the persona',
    rig.geminiCalls.filter((c) => c.kind === 'speak').length,
    1,
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('0.9 — the router is not asked to think hard');
//
// 0.16.0 set `thinkingLevel: 'high'` here, reasoning that the model was using
// `title` as a scratchpad because it had nowhere legitimate to reason.
//
// Production disagreed on both counts. Routing went from seconds to 18.9s and
// took the turn down with it — and reminder 71's title came back
// "ללכת לישון / : ללכת לישון" anyway, so it did not even buy the thing it was
// for. Meanwhile Stage 1's precedence flip had already removed the arithmetic
// that was the reason to think hard in the first place.
//
// Reverted, and pinned here so it does not get re-argued from first principles
// a third time.
{
  const rig = createRig();
  seedSettings(rig);
  const now = wallToUtc(2026, 9, 2, 22, 27, TZ);
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('נו?');
  await withNow(now, () => runWebhook(rig, 'מה נשמע אצלך היום'));

  const router = rig.geminiCalls.find((c) => c.kind === 'router');
  check('the router was consulted', !!router, JSON.stringify(rig.geminiCalls.map((c) => c.kind)));
  check(
    'and it is not asked to think hard',
    router?.generationConfig?.thinkingConfig?.thinkingLevel !== 'high',
    JSON.stringify(router?.generationConfig?.thinkingConfig),
  );
}

// ---------------------------------------------------------------------------
section('0.10 — one stray separator is a spill');
//
// Reminder 71, written 02.09.2026 22:27, title as stored:
//
//     "ללכת לישון / : ללכת לישון"
//
// His message contained no slash. FILLER_RUN required TWO filler characters in
// a row, so a single "/" — with the model's alternative phrasing after it —
// went through untouched and is now read out every time the reminder fires.
//
// Safe to tighten to one, because titleFromHisWords already bails entirely
// when HIS message contains a filler character. A slash he typed is his; this
// only ever cuts one he did not.
{
  eq(
    'a lone slash he never typed is cut, with everything after it',
    titleFromHisWords('ללכת לישון / : ללכת לישון', 'תזכיר לי עוד יומיים ב9:30 בבוקר ללכת לישון'),
    'ללכת לישון',
  );
  eq(
    'a slash HE typed is left alone',
    titleFromHisWords('לקרוא ב9/9', 'תזכיר לי לקרוא ב9/9'),
    'לקרוא ב9/9',
  );
}

// ---------------------------------------------------------------------------
section('0.13 — a title longer than his message was not extracted from it');
//
// Spill number four, and the one that settles the argument. Reminder #75,
// 03.09.2026 17:07, while the filters reminder was ringing. He typed sixteen
// characters:
//
//     תזכיר לי עוד שעה
//
// and the stored title is 187 — the model reasoning out loud about what the
// title ought to be, in fluent Hebrew:
//
//     "תזכורת חסרה כותרת או תזכורת מהירה שיש לחדד בהמשך אם יש צורך אך המשתמש
//      כתב תזכיר לי עוד שעה בלבד אז הכותרת תהיה במילים שלו או תזכורת כללית
//      כנדרש בתקנון לפי הכללים המותרות בלבד בלשון המשתמש"
//
// It defeated all three existing guards at once: no filler characters, no
// self-repetition, and the same script as his message. Adding a fourth
// character class was never going to converge — issues.md §3 said so, and this
// is the fourth shape in four days.
//
// So the guard is not about characters at all. The router EXTRACTS a title
// from his words; CLAUDE.md is explicit that dropping "תזכיר לאמנון" from the
// front is its job and adding letters is not. Extraction cannot grow. A title
// longer than the message it came out of did not come out of it.
//
// The fallback is UNTITLED_TITLE rather than a truncation, because a truncated
// deliberation is still not an errand. voice.ts already words that case
// properly ("קבעתי לך משהו ל-09:12. על מה להזכיר?") and questionAsked arms the
// slot, so the bot asks instead of inventing.
{
  const spill =
    'תזכורת חסרה כותרת או תזכורת מהירה שיש לחדד בהמשך אם יש צורך אך המשתמש כתב ' +
    'תזכיר לי עוד שעה בלבד אז הכותרת תהיה במילים שלו או תזכורת כללית כנדרש ' +
    'בתקנון לפי הכללים המותרות בלבד בלשון המשתמש';
  eq(
    'a title that cannot have come from his words is discarded, not stored',
    titleFromHisWords(spill, 'תזכיר לי עוד שעה'),
    '',
  );
  // A title that is merely LONG is fine when the message is long too — the
  // rule is a ratio against his own words, not a fixed ceiling.
  eq(
    'a long errand from a long message survives',
    titleFromHisWords(
      'להחזיר ראוטר, לקנות מחבת לטבון, ללכת למחסני תאורה',
      'תזכיר לי מחר בבוקר להחזיר ראוטר, לקנות מחבת לטבון, ללכת למחסני תאורה',
    ),
    'להחזיר ראוטר, לקנות מחבת לטבון, ללכת למחסני תאורה',
  );
  // The exclusion that keeps it honest: a bare confirmation. The router is
  // told that "כן" means 'repeat the action you just offered, with all its
  // details', so a two-character message legitimately yields a title pulled
  // from the previous turn. Length cannot judge that one.
  eq(
    'a title confirmed with a bare yes is not measured against it',
    titleFromHisWords('לקנות בגד ים לים', 'כן'),
    'לקנות בגד ים לים',
  );
  // And the ordinary case: the router strips the framing, so the title is
  // always shorter than the message anyway.
  eq(
    'the normal shape is untouched',
    titleFromHisWords('לקחת אוכל', 'תזכיר לי מחר ב7:08 לקחת אוכל'),
    'לקחת אוכל',
  );
}

done();
