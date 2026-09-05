/**
 * Run with `npm run test:v23`.
 *
 * Production, chat B, 03.09.2026 23:46, running 0.19.0:
 *
 *   him  תזכיר לי מחר לבדוק כמה אתה טיפש
 *   bot  רשמתי. מחר בודקים.
 *   bot  בלי שעה:
 *        #77 תזכורת
 *
 * Two failures, and they are the same failure twice: **the bot asked for
 * things he had already given.**
 *
 *   1. `readWhen` returns {kind:'none'} for a bare "מחר". Not `ambiguous` —
 *      NONE, as though no time word had been typed at all. So the create path
 *      captured, and the capture's baseline says "לא אמרת על מה ולא מתי" about
 *      a day he named in the first three words. The persona then papered over
 *      the contradiction with "מחר בודקים" — asserting a tomorrow that is not
 *      scheduled, over a row with no next_fire_at.
 *
 *      The fix is NOT to invent an hour. CLAUDE.md is explicit that a pinned
 *      day plus a named PART of it ("מחר בערב" → 20:00) is the whole of what
 *      may be guessed, and a bare day is not that. What changes is that the
 *      code can now say WHICH half is missing.
 *
 *   2. The title is `תזכורת`, the generic fallback. titleFromHisWords keeps
 *      "לבדוק כמה אתה טיפש" intact when it is given it, so the ROUTER returned
 *      no title — and the fallback threw his own words away rather than using
 *      them. His words are always the safer source; that is the whole premise
 *      of titleFromHisWords, and it was only ever applied in one direction.
 */
import { readWhen } from '../src/when';
import { applyIntent, titleFromMessage } from '../src/effects';
import { renderBaseline } from '../src/voice';
import * as db from '../src/db';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Context } from '../src/brain';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';
/** 03.09.2026 23:46 — the minute it happened. */
const NOW = wallToUtc(2026, 9, 3, 23, 46, TZ);

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

async function ctxFor(rig: Rig): Promise<Context> {
  return {
    settings: await db.getSettings(rig.env, CHAT),
    stats: await db.stats(rig.env, CHAT),
    reminders: await db.listReminders(rig.env, CHAT),
    goals: [],
    open: await db.openInstances(rig.env, CHAT),
    nowLabel: 'עכשיו',
  };
}

// ===========================================================================
section('§1 — a day with no hour is not "no time at all"');
//
// TimeRef already has an arm for "there is something here I cannot fully
// read". A bare day belongs in it: the parser knows strictly more than
// nothing, and reporting `none` throws that knowledge away at the seam.
{
  const ref = readWhen('תזכיר לי מחר לבדוק כמה אתה טיפש', NOW, TZ);
  check(`"מחר" alone is ambiguous, not none — got ${ref.kind}`,
    ref.kind === 'ambiguous', JSON.stringify(ref));
  if (ref.kind === 'ambiguous') {
    eq('and it says which half is missing', ref.why, 'no-hour');
    check(`carrying the day he actually said — ${JSON.stringify(ref.seen)}`,
      ref.seen.some((s) => s.includes('מחר')), JSON.stringify(ref.seen));
  }
}

// ---------------------------------------------------------------------------
section('§1 — and it still refuses to invent the hour');
//
// The guess that IS allowed is a pinned day plus a named part of it, and it is
// allowed only because voice.ts always states the hour it chose. A bare day is
// not that, and turning this arm into a default would be the invention the
// whole `findFutureInstant` rule exists to refuse.
{
  const ref = readWhen('תזכיר לי מחר לבדוק כמה אתה טיפש', NOW, TZ);
  check('no instant is produced', ref.kind !== 'instant', JSON.stringify(ref));
  // The named-part case must keep working exactly as it did.
  const evening = readWhen('תזכיר לי מחר בערב לבדוק משהו', NOW, TZ);
  check(`"מחר בערב" is still 20:00 — ${JSON.stringify(evening)}`,
    evening.kind === 'instant', JSON.stringify(evening));
  // And a message with no time word at all is still plain `none`.
  eq('nothing at all is still none',
    readWhen('תזכיר לי לבדוק משהו', NOW, TZ).kind, 'none');
}

