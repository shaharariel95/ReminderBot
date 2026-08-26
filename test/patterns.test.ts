/**
 * Run with `npm run test:patterns`.
 *
 * The thresholds ARE the feature. Everything else in patterns.ts is arithmetic;
 * what makes it safe or unsafe to ship is whether it stays quiet on thin
 * evidence and whether it ever offers an hour he has not actually used.
 *
 * Pure functions, no rig, no database — which is the point of the file existing
 * separately at all.
 */
import { detectPattern, usualHour, MIN_SAMPLE, type Behaviour } from '../src/patterns';
import { check, eq, done, section } from './harness';

function b(over: Partial<Behaviour> = {}): Behaviour {
  return { fires: 0, snoozes: 0, dones: 0, failures: 0, doneHours: [], ...over };
}

// --------------------------------------------------------------------------
section('silence on thin evidence');

eq(
  'nothing at all from a single bad day',
  detectPattern(b({ fires: 2, snoozes: 2 })),
  null,
);
check(
  'and nothing right up to the sample floor',
  detectPattern(b({ fires: MIN_SAMPLE - 1, snoozes: MIN_SAMPLE - 1 })) === null,
  'announcing a habit off three data points is astrology, and it costs trust in everything else the bot says',
);

// --------------------------------------------------------------------------
section('pushing it repeatedly');

{
  const p = detectPattern(b({ fires: 7, snoozes: 5, dones: 5, doneHours: [19, 19, 20, 19, 20] }));
  check('five pushes out of seven is a pattern', p?.kind === 'pushed', JSON.stringify(p));
  eq('and it counts them honestly', (p as any)?.snoozes, 5);
  eq('out of the real denominator', (p as any)?.fires, 7);
  eq('offering the hour he actually closes it at', (p as any)?.hour, 19);
}

check(
  'pushing it occasionally is not a pattern',
  detectPattern(b({ fires: 10, snoozes: 4, dones: 6, doneHours: [8, 8, 8, 8, 8, 8] })) === null,
  'four pushes in ten is a normal life, not a reminder set at the wrong hour',
);

// --------------------------------------------------------------------------
section('an hour is offered only when it is real');

eq('no completions, no suggested hour', usualHour([]), null);
eq('too few completions to cluster', usualHour([19, 20]), null);
eq('a clear cluster gives its median', usualHour([19, 19, 20, 19]), 19);
check(
  'a split habit offers NOTHING rather than the average of two',
  usualHour([8, 8, 8, 20, 20, 20]) === null,
  'the mean of 08:00 and 20:00 is 14:00 — an hour he has never once used. Offering it invents a habit out of two real ones',
);
check(
  'and a bare plurality is not enough',
  usualHour([7, 9, 13, 17, 21, 23]) === null,
  'scattered completions mean there is no usual hour to offer; the honest move is to ask',
);

{
  const p = detectPattern(b({ fires: 6, snoozes: 5, dones: 5, doneHours: [7, 12, 16, 20, 23] }));
  check('a push pattern with no usual hour still fires', p?.kind === 'pushed', JSON.stringify(p));
  eq('but suggests no hour at all', (p as any)?.hour, null);
}

// --------------------------------------------------------------------------
section('a reminder that has never once worked');

{
  const p = detectPattern(b({ fires: 5, failures: 3, dones: 0 }));
  check('is reported as failing, not as pushing', p?.kind === 'failing', JSON.stringify(p));
  eq('with the real count', (p as any)?.failures, 3);
}

check(
  'one completion is enough to stop calling it a failure',
  detectPattern(b({ fires: 5, failures: 3, dones: 1 }))?.kind !== 'failing',
  'he HAS done it — the reminder works sometimes, and offering to delete it would be wrong',
);

{
  // Both conditions true at once. Failing must win: offering to retime a
  // reminder he has never once completed treats a wrong reminder as a
  // scheduling detail.
  const p = detectPattern(b({ fires: 8, snoozes: 6, failures: 4, dones: 0 }));
  eq('never-completed beats pushed when both apply', p?.kind, 'failing');
}

// --------------------------------------------------------------------------
section('end to end: a reminder he keeps pushing');

import worker from '../src/index';
import * as db from '../src/db';
import { renderBaseline } from '../src/voice';
import { buttonsFor, decode, encode } from '../src/buttons';
import { buildFacts } from '../src/facts';
import { createRig, withNow, type Rig } from './harness';

