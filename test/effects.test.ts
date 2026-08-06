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

  section('duplicate detection — clearly outside the window is NOT a duplicate');
  {
    // Two `once` schedules only carry HH:MM (no seconds — see time.ts's parse
    // regex), so the meaningful boundary to test at this granularity is
    // whole minutes. Five minutes apart is unambiguously outside any 60s
    // window and exercises the self-review question directly: a legitimate
    // second reminder must never be silently refused.
    const rig = createRig();
    seedSettings(rig);
    const base = wallToUtc(2026, 8, 7, 9, 0, TZ);

    await withNow(base - 3_600_000, async () => {
      await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', once_at: '2026-08-07T09:00' },
        'x',
      );
      const second = await applyIntent(
        rig.env, CHAT, await ctxFor(rig),
        { action: 'create_reminder', title: 'לקחת בגד ים', schedule_type: 'once', once_at: '2026-08-07T09:05' },
        'x',
      );
      eq('a same-title reminder 5 minutes outside the window creates normally', second[0].kind, 'reminder_created');
      check('and does not carry a duplicateOf warning',
        second[0].kind === 'reminder_created' && second[0].duplicateOf === undefined);
    });
    eq('both rows exist — a legitimate second reminder is never silently refused', reminderRows(rig).length, 2);
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

  done();
}

main();
