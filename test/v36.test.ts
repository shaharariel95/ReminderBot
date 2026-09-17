/**
 * Run with `npm run test:v36`.
 *
 * **The bot sent him its own prompt.**
 *
 * Production, 14.09.2026, the evening close-out. Four messages went out, and
 * the first two were the scaffolding the persona call is built from:
 *
 *   21:00  bot  מה שקרה עכשיו:
 *               סגרת 1 היום: "לדבר עם פרטנר להוריד מחיר חבילת סלולר".
 *               ויתרתי על אלה היום:
 *               · לקנות כרטיס לחתונה של אופיר
 *   21:01  bot  הנחיות:
 *               - לנסח מחדש בקול שלך.
 *               - מותר: שינוי ניסוח, עוקץ, פיצול להודעות, שאלה קצרה.
 *               - אסור להוסיף שעה, תאריך, שם משימה, מספר או הבטחה שלא כתובים למעלה.
 *               - אישור קצר = הודעה אחת.
 *               - שעות בספרות אם יש (אין פה).
 *               - בלי מרכאות, בלי הקדמות.
 *   21:01  bot  משימה אחת סגורה, אחת זרקת לפח.
 *   21:01  bot  לפחות הסלולר סודר. מה עושים מחר עם הכרטיס?
 *
 * Then again ninety seconds later, over a `needs_time`, where the echoed
 * instruction block carried the model's reasoning out loud with it — "אין
 * משימה כזו ב'מה שקרה עכשיו'... אה, רגע: השאלה היא ...".
 *
 * The model restated its task before doing it, and the whole thing shipped.
 * `sendBurst` splits on blank lines and caps at four, so the two real
 * messages were the two that nearly did not fit.
 *
 * **Why all seven rules passed.** Rules 1-4 ask "did the model INVENT this?"
 * — an echo invents nothing, and `validate` folds the baseline into its own
 * allow-lists, so quoting the baseline back verbatim is the most permitted
 * thing there is. Rules 5-7 ask the opposite, "did it say LESS?" — the echo
 * says strictly MORE. A rewrite that reproduces its own prompt is neither,
 * and nothing in the pipeline was looking at whether the reply was a chat
 * message at all.
 *
 * The only thing standing against it was a line in the prompt: "רק את
 * ההודעות עצמן, בלי הקדמות ובלי מרכאות מסביב". A rule that matters goes in
 * code.
 *
 * What must hold:
 *
 *   - a rewrite carrying one of the prompt's own section labels is thrown
 *     away, and he gets the baseline — which was true, and was the thing
 *     being crowded out of the burst
 *   - the label list is the one the prompt is actually built from, or it
 *     rots into a second stale copy the first time a heading is reworded
 *   - a bulleted document is refused on its SHAPE, with no lexicon: that is
 *     what catches the "הנחיות" half, which quotes no heading at all
 *   - one stray dash is not a document. The floor is a LIST.
 */
import worker from '../src/index';
import { buildFacts } from '../src/facts';
import { renderBaseline } from '../src/voice';
import { validate } from '../src/validate';
import { PROMPT_LABELS, buildSystemPrompt } from '../src/persona';
import { speak } from '../src/brain';
import type { Context } from '../src/brain';
import type { Effect, Instance, Settings, Stats } from '../src/types';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

/** 14.09.2026 21:00 — the close-out slot. */
const NOW = wallToUtc(2026, 9, 14, 21, 0, TZ);

const settings: Settings = {
  chat_id: CHAT, tz: TZ, intensity: 2, muted_until: null, off_limits: null,
  checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
  next_checkin_at: null, awaiting: null,
  brief_hour: 9, closeout_hour: 21, last_brief_on: null, last_closeout_on: null,
  display_name: 'שחר',
};
const stats: Stats = { done7: 3, failed7: 2, done30: 20, failed30: 8, currentStreak: 40 };