async function runCron(rig: Rig): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.scheduled({} as any, rig.env, ctx);
  await Promise.all(pending);
}

const HIM = '12345';
const TZ = 'Asia/Jerusalem';

async function endToEnd(): Promise<void> {
  const rig = createRig({ tz: TZ });
  const now = Date.UTC(2026, 7, 17, 6, 0, 0);
  const remId = 1;
  rig.db.prepare(
    `INSERT INTO reminders (chat_id, title, notes, schedule, tz, requires_proof, proof_type,
      nag_interval_min, max_nags, next_fire_at, event_at, status, active, created_at)
     VALUES (?, 'לרוץ', NULL, ?, ?, 0, 'any', 20, 3, ?, NULL, 'scheduled', 1, ?)`,
  ).run(HIM, JSON.stringify({ type: 'daily', time: '08:00' }), TZ, now + 3_600_000, now);

  // Seven mornings: it fired, he pushed it, and he closed it in the evening.
  for (let d = 7; d >= 1; d--) {
    const day = now - d * 86_400_000;
    rig.db.prepare("INSERT INTO events (chat_id, reminder_id, at, kind) VALUES (?,?,?,'צלצלה')").run(HIM, remId, day);
    if (d > 2) {
      rig.db.prepare("INSERT INTO events (chat_id, reminder_id, at, kind) VALUES (?,?,?,'נדחתה')").run(HIM, remId, day);
    }
    // Closed around 19:00 local each time.
    rig.db.prepare("INSERT INTO events (chat_id, reminder_id, at, kind) VALUES (?,?,?,'נסגרה')")
      .run(HIM, remId, day + 10 * 3_600_000); // 06:00 UTC + 10h = 19:00 local
  }

  const b = await db.behaviourOf(rig.env, HIM, remId, TZ, 0);
  eq('the record is read back off events', b.fires, 7);
  eq('with the pushes counted', b.snoozes, 5);
  check('and the hours he actually closes it at', b.doneHours.every((h) => h === 19), JSON.stringify(b.doneHours));

  const p = detectPattern(b);
  check('which is a pattern', p?.kind === 'pushed', JSON.stringify(p));

  // The sentence, and the tap.
  const at = Date.UTC(2026, 7, 17, 16, 0, 0); // 19:00 local
  const eff = [{ kind: 'pattern_pushed', id: remId, title: 'לרוץ', snoozes: 5, fires: 7, at }] as any;
  const line = renderBaseline(eff, TZ);
  check('states the count, not a motive', /5/.test(line) && /7/.test(line), line);
  check(
    'and never diagnoses him',
    !/נמנע|עצלן|מפחד/.test(line),
    `a claim about HIM is not checkable against rows: ${line}`,
  );

  const facts = buildFacts(
    { settings: { chat_id: HIM, tz: TZ } as any, stats: {} as any, reminders: [], goals: [], open: [], nowLabel: '' } as any,
    eff, TZ,
  );
  check(
    'the suggested hour is swept, so the rewrite is not silently discarded',
    facts.times.includes('19:00'),
    `times: ${JSON.stringify(facts.times)}`,
  );

  const kb = buttonsFor(eff, TZ, now);
  const flat = (kb ?? []).flat();
  check('the offer is finishable in one tap', flat.some((x) => (x.data as any).t === 'retime'), JSON.stringify(kb));
  check('and declining is one tap too', flat.some((x) => (x.data as any).t === 'keep'), JSON.stringify(kb));

  // The decline button must not CHANGE anything. It reused plan/'none' at
  // first, which means "no time" and would have unscheduled the very reminder
  // he had just said was fine.
  check(
    'declining writes nothing',
    !flat.some((x) => (x.data as any).t === 'plan'),
    'plan/none unschedules the reminder — a decline button that changes something is worse than none',
  );
  check('and the keep payload round-trips', decode(encode({ t: 'keep' }))?.t === 'keep', '');
  check(
    'as does the drop payload',
    (decode(encode({ t: 'rdrop', reminder: 9 })) as any)?.reminder === 9,
    '',
  );
  rig.restore();
}

// --------------------------------------------------------------------------
section('a busy part of the day is observed, not argued with');

