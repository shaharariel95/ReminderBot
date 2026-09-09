/**
 * Run with `npm run test:v35`.
 *
 * **Closing something before it rings.**
 *
 * Production, 09.09.2026. #88 "לבקש מצחי את המייל שלו" was on the books for
 * 10:00. He did it at 09:37 and tried three times to say so:
 *
 *   09:37  him  סגור את המשימה עם המייל, עשיתי
 *   09:37  bot  אין לי משימה פתוחה שמתאימה לזה.
 *   09:37  him  סגור את הבקשה מצחי
 *   09:37  bot  אין לי משימה פתוחה כזאת לסגור כרגע.
 *   09:37  bot  בטוח שפתחת אותה בכלל?
 *   09:38  him  /list
 *   09:38  bot  #88 לבקש מצחי את המייל שלו · יום ד׳, 09.09.2026, 10:00
 *   09:38  him  סגור את 88
 *   09:38  bot  אין לי משימה פתוחה כזאת לסגור.
 *   09:38  bot  בטוח לגבי המספר?
 *   10:00  bot  נו? לבקש מצחי את המייל שלו.          ← it rang anyway
 *
 * Five refusals, two of them casting doubt on him, about a row the bot had
 * just printed with its own id — and then it rang for something he had done an
 * hour earlier and he had to close it twice.
 *
 * `applyIntent`'s `complete` resolves only against `ctx.open`, which holds
 * open INSTANCES. A reminder that has not fired yet has no instance, so there
 * was no path at all from "I did it" to a scheduled row: the answer to every
 * phrasing was the same, and it reads as a denial that the task exists.
 *
 * **This is the second time.** Chat B, 30.08.2026 20:01: "חידשתי" over the
 * same empty `ctx.open`, and the persona inverted the refusal into "יפה שסגרת
 * את זה מוקדם" — praise for closing something still open. #68 rang
 * twenty-four minutes later. 0.19.0 fixed the LIE (validate.ts learned second
 * person, see CLAIM_GROUPS) and left the GAP, so the same message came back
 * ten days later wearing the honest wording. A validator that stops the bot
 * lying about a thing it cannot do is not a fix for not being able to do it.
 *
 * What must hold once it can:
 *
 *   - the write is a real dose — an instance for THIS slot, closed `done`, so
 *     the streak, /stats, /why and patterns.ts all see it exactly as they see
 *     a close that followed a ring
 *   - the schedule moves past that dose, or the fix is only the first half and
 *     it rings at 10:00 regardless — which is the 30.08 half
 *   - a `once` reminder is finished; a daily one comes back tomorrow
 *   - and it refuses when his sentence does not name a row. Guessing here
 *     writes "done" against an errand he has not started.
 */
import worker from '../src/index';
import { applyIntent } from '../src/effects';
import { buildFacts } from '../src/facts';
import { renderBaseline } from '../src/voice';
import { validate } from '../src/validate';
import type { Context } from '../src/brain';
import type { Effect } from '../src/types';
import * as db from '../src/db';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const OTHER = '999';
const TZ = 'Asia/Jerusalem';

/** 09.09.2026 — the reminder is at 10:00, he reports at 09:37. */
const DUE = wallToUtc(2026, 9, 9, 10, 0, TZ);
const NOW = wallToUtc(2026, 9, 9, 9, 37, TZ);

function seedSettings(rig: Rig, chat = CHAT): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(chat, TZ);
}