const inst = (id: number, title: string, status: Instance['status']): Instance =>
  ({
    id, reminder_id: id, chat_id: CHAT, title, fired_at: NOW - 3_600_000,
    next_nag_at: null, nag_count: 0, status, proof: null, closed_at: NOW, granted_min: 0,
  }) as Instance;

const CELL = 'לדבר עם פרטנר להוריד מחיר חבילת סלולר';
const TICKET = 'לקנות כרטיס לחתונה של אופיר';

/** The effects behind the 21:00 message. */
const CLOSEOUT: Effect = {
  kind: 'evening_closeout',
  done: [inst(90, CELL, 'done')],
  missed: [],
  dropped: [inst(80, TICKET, 'failed')],
  ahead: [],
};
/** The effects behind the 21:02 message. */
const ASKED: Effect = { kind: 'needs_time', id: 90, title: CELL };

function facts(effects: Effect[], ctx: Partial<Context> = {}) {
  return buildFacts(
    { settings, stats, reminders: [], goals: [], open: [], nowLabel: 'עכשיו', ...ctx },
    effects,
    TZ,
  );
}
const base = (effects: Effect[]) => renderBaseline(effects, TZ);

/** Exactly what shipped at 21:00, blank lines and all. */
const LEAK_CLOSEOUT = `מה שקרה עכשיו:
סגרת 1 היום: "${CELL}".
ויתרתי על אלה היום:
· ${TICKET}

הנחיות:
- לנסח מחדש בקול שלך.
- מותר: שינוי ניסוח, עוקץ, פיצול להודעות, שאלה קצרה.
- אסור להוסיף שעה, תאריך, שם משימה, מספר או הבטחה שלא כתובים למעלה.
- אישור קצר = הודעה אחת.
- שעות בספרות אם יש (אין פה).
- בלי מרכאות, בלי הקדמות.

משימה אחת סגורה, אחת זרקת לפח.

לפחות הסלולר סודר. מה עושים מחר עם הכרטיס?`;

/** And at 21:02, over the needs_time. */
const LEAK_NEEDS_TIME = `מה שקרה עכשיו:
מתי לשים את "${CELL}"?

הנחיות:
- לנסח מחדש בקול שלך.
- שאלת עובדה פשוטה. תן תשובה ישירה לפי הנתונים.
- ענה ישירות על השאלה: מתי שמים את המשימה הזו?

מתי לשים את "${CELL}"?

תן שעה ויום ונסגור את זה.`;

/**
 * `rejections` #15, 07.09.2026 20:26 — the same leak a week earlier, pulled
 * out of production verbatim.
 *
 * It was caught, and caught by ACCIDENT: the third bullet quotes the heading,
 * so rule 3 scored "מה שקרה עכשיו" an invented task. Nothing was looking at
 * the shape, so when the same thing arrived on 14.09 without the quote marks
 * it shipped. This case therefore asserts the REASON, not just the refusal —
 * "rejected" is true of it either way, and that is exactly the trap.
 */
const LEAK_0709 = `מה שקרה עכשיו: קבעתי #85: "לשלוח לשחר הודעה שעבד" — פעם אחת ב-07.09 בשעה 20:28. הראשונה ב-יום ב׳, 07.09.2026, 20:28.

משימה: לנסח את זה מחדש בקול שלי.
חוקים:
- אישור קצר = הודעה אחת.
- בלי שקרים — תאריך ושעה בדיוק כמו ב"מה שקרה עכשיו": 07.09 בשעה 20:28 (או בספרות שצוינו).
- מספר תזכורת: #85.
- בלי עובדות חדשות.

ניסוח:
רשמתי.

#85 — 20:28.`;

/**
 * The FIRST message of the 21:00 burst on its own, exactly as he received it.
 *
 * Carried separately because the full leak above trips both halves of rule 8
 * at once, and two guards over one bug prove neither when only one is deleted.
 * This half has no bullet in it: the heading scan is the only thing that can
 * refuse it.
 */