async function crowding(): Promise<void> {
  const rig = createRig({ tz: TZ });
  const now = Date.UTC(2026, 7, 17, 5, 0, 0); // 08:00 local
  await withNow(now, async () => {
    const ctx: any = {
      settings: await db.getSettings(rig.env, HIM),
      stats: { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 },
      reminders: [], goals: [], open: [], friends: [], nowLabel: '',
    };
    const { applyIntent } = await import('../src/effects');

    // Four unrelated things, all tomorrow morning.
    const titles = ['לקנות חלב', 'להתקשר לרופא', 'לשלוח מייל', 'לאסוף חבילה'];
    let last: any[] = [];
    for (let i = 0; i < titles.length; i++) {
      last = await applyIntent(
        rig.env, HIM, ctx,
        {
          action: 'create_reminder', title: titles[i],
          schedule_type: 'once',
          once_at: `2026-08-18T${String(8 + i).padStart(2, '0')}:00`,
        } as any,
        titles[i],
      );
    }

    check(
      'the reminder is still created and still confirmed',
      last.some((e) => e.kind === 'reminder_created'),
      `effects: ${last.map((e) => e.kind).join(', ')}`,
    );
    const crowded = last.find((e) => e.kind === 'window_crowded');
    check('and the crowding is mentioned alongside it', !!crowded, `effects: ${last.map((e) => e.kind).join(', ')}`);
    eq('counting the one he just made, as /list would', crowded?.count, 4);

    // These four really are tomorrow, and this is the case that always worked.
    eq('a busy morning tomorrow is called tomorrow', crowded?.label, 'מחר בבוקר');

    const line = renderBaseline(last, TZ);
    check(
      'stated as a number, never as advice',
      !/בטוח|באמת|יותר מדי|אולי תוותר/.test(line),
      `unsolicited opinions about his day are how a prompt gets muted: ${line}`,
    );
  });
  rig.restore();
}

// --------------------------------------------------------------------------
section('the nag ladder only offers a part when a part exists');

async function ladderHonesty(): Promise<void> {
  const { NAG_LADDER, NAG_LADDER_ITEMS } = await import('../src/persona');
  check(
    'the generic level-1 nag no longer promises to halve the task',
    !/חצי/.test(NAG_LADDER[1]),
    `the bot knows a task's parts only when he typed them as a list; "offer half" of anything else is invented: ${NAG_LADDER[1]}`,
  );
  check(
    'and it says so outright',
    /אל תמציא/.test(NAG_LADDER[1]),
    NAG_LADDER[1],
  );
  check(
    'while the items variant does name one, because they are real',
    /פריט אחד/.test(NAG_LADDER_ITEMS),
    NAG_LADDER_ITEMS,
  );
}

// --------------------------------------------------------------------------
section('a tap that declines, and a tap that deletes');

/** The suffix settleButtons appended — "✓" if the tap did something, "—" if not. */
function settleMark(rig: Rig): string {
  const edit = rig.sent.filter((s) => s.method === 'editMessageText').pop();
  return (edit?.text ?? '').trim().split('\n').pop() ?? '';
}

async function tap(rig: Rig, data: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.fetch(
    new Request('https://x/tg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        callback_query: {
          id: 'cb1',
          from: { id: Number(HIM) },
          message: { message_id: 555, chat: { id: Number(HIM) }, text: 'שאלה' },
          data,
        },
      }),
    }),
    rig.env,
    ctx,
  );
  await Promise.all(pending);
}

/**
 * Both branches lived inside handleCallback's switch and both declared their
 * OWN `const effects`, shadowing the array the tail reads. The tail therefore
 * saw an empty list and settled the keyboard with the "nothing happened"
 * marker — on `rdrop`, which had just deleted a reminder.
 *
 * And `keep` answered with {nothing, why:'chat'}, which voice.ts words as the
 * bare "נו?" — the bot's own nag opener, handed back to a man who had just
 * tapped "leave it as it is". CLAUDE.md is explicit that "נו?" is not
 * available as a fallback; this reached it through a route that is
 * technically legitimate, which is why nothing caught it.
 */
