/**
 * Run with `npm run test:v38`.
 *
 * **A repeat rule he stated became a single fire, and said so out loud.**
 *
 * CLAUDE.md has carried the rule since the time seam was built — "A repeat
 * rule must never be flattened into a single fire — that ENDS the recurrence.
 * → `when.readWhen`" — and the thing enforcing it was `RECURRING.test(t)`, one
 * regex, read by both `readWhen` and `quickParse`. A regex is a lexicon, and
 * the rule only held for the phrasings that were in it.
 *
 * Production, 30.09.2026, three attempts at one reminder:
 *
 *   21:32  him  תזכיר לי פעם בשבוע בימי שני בשנה 8 בערב להשקות את העציץ
 *   21:32  bot  תפסתי את #95: "להשקות את העציץּל".
 *   21:34  him  תבטל
 *   21:34  bot  ביטלתי את #95 "95".
 *   22:19  him  תזכיר לי פעם בשבוע בימי שני בשעה 8 בערב להשקות את העציץ
 *   22:19  bot  קבעתי #96: "פעם בשבוע בימי שני להשקות את העציץ"
 *                — יום ה׳, 01.10.2026, 20:00.
 *   22:29  him  תזכיר לי כל שבוע בים שני בשעה 8 בערב להשקות את העציץ
 *   22:29  bot  תפסתי #97: "להשקות את העציץשקות את העציץ". בלי שעה בינתיים.
 *
 * #96 is the one that matters and it is not a miss, it is a **confident wrong
 * answer** — the thing rule 2 at the top of quickparse.ts calls the whole
 * design and forbids. `פעם בשבוע` is absent from `RECURRING`, so:
 *
 *   - `readWhen` never reached its repeat-rule arm and returned an `instant`
 *   - `quickParse` never reached `parseRecurring` and took the clock path
 *   - `hasTimeResidue` did not object, because `WEEKDAY_RESIDUE` knows
 *     `ביום שני` and `בשני` and has never known the PLURAL `בימי שני`
 *
 * So the repeat phrase was left in the TITLE as decoration and the row was
 * written `once`, on a Thursday, for a reminder he asked to repeat on Mondays.
 * Nothing downstream could catch it: `validate` compares the reply against the
 * effect, and the effect was faithful to a schedule that was already wrong.
 *
 * What must hold — and the third one is the point, because the first two are
 * still lexicons:
 *
 *   1. `RECURRING` knows the phrasings he actually types.
 *   2. `WEEKDAY_RESIDUE` sees the plural `בימי`.
 *   3. **No path may turn a repeat rule into a `once`, even when the ROUTER
 *      asks for it.** `preferHisWords` refuses the combination outright, so
 *      the next phrasing missing from the lexicon costs a capture and a
 *      question rather than a wrong write. That is the guard that does not
 *      need the lexicon to be complete.
 *
 * Plus the two other bugs in the same transcript:
 *
 *   4. The stored titles. `העציץּל` is U+05BC DAGESH plus a stray ל, and
 *      `העציץשקות את העציץ` is a partial self-repeat. `FOREIGN_SCRIPT` is an
 *      allow-list containing `\p{Script=Hebrew}`, and every niqqud and
 *      cantillation mark in Unicode is Script=Hebrew — so the guard CLAUDE.md
 *      describes as catching "any SCRIPT absent from his message" waves both
 *      through.
 *   5. `ביטלתי את #95 "95"`. The delete arm resolves through `ctx.reminders`,
 *      which is `listReminders` (status='scheduled') plus the ringing rows —
 *      an inbox capture lives in `ctx.inbox` and is invisible to it. So the
 *      title fell back to `String(target_id)` and the bot quoted him an errand
 *      he never wrote. Same shape as `completeEarly` resolving against
 *      `ctx.open` alone.
 */
import worker from '../src/index';
import { applyIntent, titleFromHisWords } from '../src/effects';
import type { Context } from '../src/brain';
import { readWhen } from '../src/when';
import { quickParse } from '../src/quickparse';
import * as db from '../src/db';
import { wallToUtc, wallString } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

