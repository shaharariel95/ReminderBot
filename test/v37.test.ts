/**
 * Run with `npm run test:v37`.
 *
 * **A retime goes where the router points, and nothing checks it.**
 *
 * Two production messages, a day apart, one cause. `reschedule` resolves
 * through `resolveReminder`, which reads `intent.target_id` straight into
 * `db.getReminder` — a primary-key lookup with a chat_id check and nothing
 * else. Every other field the model emits has code behind it: times through
 * `preferHisWords`, titles through `titleFromHisWords`, the addressee through
 * `friendFromHisWords`. The TARGET had nothing.
 *
 * **13.09.2026 10:56.** #80 "לקנות כרטיס לחתונה של אופיר" rang at 10:26 and
 * was on its second nag. He answered it:
 *
 *   10:56  him  תזיז ל16:00
 *   10:56  bot  הזזתי את #69 "לנקות את הפילטרים של המזגנים" ל-16:00.
 *   10:56  bot  מה, חם מדי בשביל לעשות את זה עכשיו?
 *   10:56  him  /list
 *   10:57  him  תזיז את 80 ל16:00
 *   10:57  him  תבטל את 69
 *
 * Three messages to undo one. His sentence named no errand at all, and the
 * one thing in the chat that "it" could mean was the instance the bot had
 * asked him about thirty minutes earlier. The router answered #69.
 *
 * **14.09.2026 21:02.** #90 "לדבר עם פרטנר…" was closed that morning at
 * 11:11. #80 was the only scheduled row left. He typed:
 *
 *   21:02  him  חתונה של אופיר
 *   21:02  bot  מתי לשים את "לדבר עם פרטנר להוריד מחיר חבילת סלולר"?
 *
 * The router returned `reschedule target_id=90`, and #90 is real — it is in
 * `doneSummary`, which shows finished rows with their ids and tells the model
 * they are revivable. But the licence it grants is conditional: "אם הוא נוקב
 * עכשיו בשעה". He named no hour, so the turn asked "when?" about an errand he
 * had finished ten hours earlier while the one he actually said sat one row
 * away. A rule that matters, living in the prompt.
 *
 * What must hold:
 *
 *   - his sentence names no row and exactly one thing is ringing → the ring
 *     wins, whatever id came back. It is the live question the bot just asked.
 *   - unless his sentence DID point at the router's row — by name or by the
 *     id he typed himself. "תזיז את 80" is the very next message in that
 *     transcript and it has to keep working.
 *   - a FINISHED row plus no hour is not a revival; his own words get the
 *     turn, and if they name nothing it asks rather than guessing.
 *   - an inbox capture is not a finished row. Giving one its first hour is
 *     the documented flow and must be untouched.
 */
import { applyIntent } from '../src/effects';
import type { Context } from '../src/brain';
import * as db from '../src/db';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

/** 13.09.2026 — #80 rang at 10:26, he answers at 10:56. */
const RANG = wallToUtc(2026, 9, 13, 10, 26, TZ);
const NOW = wallToUtc(2026, 9, 13, 10, 56, TZ);

const TICKET = 'לקנות כרטיס לחתונה של אופיר';
const FILTERS = 'לנקות את הפילטרים של המזגנים';
const CELL = 'לדבר עם פרטנר להוריד מחיר חבילת סלולר';

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

function seedReminder(
  rig: Rig,
  title: string,
  fireAt: number | null,
  status: 'scheduled' | 'done' | 'inbox' = 'scheduled',
): number {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      CHAT, title, JSON.stringify({ type: 'once', at: '2026-09-13T10:26' }), TZ,
      fireAt, status, status === 'scheduled' ? 1 : 0, NOW - 86_400_000,
    );
  return Number(r.lastInsertRowid);
}