async function declineAndDrop(): Promise<void> {
  const seed = (rig: Rig, now: number) =>
    rig.db
      .prepare(
        "INSERT INTO reminders (chat_id, title, notes, schedule, tz, requires_proof, proof_type," +
          " nag_interval_min, max_nags, next_fire_at, event_at, status, active, created_at)" +
          " VALUES (?, 'לרוץ', NULL, ?, ?, 0, 'any', 20, 3, ?, NULL, 'scheduled', 1, ?)",
      )
      .run(HIM, JSON.stringify({ type: 'daily', time: '08:00' }), TZ, now + 3_600_000, now);

  {
    const rig = createRig({ tz: TZ });
    const now = Date.UTC(2026, 7, 17, 6, 0, 0);
    await withNow(now, async () => {
      seed(rig, now);
      await tap(rig, encode({ t: 'rdrop', reminder: 1 }));

      const row = rig.db.prepare('SELECT status FROM reminders WHERE id = 1').get() as any;
      eq('the drop actually deletes the reminder', row?.status, 'cancelled');
      eq('and the keyboard says so, rather than "nothing happened"', settleMark(rig), '✓');
    });
    rig.restore();
  }
  {
    const rig = createRig({ tz: TZ });
    const now = Date.UTC(2026, 7, 17, 6, 0, 0);
    await withNow(now, async () => {
      seed(rig, now);
      await tap(rig, encode({ t: 'keep' }));

      const row = rig.db.prepare('SELECT status, next_fire_at FROM reminders WHERE id = 1').get() as any;
      eq('declining writes nothing at all', row?.status, 'scheduled');
      check('and above all does not unschedule it', row?.next_fire_at !== null, JSON.stringify(row));

      const replies = rig.sent.filter((x) => x.method === 'sendMessage').map((x) => x.text ?? '');
      check(
        'declining is acknowledged, never answered with the nag opener',
        replies.length > 0 && !replies.some((t) => t.trim() === 'נו?'),
        JSON.stringify(replies),
      );
      eq('and the keyboard says the tap registered', settleMark(rig), '✓');
    });
    rig.restore();
  }
}

/**
 * The DAY in a crowding remark has to be true.
 *
 * `when` used to be a two-way choice: today, or the literal word "tomorrow"
 * for everything else. So four things on a Thursday morning next week were
 * announced as "מחר בבוקר" — a wrong claim about WHEN, inside the one message
 * whose entire value is that he can check it in two taps.
 */
async function crowdingNamesTheRightDay(): Promise<void> {
  const now = Date.UTC(2026, 7, 17, 5, 0, 0); // Monday 08:00 local

  // day 0 = today, 1 = tomorrow, 3 = a day that needs naming.
  const cases: [number, string][] = [
    [0, 'הבוקר'],
    [1, 'מחר בבוקר'],
    [3, 'ביום חמישי בבוקר'],
  ];

  for (const [offset, expected] of cases) {
    const rig = createRig({ tz: TZ });
    await withNow(now, async () => {
      const ctx: any = {
        settings: await db.getSettings(rig.env, HIM),
        stats: { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 },
        reminders: [], goals: [], open: [], friends: [], nowLabel: '',
      };
      const { applyIntent } = await import('../src/effects');
      const day = String(17 + offset).padStart(2, '0');
      // Four inside ONE part of the day — DAY_PARTS puts morning at [5,12), so
      // these are half-hours rather than 9..12, which would spill the last one
      // into צהריים and never reach CROWDED_AT. All ahead of 08:00 so the
      // same times work for today.
      const titles = ['לקנות חלב', 'להתקשר לרופא', 'לשלוח מייל', 'לאסוף חבילה'];
      const times = ['09:00', '09:30', '10:00', '10:30'];
      let last: any[] = [];
      for (let i = 0; i < titles.length; i++) {
        last = await applyIntent(
          rig.env, HIM, ctx,
          {
            action: 'create_reminder', title: titles[i],
            schedule_type: 'once', once_at: `2026-08-${day}T${times[i]}`,
          } as any,
          titles[i],
        );
      }
      const crowded = last.find((e: any) => e.kind === 'window_crowded');
      eq(`+${offset} days reads as "${expected}"`, crowded?.label, expected);
    });
    rig.restore();
  }

  // And the sentence around it stays grammatical, which is why the label
  // carries its own preposition rather than having one glued on: "הבוקר" needs
  // none, "מחר בבוקר" and "ביום חמישי בבוקר" bring their own.
  const line = renderBaseline([{ kind: 'window_crowded', count: 4, label: 'ביום חמישי בבוקר' }] as any, TZ);
  check('the rendered sentence reads as Hebrew', /דברים ביום חמישי בבוקר/.test(line), line);
}

// --------------------------------------------------------------------------
section('a reminder that has never worked is noticed when it fails, not only when he pushes it');