// ===========================================================================
section('§1 — so the question asks for the hour, not for both');
{
  const rig = createRig();
  seedSettings(rig);
  const result = await withNow(NOW, async () =>
    applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'create_reminder', title: 'לבדוק כמה אתה טיפש' },
      'תזכיר לי מחר לבדוק כמה אתה טיפש',
    ),
  );
  check(`still a capture — got ${result[0]?.kind}`,
    result[0]?.kind === 'reminder_captured', JSON.stringify(result[0]));

  const line = renderBaseline(result, TZ);
  check(`the day he gave is echoed back — ${JSON.stringify(line)}`,
    line.includes('מחר'), line);
  check('and it does not claim he failed to say when at all',
    !/לא אמרת.*מתי/.test(line), line);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§1 — a capture with NO day at all keeps the old question');
//
// The wording that says both halves are missing is right when both halves are
// missing, and must not be lost to the narrower case.
{
  const rig = createRig();
  seedSettings(rig);
  const result = await withNow(NOW, async () =>
    applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'create_reminder', title: 'לבדוק משהו' },
      'תזכיר לי לבדוק משהו',
    ),
  );
  const line = renderBaseline(result, TZ);
  check(`it still asks for the time — ${JSON.stringify(line)}`, /מתי/.test(line), line);
  check('and names no day, because he named none', !line.includes('מחר'), line);
  rig.restore();
}

// ===========================================================================
section('§2 — his own words beat the generic fallback');
//
// titleFromHisWords exists on the premise that his words are the safer source.
// It was only ever applied to a title the model HAD supplied; when the model
// supplied none, the premise was dropped and "תזכורת" went into the database.
{
  eq('the lead-in comes off',
    titleFromMessage('תזכיר לי מחר לבדוק כמה אתה טיפש'), 'לבדוק כמה אתה טיפש');
  eq('and a leading bare day word with it',
    titleFromMessage('תזכיר לי מחר לקנות חלב'), 'לקנות חלב');
  /*
   * Only a LEADING time word, and only a bare one. CLAUDE.md's warning about
   * stripping time words from a title is about the ROUTER's title, where
   * "לתכנן את היום" is an errand whose subject is the day. Building from his
   * own words and taking only the front is the narrow version of that move.
   */
  eq('a time word that is part of the errand survives',
    titleFromMessage('תזכיר לי מחר לתכנן את היום'), 'לתכנן את היום');
  eq('nothing left over means nothing is offered',
    titleFromMessage('תזכיר לי מחר'), null);
  eq('and a pure time phrase is not an errand',
    titleFromMessage('תזכיר לי עוד 5 דקות'), null);
  eq('nor is ordinary chat', titleFromMessage('מה קורה'), null);
  // "לי" is the pronoun in the request itself, not an infinitive — the same
  // exclusion addressesSomeoneElse makes, for the same word. Without it every
  // title would begin "לי ...".
  eq('the request pronoun is not mistaken for an errand',
    titleFromMessage('תזכיר לי לקנות חלב'), 'לקנות חלב');
}

// ---------------------------------------------------------------------------
section('§2 — end to end: the router gives no title and his words are used');
{
  const rig = createRig();
  seedSettings(rig);
  const result = await withNow(NOW, async () =>
    applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      // Exactly what the router returned in production: an action, no title.
      { action: 'create_reminder' },
      'תזכיר לי מחר לבדוק כמה אתה טיפש',
    ),
  );
  const captured = result.find((e) => e.kind === 'reminder_captured') as any;
  check(`captured with his errand, not "תזכורת" — ${JSON.stringify(captured?.title)}`,
    captured?.title === 'לבדוק כמה אתה טיפש', JSON.stringify(result));

  const row = rig.db.prepare('SELECT title FROM reminders WHERE id = ?').get(captured.id) as any;
  eq('and that is what is on the row', row.title, 'לבדוק כמה אתה טיפש');
  rig.restore();
}

// ---------------------------------------------------------------------------
section('§2 — the router\'s own title still wins when it gives one');
//
// The fallback is a fallback. Re-wording him is the router's job and it is
// usually better at it — "תזכיר לאמנון לדבר עם שחר" should not become a title
// with the addressee still in it.
{
  const rig = createRig();
  seedSettings(rig);
  const result = await withNow(NOW, async () =>
    applyIntent(
      rig.env, CHAT, await ctxFor(rig),
      { action: 'create_reminder', title: 'לקנות חלב' },
      'תזכיר לי מחר לקנות חלב ועוד כמה דברים',
    ),
  );
  const captured = result.find((e) => e.kind === 'reminder_captured') as any;
  eq('the model\'s title is used', captured?.title, 'לקנות חלב');
  rig.restore();
}

done();
