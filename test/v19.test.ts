/**
 * Run with `npm run test:v19`.
 *
 * One turn from production, 03.09.2026 17:07, running 0.16.2. Reminder #69 had
 * fired at 16:30 and been nagged at 17:00 and was still open:
 *
 *   17:07  Shahar  תזכיר לי עוד שעה
 *   17:07  נו?     סגרנו על #75.
 *   17:07  נו?     אבל על מה להזכיר לך ובאיזו שעה בדיוק? תדייק אותי רגע.
 *
 * Four separate defects, stacked:
 *
 *   1. the hour was in the sentence. `readWhen` reads "עוד שעה" as
 *      {kind:'duration',minutes:60} and always has — `preferHisWords` then
 *      throws it away, because it acts only on `kind:'instant'`.
 *   2. with something ringing, a bare relative push is a SNOOZE. CLAUDE.md
 *      says so and `applyIntent` enforces it deterministically — but only on
 *      the `reschedule` path, and the router called this a create.
 *   3. "סגרנו" is not in the CLAIM lexicon. `סגרתי` is.
 *   4. and even if it were, `reminder_captured` sat in the same CLAIM_GROUP as
 *      קבעתי / נקבע / שמרתי, so the persona was LICENSED to report a row with
 *      no time as an agreed appointment.
 *
 * Plus two things the same audit found and this turn did not happen to show:
 * rule 4's frames, and a goal backoff with no way out.
 */
import * as db from '../src/db';
import { applyIntent } from '../src/effects';
import { validate } from '../src/validate';
import { buildFacts } from '../src/facts';
import { renderBaseline } from '../src/voice';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Context } from '../src/brain';
import type { Effect, Settings, Stats } from '../src/types';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';
/** 03.09.2026 17:07 — the minute the turn above happened. */
const NOW = wallToUtc(2026, 9, 3, 17, 7, TZ);
const FIRED = wallToUtc(2026, 9, 3, 16, 30, TZ);

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

/** A reminder that has fired and is still open, exactly like #69 at 17:07. */
function seedRinging(rig: Rig, title: string): { reminder: number; instance: number } {
  const r = rig.db
    .prepare(
      `INSERT INTO reminders (chat_id, title, schedule, tz, next_fire_at, status, active, created_at, event_at)
       VALUES (?, ?, ?, ?, NULL, 'done', 1, ?, NULL)`,
    )
    .run(CHAT, title, JSON.stringify({ type: 'once', at: '2026-09-03T16:30' }), TZ, FIRED);
  const reminder = Number(r.lastInsertRowid);
  const i = rig.db
    .prepare(
      `INSERT INTO instances (reminder_id, chat_id, title, fired_at, next_nag_at, nag_count, status, due_at)
       VALUES (?, ?, ?, ?, ?, 1, 'open', ?)`,
    )
    .run(reminder, CHAT, title, FIRED, FIRED + 1_800_000, FIRED);
  return { reminder, instance: Number(i.lastInsertRowid) };
}

async function ctxFor(rig: Rig): Promise<Context> {
  const settings = await db.getSettings(rig.env, CHAT);
  return {
    settings,
    stats: await db.stats(rig.env, CHAT),
    reminders: await db.listReminders(rig.env, CHAT),
    goals: [],
    open: await db.openInstances(rig.env, CHAT),
    nowLabel: 'עכשיו',
  };
}