/**
 * `patternFor` had exactly one caller: the `snooze` branch of applyIntent.
 *
 * But `failing` requires `dones === 0 && failures >= FAILURE_FLOOR`, and a
 * reminder that runs the ladder out is one he IGNORED — ignoring never
 * produces a snooze. So the detector could only ever fire for a reminder he
 * both ignores and occasionally pushes, which is not the case it was written
 * for. In production `events` holds no `ויתרתי` rows at all.
 *
 * The give-up is where this question belongs: it is the moment the bot has
 * just spent a whole ladder on something and got nothing back.
 */
async function givingUpAsksWhetherItIsWorthKeeping(): Promise<void> {
  const rig = createRig({ tz: TZ });
  const now = Date.UTC(2026, 7, 17, 6, 0, 0);
  const remId = 1;

  rig.db.prepare(
    "INSERT INTO reminders (chat_id, title, notes, schedule, tz, requires_proof, proof_type," +
      " nag_interval_min, max_nags, next_fire_at, event_at, status, active, created_at)" +
      " VALUES (?, 'לרוץ', NULL, ?, ?, 0, 'any', 20, 3, NULL, NULL, 'scheduled', 1, ?)",
  ).run(HIM, JSON.stringify({ type: 'daily', time: '08:00' }), TZ, now);

  // Four mornings it rang, two of which ran the ladder out. Never once closed.
  for (let d = 4; d >= 1; d--) {
    const day = now - d * 86_400_000;
    rig.db.prepare("INSERT INTO events (chat_id, reminder_id, at, kind) VALUES (?,?,?,'צלצלה')").run(HIM, remId, day);
    if (d > 2) {
      rig.db.prepare("INSERT INTO events (chat_id, reminder_id, at, kind) VALUES (?,?,?,'ויתרתי')").run(HIM, remId, day);
    }
  }

  // An instance sitting at the end of its ladder, due for the give-up now.
  rig.db.prepare(
    "INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status)" +
      " VALUES (?, ?, 'לרוץ', ?, ?, 3, 'open')",
  ).run(remId, HIM, now - 3_600_000, now - 60_000);

  await withNow(now, async () => {
    rig.speakQueue.push('ויתרתי על זה להיום.');
    await runCron(rig);
  });

  const inst = rig.db.prepare('SELECT status FROM instances WHERE reminder_id = ?').get(remId) as any;
  eq('the ladder still runs out as it always did', inst?.status, 'failed');

  // The offer rides on the give-up's own message rather than arriving as a
  // second ping — same reasoning as raising the push pattern on the snooze.
  // Asserted through decode(), not on the raw JSON: the payload is encoded
  // ('rx:1'), so a substring search for 'rdrop' passes nothing and fails
  // everything.
  check(
    'and the give-up carries the offer to delete a reminder that has never worked',
    offersDrop(rig),
    JSON.stringify(rig.sent.map((x) => x.markup ?? null)),
  );
  rig.restore();
}

/** Did any keyboard this rig sent carry the 'delete this reminder' tap? */
function offersDrop(rig: Rig): boolean {
  return rig.sent.some((s) => {
    const rows = (s.markup as any)?.inline_keyboard ?? [];
    return rows.flat().some((btn: any) => decode(String(btn?.callback_data ?? ''))?.t === 'rdrop');
  });
}

/**
 * The other half of the give-up offer: it stays quiet below the floor, and the
 * in-flight failure is what decides which side of the floor this turn is on.
 *
 * FAILURE_FLOOR is 3. With TWO give-ups on the record, this one is the third
 * and the offer is right. With ONE on the record it is the second, and a bot
 * that offers to delete a reminder after two bad days is doing the astrology
 * MIN_SAMPLE exists to prevent.
 *
 * Counting the in-flight give-up matters in both directions, which is why this
 * case is here: sendOutcome writes the `ויתרתי` row AFTER the decision, so
 * reading `events` alone silently moves the threshold to four.
 */