/** A scheduled reminder with no instance behind it — the state this is about. */
function seedReminder(
  rig: Rig,
  title: string,
  fireAt: number,
  schedule: object = { type: 'once', at: '2026-09-09T10:00' },
  chat = CHAT,
): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?)`,
    )
    .run(chat, title, JSON.stringify(schedule), TZ, fireAt, NOW - 86_400_000);
  return Number(r.lastInsertRowid);
}

async function ctxFor(rig: Rig, chat = CHAT): Promise<Context> {
  const [settings, stats, rems, goals, open] = await Promise.all([
    db.getSettings(rig.env, chat),
    db.stats(rig.env, chat),
    db.listReminders(rig.env, chat),
    db.listGoals(rig.env, chat),
    db.openInstances(rig.env, chat),
  ]);
  return { settings, stats, reminders: rems, goals, open, nowLabel: 'עכשיו' };
}

function instancesOf(rig: Rig, reminderId: number): any[] {
  return rig.db
    .prepare('SELECT * FROM instances WHERE reminder_id = ? ORDER BY id')
    .all(reminderId) as any[];
}

function reminderRow(rig: Rig, id: number): { status: string; next_fire_at: number | null } {
  return rig.db.prepare('SELECT status, next_fire_at FROM reminders WHERE id = ?').get(id) as any;
}

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

async function say(rig: Rig, text: string): Promise<void> {
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

async function main() {
  // =========================================================================
  section('the 09.09.2026 transcript, end to end');
  {
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לבקש מצחי את המייל שלו', DUE);

    // The router names the row it can see in `contextBlock` — #88 is a
    // reminder id, and nothing is ringing, so no instance id exists to name.
    rig.routerQueue.push({ actions: [{ action: 'complete', target_id: id }] });
    // A rewrite that CLAIMS the close, on purpose. Over a `no_open_task`
    // baseline validate.ts rule 2 discards it and the refusal ships, so the
    // two text assertions below are reading the real answer either way rather
    // than reading the stub — an "it doesn't say X" check passed by a stub
    // that never says X is worth nothing.
    rig.speakQueue.push('סגרתי את "לבקש מצחי את המייל שלו". רצף 1.');
    await withNow(NOW, () => say(rig, 'סגור את המשימה עם המייל, עשיתי'));

    const reply = rig.texts().join('\n');
    check(
      'it does not deny a task it printed the id of two lines earlier',
      !reply.includes('אין לי משימה פתוחה'),
      `got: ${reply}`,
    );
    check('it confirms the close, naming the errand', reply.includes('מצחי'), `got: ${reply}`);

    const inst = instancesOf(rig, id);
    eq('exactly one dose was opened for it', inst.length, 1);
    eq('and it is closed done, not left ringing', inst[0]?.status, 'done');
    eq(
      'filed against the 10:00 slot it belongs to, not against "now" — due_at is the idempotency key',
      Number(inst[0]?.due_at),
      DUE,
    );

    const row = reminderRow(rig, id);
    eq('the one-off is finished', row.status, 'done');
    eq('and has nothing left to fire', row.next_fire_at, null);

    // "Every write the bot makes is visible in `events`" is the invariant
    // CLAUDE.md lists as enforced by nobody, so a new write path asserts its
    // own row. Filed against the INSTANCE, which is what ID_IS_INSTANCE says
    // `instance_done.id` is — get that wrong and /why attributes the close to
    // whichever reminder happens to carry that number.
    const ev = rig.db
      .prepare("SELECT kind, reminder_id, instance_id FROM events WHERE kind = 'נסגרה'")
      .all() as any[];
    eq('the close left exactly one event row', ev.length, 1);
    eq('filed against the instance', Number(ev[0]?.instance_id), Number(inst[0]?.id));

    // The 30.08 half: the fix is only half a fix if it rings anyway.
    const before = rig.texts().length;
    rig.speakQueue.push('נו?');
    await withNow(DUE + 30_000, () => runCron(rig));
    eq('and 10:00 comes and goes in silence', rig.texts().length, before);
    rig.restore();
  }

  // =========================================================================
  section('his own words, when the router names no row');
  {
    // "סגור את הבקשה מצחי" — the model routed `complete` and gave no
    // target_id, which is what it does when the prompt has told it target_id
    // is an instance id and no instance exists.
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לבקש מצחי את המייל שלו', DUE);
    const ctx = await ctxFor(rig);

    const result = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'complete' }, 'סגור את הבקשה מצחי'),
    );
    eq('a word of his that names the row is enough', result[0]?.kind, 'instance_done');
    check(
      'and it closed that row',
      result[0]?.kind === 'instance_done' && result[0].title === 'לבקש מצחי את המייל שלו',
    );
    rig.restore();
  }

  // =========================================================================
  section('it refuses rather than guesses');
  {
    // Two rows his sentence fits equally. Guessing marks an errand he has not
    // done — the same reason matchByTitle and matchFriend return null on a tie.
    const rig = createRig();
    seedSettings(rig);
    const a = seedReminder(rig, 'לבקש מצחי את המייל שלו', DUE);
    const b = seedReminder(rig, 'לבקש מצחי את הטלפון שלו', DUE + 3_600_000);
    const ctx = await ctxFor(rig);

    const result = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'complete' }, 'סגרתי את מצחי'),
    );
    eq('a tie writes nothing', result[0]?.kind, 'nothing');
    eq('instances for the first', instancesOf(rig, a).length, 0);
    eq('instances for the second', instancesOf(rig, b).length, 0);
    rig.restore();
  }
  {
    // "סיימתי" with one scheduled row and nothing ringing. A lone OPEN
    // INSTANCE is a live question and resolves on its own; a reminder for next
    // Friday is not, and closing it on a bare "done" would be the bot deciding
    // which of his days he was talking about.
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לקנות כרטיס לחתונה של אופיר', DUE + 2 * 86_400_000);
    const ctx = await ctxFor(rig);

    const result = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'complete' }, 'סיימתי'),
    );
    eq('a bare report names nothing, so nothing is closed', result[0]?.kind, 'nothing');
    eq('and nothing was written', instancesOf(rig, id).length, 0);
    eq('the reminder is untouched', reminderRow(rig, id).next_fire_at, DUE + 2 * 86_400_000);
    rig.restore();
  }
  {
    // ctx.reminders is chat-scoped, and the resolution is against it rather
    // than against db.getReminder — so a hallucinated id belonging to somebody
    // else's row cannot be reached from here at all.
    const rig = createRig();
    seedSettings(rig);
    seedSettings(rig, OTHER);
    const hers = seedReminder(rig, 'לקחת את הרכב לטסט', DUE, { type: 'once', at: '2026-09-09T10:00' }, OTHER);
    const ctx = await ctxFor(rig);

    const result = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'complete', target_id: hers }, 'עשיתי'),
    );
    eq('another chat\'s row is not his to close', result[0]?.kind, 'nothing');
    eq('and it was not touched', instancesOf(rig, hers).length, 0);
    rig.restore();
  }

  // =========================================================================
  section('a recurring reminder closed early comes back tomorrow');
  {
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לרוץ', DUE, { type: 'daily', time: '10:00' });
    const ctx = await ctxFor(rig);

    const result = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'complete', target_id: id }, 'רצתי כבר'),
    );
    eq('today is closed', result[0]?.kind, 'instance_done');

    const row = reminderRow(rig, id);
    eq('the recurrence is not flattened into a single fire', row.status, 'scheduled');
    eq('it comes back tomorrow at 10:00', row.next_fire_at, DUE + 86_400_000);
    rig.restore();
  }

  // =========================================================================
  section('the streak counts an early close exactly like any other');
  {
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לבקש מצחי את המייל שלו', DUE);
    const before = (await db.stats(rig.env, CHAT)).currentStreak;
    const ctx = await ctxFor(rig);

    const result = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'complete', target_id: id }, 'עשיתי'),
    );
    check(
      'the streak it reports is the one /stats will show him',
      result[0]?.kind === 'instance_done' && result[0].streak === before + 1,
      `before ${before}, reported ${result[0]?.kind === 'instance_done' ? result[0].streak : '—'}`,
    );
    eq(
      'because the row it counts is a real instance',
      (await db.stats(rig.env, CHAT)).currentStreak,
      before + 1,
    );
    rig.restore();
  }

  // =========================================================================
  section('regression — something that IS ringing still wins');
  {
    /*
     * The new path must be reached only when nothing is ringing, and this is
     * the case where the ORDER is load-bearing rather than incidental: a DAILY
     * reminder that is ringing right now is still `status='scheduled'` with a
     * next_fire_at (tomorrow's dose), so it is in `ctx.reminders` at the same
     * time as it is in `ctx.open`. Both paths can resolve it, from his one
     * sentence, and they resolve DIFFERENT doses.
     *
     * Try completeEarly first and "לקחתי את הכלב" closes TOMORROW — a second
     * instance, filed against tomorrow's slot, schedule pushed to the day
     * after — while tonight's ring stays open and goes on nagging him for the
     * thing he just reported.
     *
     * Both of the first two versions of this test were VACUOUS, and by the
     * same mechanism: nothing in his sentence matched a title, so completeEarly
     * returned null whichever order it ran in and the check passed with the
     * guard deleted. "סיימתי" shares no word with anything, and — the one that
     * looked fine — "זרקתי את הזבל" shares none with "לזרוק זבל" either,
     * because matchByTitle compares WHOLE WORDS and Hebrew inflects every one
     * of them. The sentence has to hit the title exactly ("הכלב") for the two
     * paths to disagree at all. CLAUDE.md's vacuity mode 8: an assertion whose
     * other branch the suite cannot produce.
     */
    const rig = createRig();
    seedSettings(rig);
    // Burnt so the reminder ids and instance ids cannot coincide: a fresh rig
    // numbers both from 1, and "it closed instance 1" is then true of the
    // wrong row too (vacuity mode 5).
    seedReminder(rig, 'שורה שנשרפת כדי להזיז את המספרים', DUE + 9 * 86_400_000);
    seedReminder(rig, 'ועוד אחת', DUE + 10 * 86_400_000);
    const daily = seedReminder(rig, 'לקחת את הכלב', DUE + 86_400_000, {
      type: 'daily',
      time: '10:00',
    });
    const openInst = Number(
      rig.db
        .prepare(
          `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status, due_at)
           VALUES (?, ?, 'לקחת את הכלב', ?, 'open', ?)`,
        )
        .run(daily, CHAT, NOW - 60_000, DUE).lastInsertRowid,
    );
    check('the ids really do differ, or this proves nothing', openInst !== daily,
      `instance ${openInst}, reminder ${daily}`);
    const ctx = await ctxFor(rig);

    const result = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'complete' }, 'לקחתי את הכלב'),
    );
    check(
      'the dose that closed is the one that is ringing',
      result[0]?.kind === 'instance_done' && result[0].id === openInst,
      `got ${JSON.stringify(result[0])}, wanted instance ${openInst}`,
    );
    const rows = instancesOf(rig, daily);
    eq('no second dose was opened behind it', rows.length, 1);
    eq('and the ring from tonight is what got closed', rows[0]?.status, 'done');
    eq(
      'tomorrow is still tomorrow — the schedule was not pushed a day on',
      reminderRow(rig, daily).next_fire_at,
      DUE + 86_400_000,
    );
    rig.restore();
  }

  // =========================================================================
  section('the router prompt no longer sends this case to "chat"');
  {
    // A rule that matters goes in code, and the code above is the rule. But
    // the prompt's own `complete` bullet said "אם אין משימה פתוחה מתאימה,
    // החזר chat" — which instructs the model to route AWAY from the path that
    // now exists. Two places holding one rule, and this is the one that had
    // the wrong copy.
    //
    // Scoped to the bullet, not to the prompt: `contextBlock` renders titles
    // and worked examples further up, so a bare `system.includes(...)` here is
    // green with the bullet deleted entirely.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לבקש מצחי את המייל שלו', DUE);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');
    await withNow(NOW, () => say(rig, 'מה המצב'));

    const router = rig.geminiCalls.find((c) => c.kind === 'router');
    check('the router was consulted', !!router, JSON.stringify(rig.geminiCalls.map((c) => c.kind)));
    const system = router?.system ?? '';
    const from = system.indexOf('- "complete" —');
    const to = system.indexOf('- "complete_item" —');
    check('the complete bullet is still findable', from >= 0 && to > from, `from ${from}, to ${to}`);
    const bullet = system.slice(from, to);
    check(
      'it no longer routes "I did it" away when nothing is ringing',
      !bullet.includes('אם אין משימה פתוחה מתאימה, החזר "chat"'),
      `got: ${bullet}`,
    );
    check(
      'and it says a not-yet-rung reminder can be named here',
      bullet.includes('reminder id'),
      `got: ${bullet}`,
    );
    rig.restore();
  }

  // =========================================================================
  section('the close-out names what it closed');
  {
    /*
     * The other half of the same day, 09.09.2026 21:00:
     *
     *   אוקיי, המשימה נסגרה.
     *   יש לך 39 ברצף. נחמד.
     *
     * Eleven hours after his last message, with no interaction in between, over
     * a task the bot never names. Every word of it is TRUE — one instance did
     * close that day, and 39 is his streak — and it is unanswerable: "what task
     * was closed?" has no answer in it, and the baseline's own "היום" is gone,
     * so it reads as a confirmation of a write that had just happened.
     *
     * `done` was a bare count on the effect, which is what left the persona
     * with a number and no identity. The rest of the same effect carries ROWS
     * for exactly this reason, and said so in its own comment.
     */
    const rig = createRig();
    rig.db
      .prepare(
        `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
          quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
          last_brief_on, last_closeout_on)
         VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, 21, NULL, NULL)`,
      )
      .run(CHAT, TZ);
    // Closed at 10:09 and finished — nothing about it is due at 21:00.
    const id = seedReminder(rig, 'לבקש מצחי את המייל שלו', DUE);
    rig.db.prepare("UPDATE reminders SET status = 'done', next_fire_at = NULL WHERE id = ?").run(id);
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status, closed_at, due_at)
         VALUES (?, ?, 'לבקש מצחי את המייל שלו', ?, 'done', ?, ?)`,
      )
      .run(id, CHAT, DUE, DUE + 9 * 60_000, DUE);

    // The rewrite that actually shipped, verbatim.
    rig.speakQueue.push('אוקיי, המשימה נסגרה.\n\nיש לך 39 ברצף. נחמד.');
    await withNow(wallToUtc(2026, 9, 9, 21, 0, TZ), () => runCron(rig));

    const out = rig.texts().join('\n');
    check('the close-out went out at all', out.length > 0, JSON.stringify(rig.texts()));
    check(
      'and it says WHICH task closed, not just how many',
      out.includes('מצחי'),
      `got: ${out}`,
    );
    check(
      'the day is still anchored to a day',
      out.includes('היום'),
      `got: ${out}`,
    );
    check(
      'the rewrite that named nothing was discarded, so the baseline shipped',
      !out.includes('המשימה נסגרה'),
      `got: ${out}`,
    );
    rig.restore();
  }
  {
    // The floor is `mentions` — one shared word, and any of the day's closes
    // satisfies it. A rewrite that names one of two must survive, or the rule
    // is demanding fidelity rather than identity and will discard good writing.
    const closed = (id: number, title: string) =>
      ({
        id, reminder_id: 1, chat_id: CHAT, title, fired_at: NOW, next_nag_at: null,
        nag_count: 0, status: 'done', proof: null, closed_at: NOW, granted_min: 0,
      }) as any;
    const effects: Effect[] = [
      {
        kind: 'evening_closeout',
        done: [closed(20, 'לבקש מצחי את המייל שלו'), closed(21, 'לרוץ')],
        missed: [], dropped: [], ahead: [],
      },
    ];
    const rig = createRig();
    seedSettings(rig);
    const facts = buildFacts(await ctxFor(rig), effects, TZ);
    const baseline = renderBaseline(effects, TZ);

    check(
      'the baseline names both',
      baseline.includes('מצחי') && baseline.includes('לרוץ'),
      baseline,
    );
    check(
      'a rewrite that names one of them passes',
      validate('סגרת את המייל של מצחי היום. השאר יכול לחכות.', facts, baseline).ok,
      JSON.stringify(validate('סגרת את המייל של מצחי היום. השאר יכול לחכות.', facts, baseline)),
    );
    check(
      'a rewrite that names neither is rejected',
      !validate('אוקיי, המשימה נסגרה. יש לך 39 ברצף.', facts, baseline).ok,
    );
    check(
      'and quoting a closed title is not scored as an invented task',
      validate('סגרת "לרוץ" היום. יפה.', facts, baseline).ok,
      JSON.stringify(validate('סגרת "לרוץ" היום. יפה.', facts, baseline)),
    );
    rig.restore();
  }
  {
    // A day with nothing closed has no identity to require, and must not be
    // rejected for failing to name one. This is the branch that makes the rule
    // safe to have at all — and an `if` that never runs is vacuity mode 8.
    const effects: Effect[] = [
      { kind: 'evening_closeout', done: [], missed: [], dropped: [], ahead: [] },
    ];
    const rig = createRig();
    seedSettings(rig);
    const facts = buildFacts(await ctxFor(rig), effects, TZ);
    const baseline = renderBaseline(effects, TZ);
    check('an empty day still says something', baseline.includes('לא סגרת כלום'), baseline);
    check(
      'and any rewrite of it is allowed to name nothing',
      validate('יום ריק. מחר ננסה שוב.', facts, baseline).ok,
      JSON.stringify(validate('יום ריק. מחר ננסה שוב.', facts, baseline)),
    );
    rig.restore();
  }
  {
    // Capped and the remainder COUNTED. A wall of eleven quoted titles is not
    // a summary of a day, and silently dropping seven of them is worse.
    const closed = (id: number, title: string) =>
      ({
        id, reminder_id: 1, chat_id: CHAT, title, fired_at: NOW, next_nag_at: null,
        nag_count: 0, status: 'done', proof: null, closed_at: NOW, granted_min: 0,
      }) as any;
    const six = ['אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש'].map((t, i) => closed(20 + i, t));
    const baseline = renderBaseline(
      [{ kind: 'evening_closeout', done: six, missed: [], dropped: [], ahead: [] }],
      TZ,
    );
    check('the count is the true one', baseline.includes('6'), baseline);
    // What the facts.ts sweep of `done` actually buys, and the only thing it
    // does: "חמש" is a true close that the baseline never quotes, so without
    // the sweep rule 3 scores it an invented task and throws away a rewrite
    // that was right. The named four are covered by validate's baseline fold
    // with or without facts.ts, which is why asserting on one of THOSE was
    // vacuous — it passed with the sweep deleted.
    const rig6 = createRig();
    seedSettings(rig6);
    const facts6 = buildFacts(
      await ctxFor(rig6),
      [{ kind: 'evening_closeout', done: six, missed: [], dropped: [], ahead: [] }],
      TZ,
    );
    check(
      'a close the baseline did not name is still a true thing to say',
      validate('סגרת 6 היום, "חמש" ביניהן.', facts6, baseline).ok,
      JSON.stringify(validate('סגרת 6 היום, "חמש" ביניהן.', facts6, baseline)),
    );
    rig6.restore();
    check('the first few are named', baseline.includes('אחת') && baseline.includes('ארבע'), baseline);
    check(
      'and the ones it did not name are counted, not dropped',
      baseline.includes('ועוד 2'),
      baseline,
    );
    check('so the tail is not silently missing', !baseline.includes('שש'), baseline);
  }

  done();
}

main();
