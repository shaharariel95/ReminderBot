/**
 * Run with `npm run test:effects`.
 *
 * Two independent behaviours of applyIntent's create/complete/snooze cases:
 *
 * 1. Duplicate detection — a create_reminder that lands within 60s of an
 *    existing scheduled reminder must not silently double-insert. Exact
 *    title match: no insert, `reminder_duplicate` naming the existing row.
 *    Near match: insert proceeds, but `reminder_created.duplicateOf` warns.
 *
 * 2. Task disambiguation — complete/snooze with an unresolved target and
 *    MORE THAN ONE open instance must ask which one (`needs_task_choice`),
 *    not falsely claim there is no matching task.
 */
import { applyIntent } from '../src/effects';
import * as db from '../src/db';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Context } from '../src/brain';
import { wallToUtc } from '../src/time';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

function seedSettings(rig: Rig): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
                             quiet_start_hour, quiet_end_hour, next_checkin_at)
       VALUES (?, ?, 2, 0, 2, 23, 8, NULL)`,
    )
    .run(CHAT, TZ);
}

async function ctxFor(rig: Rig): Promise<Context> {
  const [settings, stats, rems, goals, open] = await Promise.all([
    db.getSettings(rig.env, CHAT),
    db.stats(rig.env, CHAT),
    db.listReminders(rig.env, CHAT),
    db.listGoals(rig.env, CHAT),
    db.openInstances(rig.env, CHAT),
  ]);
  return { settings, stats, reminders: rems, goals, open, nowLabel: 'עכשיו' };
}

function reminderRows(rig: Rig): { id: number; title: string; next_fire_at: number | null }[] {
  return rig.db.prepare('SELECT id, title, next_fire_at FROM reminders').all() as any;
}

/** An already-open instance, so complete/snooze have something to resolve. */
function seedInstance(rig: Rig, title: string, firedAt: number): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
       VALUES (?, ?, '{"type":"once","at":"2099-01-01T07:00"}', ?, ?, 'scheduled', 1, ?)`,
    )
    .run(CHAT, title, TZ, firedAt + 3_600_000, Date.now());
  const reminderId = Number(r.lastInsertRowid);
  const i = rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, status) VALUES (?, ?, ?, ?, 'open')`,
    )
    .run(reminderId, CHAT, title, firedAt);
  return Number(i.lastInsertRowid);
}

/** A plain scheduled reminder with no instance attached. */
function seedReminder(rig: Rig, title: string, fireAt: number, chatId = CHAT): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 1, ?)`,
    )
    .run(chatId, title, JSON.stringify({ type: 'once', at: '2099-01-01T07:00' }), TZ, fireAt, Date.now());
  return Number(r.lastInsertRowid);
}

/** The note column specifically — rowById deliberately projects only three columns. */
function notesOf(rig: Rig, id: number): string | null {
  return (rig.db.prepare('SELECT notes FROM reminders WHERE id = ?').get(id) as any).notes;
}

function rowById(rig: Rig, id: number): { title: string; next_fire_at: number | null; status: string } {
  return rig.db
    .prepare('SELECT title, next_fire_at, status FROM reminders WHERE id = ?')
    .get(id) as any;
}