async function givingUpStaysQuietBelowTheFloor(): Promise<void> {
  const build = async (priorFailures: number): Promise<Rig> => {
    const rig = createRig({ tz: TZ });
    const now = Date.UTC(2026, 7, 17, 6, 0, 0);
    const remId = 1;
    rig.db.prepare(
      "INSERT INTO reminders (chat_id, title, notes, schedule, tz, requires_proof, proof_type," +
        " nag_interval_min, max_nags, next_fire_at, event_at, status, active, created_at)" +
        " VALUES (?, 'לרוץ', NULL, ?, ?, 0, 'any', 20, 3, NULL, NULL, 'scheduled', 1, ?)",
    ).run(HIM, JSON.stringify({ type: 'daily', time: '08:00' }), TZ, now);
    for (let d = 4; d >= 1; d--) {
      const day = now - d * 86_400_000;
      rig.db.prepare("INSERT INTO events (chat_id, reminder_id, at, kind) VALUES (?,?,?,'צלצלה')").run(HIM, remId, day);
      if (d > 4 - priorFailures) {
        rig.db.prepare("INSERT INTO events (chat_id, reminder_id, at, kind) VALUES (?,?,?,'ויתרתי')").run(HIM, remId, day);
      }
    }
    rig.db.prepare(
      "INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status)" +
        " VALUES (?, ?, 'לרוץ', ?, ?, 3, 'open')",
    ).run(remId, HIM, now - 3_600_000, now - 60_000);
    await withNow(now, async () => {
      rig.speakQueue.push('ויתרתי על זה להיום.');
      await runCron(rig);
    });
    return rig;
  };

  const one = await build(1);
  check(
    'two failures in total is not yet a pattern — no offer',
    !offersDrop(one),
    JSON.stringify(one.sent.map((x) => x.markup ?? null)),
  );
  one.restore();

  const two = await build(2);
  check(
    'the third is, and the in-flight one is what makes it the third',
    offersDrop(two),
    JSON.stringify(two.sent.map((x) => x.markup ?? null)),
  );
  two.restore();
}


// --------------------------------------------------------------------------
section('the bot stops raising a goal he has never once answered about');

/**
 * `stalestGoal`'s backoff tops out at four days and then repeats forever.
 * `checkin_count` counts CONSECUTIVE unanswered check-ins (recordGoalProgress
 * resets it), so a goal he never engages with is asked about indefinitely.
 *
 * Production, 19.08.2026: one goal, `checkin_count = 11`, last progress on
 * 07.08 — twelve days of being asked, and the count is a floor rather than a
 * total, because an answer the router files as `chat` never resets it. He
 * replied "מחכה לנס" that morning and the counter still went up.
 *
 * Past the floor the bot simply stops bringing it up on its own. Nothing is
 * claimed and nothing is deleted: it stays in /goals, the persona may still
 * use its name, and every check-in already carried "עשיתי" and "תוריד את זה"
 * buttons. Going quiet about something ignored eight times running is not a
 * statement about him, which is why it needs no announcement to stay honest.
 */
async function aGoalHeNeverAnswersGoesQuiet(): Promise<void> {
  const rig = createRig({ tz: TZ });
  const now = Date.UTC(2026, 7, 17, 9, 0, 0);

  rig.db.prepare(
    "INSERT INTO goals (chat_id, title, why, status, last_progress, last_progress_at," +
      " last_checkin_at, checkin_count, created_at) VALUES (?, 'להגיד לאישתי משהו יפה', NULL," +
      " 'active', NULL, NULL, ?, ?, ?)",
  ).run(HIM, now - 30 * 86_400_000, db.GOAL_QUIET_AFTER, now - 60 * 86_400_000);

  const silent = await db.stalestGoal(rig.env, HIM, now);
  check(
    'past the floor it is no longer offered for an unprompted check-in',
    silent === null,
    JSON.stringify(silent),
  );

  // One below the floor it is still fair game — the bot has not given up on
  // him, it has given up on ASKING about this one unprompted.
  rig.db.prepare('UPDATE goals SET checkin_count = ? WHERE chat_id = ?')
    .run(db.GOAL_QUIET_AFTER - 1, HIM);
  const stillAsked = await db.stalestGoal(rig.env, HIM, now);
  check('one below it, the bot still asks', stillAsked !== null, JSON.stringify(stillAsked));

  // And engaging brings it straight back: recordGoalProgress zeroes the count,
  // which is what makes it "consecutive" rather than "ever".
  rig.db.prepare('UPDATE goals SET checkin_count = ? WHERE chat_id = ?')
    .run(db.GOAL_QUIET_AFTER + 5, HIM);
  await db.recordGoalProgress(rig.env, 1, 'שלחתי לה משהו');
  const revived = await db.stalestGoal(rig.env, HIM, now + 10 * 86_400_000);
  check('and one answer from him brings it back', revived !== null, JSON.stringify(revived));
  rig.restore();
}

await endToEnd();
await declineAndDrop();
await crowding();
await crowdingNamesTheRightDay();
await givingUpAsksWhetherItIsWorthKeeping();
await givingUpStaysQuietBelowTheFloor();
await aGoalHeNeverAnswersGoesQuiet();
await ladderHonesty();
done();