/** A ringing instance: fired, nobody has reported back. */
function seedInstance(rig: Rig, reminderId: number, title: string): number {
  const r = rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count,
        status, due_at)
       VALUES (?, ?, ?, ?, ?, 1, 'open', ?)`,
    )
    .run(reminderId, CHAT, title, RANG, NOW + 1_800_000, RANG);
  return Number(r.lastInsertRowid);
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

function fireAt(rig: Rig, id: number): number | null {
  return (rig.db.prepare('SELECT next_fire_at FROM reminders WHERE id = ?').get(id) as any)
    ?.next_fire_at ?? null;
}

async function main(): Promise<void> {
  // =========================================================================
  section('13.09 — "תזיז ל16:00" while something is ringing');
  {
    const rig = createRig();
    seedSettings(rig);
    // Burned so the ids differ from the instance ids underneath them — a fresh
    // rig numbers both from 1, and "WHERE reminder_id = 1" is then true
    // whichever row was written.
    seedReminder(rig, 'burn', null, 'done');
    seedReminder(rig, 'burn', null, 'done');
    const filters = seedReminder(rig, FILTERS, wallToUtc(2026, 9, 20, 16, 30, TZ));
    const ticket = seedReminder(rig, TICKET, RANG);
    const cell = seedReminder(rig, CELL, wallToUtc(2026, 9, 14, 8, 30, TZ));
    seedInstance(rig, ticket, TICKET);
    const ctx = await ctxFor(rig);

    const before = { filters: fireAt(rig, filters), cell: fireAt(rig, cell) };
    const out = await withNow(NOW, () =>
      applyIntent(
        rig.env, CHAT, ctx,
        // Exactly what the router returned: a real id, for the wrong row.
        { action: 'reschedule', target_id: filters, schedule_type: 'once', time: '16:00' },
        'תזיז ל16:00',
      ),
    );

    eq('it retimes', out[0]?.kind, 'reminder_retimed');
    check('the row it moved is the one that was ringing',
      out[0]?.kind === 'reminder_retimed' && out[0].id === ticket,
      `moved: ${JSON.stringify(out[0])}`);
    eq('and the filters are where they were', fireAt(rig, filters), before.filters);
    eq('and so is the cellular one', fireAt(rig, cell), before.cell);
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('...but "תזיז את 80" is the very next message he sent');
  {
    // The half that keeps the redirect narrow. He names the id himself, the
    // router agrees, and nothing may second-guess either of them — and the id
    // he typed is the ONLY thing separating this from the case above, since
    // "תזיז את 80 ל16:00" names no errand either.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'burn', null, 'done');
    seedReminder(rig, 'burn', null, 'done');
    const filters = seedReminder(rig, FILTERS, wallToUtc(2026, 9, 20, 16, 30, TZ));
    const ticket = seedReminder(rig, TICKET, RANG);
    seedInstance(rig, ticket, TICKET);
    const ctx = await ctxFor(rig);

    const out = await withNow(NOW, () =>
      applyIntent(
        rig.env, CHAT, ctx,
        { action: 'reschedule', target_id: filters, schedule_type: 'once', time: '16:00' },
        `תזיז את ${filters} ל16:00`,
      ),
    );
    check('the row he typed the id of is the row that moves',
      out[0]?.kind === 'reminder_retimed' && out[0].id === filters,
      `moved: ${JSON.stringify(out[0])}`);
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('...and so does naming it');
  {
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'burn', null, 'done');
    const filters = seedReminder(rig, FILTERS, wallToUtc(2026, 9, 20, 16, 30, TZ));
    const ticket = seedReminder(rig, TICKET, RANG);
    seedInstance(rig, ticket, TICKET);
    const ctx = await ctxFor(rig);

    const out = await withNow(NOW, () =>
      applyIntent(
        rig.env, CHAT, ctx,
        { action: 'reschedule', target_id: filters, schedule_type: 'once', time: '16:00' },
        'תזיז את הפילטרים ל16:00',
      ),
    );
    check('a word of his that names the row beats the ring',
      out[0]?.kind === 'reminder_retimed' && out[0].id === filters,
      `moved: ${JSON.stringify(out[0])}`);
    rig.restore();
  }

  // =========================================================================
  section('14.09 — a finished row is a revival, and a revival needs an hour');
  {
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'burn', null, 'done');
    const cell = seedReminder(rig, CELL, null, 'done');
    const ticket = seedReminder(rig, TICKET, wallToUtc(2026, 9, 15, 20, 0, TZ));
    const ctx = await ctxFor(rig);

    const out = await withNow(NOW, () =>
      applyIntent(
        rig.env, CHAT, ctx,
        { action: 'reschedule', target_id: cell },
        'חתונה של אופיר',
      ),
    );
    eq('it still asks for the hour', out[0]?.kind, 'needs_time');
    check('but about the errand he actually named',
      out[0]?.kind === 'needs_time' && out[0].id === ticket,
      `asked about: ${JSON.stringify(out[0])}`);
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('...and WITH an hour, reviving a finished row still works');
  {
    // doneSummary shows finished rows for exactly this, and the prompt's own
    // wording is the condition: "אם הוא נוקב עכשיו בשעה, הוא רוצה אותה שוב".
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'burn', null, 'done');
    const cell = seedReminder(rig, CELL, null, 'done');
    const ctx = await ctxFor(rig);

    const out = await withNow(NOW, () =>
      applyIntent(
        rig.env, CHAT, ctx,
        { action: 'reschedule', target_id: cell, schedule_type: 'once', time: '18:00' },
        'תחזיר את פרטנר ל18:00',
      ),
    );
    check('the finished row is revived',
      out[0]?.kind === 'reminder_retimed' && out[0].id === cell,
      `got: ${JSON.stringify(out[0])}`);
    rig.restore();
  }

  // -------------------------------------------------------------------------
  section('...and an inbox capture is not a finished row');
  {
    // A capture has no hour by construction. Asking "when?" about one is the
    // whole point of the flow, so the rule above must not reach it.
    const rig = createRig();
    seedSettings(rig);
    seedReminder(rig, 'burn', null, 'done');
    const captured = seedReminder(rig, 'לדבר עם רואה החשבון', null, 'inbox');
    const ctx = await ctxFor(rig);
    ctx.inbox = [(rig.db.prepare('SELECT * FROM reminders WHERE id = ?').get(captured) as any)];

    const out = await withNow(NOW, () =>
      applyIntent(rig.env, CHAT, ctx, { action: 'reschedule', target_id: captured }, 'מתי שיהיה'),
    );
    eq('it asks for the hour', out[0]?.kind, 'needs_time');
    check('about the capture itself',
      out[0]?.kind === 'needs_time' && out[0].id === captured,
      `asked about: ${JSON.stringify(out[0])}`);
    rig.restore();
  }

  done();
}

main();