// ===========================================================================
section('§1 — "עוד שעה" is an hour he gave, not an hour he withheld');
//
// readWhen has always read it. preferHisWords discarded it, so the turn fell
// through to the inbox capture and the bot asked for a time it had been
// handed. Nothing is being OVERRIDDEN here: the router returned no time at
// all, so there is nothing of the model's to beat.
{
  const rig = createRig();
  seedSettings(rig);
  const result = await withNow(NOW, async () =>
    applyIntent(rig.env, CHAT, await ctxFor(rig), { action: 'create_reminder' }, 'תזכיר לי עוד שעה'),
  );
  check(
    `it is scheduled, not captured — got ${result[0]?.kind}`,
    result[0]?.kind === 'reminder_created',
    JSON.stringify(result[0]),
  );
  if (result[0]?.kind === 'reminder_created') {
    eq('for an hour from now', result[0].at, NOW + 3_600_000);
  }
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§1 — the router\'s own in_minutes is still never overridden');
//
// The exclusion that cost "ללכת למוסך ב8:20", typed AT 08:20, a whole day.
// Reading a duration off his sentence when the router gave nothing is a
// different act from second-guessing a number the router did give.
{
  const rig = createRig();
  seedSettings(rig);
  const result = await withNow(NOW, async () =>
    applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'create_reminder', title: 'לרוץ', schedule_type: 'once', in_minutes: 5 },
      'תזכיר לי עוד שעה לרוץ',
    ),
  );
  check(
    'the router said five minutes and five minutes is what happens',
    result[0]?.kind === 'reminder_created' && result[0].at === NOW + 5 * 60_000,
    JSON.stringify(result[0]),
  );
  rig.restore();
}

// ===========================================================================
section('§2 — a bare relative push while something is ringing is a snooze');
//
// CLAUDE.md states this as a rule and applyIntent enforces it deterministically
// — on the `reschedule` path only. The router called this one a create, and the
// rule did not reach it. The result was a second row, a question, and #69 left
// ringing underneath the whole exchange.
{
  const rig = createRig();
  seedSettings(rig);
  const { instance } = seedRinging(rig, 'לנקות את הפילטרים של המזגנים');

  const result = await withNow(NOW, async () =>
    applyIntent(rig.env, CHAT, await ctxFor(rig), { action: 'create_reminder' }, 'תזכיר לי עוד שעה'),
  );
  check(
    `the ring is pushed, not duplicated — got ${result[0]?.kind}`,
    result[0]?.kind === 'instance_snoozed',
    JSON.stringify(result[0]),
  );
  if (result[0]?.kind === 'instance_snoozed') {
    eq('the one that was ringing', result[0].id, instance);
    eq('by the hour he asked for', result[0].minutes, 60);
  }
  const rows = rig.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as any;
  eq('and no second reminder was written', rows.n, 1);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§2 — naming an errand makes it a new reminder, ringing or not');
//
// The redirect is scoped to a message that names NOTHING. "תזכיר לי עוד שעה
// לקנות חלב" while the filters are ringing is a second errand, and turning it
// into a snooze would lose it outright.
{
  const rig = createRig();
  seedSettings(rig);
  seedRinging(rig, 'לנקות את הפילטרים של המזגנים');

  const result = await withNow(NOW, async () =>
    applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'create_reminder', title: 'לקנות חלב' },
      'תזכיר לי עוד שעה לקנות חלב',
    ),
  );
  check(
    `a named errand is its own reminder — got ${result[0]?.kind}`,
    result[0]?.kind === 'reminder_created',
    JSON.stringify(result[0]),
  );
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§2 — with two things ringing it does not guess which');
//
// Same reason matchByTitle returns null on a tie: pushing the wrong ring leaves
// the other one nagging and tells him it was handled.
{
  const rig = createRig();
  seedSettings(rig);
  seedRinging(rig, 'לנקות את הפילטרים');
  seedRinging(rig, 'לקחת תרופה');

  const result = await withNow(NOW, async () =>
    applyIntent(rig.env, CHAT, await ctxFor(rig), { action: 'create_reminder' }, 'תזכיר לי עוד שעה'),
  );
  check(
    `it does not silently pick one — got ${result[0]?.kind}`,
    result[0]?.kind !== 'instance_snoozed',
    JSON.stringify(result[0]),
  );
  rig.restore();
}

