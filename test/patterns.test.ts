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

await endToEnd();
await crowding();
await ladderHonesty();
done();