const LEAK_HEADING_ONLY = `מה שקרה עכשיו:
סגרת 1 היום: "${CELL}".
ויתרתי על אלה היום:
· ${TICKET}`;

/**
 * And the second message on its own — it quotes no heading of the prompt at
 * all, so only its SHAPE gives it away.
 *
 * Worded to pass all seven of the other rules, and that is not decoration.
 * The first draft opened "סגרת אחת היום, אחת נפלה" and named nothing, so rule
 * 7 refused it and deleting the bullet scan left the suite green — two guards
 * over one bug, which proves neither. It names the errand it closed and uses
 * only close verbs an `evening_closeout` is entitled to, so rule 8 is the only
 * thing left standing between this and the user.
 */
const LEAK_INSTRUCTIONS_ONLY = `סגרת את ${CELL} היום, והכרטיס נפל.

- לנסח מחדש בקול שלך.
- מותר: שינוי ניסוח, עוקץ, פיצול להודעות.
- בלי מרכאות, בלי הקדמות.`;

/**
 * The same shape over an ordinary chat turn, for the end-to-end. Carries no
 * claim verb and names nothing, because on a `nothing` turn rule 2 refuses
 * every close verb there is — and that would mask rule 8 exactly the way rule
 * 7 did above.
 */
const LEAK_BULLETS_IN_CHAT = `מה איתך היום?

- קודם אחד.
- אחר כך השני.
- ובלי תירוצים.`;