async function runWebhook(rig: Rig, text: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException() {},
  };
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

/** 30.09.2026 22:19 — the minute #96 was written. */
const NOW = wallToUtc(2026, 9, 30, 22, 19, TZ);

const PLANT = 'להשקות את העציץ';
/** His message, with the בשנה/בשעה typo corrected — the #96 turn. */
const WEEKLY = `תזכיר לי פעם בשבוע בימי שני בשעה 8 בערב ${PLANT}`;

function seedSettings(rig: Rig, awaiting: string | null = null): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on, awaiting)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL, ?)`,
    )
    .run(CHAT, TZ, awaiting);
}

function seedInbox(rig: Rig, title: string): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
       VALUES (?, ?, '', ?, NULL, 'inbox', 1, ?)`,
    )
    .run(CHAT, title, TZ, NOW);
  return Number(r.lastInsertRowid);
}

async function ctxFor(rig: Rig): Promise<Context> {
  const settings = await db.getSettings(rig.env, CHAT);
  return {
    settings,
    stats: await db.stats(rig.env, CHAT),
    reminders: await db.listReminders(rig.env, CHAT),
    goals: [],
    open: [],
    inbox: await db.listInbox(rig.env, CHAT),
    friends: [],
    done: [],
  } as unknown as Context;
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section('readWhen refuses the repeat rule it could not previously see');
  {
    const cases: [string, string][] = [
      ['פעם בשבוע', WEEKLY],
      ['בימי <day> ו<day>', `תזכיר לי בימי שני ורביעי ב20:00 ${PLANT}`],
      ['כל חודש', 'תזכיר לי כל חודש ב10 בשעה 9 לשלם שכירות'],
      ['כל שנה', 'תזכיר לי כל שנה ב15.3 בשעה 9 יום הולדת לאמא'],
      ['פעם ביום', 'תזכיר לי פעם ביום בשעה 8 לקחת תרופה'],
      ['בסוף כל חודש', 'תזכיר לי בסוף כל חודש בשעה 9 לשלם שכירות'],
      ['ימי חול', 'תזכיר לי בימי חול בשעה 7 לקום'],
    ];
    for (const [label, text] of cases) {
      const w = readWhen(text, NOW, TZ);
      check(
        `${label} → ambiguous/repeat-rule`,
        w.kind === 'ambiguous' && w.why === 'repeat-rule',
        `got ${JSON.stringify(w)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  section('quickParse never writes a `once` for a repeat rule');
  {
    /*
     * Each case names the schedules that would be a WRONG WRITE for it, and
     * asserts against exactly those. Deliberately not a blanket "returns
     * null": 0.39.0 teaches parseRecurring most of these, and an assertion
     * that accepts either answer is passed by whichever is easiest — harness
     * mode 8. Deliberately not a blanket "not a one-off" either: that is the
     * version of this check I first wrote, and `כל יום חוץ משבת` PASSED it
     * while returning `daily`, which fires on the Saturday he excluded.
     */
    const cases: [string, string, string[]][] = [
      ['פעם בשבוע', WEEKLY, ['once']],
      ['בימי <day> ו<day>', `תזכיר לי בימי שני ורביעי ב20:00 ${PLANT}`, ['once', 'daily']],
      ['כל שבוע ביום <day>', `תזכיר לי כל שבוע ביום שני בשעה 8 בערב ${PLANT}`, ['once', 'daily']],
      // A month is not a day and not a week: every one of those three would
      // ring on days he did not ask for.
      ['כל חודש', 'תזכיר לי כל חודש ב10 בשעה 9 לשלם שכירות', ['once', 'daily', 'weekly']],
      ['ימי חול', 'תזכיר לי בימי חול בשעה 7 לקום', ['once', 'daily']],
      ['כל יום חוץ מ<day>', 'תזכיר לי כל יום חוץ משבת בשעה 7 לקום', ['once', 'daily']],
      /*
       * These two are the ones that reach REPEAT_RESIDUE, and they are here
       * because the red-proof said so: with the other cases alone, deleting
       * the REPEAT_RESIDUE line from `hasTimeResidue` left the suite GREEN —
       * harness mode 2, two guards and one bug, with the widened RECURRING
       * catching everything on its own.
       *
       * RE_DAILY eats the "כל יום" off the front of both and leaves the
       * qualifier behind, so the message is recurrence-shaped and the TITLE is
       * not. `daily` here means it rings on Saturday.
       */
      ['כל יום חול', 'תזכיר לי כל יום חול בשעה 7 לקום', ['once', 'daily']],
      ['כל יום עבודה', 'תזכיר לי כל יום עבודה בשעה 7 לקום', ['once', 'daily']],
    ];
    for (const [label, text, forbidden] of cases) {
      const q = quickParse(text, NOW, TZ);
      check(
        `${label} → never ${forbidden.join('/')}`,
        q === null || !forbidden.includes(q.schedule_type ?? ''),
        `got ${JSON.stringify(q)}`,
      );
      check(
        `${label} → no repeat phrase left in the title`,
        q === null || !/פעם\s+ב|כל\s+(?:שבוע|חודש|שנה|יום)|ימי\s|חוץ\s+מ/.test(q.title ?? ''),
        `title: ${JSON.stringify(q?.title)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  section('the plural "בימי שני" is a weekday left in the title');
  {
    // The singular has been residue since the residue check existed. The
    // plural is one letter away and was invisible, which is half of why #96
    // sailed through: `ביום שני` would have bailed to the router, `בימי שני`
    // did not.
    const q = quickParse(`תזכיר לי מחר ב20:00 ${PLANT} בימי שני`, NOW, TZ);
    check(
      'a pinned day does not excuse it',
      q === null || !/בימי\s+שני/.test(q.title ?? ''),
      `got ${JSON.stringify(q)}`,
    );
  }

  // -------------------------------------------------------------------------
  section('a ROUTER `once` over a repeat rule is refused, not written');
  {
    // The guard that does not depend on the lexicon being complete. Even with
    // `פעם בשבוע` unknown to every regex in the codebase, the combination
    // "his sentence states a repeat rule" + "the intent is a single fire" is
    // decidable, and it is the one combination that can end a recurrence.
    const rig = createRig();
    seedSettings(rig);
    const ctx = await ctxFor(rig);

    const out = await withNow(NOW, () =>
      applyIntent(
        rig.env,
        CHAT,
        ctx,
        {
          action: 'create_reminder',
          title: PLANT,
          schedule_type: 'once',
          once_at: wallString(wallToUtc(2026, 10, 1, 20, 0, TZ), TZ),
        },
        WEEKLY,
      ),
    );

    eq('it captures instead', out[0]?.kind, 'reminder_captured');
    const rows = rig.db
      .prepare("SELECT schedule, status FROM reminders WHERE chat_id = ?")
      .all(CHAT) as { schedule: string; status: string }[];
    eq('exactly one row was written', rows.length, 1);
    check(
      'and it carries no `once` schedule',
      !rows.some((r) => r.schedule.includes('"once"')),
      `rows: ${JSON.stringify(rows)}`,
    );
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('a corrupted title is not his words');
  {
    // #95: U+05BC HEBREW POINT DAGESH, then a stray ל. Script=Hebrew, so the
    // allow-list waves it through; `ץ` is a FINAL letter with a letter after
    // it, which is not something Hebrew spelling can produce.
    const dagesh = titleFromHisWords('להשקות את העציץּל', WEEKLY);
    check(
      'the dagesh + stray letter goes',
      !dagesh.includes('ּ') && !/ץ[֑-ׇ]*[א-ת]/.test(dagesh),
      `got ${JSON.stringify(dagesh)}`,
    );

    // #97: a partial self-repeat. `cutSelfRepeat` needs the leading run to
    // recur whole and this one restarts mid-word, so it survived that too.
    const repeat = titleFromHisWords('להשקות את העציץשקות את העציץ', WEEKLY);
    check(
      'the partial self-repeat goes',
      !/ץ[֑-ׇ]*[א-ת]/.test(repeat),
      `got ${JSON.stringify(repeat)}`,
    );

    /*
     * POINTED HEBREW WITH NO FINAL LETTER MID-WORD — and this case exists
     * because the red-proof demanded it.
     *
     * With only the two cases above, deleting the Hebrew-point pass left the
     * suite green: #95's dagesh sits right next to a final ץ, so
     * FINAL_MIDWORD caught it and the point filter was never the thing under
     * test. Harness mode 2 — two guards, one bug.
     *
     * This title has no final letter followed by anything, so FINAL_MIDWORD
     * cannot see it, and the only reason it is wrong is that this bot writes
     * unpointed Hebrew and he did not type these marks.
     */
    const pointed = titleFromHisWords('לְהַשְׁקוֹת אֶת הֶעָצִיץ', WEEKLY);
    check(
      'niqqud he never typed goes',
      !/[֑-ׇ]/.test(pointed) && pointed.length > 0,
      `got ${JSON.stringify(pointed)}`,
    );

    // Two controls, and both matter. A clean title has to survive untouched...
    eq('a clean title is untouched', titleFromHisWords(PLANT, WEEKLY), PLANT);
    // ...and his OWN typo is his. #92 is stored "ללכת לסופר םארם", a final מ
    // opening a word, because that is what he typed — and the whole discipline
    // of this filter is that only what is ABSENT from his message is removed.
    eq(
      'his own typo stays',
      titleFromHisWords('ללכת לסופר םארם', 'תזכיר לי ללכת לסופר םארם מחר ב10:30'),
      'ללכת לסופר םארם',
    );
  }

  // -------------------------------------------------------------------------
  section('deleting a capture names the capture');
  {
    const rig = createRig();
    seedSettings(rig);
    // Burn a row first so the reminder id and any other id cannot coincide —
    // harness mode 5. The capture must not be id 1.
    seedInbox(rig, 'burn');
    const id = seedInbox(rig, PLANT);
    const ctx = await ctxFor(rig);
    check('the capture is invisible to ctx.reminders', !ctx.reminders.some((r) => r.id === id));

    const out = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'delete', target_id: id }, 'תבטל'),
    );
    eq('it deleted something', out[0]?.kind, 'reminder_deleted');
    check(
      'and named the errand, not the id',
      out[0]?.kind === 'reminder_deleted' && out[0].title === PLANT,
      `got ${JSON.stringify(out[0])}`,
    );
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('an expired awaiting slot is cleared from the column');
  {
    // Production: chat 701531870 still held {"k":"time","r":77,...} armed on
    // 03.09.2026 — twenty-seven days, across turns that asked nothing. The
    // clearing branch is `else if (awaiting)`, and `awaiting` is the result of
    // `readAwaiting`, which returns null once the TTL has passed. So the one
    // case that needs clearing is the one case that cannot reach the clear.
    //
    // Behaviour is currently correct — every read re-checks the TTL — so this
    // asserts the COLUMN, which is the only place the bug is visible.
    const stale = JSON.stringify({ k: 'time', r: 77, at: NOW - db.AWAITING_TTL_MS - 60_000 });
    const rig = createRig();
    seedSettings(rig, stale);

    // Two assertions, because they are two different facts. The read is
    // already correct — that is why the bug is invisible in behaviour...
    check('readAwaiting already ignores it', db.readAwaiting(stale, NOW) === null);
    // ...and this is the one that goes red: something has to be able to tell
    // "the column holds a question" apart from "the question is live".
    check('but the column still holds a question', db.heldAwaiting(stale));

    // The real path. A plain chat turn asks nothing and writes nothing, which
    // is exactly the shape that left the row behind for twenty-seven days.
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');
    await withNow(NOW, () => runWebhook(rig, 'מה קורה'));

    const row = rig.db
      .prepare('SELECT awaiting FROM settings WHERE chat_id = ?')
      .get(CHAT) as { awaiting: string | null };
    eq('the column is cleared', row.awaiting, null);
    rig.restore();
  }

  done();
}

main();