// ===========================================================================
// The validator half. These call validate() directly, which is where the
// licence to say "סגרנו" is granted or refused.
// ===========================================================================
const settings: Settings = {
  chat_id: CHAT, tz: TZ, intensity: 2, muted_until: null, off_limits: null,
  checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
  next_checkin_at: null, awaiting: null, brief_hour: 8, closeout_hour: 21,
  last_brief_on: null, last_closeout_on: null, display_name: null,
};
const stats: Stats = { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 3 };
const facts = (effects: Effect[], ctx: Partial<Context> = {}) =>
  buildFacts(
    { settings, stats, reminders: [], goals: [], open: [], nowLabel: 'עכשיו', ...ctx },
    effects, TZ,
  );
const base = (effects: Effect[]) => renderBaseline(effects, TZ);

const CAPTURED: Effect = { kind: 'reminder_captured', id: 75, title: 'תזכורת' };

section('§3/§4 — "סגרנו על #75" over a capture is refused');
//
// The message that shipped. The baseline said "תפסתי, אבל לא אמרת על מה ולא
// מתי" — it was WRITTEN DOWN and nothing was agreed. Two independent holes let
// the rewrite through: the verb was not in the lexicon at all, and the effect
// was in the group that licenses scheduling verbs.
check('the exact sentence that shipped is now rejected',
  !validate('סגרנו על #75.', facts([CAPTURED]), base([CAPTURED])).ok,
  JSON.stringify(validate('סגרנו על #75.', facts([CAPTURED]), base([CAPTURED]))));

for (const claim of ['קבעתי לך את זה.', 'נקבע.', 'שמתי לך תזכורת.']) {
  check(`"${claim}" over a capture is rejected — nothing has a time yet`,
    !validate(claim, facts([CAPTURED]), base([CAPTURED])).ok);
}

section('§3 — but a capture may still be reported as what it IS');
//
// The narrowing must not cost the true sentence. Writing it down really did
// happen, and "רשמתי" is the honest word for it.
for (const ok of ['רשמתי את זה, בלי שעה.', 'קלטתי.']) {
  check(`"${ok}" over a capture passes`,
    validate(ok, facts([CAPTURED]), base([CAPTURED])).ok,
    JSON.stringify(validate(ok, facts([CAPTURED]), base([CAPTURED]))));
}

const CREATED: Effect = {
  kind: 'reminder_created', id: 1, title: 'לרוץ', at: NOW,
  schedule: { type: 'once', at: '2026-09-03T17:07' }, requiresProof: false,
};
check('and a REAL create may still be agreed on — "סגרנו על #74" was true',
  validate('סגרנו על #1.', facts([CREATED]), base([CREATED])).ok,
  JSON.stringify(validate('סגרנו על #1.', facts([CREATED]), base([CREATED]))));

// ---------------------------------------------------------------------------
section('§4 — a claim about what HE did is a claim too');
//
// CLAIM is first-person only, so every affirmation of the user sails through.
// Chat B, 30.08.2026 20:01: "יפה שסגרת את זה מוקדם" over a no_open_task
// baseline — nothing was closed, and #68 fired twenty-four minutes later.
{
  const NO_TASK: Effect = { kind: 'nothing', why: 'no_open_task', userText: 'עשיתי' };
  check('"יפה שסגרת את זה מוקדם" with nothing closed is rejected',
    !validate('יפה שסגרת את זה מוקדם.', facts([NO_TASK]), base([NO_TASK])).ok,
    JSON.stringify(validate('יפה שסגרת את זה מוקדם.', facts([NO_TASK]), base([NO_TASK]))));

  const DONE: Effect = { kind: 'instance_done', id: 9, title: 'לרוץ', streak: 4 };
  check('and the same words pass when he really did close it',
    validate('יפה שסגרת את זה מוקדם.', facts([DONE]), base([DONE])).ok,
    JSON.stringify(validate('יפה שסגרת את זה מוקדם.', facts([DONE]), base([DONE]))));

  check('"לא סגרת את זה" is the opposite of a claim and is left alone',
    validate('לא סגרת את זה, אז אל תספר לי סיפורים.', facts([NO_TASK]), base([NO_TASK])).ok,
    JSON.stringify(validate('לא סגרת את זה, אז אל תספר לי סיפורים.', facts([NO_TASK]), base([NO_TASK]))));
}