async function main(): Promise<void> {
  section('the message that shipped is thrown away');
  {
    const v = validate(LEAK_CLOSEOUT, facts([CLOSEOUT]), base([CLOSEOUT]));
    check('the 21:00 close-out rewrite is rejected', !v.ok, `verdict: ${JSON.stringify(v)}`);
    const v2 = validate(LEAK_NEEDS_TIME, facts([ASKED]), base([ASKED]));
    check('and so is the 21:02 one', !v2.ok, `verdict: ${JSON.stringify(v2)}`);
    // The half with no bullet in it, so the heading scan is on its own here.
    const v3 = validate(LEAK_HEADING_ONLY, facts([CLOSEOUT]), base([CLOSEOUT]));
    check('the heading alone is enough, with no bullet under it', !v3.ok,
      `verdict: ${JSON.stringify(v3)}`);

    // 07.09, which rule 3 caught by luck. The REASON is the assertion: this
    // one is rejected with or without rule 8, and only the reason says which
    // guard did it.
    const created: Effect = {
      kind: 'reminder_created', id: 85, title: 'לשלוח לשחר הודעה שעבד',
      at: wallToUtc(2026, 9, 7, 20, 28, TZ),
      schedule: { type: 'once', at: '2026-09-07T20:28' }, requiresProof: false,
    };
    const v4 = validate(LEAK_0709, facts([created]), base([created]));
    check('the 07.09 leak is refused for being the prompt, not for a quote',
      v4.reason?.startsWith('wrote the prompt back') === true,
      `verdict: ${JSON.stringify(v4)}`);
  }

  section('the instruction block is caught by its shape, not by its words');
  {
    const v = validate(LEAK_INSTRUCTIONS_ONLY, facts([CLOSEOUT]), base([CLOSEOUT]));
    check('a bulleted list quoting no heading is still refused', !v.ok,
      `verdict: ${JSON.stringify(v)}`);
  }

  section('and a chat message is still a chat message');
  {
    // The two real messages out of that same burst, which is what he should
    // have got, plus the ones from the days around it. None may be refused.
    const CHAT_ONLY: Effect = { kind: 'nothing', why: 'chat', userText: 'סתום את הפה' };
    const good: [string, Effect[]][] = [
      // The two real messages out of that same burst — what he should have got.
      [`סגרת את הסלולר, ${TICKET} זרקת לפח.\n\nמה עושים מחר עם הכרטיס?`, [CLOSEOUT]],
      [`נסגר: "${CELL}". רצף 40.`, [CLOSEOUT]],
      ['בסדר, מחר.', [CHAT_ONLY]],
      // A single dash is punctuation, not a document. The floor is a LIST —
      // without it, one dashed line of ordinary Hebrew costs the whole rewrite.
      [`סגרת אחת היום — ${CELL}.\n- וגם זה מאחוריך.`, [CLOSEOUT]],
    ];
    for (const [text, effects] of good) {
      const v = validate(text, facts(effects), base(effects));
      check(`"${text.slice(0, 40).replace(/\n/g, ' ⏎ ')}" survives`, v.ok,
        `verdict: ${JSON.stringify(v)}`);
    }
  }

  section('the labels are the ones the prompt is actually built from');
  {
    // Without this the list is a second copy: reword a heading in persona.ts
    // and the validator goes on guarding a string nothing emits any more,
    // silently, which is the drift half the rules in CLAUDE.md exist to stop.
    const system = buildSystemPrompt(
      settings, stats, 'יום ב׳, 14.09.2026, 21:00',
      '  (אין)', '  (אין)', '  (אין)',
      ['הוא שונא טלפונים'],
    );
    // The two the persona prompt does not own live in brain.speak, so they are
    // checked against a real speak() call below rather than against this.
    const fromSpeak = new Set(['מה שקרה עכשיו', 'כמה זמן זה כבר פתוח', 'הנחיית טון לתשובה הזאת']);
    for (const label of PROMPT_LABELS) {
      if (fromSpeak.has(label)) continue;
      check(`"${label}" is a heading persona.ts still writes`, system.includes(label));
    }

    const rig = createRig({ chatId: CHAT });
    rig.speakQueue.push('סבבה.');
    await withNow(NOW, async () => {
      await speak(
        rig.env,
        facts([CLOSEOUT], {
          open: [inst(80, TICKET, 'open')],
        }),
        [{ role: 'user', text: 'מה קורה' }],
        base([CLOSEOUT]),
        'תהיה רך איתו',
        'summarising',
      );
    });
    const system2 = rig.geminiCalls.find((c) => c.kind === 'speak')?.system ?? '';
    check('speak() was actually called', !!system2);
    for (const label of fromSpeak) {
      check(`"${label}" is a heading brain.speak still writes`, system2.includes(label),
        `not in: ${system2.slice(-1200)}`);
    }
    rig.restore();
  }

  /*
   * 0.36.1. Four of the last five rows in production's `rejections` table are
   * rule 2 firing on something that is not a claim. The table is the
   * instrument /diag exists to expose and nobody had read it — which is the
   * same failure the 07.09 leak sat in for a week.
   */
  section('rule 2 — the nag ladder\'s own future tense is not a claim');
  {
    // rejections #18, #19, #20 — 11.09 and 14.09 twice, all `claimed a write
    // with no effect (סגרת)`. persona.NAG_LADDER asks for exactly this shape:
    // shrink the ask, end on one concrete action and how little it costs.
    const NAGGED: Effect = {
      kind: 'nagged', instanceId: 72, title: TICKET, since: NOW - 7_260_000,
      round: 2, granted: 0,
    };
    const BRIEF: Effect = { kind: 'morning_brief', rows: [], openCount: 1 };
    for (const [text, effects] of [
      [`נו? "${TICKET}" עדיין מחכה.\n\nחמש דקות וסגרת את זה.`, [NAGGED]],
      [`${TICKET} יושב שם.\n\nשתי דקות עבודה וסגרת את זה.`, [NAGGED]],
      [`בוקר. היום יש לך משימה אחת.\n\nחצי דקה וסגרת את זה.`, [BRIEF]],
    ] as [string, Effect[]][]) {
      const v = validate(text, facts(effects), base(effects));
      check(`"${text.split('\n').pop()}" survives`, v.ok, `verdict: ${JSON.stringify(v)}`);
    }
  }

  section('rule 2 — an OFFER to schedule is a question, not a write');
  {
    // rejection #21, 16.09 21:34 — the last message he got, and he got the
    // flat baseline instead. Day three of a task nobody had touched, and the
    // version that asked him something was the one thrown away.
    const GAVE_UP: Effect = { kind: 'gave_up', instanceId: 72, title: TICKET, rounds: 4 };
    const v = validate(
      `כרטיס לחתונה של אופיר ירד להיום.\n\nרוצה שנקבע את זה למחר או שאתה נותן לזה לברוח?`,
      facts([GAVE_UP]), base([GAVE_UP]),
    );
    check('"רוצה שנקבע את זה למחר" survives a gave_up', v.ok, `verdict: ${JSON.stringify(v)}`);
  }

  section('rule 2 — a mute IS a write');
  {
    // rejection #16, 07.09. `muted` is in types.WROTE and was in no claim
    // group, so the one verb that fits it was refused.
    const MUTED: Effect = { kind: 'muted', until: NOW + 54_000_000, hours: 15 };
    const DONE: Effect = { kind: 'instance_done', id: 72, title: TICKET, streak: 40 };
    const v = validate('רשמתי. שקט עד מחר.\n\nלילה טוב.', facts([DONE, MUTED]), base([DONE, MUTED]));
    check('"רשמתי" survives a mute', v.ok, `verdict: ${JSON.stringify(v)}`);
  }

  section('and rule 2 still has its teeth');
  {
    // The half that matters. Every one of these is the lie the rule exists
    // for, and the three scopings above must not reach any of them.
    const NOTHING: Effect = { kind: 'nothing', why: 'chat', userText: 'מה קורה' };
    const NO_TASK: Effect = { kind: 'nothing', why: 'no_open_task', userText: 'סיימתי' };
    for (const [text, effects] of [
      // 30.08.2026, the message the second person was added for.
      ['יפה שסגרת את זה מוקדם.', [NO_TASK]],
      // rejection #17, 09.09.
      ['סגרתי.\n\nלפחות צחי לא יצטרך לחכות לך שבוע.', [NOTHING]],
      // A claim about a schedule with nothing scheduled.
      ['נקבע ל-20:00, אל תתלונן.', [NOTHING]],
      // "ו + סגרת" with no duration in front of it is not the ladder's idiom,
      // it is a report. The scoping must not swallow it.
      ['דיברנו וסגרת את זה.', [NOTHING]],
    ] as [string, Effect[]][]) {
      const v = validate(text, facts(effects), base(effects));
      check(`"${text.split('\n')[0]}" is still refused`, !v.ok, `verdict: ${JSON.stringify(v)}`);
    }
  }

  section('end to end: he gets the baseline, and the rejection is on the record');
  {
    const rig = createRig({ chatId: CHAT });
    seed(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push(LEAK_BULLETS_IN_CHAT);
    await withNow(NOW, async () => {
      await runWebhook(rig, 'מה קורה');
    });
    const out = rig.texts().join('\n');
    check('the bulleted document never reaches him', !out.includes('ובלי תירוצים'),
      `sent: ${out}`);
    const rejections = rig.db
      .prepare('SELECT COUNT(*) AS n FROM rejections')
      .get() as { n: number };
    eq('and the rejection is written down, not just counted in a log line',
      rejections.n, 1);
    rig.restore();
  }

  done();
}

function seed(rig: Rig): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, quiet_start_hour, quiet_end_hour,
                             brief_hour, closeout_hour, checkins_enabled, checkin_per_day)
       VALUES (?, ?, 2, 23, 8, 9, 21, 0, 2)`,
    )
    .run(CHAT, TZ);
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
  await (worker as any).fetch(req, rig.env, ctx);
  await Promise.all(pending);
}

main();
