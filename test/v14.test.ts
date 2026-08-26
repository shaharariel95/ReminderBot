/**
 * Run with `npm run test:v14`.
 *
 * The failures production actually produced after 0.14.0 shipped, each pinned
 * by the row or the message that recorded it. Every block names the symptom
 * the user saw, so a regression here is legible without re-deriving the bug
 * from the database.
 */
import worker from '../src/index';
import { validate } from '../src/validate';
import { splitIntoItems } from '../src/effects';
import { buildFacts } from '../src/facts';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Context } from '../src/brain';
import type { Effect, Facts } from '../src/types';

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
       VALUES (?, ?, 2, 0, 0, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      CHAT, TZ,
      (over.quiet_start_hour ?? 23) as any,
      (over.quiet_end_hour ?? 8) as any,
      (over.brief_hour ?? null) as any,
      (over.closeout_hour ?? null) as any,
      (over.last_brief_on ?? null) as any,
      (over.last_closeout_on ?? null) as any,
    );
}

function seedReminder(
  rig: Rig,
  title: string,
  dueAt: number,
  schedule = '{"type":"once","at":"2099-01-01T07:05"}',
): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?)`,
    )
    .run(CHAT, title, schedule, TZ, dueAt, Date.now());
  return Number(r.lastInsertRowid);
}

function instances(rig: Rig): { id: number; reminder_id: number; status: string }[] {
  return rig.db.prepare('SELECT id, reminder_id, status FROM instances ORDER BY id').all() as any;
}

/** A Facts good enough for the validator; only the fields each rule reads matter. */
function factsFor(effects: Effect[]): Facts {
  const ctx: Context = {
    settings: { chat_id: CHAT, tz: TZ } as any,
    stats: { streak: 0, done7: 0, missed7: 0, done30: 0, missed30: 0 } as any,
    reminders: [],
    goals: [],
    open: [],
    nowLabel: 'עכשיו',
  };
  return buildFacts(ctx, effects, TZ);
}

async function main() {
  // ------------------------------------------------------------------------
  section('FINDING 1 — the bot answers a word he never typed');
  //
  // Production, chat 701531870, 25.08.2026 22:00. The 'לקחת תרופה' reminder
  // fired (event 153, צלצלה) and what shipped was:
  //
  //   "המשך למה בדיוק? הכל נקי פה.
  //    או שתביא משימה חדשה, או שתשחרר אותי לראות טלוויזיה."
  //
  // and its nag, half an hour later: "מה המשך? הכל סגור. לך לישון."
  //
  // Nobody typed "המשך". The Gemini API requires the last turn to be
  // `role: 'user'`, and every unprompted message ends on a bot turn, so
  // brain.speak appended a literal "(המשך)" — which the model read as his word
  // and answered instead of rewriting the baseline. `rejections` #2 and #3 are
  // the same phantom, caught only because the model happened to quote it.
  {
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'לקחת תרופה', Date.now() - 1000);
    rig.speakQueue.push('נו? לקחת תרופה.');
    await runCron(rig);

    const spoken = rig.geminiCalls.filter((c) => c.kind === 'speak');
    check(
      'the fire consulted the persona',
      spoken.length === 1,
      JSON.stringify(rig.geminiCalls.map((c) => c.kind)),
    );
    const turns = spoken[0]?.contents ?? [];
    const last = turns[turns.length - 1];
    const lastText = (last?.parts?.[0]?.text ?? '').trim();

    check(
      'the API still gets a user turn to answer',
      last?.role === 'user',
      'Gemini rejects a contents array that ends on a model turn — the synthetic turn cannot simply be dropped',
    );
    check(
      'but it is not a bare word he could have said',
      !/^\(?המשך\)?$/.test(lastText),
      `the synthetic turn was ${JSON.stringify(lastText)} — production read that as his message and answered it`,
    );
    check(
      'it says outright that he said nothing',
      /לא אמר/.test(lastText),
      'the model has to be told this turn is the bot speaking unprompted, or it fills the silence with a reply',
    );
  }

  // ------------------------------------------------------------------------
  section('FINDING 2 — a rewrite may not drop the confirmation it was given');
  //
  // Production, 23.08.2026 08:30:54. Event 139 records `הוזזה` on reminder 61:
  // the row really was moved to 09:00. What shipped (message #532) was
  //
  //   "חצי שעה? מה קרה, האוטו צריך הפסקת קפה?
  //    תפתח את הדלת של האוטו, משם נמשיך."
  //
  // — no hour, no confirmation, and no rejection. He believed he had snoozed;
  // the row had been rescheduled. validate.ts polices facts INVENTED and had
  // no rule for a write whose confirmation simply vanished.
  {
    const effects: Effect[] = [
      { kind: 'reminder_retimed', id: 61, title: 'ללכת למוסך', at: wallToUtc(2026, 8, 23, 9, 0, TZ) },
    ];
    const facts = factsFor(effects);
    const baseline = 'הזזתי את "ללכת למוסך" ל-09:00.';

    const dropped = validate(
      'חצי שעה? מה קרה, האוטו צריך הפסקת קפה?\n\nתפתח את הדלת של האוטו, משם נמשיך.',
      facts,
      baseline,
    );
    check('the hour it moved to may not be dropped', !dropped.ok, JSON.stringify(dropped));

    const kept = validate('הזזתי לך את המוסך ל-09:00. שיהיה בהצלחה.', facts, baseline);
    check('stating it in his own words is still fine', kept.ok, JSON.stringify(kept));
  }
  {
    // The rule must not fire where the baseline states no hour at all —
    // "ביטלתי את X" is a complete confirmation with no clock in it.
    const effects: Effect[] = [{ kind: 'reminder_deleted', id: 60, title: 'ללכת למוסך' }];
    const v = validate('ביטלתי. מה, האוטו הבריא לבד?', factsFor(effects), 'ביטלתי את "ללכת למוסך".');
    check('a write with no hour in its baseline is unaffected', v.ok, JSON.stringify(v));
  }
  {
    // FINDING 1's second line of defence: a fired reminder that shares not one
    // word with the errand is not a rewrite of it.
    const effects: Effect[] = [
      { kind: 'reminder_fired', id: 63, title: 'לקחת תרופה', instanceId: 44, requiresProof: false },
    ];
    const facts = factsFor(effects);
    const baseline = 'נו? לקחת תרופה.';

    const phantom = validate(
      'המשך למה בדיוק? הכל נקי פה.\n\nאו שתביא משימה חדשה, או שתשחרר אותי לראות טלוויזיה.',
      facts,
      baseline,
    );
    check('a fired reminder must name its errand', !phantom.ok, JSON.stringify(phantom));

    // Production message #545, which is a GOOD rewrite: it says "לקחת את
    // התרופה", so the title is not a verbatim substring of it. A rule that
    // demanded the title word for word would have discarded this.
    const real = validate(
      'בדיוק כמו שקבענו.\n\nנו, לקחת את התרופה? שלוק מים וסגרנו.',
      facts,
      baseline,
    );
    check('while a reworded one still ships', real.ok, JSON.stringify(real));
  }

  // ------------------------------------------------------------------------
  section('FINDING 3 — a turn that failed does not get dressed up');
  //
  // `rejections` #8, 23.08.2026 07:47. The route/apply call had thrown
  // (`errors` #14), so the effects were `nothing: 'failed'` — and the persona
  // rewrote that baseline into
  //
  //   "העברתי את #60 ללכת למוסך להיום ב-08:47. בלי תירוצים, כן?"
  //
  // a flat invention of a write, caught only because 08:47 was not an hour the
  // turn knew. CLAUDE.md's rule is that the failure wording must never confirm
  // or deny the write; handing it to a model licensed to rephrase contradicts
  // that, so the model is not asked at all.
  {
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'ללכת למוסך', Date.now() + 3_600_000);
    // Only the ROUTER fails — deliberately not `rig.geminiDown`, which kills
    // speak() as well and would make the second assertion below pass with no
    // fix in place at all. This is the production shape: the model answered,
    // the answer was unparseable (`errors` #14), and the persona was still up
    // and willing to dress the wreckage.
    for (let i = 0; i < 12; i++) {
      rig.routerQueue.push(new Error('gemini returned non-JSON (4345 chars)'));
    }
    rig.speakQueue.push('העברתי את #60 ללכת למוסך להיום ב-08:47. בלי תירוצים, כן?');
    await runWebhook(rig, 'תעביר את ללכת למוסך לעוד שעה');

    check(
      'the failure is reported',
      rig.texts().some((t) => /לא סיימתי|נפל/.test(t)),
      JSON.stringify(rig.texts()),
    );
    check(
      'and the persona was never asked to reword it',
      rig.geminiCalls.every((c) => c.kind !== 'speak'),
      'a model asked to make "something broke" sound better invents the write it could not confirm',
    );
    check(
      'so the invented move never reaches him',
      !rig.texts().some((t) => t.includes('08:47')),
      JSON.stringify(rig.texts()),
    );
  }

  // ------------------------------------------------------------------------
  section('FINDING 4 — one errand, two instances, two streak points');
  //
  // Reminder 61, "ללכת למוסך", 23.08.2026, straight out of the events table:
  //
  //   08:30:38  צלצלה   instance 39 opens
  //   08:30:54  הוזזה   retimed to 09:00 — instance 39 left untouched
  //   09:00:42  צלצלה   instance 41 opens, while 39 is STILL open
  //   09:00:45  נדנוד   on instance 39, three seconds after the new fire
  //   09:04     נסגרה   instance 39 — "רצף 27"
  //   09:31     נסגרה   instance 41 — "רצף 28"
  //
  // One trip to the garage, two streak points, and four messages inside ten
  // seconds at 09:00. Moving a reminder that is RINGING has to supersede the
  // ring; leaving the instance open means the nag ladder runs twice over.
  {
    const rig = createRig();
    seedSettings(rig);
    const fireAt = wallToUtc(2026, 8, 23, 8, 30, TZ);
    seedReminder(rig, 'ללכת למוסך', fireAt, '{"type":"once","at":"2026-08-23T08:30"}');

    await withNow(fireAt + 1000, async () => {
      rig.speakQueue.push('נו? ללכת למוסך.');
      await runCron(rig);
    });
    eq('it rings once', instances(rig).filter((i) => i.status === 'open').length, 1);

    await withNow(fireAt + 20_000, async () => {
      rig.routerQueue.push({
        actions: [{ action: 'reschedule', target_id: 1, schedule_type: 'once', once_at: '2026-08-23T09:00' }],
      });
      rig.speakQueue.push('הזזתי ל-09:00.');
      await runWebhook(rig, 'תעביר את ללכת למוסך ל-09:00');
    });

    const afterMove = instances(rig);
    eq('the ring it superseded is closed', afterMove.filter((i) => i.status === 'open').length, 0);
    eq('and closed as superseded, not as done or failed', afterMove[0].status, 'skipped');

    await withNow(wallToUtc(2026, 8, 23, 9, 0, TZ) + 1000, async () => {
      rig.speakQueue.push('נו? ללכת למוסך.');
      await runCron(rig);
    });

    const afterSecond = instances(rig);
    eq('the new time rings', afterSecond.length, 2);
    eq(
      'and he is being chased about exactly one of them',
      afterSecond.filter((i) => i.status === 'open').length,
      1,
    );

    // The streak is the number this cost him in production. `skipped` is
    // invisible to db.stats (which counts only done/failed), so closing the
    // superseded ring cannot pay him for a garage trip he made once.
    const stats = rig.db
      .prepare("SELECT COUNT(*) AS n FROM instances WHERE status IN ('done','failed')")
      .get() as any;
    eq('and the superseded ring is worth no streak at all', stats.n, 0);
  }

  // ------------------------------------------------------------------------
  section('FINDING 5 — "עוד חצי שעה" on a ringing reminder is a snooze');
  //
  // The trigger for FINDING 4. brain.ts already tells the router that a task
  // which has rung takes `snooze` and one which has not takes `reschedule`; it
  // returned `reschedule` anyway (event 139, `הוזזה`).
  //
  // On the once-off above that cost a duplicate. On a REPEAT it is worse:
  // scheduleFromIntent turns in_minutes into `{type:'once'}`, so pushing a
  // daily reminder half an hour would end the recurrence — the same trap
  // findNamedTime refuses to walk into for exactly this reason.
  {
    const rig = createRig();
    seedSettings(rig);
    const fireAt = wallToUtc(2026, 8, 23, 8, 30, TZ);
    seedReminder(rig, 'לקחת תרופה', fireAt, '{"type":"daily","time":"08:30"}');

    await withNow(fireAt + 1000, async () => {
      rig.speakQueue.push('נו? לקחת תרופה.');
      await runCron(rig);
    });
    // Captured BEFORE the push. Asserting the new nag clock against a constant
    // would pass on the clock the fire itself set (nagDelayMinutes(0)) without
    // anything having been pushed at all.
    const nagBefore = (rig.db.prepare('SELECT next_nag_at FROM instances WHERE id = 1').get() as any)
      .next_nag_at as number;

    await withNow(fireAt + 20_000, async () => {
      // What production's router actually returned for "עוד חצי שעה".
      rig.routerQueue.push({ actions: [{ action: 'reschedule', target_id: 1, in_minutes: 30 }] });
      rig.speakQueue.push('דחיתי ב-30 דקות.');
      await runWebhook(rig, 'עוד חצי שעה');
    });

    const row = rig.db.prepare('SELECT schedule, next_fire_at FROM reminders WHERE id = 1').get() as any;
    eq(
      'the daily rule survives being pushed',
      JSON.parse(row.schedule).type,
      'daily',
      );
    eq('with its hour untouched', JSON.parse(row.schedule).time, '08:30');

    const after = instances(rig);
    eq('nothing new was opened', after.length, 1);
    eq('and the ring he pushed is still the one he owes', after[0].status, 'open');

    const inst = rig.db.prepare('SELECT next_nag_at FROM instances WHERE id = 1').get() as any;
    check(
      'the push landed on the nag clock',
      inst.next_nag_at > nagBefore,
      `next_nag_at is still ${inst.next_nag_at} — the fire had already set it to ${nagBefore}, so nothing was pushed`,
    );
  }

  // ------------------------------------------------------------------------
  section('FINDING 6 — the router may not use a field as a scratchpad');
  //
  // Removing `why` from the schema (0.13) did not end this; it relocated it.
  // The model needed somewhere to think out loud, `title` was the remaining
  // unbounded STRING, and all three route/apply failures since 0.14.0 shipped
  // are the same shape — `errors` #13, #14 and #15:
  //
  //   "title":"ללכת למוסךTrimmed to: ללכת למוסך והוא לא אמר משהו אחר. ללכת
  //    למוסך. ללכת למוסך. ללכת למוסך…"                        (3022 chars)
  //
  //   "title":"ללכת למוסך24.08.2026, 07:30 — הבא: יום ב׳, 24.08.2026, 07:30\n
  //    \nנתפסו אבל עדיין בלי שעה — …"                          (4345 chars)
  //
  //   "title":"להזמין רכב לאוסטריה Lights-out-time-limit-reached-or-similar-
  //    context-implied-by-today-limit-…"                       (4800 chars)
  //
  // The first is the model echoing titleFromHisWords' own prompt rule back
  // into the field; the second is the rendered context block. Each ran until
  // the response truncated mid-string, so JSON.parse threw, the turn died, and
  // the catch-block filed his raw sentence as a reminder — which is what
  // reminder #62's title is.
  //
  // titleFromHisWords cannot help here: it runs on the PARSED intent, and
  // there was never a parse. The bound has to be on the schema, where
  // constrained decoding makes it a guarantee rather than a request.
  {
    const rig = createRig();
    seedSettings(rig);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('בטח.');
    await runWebhook(rig, 'מחר ב7:30 - ללכת למוסך אם יתאפשר');

    const router = rig.geminiCalls.find((c) => c.kind === 'router');
    check('the router was consulted', !!router, JSON.stringify(rig.geminiCalls.map((c) => c.kind)));
    const props = router?.schema?.properties?.actions?.items?.properties ?? {};

    // Asserted on the schema that actually went over the wire, not on the
    // exported constant — the same reason the rig captures `schema` at all.
    eq('title is bounded on the wire', props.title?.maxLength, 120);
    check('and so is every other free-text field', !!props.note?.maxLength && !!props.reason?.maxLength,
      JSON.stringify({ note: props.note, reason: props.reason }));
  }

  // ------------------------------------------------------------------------
  section('FINDING 7 — a day is not an errand');
  //
  // Production `reminder_items`, rows 1 and 2, both on reminder 57:
  //
  //   1  "לקבוע רעמוו נשק במאי"
  //   2  "להיום"
  //
  // He had typed "תזכיר לי לקבוע רעמוו נשק במאי, להיום ב12 וחצי". The time
  // phrase stayed in the title, splitIntoItems counts a part as an action when
  // it starts with ל plus a letter, and ל+היום passes. The nag then named it:
  // "עזוב את 'להיום'. רק תעשה את החלק של לקבוע רעמוו נשק במאי."
  {
    eq(
      'a trailing day word does not turn one errand into two',
      splitIntoItems('לקבוע רעמוו נשק במאי, להיום'),
      [],
    );
    // The rule is about the WORD, not about ל followed by ה. Every nif'al
    // infinitive has that shape and every one of them is a real errand.
    eq(
      'while real infinitives that start ל-ה still split',
      splitIntoItems('להיכנס לבנק, להירשם לחוג'),
      ['להיכנס לבנק', 'להירשם לחוג'],
    );
    eq(
      'and an ordinary list is untouched',
      splitIntoItems('להחזיר ראוטר, לקנות מחבת, ללכת למחסני תאורה'),
      ['להחזיר ראוטר', 'לקנות מחבת', 'ללכת למחסני תאורה'],
    );
  }

  // ------------------------------------------------------------------------
  section('FINDING 8 — a night is not a debt');
  //
  // Production, instance 44 ("לקחת תרופה", chat B): fired 25.08.2026 22:00,
  // nagged again at 08:03 the next morning. facts.addElapsed is a flat
  // `now - fired_at`, so the number handed to the persona was 630, and the
  // message he woke up to was
  //
  //   התרופה מאתמול גוררת חוב של 600 דקות. לסגור אותה?
  //
  // He was asleep for nine of those ten hours — the bot's own quiet window
  // says so. The span the block exists to make truthful has to be the span he
  // was actually awake for, or the number is an accusation dressed as a fact.
  {
    const rig = createRig();
    seedSettings(rig, { quiet_start_hour: 23, quiet_end_hour: 8 });
    const firedAt = wallToUtc(2026, 8, 25, 22, 0, TZ);
    const now = wallToUtc(2026, 8, 26, 8, 3, TZ);
    // next_fire_at is TOMORROW's dose: this tick must produce the nag on the
    // open instance and nothing else, or the fire consumes the speak call and
    // every assertion below is about the wrong message.
    const id = seedReminder(
      rig, 'לקחת תרופה', wallToUtc(2026, 8, 26, 22, 0, TZ), '{"type":"daily","time":"22:00"}',
    );
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status)
         VALUES (?, ?, 'לקחת תרופה', ?, ?, 1, 'open')`,
      )
      .run(id, CHAT, firedAt, now - 1000);

    await withNow(now, async () => {
      rig.speakQueue.push('נו? לקחת תרופה. פתוח מאתמול בערב.');
      await runCron(rig);
    });

    const spoken = rig.geminiCalls.filter((c) => c.kind === 'speak');
    check('the nag went out', spoken.length === 1, JSON.stringify(rig.geminiCalls.map((c) => c.kind)));
    const block = spoken[0]?.system ?? '';

    check(
      'the raw ten-hour span is not what it is handed',
      !/\b6[0-9][0-9] דקות/.test(block),
      `the elapsed block still reads: ${JSON.stringify(block.match(/## כמה זמן[\s\S]{0,220}/)?.[0])}`,
    );
    check(
      'it is handed the hour he has actually been awake for',
      /\b6[0-9] דקות/.test(block),
      `expected ~63 minutes (22:00→08:03 less the 23:00→08:00 quiet window); block: ${JSON.stringify(
        block.match(/## כמה זמן[\s\S]{0,220}/)?.[0],
      )}`,
    );
    check(
      'and told why, so it does not present the night as one more hour of avoidance',
      /שקט|ישן/.test(block.match(/## כמה זמן[\s\S]{0,320}/)?.[0] ?? ''),
      JSON.stringify(block.match(/## כמה זמן[\s\S]{0,320}/)?.[0]),
    );
  }

  // ------------------------------------------------------------------------
  section('FINDING 10 — the daily messages respect his quiet hours');
  //
  // index.ts guards check-ins with `quiet` and does not guard the brief or the
  // close-out at all. The owner's row is quiet_end_hour = 9 with brief_hour =
  // 8, so the bot opened every single morning inside the window he had asked
  // it to stay out of. A reminder firing at 08:30 is his own instruction and
  // still fires; an unprompted good-morning is not.
  {
    const rig = createRig();
    seedSettings(rig, { brief_hour: 8, quiet_start_hour: 23, quiet_end_hour: 9 });
    seedReminder(rig, 'ללכת למוסך', wallToUtc(2026, 8, 26, 14, 0, TZ));

    await withNow(wallToUtc(2026, 8, 26, 8, 1, TZ), async () => {
      await runCron(rig);
    });
    eq('no brief inside the quiet window', rig.texts().length, 0);

    // And it is a HOLD, not a cancellation: it still arrives once he is up.
    // Counted as a delta rather than a total — with the bug in place the brief
    // has already gone out and marked the day, so `length === 1` would pass
    // here on the 08:01 message and prove nothing.
    const before = rig.texts().length;
    await withNow(wallToUtc(2026, 8, 26, 9, 1, TZ), async () => {
      rig.speakQueue.push('בוקר. יש לך משהו ב-14:00.');
      await runCron(rig);
    });
    eq('but it still arrives once the window closes', rig.texts().length - before, 1);
  }

  // ------------------------------------------------------------------------
  section('FINDING 9 — "nothing left today" has to mean it');
  //
  // Chat B, 25.08.2026 21:00 (message #551):
  //
  //   זהו, אין יותר להיום.
  //   תפתח משימה חדשה או שחרר.
  //
  // Reminder 63 was due at 22:00 that same evening, and did fire. The
  // close-out reads dayTally (start of day → now), the still-open instances
  // and today's give-ups — all of it BACKWARD — so the baseline has nothing to
  // say about the rest of the evening and the persona filled the gap. The
  // night before it happened to fill it correctly ("נתראה ב-22:00 עם התרופה",
  // message #544), which is the tell: it was guessing either way.
  {
    const rig = createRig();
    seedSettings(rig, { closeout_hour: 21, quiet_start_hour: 23, quiet_end_hour: 8 });
    seedReminder(rig, 'לקחת תרופה', wallToUtc(2026, 8, 25, 22, 0, TZ), '{"type":"daily","time":"22:00"}');
    // Something closed today, so the close-out has a reason to be sent at all.
    rig.db
      .prepare(
        `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status, closed_at)
         VALUES (1, ?, 'לקחת תרופה', ?, 'done', ?)`,
      )
      .run(CHAT, wallToUtc(2026, 8, 25, 9, 0, TZ), wallToUtc(2026, 8, 25, 9, 5, TZ));

    await withNow(wallToUtc(2026, 8, 25, 21, 0, TZ), async () => {
      rig.speakQueue.push('סגרת אחת היום. ב-22:00 יש לך את התרופה.');
      await runCron(rig);
    });

    const spoken = rig.geminiCalls.filter((c) => c.kind === 'speak');
    check('the close-out went out', spoken.length === 1, JSON.stringify(rig.geminiCalls.map((c) => c.kind)));
    const truth = /## מה שקרה עכשיו[\s\S]*?(?=\n## |$)/.exec(spoken[0]?.system ?? '')?.[0] ?? '';
    check(
      'and the baseline says what is still ahead tonight',
      truth.includes('22:00') && truth.includes('לקחת תרופה'),
      `the deterministic text the persona was told to rewrite was: ${JSON.stringify(truth)}`,
    );
  }

  // ------------------------------------------------------------------------
  section('FINDING 11 — an apostrophe is not an invented task');
  //
  // `rejections` #9, chat B, 23.08.2026. He typed
  //
  //   אני צריך עוד במהלך היום להזמין רכב לאוסטריה. תזכיר לי עוד 'שעה בערך
  //
  // — note the stray apostrophe. The persona quoted him back without it and
  // scored `invented task "עוד שעה בערך"`, so a rewrite that correctly pushed
  // back on a vague time was binned and he got the flat baseline instead.
  // facts.quotable is compared with a raw substring test, which cannot see
  // past one character of punctuation.
  {
    const effects: Effect[] = [{ kind: 'nothing', why: 'chat', userText: "תזכיר לי עוד 'שעה בערך" }];
    const facts = factsFor(effects);
    const v = validate(
      'תפסתי.\n\nאבל "עוד שעה בערך" זה לא באמת שעה. תן לי זמן מדויק.',
      facts,
      'לא הבנתי.',
    );
    check('quoting him back across his own typo is not invention', v.ok, JSON.stringify(v));

    // And the rule keeps its teeth: a task nobody ever mentioned is still one.
    const invented = validate('ומה עם "לכתוב את הדוח השנתי"?', facts, 'לא הבנתי.');
    check('while something he never said is still rejected', !invented.ok, JSON.stringify(invented));
  }

  done();
}

void main();