async function main() {
  // =========================================================================
  section('duplicate detection — exact title match within the 60s window');
  {
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();

    await withNow(now, async () => {
      const ctx1 = await ctxFor(rig);
      const first = await applyIntent(
        rig.env, CHAT, ctx1,
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', in_minutes: 30 },
        'תזכיר לי עוד חצי שעה לקחת בגד ים',
      );
      eq('first create succeeds normally', first[0].kind, 'reminder_created');
      const firstId = (first[0] as any).id as number;

      const ctx2 = await ctxFor(rig);
      const second = await applyIntent(
        rig.env, CHAT, ctx2,
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', in_minutes: 30 },
        'תזכיר לי עוד חצי שעה לקחת בגד ים',
      );

      eq('the second identical request is reported as a duplicate, not created', second[0].kind, 'reminder_duplicate');
      check(
        'the duplicate effect names the EXISTING row, not a new one',
        second[0].kind === 'reminder_duplicate' && second[0].id === firstId,
        `expected id ${firstId}, got ${JSON.stringify(second[0])}`,
      );
      eq('only one row was ever inserted — no silent double-send', reminderRows(rig).length, 1);
    });
    rig.restore();
  }

  section('duplicate detection — punctuation/whitespace differences still count as exact');
  {
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();

    await withNow(now, async () => {
      await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת   בגד-ים!', schedule_type: 'once', in_minutes: 10 },
        'x',
      );
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', in_minutes: 10 },
        'x',
      );
      eq(
        'normalisation (whitespace/punctuation/case) treats these as the same title',
        second[0].kind,
        'reminder_duplicate',
      );
    });
    rig.restore();
  }

  section('duplicate detection — outside the window is warned about, never refused');
  {
    // Two `once` schedules only carry HH:MM (no seconds — see time.ts's parse
    // regex), so the meaningful boundary to test at this granularity is
    // whole minutes. Five minutes apart is outside the 60s window, so the
    // insert must go through — but it IS the same thing on the same day, which
    // is what the wider check exists to notice.
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);

    await withNow(base - 3_600_000, async () => {
      const first = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', once_at: '2026-08-07T09:00' },
        'x',
      );
      const firstId = (first[0] as any).id as number;
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', once_at: '2026-08-07T09:05' },
        'x',
      );
      eq('a same-title reminder 5 minutes outside the window creates normally', second[0].kind, 'reminder_created');
      check(
        'but is flagged against the one already on the same day, with its time',
        second[0].kind === 'reminder_created' &&
          second[0].duplicateOf?.id === firstId &&
          second[0].duplicateOf?.at === wallToUtc(2026, 8, 7, 9, 0, TZ),
        `got: ${JSON.stringify(second[0])}`,
      );
    });
    eq('both rows exist — a legitimate second reminder is never silently refused', reminderRows(rig).length, 2);
    rig.restore();
  }

  section('duplicate detection — the same-day check warns, it never refuses');
  {
    // The realistic case the 60-second window was never going to catch: he
    // asked for the same thing twice, hours apart, having forgotten the first.
    // It still has to be CREATED, because "the pill at 09:00 and again at
    // 21:00" is an ordinary pair and refusing it would be far worse than
    // mentioning it.
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);

    await withNow(base - 3_600_000, async () => {
      const first = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת כדור', schedule_type: 'once', once_at: '2026-08-07T09:00' },
        'x',
      );
      const firstId = (first[0] as any).id as number;
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת כדור', schedule_type: 'once', once_at: '2026-08-07T21:00' },
        'x',
      );
      eq('twelve hours apart still creates', second[0].kind, 'reminder_created');
      check('and warns, naming the other one and when it is',
        second[0].kind === 'reminder_created' && second[0].duplicateOf?.id === firstId,
        `got: ${JSON.stringify(second[0])}`);
    });
    eq('both were written — the user decides, not the bot', reminderRows(rig).length, 2);
    rig.restore();
  }

  section('duplicate detection — a different task on the same day is not a duplicate');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);

    await withNow(base - 3_600_000, async () => {
      await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת כדור', schedule_type: 'once', once_at: '2026-08-07T09:00' },
        'x',
      );
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'להתקשר לאמא', schedule_type: 'once', once_at: '2026-08-07T21:00' },
        'x',
      );
      check('an unrelated task on the same day is left alone',
        second[0].kind === 'reminder_created' && second[0].duplicateOf === undefined,
        `got: ${JSON.stringify(second[0])}`);
    });
    rig.restore();
  }

  section('duplicate detection — the next DAY is a different day');
  {
    // The window is the local calendar day. A daily habit created two days
    // running must not accuse itself.
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);

    await withNow(base - 3_600_000, async () => {
      await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת כדור', schedule_type: 'once', once_at: '2026-08-07T09:00' },
        'x',
      );
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת כדור', schedule_type: 'once', once_at: '2026-08-08T09:00' },
        'x',
      );
      check('tomorrow is not today',
        second[0].kind === 'reminder_created' && second[0].duplicateOf === undefined,
        `got: ${JSON.stringify(second[0])}`);
    });
    rig.restore();
  }

  section('duplicate detection — exactly at the 60s boundary still counts (inclusive window)');
  {
    // Two creates one minute apart is exactly the "two quick double-sends
    // straddling a minute boundary" case the window exists for — e.g. one
    // request computed at 12:04:58 and another at 12:05:02, both "in 5
    // minutes", land on next_fire_at values exactly 60s apart. That must
    // still be caught, not treated as just outside the window.
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);

    await withNow(base - 3_600_000, async () => {
      const first = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', once_at: '2026-08-07T09:00' },
        'x',
      );
      const firstId = (first[0] as any).id as number;
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', once_at: '2026-08-07T09:01' },
        'x',
      );
      eq('exactly 60s apart is still within the (inclusive) window', second[0].kind, 'reminder_duplicate');
      check('and names the first row',
        second[0].kind === 'reminder_duplicate' && second[0].id === firstId);
    });
    rig.restore();
  }

  section('duplicate detection — near match (similar, not identical) inserts but warns');
  {
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();

    await withNow(now, async () => {
      const first = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים לים', schedule_type: 'once', in_minutes: 15 },
        'x',
      );
      const firstId = (first[0] as any).id as number;

      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', in_minutes: 15 },
        'x',
      );

      eq('a near-duplicate is still created (not silently dropped)', second[0].kind, 'reminder_created');
      check(
        'but it carries duplicateOf pointing at the existing similar reminder',
        second[0].kind === 'reminder_created' &&
          second[0].duplicateOf?.id === firstId &&
          second[0].duplicateOf?.title === 'לקחת בגד ים לים',
        `got: ${JSON.stringify(second[0])}`,
      );
    });
    eq('both rows were actually inserted', reminderRows(rig).length, 2);
    rig.restore();
  }

  section('duplicate detection — unrelated titles never collide');
  {
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();

    await withNow(now, async () => {
      await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', in_minutes: 5 },
        'x',
      );
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'להתקשר לרופא', schedule_type: 'once', in_minutes: 5 },
        'x',
      );
      eq('a completely different title creates cleanly', second[0].kind, 'reminder_created');
      check('no duplicateOf warning on an unrelated title',
        second[0].kind === 'reminder_created' && second[0].duplicateOf === undefined);
    });
    rig.restore();
  }

  section('duplicate detection — generic fallback title ("תזכורת"): exact still applies, near-match does not');
  {
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();

    await withNow(now, async () => {
      const first = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', schedule_type: 'once', in_minutes: 5 }, // no title -> falls back to "תזכורת"
        'תזכיר לי עוד 5 דקות',
      );
      eq('the fallback title is used', (first[0] as any).title, 'תזכורת');

      // Exact same generic title, same minute — this IS treated as a duplicate;
      // the design explicitly allows the exact rule for generic titles because
      // an identical title at the same minute really is a double-send.
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', schedule_type: 'once', in_minutes: 5 },
        'תזכיר לי עוד 5 דקות',
      );
      eq('two identical generic-titled reminders at the same minute are still an exact duplicate', second[0].kind, 'reminder_duplicate');
    });
    rig.restore();
  }
  {
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();

    await withNow(now, async () => {
      await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', schedule_type: 'once', in_minutes: 5 }, // "תזכורת"
        'x',
      );
      // A generic title vs a specific title that happens to contain it in some
      // sense should NOT be flagged as a near-duplicate — generic titles are
      // excluded from near-matching entirely.
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'תזכורת לגבי הפגישה', schedule_type: 'once', in_minutes: 5 },
        'x',
      );
      eq('a specific title vs a generic one creates cleanly', second[0].kind, 'reminder_created');
      check(
        'near-matching is skipped when either side is generic',
        second[0].kind === 'reminder_created' && second[0].duplicateOf === undefined,
        `got: ${JSON.stringify(second[0])}`,
      );
    });
    rig.restore();
  }
  {
    // The mirror of the block above: this time the NEW title is the generic
    // one (no subject given -> falls back to "תזכורת") and the EXISTING
    // candidate is specific but happens to contain "תזכורת" as a token, e.g.
    // a reminder literally called "תזכורת חשובה מהבוקר". Without the outer
    // `generic ? undefined : ...` guard in effects.ts (as opposed to the
    // inner `!isGenericTitle(normExisting)` check, which only covers the
    // OTHER direction), containment alone (shorter="תזכורת", length >= 3,
    // longer.includes(shorter)) would still fire and produce a spurious
    // duplicateOf warning against an unrelated reminder.
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();

    await withNow(now, async () => {
      await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'תזכורת חשובה מהבוקר', schedule_type: 'once', in_minutes: 5 },
        'x',
      );
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', schedule_type: 'once', in_minutes: 5 }, // no title -> "תזכורת"
        'תזכיר לי עוד 5 דקות',
      );
      eq('a generic new title vs a specific existing one creates cleanly', second[0].kind, 'reminder_created');
      check(
        'near-matching is skipped when the NEW (not just the existing) title is generic',
        second[0].kind === 'reminder_created' && second[0].duplicateOf === undefined,
        `got: ${JSON.stringify(second[0])}`,
      );
    });
    rig.restore();
  }

  // =========================================================================
  section('disambiguation — complete with two+ open instances and no resolvable target_id');
  {
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();
    const id1 = seedInstance(rig, 'לקחת בגד ים', now - 1000);
    const id2 = seedInstance(rig, 'לזרוק זבל', now - 2000);

    const ctx = await ctxFor(rig);
    eq('two instances are open', ctx.open.length, 2);

    const result = await applyIntent(rig.env, CHAT, ctx, { action: 'complete' }, 'סיימתי');
    eq('a needs_task_choice effect is returned, not a false "no open task"', result[0].kind, 'needs_task_choice');
    if (result[0].kind === 'needs_task_choice') {
      eq('action is "complete"', result[0].action, 'complete');
      eq('both open instances are carried', result[0].open.map((i) => i.id).sort(), [id1, id2].sort());
    }

    // Neither instance was touched.
    const stillOpen = rig.db.prepare("SELECT COUNT(*) c FROM instances WHERE status='open'").get() as any;
    eq('neither instance was closed', stillOpen.c, 2);
    rig.restore();
  }

  section('disambiguation — snooze with two+ open instances and an unresolvable target_id');
  {
    const rig = createRig();
    seedSettings(rig);
    const now = Date.now();
    seedInstance(rig, 'לקחת בגד ים', now - 1000);
    seedInstance(rig, 'לזרוק זבל', now - 2000);

    const ctx = await ctxFor(rig);
    // target_id given but stale/unresolvable (matches nothing open).
    const result = await applyIntent(rig.env, CHAT, ctx, { action: 'snooze', target_id: 999999 }, 'דחה');
    eq('a needs_task_choice effect is returned for snooze too', result[0].kind, 'needs_task_choice');
    if (result[0].kind === 'needs_task_choice') eq('action is "snooze"', result[0].action, 'snooze');
    rig.restore();
  }

  section('disambiguation — regression: a single open instance still resolves without asking');
  {
    const rig = createRig();
    seedSettings(rig);
    const id = seedInstance(rig, 'לקחת בגד ים', Date.now() - 1000);
    const ctx = await ctxFor(rig);

    const result = await applyIntent(rig.env, CHAT, ctx, { action: 'complete' }, 'סיימתי');
    eq('a lone open instance is completed directly, no disambiguation needed', result[0].kind, 'instance_done');
    check('it closed the right instance', result[0].kind === 'instance_done' && result[0].id === id);
    rig.restore();
  }

  section('disambiguation — regression: zero open instances still says "no open task", not a choice list');
  {
    const rig = createRig();
    seedSettings(rig);
    const ctx = await ctxFor(rig);

    const result = await applyIntent(rig.env, CHAT, ctx, { action: 'complete' }, 'סיימתי');
    eq('the genuinely-empty case keeps its existing message', result[0].kind, 'nothing');
    check('with the right reason', result[0].kind === 'nothing' && result[0].why === 'no_open_task');
    rig.restore();
  }

  // =========================================================================
  section('snooze — a length he actually said beats the 30-minute default');
  {
    // From the 10.08.2026 transcript. He said "עוד שעה"; the router returned a
    // snooze with no snooze_minutes; the 30-minute fallback filled in and
    // voice.ts then reported it back to him as his own number ("הזזתי ב-30
    // דקות"). The write was real, so validate.ts could never catch it — the
    // lie is upstream of the model entirely.
    const rig = createRig();
    seedSettings(rig);
    const id = seedInstance(rig, 'לעבור במשק 27', Date.now() - 60_000);
    const ctx = await ctxFor(rig);

    const result = await applyIntent(
      rig.env, CHAT, ctx,
      { action: 'snooze' }, // no snooze_minutes — exactly what the router returned
      'עוד שעה, אעבוד עד קצת יותר מאוחר היום',
    );
    eq('the effect is a snooze', result[0].kind, 'instance_snoozed');
    check('it reports the hour he asked for, not the default',
      result[0].kind === 'instance_snoozed' && result[0].minutes === 60,
      `got: ${JSON.stringify(result[0])}`);

    // The stated number and the row must agree. Reporting 60 while moving the
    // row 30 would be the same class of bug wearing the opposite mask.
    const inst = rig.db.prepare('SELECT next_nag_at, fired_at FROM instances WHERE id = ?').get(id) as any;
    check('and the instance really moved by an hour',
      Number(inst.next_nag_at) - Date.now() > 55 * 60_000,
      `next_nag_at is ${Number(inst.next_nag_at) - Date.now()}ms out`);
    rig.restore();
  }

  section('snooze — an explicit snooze_minutes from the router still wins');
  {
    // parseDuration is a fallback, not an override: when the router did the
    // work, its answer is the one that stands even if the text also contains
    // a parsable length.
    const rig = createRig();
    seedSettings(rig);
    seedInstance(rig, 'לעבור במשק 27', Date.now() - 60_000);
    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'snooze', snooze_minutes: 15 },
      'תדחה בחצי שעה',
    );
    check('the router\'s 15 minutes is used, not the text\'s 30',
      result[0].kind === 'instance_snoozed' && result[0].minutes === 15,
      `got: ${JSON.stringify(result[0])}`);
    rig.restore();
  }

  section('snooze — with no length stated anywhere, the 30-minute default still applies');
  {
    const rig = createRig();
    seedSettings(rig);
    seedInstance(rig, 'לעבור במשק 27', Date.now() - 60_000);
    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig), { action: 'snooze' }, 'תדחה את זה',
    );
    check('the fallback is unchanged when he named no length',
      result[0].kind === 'instance_snoozed' && result[0].minutes === 30,
      `got: ${JSON.stringify(result[0])}`);
    rig.restore();
  }

  section('snooze — a clock reading in the text is not mistaken for a length');
  {
    // "בשעה 10" is a time, not "10 hours". If parseDuration ever reads it as a
    // duration, a snooze request lands 600 minutes away and the bot says so
    // with total confidence.
    const rig = createRig();
    seedSettings(rig);
    seedInstance(rig, 'לעבור במשק 27', Date.now() - 60_000);
    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig), { action: 'snooze' }, 'תדחה לשעה 10',
    );
    check('it falls back to the default rather than reading the clock as a length',
      result[0].kind === 'instance_snoozed' && result[0].minutes === 30,
      `got: ${JSON.stringify(result[0])}`);
    rig.restore();
  }

  // =========================================================================
  section('annotate — the answer to "why?" is kept, not just laughed at');
  {
    // 09.08.2026 20:06. It asked "מה איבדת שם?", he said "בשר אחי", it made a
    // joke and stored nothing. `reminders.notes` has existed the whole time
    // and was only ever written as null. The next day's nag had to fall back
    // on conversation history, which gets pruned — so the one detail that
    // makes a nag land is also the first thing the bot forgets.
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לעבור במשק 27', Date.now() + 3_600_000);

    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'annotate', target_id: id, note: 'בשר' }, 'בשר אחי',
    );
    eq('the effect reports the annotation', result[0].kind, 'reminder_annotated');
    eq('the note is on the row, where it outlives the conversation',
      notesOf(rig, id), 'בשר');
    rig.restore();
  }
  {
    // Annotating replaces rather than appends: the second answer to the same
    // question is a correction, not an addition.
    const rig = createRig();
    seedSettings(rig);
    const id = seedReminder(rig, 'לעבור במשק 27', Date.now() + 3_600_000);
    const ctx = await ctxFor(rig);
    await applyIntent(rig.env, CHAT, ctx, { action: 'annotate', target_id: id, note: 'בשר' }, 'בשר');
    await applyIntent(rig.env, CHAT, ctx, { action: 'annotate', target_id: id, note: 'בשר ויין' }, 'וגם יין');
    eq('the latest answer wins', notesOf(rig, id), 'בשר ויין');
    rig.restore();
  }
  {
    const rig = createRig();
    seedSettings(rig);
    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig), { action: 'annotate', note: 'בשר' }, 'בשר אחי',
    );
    eq('with no reminder to attach it to, it says so', result[0].kind, 'nothing');
    check('rather than inventing one',
      result[0].kind === 'nothing' && result[0].why === 'unknown_reminder');
    rig.restore();
  }

  // =========================================================================
  section('on_my_way — "I am doing it right now" is neither done nor postponed');
  {
    // 10.08.2026, 16:37: a photo captioned "הנה הנה נוסע עכשיו". He was on the
    // road, reporting in. The bot had exactly two things it could do with that
    // — close the task (a lie, he had not arrived) or nag him again (he was
    // literally driving there) — because open/done/failed/skipped has no state
    // for "in progress". So it is a write, and it must be reported as one.
    const rig = createRig();
    seedSettings(rig);
    const id = seedInstance(rig, 'לעבור במשק 27', Date.now() - 3_600_000);
    // Due for a nag any second now.
    rig.db.prepare('UPDATE instances SET next_nag_at = ? WHERE id = ?').run(Date.now() - 1000, id);

    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig), { action: 'on_my_way' }, 'הנה הנה נוסע עכשיו',
    );
    eq('the effect says he started, not that he finished', result[0].kind, 'instance_started');

    const row = rig.db.prepare('SELECT status, next_nag_at, closed_at FROM instances WHERE id = ?')
      .get(id) as any;
    eq('the task stays open — he has not arrived yet', row.status, 'open');
    eq('and is not closed', row.closed_at, null);
    check('the next nag is pushed out past the grace window',
      Number(row.next_nag_at) - Date.now() > 20 * 60_000,
      `next_nag_at is ${Number(row.next_nag_at) - Date.now()}ms out`);
    rig.restore();
  }
  {
    // It must not resurrect something already finished, and with nothing open
    // it has to say so rather than invent a task to be on the way to.
    const rig = createRig();
    seedSettings(rig);
    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig), { action: 'on_my_way' }, 'בדרך',
    );
    eq('nothing open means nothing to start', result[0].kind, 'nothing');
    check('with the honest reason',
      result[0].kind === 'nothing' && result[0].why === 'no_open_task');
    rig.restore();
  }
  {
    // Two open tasks and no target: ask, exactly as complete and snooze do.
    const rig = createRig();
    seedSettings(rig);
    seedInstance(rig, 'לעבור במשק 27', Date.now() - 1000);
    seedInstance(rig, 'לזרוק זבל', Date.now() - 2000);
    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig), { action: 'on_my_way' }, 'בדרך',
    );
    eq('it asks which one', result[0].kind, 'needs_task_choice');
    rig.restore();
  }

  // =========================================================================
  section('reschedule — moves an existing reminder instead of creating a second one');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);
    const id = seedReminder(rig, 'לרוץ', base);

    await withNow(base - 3_600_000, async () => {
      const result = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'reschedule', target_id: id, schedule_type: 'once', once_at: '2026-08-07T21:00' },
        'תעביר את הריצה ל-21:00',
      );
      eq('the effect reports a retime, not a creation', result[0].kind, 'reminder_retimed');
      check('and names the reminder it moved',
        result[0].kind === 'reminder_retimed' && result[0].id === id && result[0].title === 'לרוץ',
        `got: ${JSON.stringify(result[0])}`);
    });

    eq('no second reminder was inserted', reminderRows(rig).length, 1);
    eq('the row actually moved', rowById(rig, id).next_fire_at, wallToUtc(2026, 8, 7, 21, 0, TZ));
    rig.restore();
  }

  section('reschedule — an inbox capture (no fire time) becomes scheduled');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);

    await withNow(base - 3_600_000, async () => {
      // Inbox items are excluded from listReminders, so this only works because
      // resolveReminder reads by id rather than searching ctx.reminders.
      const id = await db.addInboxItem(rig.env, CHAT, 'לקנות מתנה', TZ);
      eq('the capture starts with no fire time', rowById(rig, id).next_fire_at, null);

      const result = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'reschedule', target_id: id, schedule_type: 'once', in_minutes: 60 },
        'תזכיר לי את זה עוד שעה',
      );
      // Was `reminder_retimed` until 17.08.2026, which this section's own name
      // ("becomes scheduled") already disagreed with. voice.ts words that kind
      // as "שיניתי" — I CHANGED it — about a row that never had a time to
      // change, and the kind sits in the `move` CLAIM_GROUP alone, so the
      // persona could legally escalate the baseline to "הזזתי".
      //
      // reminder_scheduled is in BOTH groups on purpose (validate.ts): giving
      // an inbox item its first hour is as fairly called a create as a move.
      // It is also what the `plan` button has always emitted for this exact
      // user-visible action — two roads to one outcome must not produce two
      // different sentences.
      eq('the capture is scheduled, not "changed"', result[0].kind, 'reminder_scheduled');
      eq('and is now scheduled rather than sitting in the inbox', rowById(rig, id).status, 'scheduled');
    });
    rig.restore();
  }

  section('reschedule — two candidates and no target_id asks which, and moves nothing');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);
    const a = seedReminder(rig, 'לרוץ', base);
    const b = seedReminder(rig, 'להתקשר לאמא', base + 7_200_000);

    await withNow(base - 3_600_000, async () => {
      const result = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'reschedule', schedule_type: 'once', once_at: '2026-08-07T21:00' },
        'תעביר את זה ל-21:00',
      );
      eq('it asks which reminder', result[0].kind, 'needs_reminder_choice');
      if (result[0].kind === 'needs_reminder_choice') {
        eq('carrying the action it was going to perform', result[0].action, 'reschedule');
        eq('and both candidates', result[0].rows.map((r) => r.id).sort(), [a, b].sort());
      }
    });

    eq('neither reminder was moved', rowById(rig, a).next_fire_at, base);
    eq('nor the other one', rowById(rig, b).next_fire_at, base + 7_200_000);
    rig.restore();
  }

  section('reschedule — a lone reminder resolves without a target_id');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);
    const id = seedReminder(rig, 'לרוץ', base);

    await withNow(base - 3_600_000, async () => {
      const result = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'reschedule', schedule_type: 'once', once_at: '2026-08-07T21:00' },
        'תעביר את זה ל-21:00',
      );
      eq('"תעביר את זה" with one reminder on file is unambiguous', result[0].kind, 'reminder_retimed');
    });
    eq('and it moved', rowById(rig, id).next_fire_at, wallToUtc(2026, 8, 7, 21, 0, TZ));
    rig.restore();
  }

  section('reschedule — no new time given writes nothing');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);
    const id = seedReminder(rig, 'לרוץ', base);

    await withNow(base - 3_600_000, async () => {
      const result = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'reschedule', target_id: id },
        'תעביר את זה',
      );
      // `needs_time`, not `nothing: 'no_time'`. The distinction is the whole
      // fix for 13.08.2026: this effect carries the reminder it is asking
      // about, so the bare "15:00" that arrives a second later has something
      // to attach itself to. `nothing` carried no id and the answer was lost.
      eq('it asks for a time', result[0].kind, 'needs_time');
      check(
        'and names which reminder it is asking about',
        result[0].kind === 'needs_time' && result[0].id === id,
      );
    });
    eq('the reminder is untouched', rowById(rig, id).next_fire_at, base);
    rig.restore();
  }

  // =========================================================================
  section('rename — changes the wording and leaves the schedule alone');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);
    const id = seedReminder(rig, 'לקנות חלב', base);

    await withNow(base - 3_600_000, async () => {
      const result = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'rename', target_id: id, title: 'לקנות לחם' },
        'זה לא חלב זה לחם',
      );
      eq('a rename effect comes back', result[0].kind, 'reminder_renamed');
      check('carrying BOTH the old and the new wording — the reply has to name each',
        result[0].kind === 'reminder_renamed' && result[0].from === 'לקנות חלב' && result[0].to === 'לקנות לחם',
        `got: ${JSON.stringify(result[0])}`);
    });

    eq('the row was actually renamed', rowById(rig, id).title, 'לקנות לחם');
    eq('and its fire time did not move', rowById(rig, id).next_fire_at, base);
    rig.restore();
  }

  section('rename — renaming to the identical title reports no change');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);
    const id = seedReminder(rig, 'לקנות חלב', base);

    await withNow(base - 3_600_000, async () => {
      const result = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'rename', target_id: id, title: 'לקנות חלב' },
        'תקרא לזה לקנות חלב',
      );
      // reminder_renamed is in WROTE, so returning it here would licence
      // "שיניתי" for a turn in which nothing changed.
      eq('no write is claimed when the title is already that', result[0].kind, 'nothing');
    });
    rig.restore();
  }

  section('rename/reschedule — a target_id belonging to another chat is refused');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);
    // db.getReminder looks up by primary key alone — without the chat_id check
    // in resolveReminder, a hallucinated target_id could reach across chats.
    const foreign = seedReminder(rig, 'משהו של מישהו אחר', base, '99999');

    await withNow(base - 3_600_000, async () => {
      const renamed = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'rename', target_id: foreign, title: 'נחטף' },
        'x',
      );
      eq('rename refuses', renamed[0].kind, 'nothing');

      const moved = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'reschedule', target_id: foreign, schedule_type: 'once', once_at: '2026-08-07T21:00' },
        'x',
      );
      eq('reschedule refuses too', moved[0].kind, 'nothing');
    });

    eq("the other chat's title is intact", rowById(rig, foreign).title, 'משהו של מישהו אחר');
    eq('and its schedule is intact', rowById(rig, foreign).next_fire_at, base);
    rig.restore();
  }

  section('rename — a cancelled reminder cannot be renamed back into the listings');
  {
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);
    const id = seedReminder(rig, 'לרוץ', base);
    await db.deleteReminder(rig.env, CHAT, id);

    await withNow(base - 3_600_000, async () => {
      const result = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'rename', target_id: id, title: 'לרוץ שוב' },
        'x',
      );
      eq('a cancelled reminder is not a rename target', result[0].kind, 'nothing');
    });
    eq('its title is unchanged', rowById(rig, id).title, 'לרוץ');
    rig.restore();
  }

  // =========================================================================
  section('profile — a stated fact is stored once, and re-stating it claims nothing');
  {
    const rig = createRig();
    seedSettings(rig);

    const first = await applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'remember', note: 'אני קם ב-6 כל בוקר' },
      'אני קם ב-6 כל בוקר',
    );
    eq('the first telling is stored', first[0].kind, 'profile_noted');

    const again = await applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'remember', note: 'אני קם ב-6 כל בוקר' },
      'אני קם ב-6 כל בוקר',
    );
    // profile_noted is in WROTE; profile_known deliberately is not. Returning
    // the former here would licence "רשמתי" for a turn that wrote nothing.
    eq('the second is reported as already known', again[0].kind, 'profile_known');

    const rows = rig.db.prepare('SELECT COUNT(*) c FROM profile').get() as any;
    eq('and only one row exists', rows.c, 1);
    rig.restore();
  }

  section('profile — forgetting works by what he said, not only by id');
  {
    const rig = createRig();
    seedSettings(rig);
    await db.addProfileNote(rig.env, CHAT, 'אני קם ב-6 כל בוקר');
    await db.addProfileNote(rig.env, CHAT, 'אני שונא לרוץ בבוקר');

    const gone = await applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'forget', note: 'קם ב-6' },
      'תשכח שאני קם ב-6',
    );
    eq('the matching note is removed', gone[0].kind, 'profile_forgotten');
    check('and it is the right one',
      gone[0].kind === 'profile_forgotten' && gone[0].note === 'אני קם ב-6 כל בוקר',
      JSON.stringify(gone[0]));

    const left = await db.listProfileNotes(rig.env, CHAT);
    eq('the other one is untouched', left.length, 1);
    eq('and it is the one he did not mention', left[0].note, 'אני שונא לרוץ בבוקר');
    rig.restore();
  }

  section('profile — forgetting something that was never said writes nothing');
  {
    const rig = createRig();
    seedSettings(rig);
    await db.addProfileNote(rig.env, CHAT, 'אני קם ב-6 כל בוקר');

    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'forget', note: 'משהו שמעולם לא אמרתי' },
      'x',
    );
    eq('it says so instead of deleting something at random', result[0].kind, 'nothing');
    check('with a reason of its own', result[0].kind === 'nothing' && result[0].why === 'unknown_note');
    eq('nothing was deleted', (await db.listProfileNotes(rig.env, CHAT)).length, 1);
    rig.restore();
  }

  section('profile — notes are capped so they cannot crowd out the prompt');
  {
    const rig = createRig();
    seedSettings(rig);
    const long = 'א'.repeat(500);
    const result = await applyIntent(
      rig.env, CHAT, await ctxFor(rig), { action: 'remember', note: long }, long,
    );
    check('the stored note is truncated',
      result[0].kind === 'profile_noted' && result[0].note.length === db.PROFILE_NOTE_MAX,
      JSON.stringify((result[0] as any).note?.length));
    const stored = await db.listProfileNotes(rig.env, CHAT);
    eq('in the database too, not just in the effect', stored[0].note.length, db.PROFILE_NOTE_MAX);
    rig.restore();
  }

  done();
}

main();