// ===========================================================================
section('§5 — rule 4 sees an elapsed claim written the way Hebrew writes it');
//
// ELAPSED_BEFORE looks for כבר/עברו/מזה BEFORE the quantity. Hebrew routinely
// puts the marker after it, so "26 דקות עברו" and "93 דקות שהיא פתוחה" — the
// shape of the 18:03 message this was all found through — were never checked
// at all. Zero rule-4 rejections in a month is not a quiet month.
{
  const OPEN_30: Partial<Context> = {
    open: [{
      id: 9, reminder_id: 1, chat_id: CHAT, title: 'לנקות את הפילטרים',
      fired_at: NOW - 30 * 60_000, next_nag_at: null, nag_count: 1,
      status: 'open', proof: null, closed_at: null, granted_min: 0,
    }],
  };
  const NAG: Effect = {
    kind: 'nagged', instanceId: 9, title: 'לנקות את הפילטרים',
    since: NOW - 30 * 60_000, round: 1, granted: 0,
  };
  const f = () => withNow(NOW, async () => facts([NAG], OPEN_30));

  for (const lie of ['151 דקות עברו מאז.', 'שעתיים וחצי עברו מאז שזה נפתח.', '151 דקות שזה פתוח.']) {
    const v = validate(lie, await f(), base([NAG]));
    check(`"${lie}" — a span the turn cannot back up is rejected`, !v.ok, JSON.stringify(v));
  }
  for (const truth of ['30 דקות עברו מאז.', 'חצי שעה עברה מאז שזה נפתח.']) {
    const v = validate(truth, await f(), base([NAG]));
    check(`"${truth}" — the true span still passes`, v.ok, JSON.stringify(v));
  }
  // The narrowness is deliberate and must survive: a duration that is not
  // being asserted as elapsed is none of this rule's business.
  const v = validate('קח 90 דקות ותסיים את זה.', await f(), base([NAG]));
  check('a duration that is not an elapsed claim is left alone', v.ok, JSON.stringify(v));
}

// ===========================================================================
section('§6 — a goal the bot has gone quiet about is asked again eventually');
//
// GOAL_QUIET_AFTER is a wall, not a backoff: `checkin_count < 8` in SQL, with
// nothing that ever clears it. Production right now — goal #1, checkin_count
// 11, last check-in 17.08.2026 — is permanently silent, with no expiry, no
// probe and no message saying so. gemini.blockFor gets this exactly right
// ("the expiry IS the probe"); goals never inherited it.
{
  const rig = createRig();
  seedSettings(rig);
  const mk = (count: number, lastCheckinAt: number) => {
    const r = rig.db
      .prepare(
        `INSERT INTO goals (chat_id, title, why, status, checkin_count, last_checkin_at, created_at)
         VALUES (?, ?, NULL, 'active', ?, ?, ?)`,
      )
      .run(CHAT, `מטרה ${count}/${lastCheckinAt}`, count, lastCheckinAt, 0);
    return Number(r.lastInsertRowid);
  };

  const quiet = mk(11, NOW - 40 * 86_400_000);
  const got = await db.stalestGoal(rig.env, CHAT, NOW);
  eq('forty days after the last unanswered check-in, it probes once', got?.id, quiet);

  rig.db.prepare('DELETE FROM goals').run();
  mk(11, NOW - 5 * 86_400_000);
  const soon = await db.stalestGoal(rig.env, CHAT, NOW);
  eq('five days after, it is still quiet — the backoff is real', soon, null);
  rig.restore();
}

done();
