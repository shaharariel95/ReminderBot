/** Run with `npm run test:validate`. */
import { validate } from '../src/validate';
import { buildFacts } from '../src/facts';
import { TURN_FAILED, renderBaseline } from '../src/voice';
import { wallToUtc } from '../src/time';
import { check, done, section } from './harness';
import type { Context } from '../src/brain';
import type { Effect, Reminder, Settings, Stats } from '../src/types';

const TZ = 'Asia/Jerusalem';

const settings: Settings = {
  chat_id: '1', tz: TZ, intensity: 2, muted_until: null, off_limits: null,
  checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
  next_checkin_at: null, awaiting: null,
  brief_hour: 8, closeout_hour: 21, last_brief_on: null, last_closeout_on: null,
    display_name: null,
};
const stats: Stats = { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 3 };

function facts(effects: Effect[], ctx: Partial<Context> = {}) {
  return buildFacts(
    { settings, stats, reminders: [], goals: [], open: [], nowLabel: 'עכשיו', ...ctx },
    effects,
    TZ,
  );
}

/** The deterministic text for the same effects — what the caller will actually pass as baseline. */
function base(effects: Effect[]): string {
  return renderBaseline(effects, TZ);
}

const CREATED: Effect = {
  kind: 'reminder_created', id: 1, title: 'לרוץ',
  at: new Date('2026-08-05T04:05:00Z').getTime(),   // 07:05 Asia/Jerusalem
  schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false,
};
const NOTHING: Effect = { kind: 'nothing', why: 'chat', userText: 'מה קורה' };

section('rule 1 — invented times are rejected');
check('a time that matches the facts passes',
  validate('קבעתי ל-07:05, אל תתלונן.', facts([CREATED]), base([CREATED])).ok);
check('a time that does not appear is rejected',
  !validate('קבעתי ל-08:30, אל תתלונן.', facts([CREATED]), base([CREATED])).ok);
check('a reply with no time at all passes',
  validate('סגור.', facts([CREATED]), base([CREATED])).ok);

section('rule 2 — phantom confirmations are rejected');
for (const claim of ['רשמתי לך', 'קבעתי', 'שמתי לך תזכורת', 'זה נשמר', 'נקבע']) {
  check(`"${claim}" is rejected when nothing was written`,
    !validate(claim + '.', facts([NOTHING]), base([NOTHING])).ok);
}
check('the same claim passes when something WAS written',
  validate('רשמתי.', facts([CREATED]), base([CREATED])).ok);
check('"שמתי לב" (I noticed) is not a claim of a write',
  validate('שמתי לב שאתה עייף היום.', facts([NOTHING]), base([NOTHING])).ok);
check('"סידרתי לך את הבלגן" (ordinary chat) is not a claim of a write',
  validate('סידרתי לך את הבלגן.', facts([NOTHING]), base([NOTHING])).ok);

section('rule 2 — a CLOSE claimed over a MOVE, in the words the persona actually reaches for');
{
  /**
   * Production, 18.08.2026 08:57. He typed "ללכת למוסך ב10:30", the router
   * returned a reschedule, voice.ts said "שיניתי. #52 ... ב-10:30" — and the
   * persona shipped **"סגרתי #52 ב-10:30"**. /list twenty seconds later
   * showed #52 open at 10:30. A move reported as a close, and the validator
   * passed it, because the `close` group held one verb — "סימנתי" — which is
   * not how anybody says it.
   *
   * The lexicon's own blind spot: voice.ts words instance_done as "נסגר" and
   * gave_up as "סגרתי", so the bot's most natural close verb was the one
   * CLAIM could not see.
   */
  const RETIMED: Effect = {
    kind: 'reminder_retimed', id: 52, title: 'ללכת למוסך',
    at: wallToUtc(2026, 8, 18, 10, 30, TZ),
  };
  for (const claim of ['סגרתי #52 ב-10:30', 'סיימתי את #52', 'סימנתי את זה כבוצע']) {
    check(`"${claim}" is rejected on a turn that only MOVED the reminder`,
      !validate(claim + '.', facts([RETIMED]), base([RETIMED])).ok);
  }
  // The move verbs must still pass on a move — this is the group that works,
  // and widening `close` must not narrow it.
  check('"העברתי" still passes on the same move',
    validate('העברתי את זה ל-10:30.', facts([RETIMED]), base([RETIMED])).ok);

  const DONE: Effect = { kind: 'instance_done', id: 9, title: 'ללכת למוסך', streak: 24 };
  for (const claim of ['סגרתי', 'סיימתי', 'סימנתי']) {
    check(`"${claim}" passes when the turn really did close something`,
      validate(claim + ' את זה.', facts([DONE]), base([DONE])).ok);
  }

  // "סגרתי" has an ordinary-Hebrew life too, and CLAIM is a lexicon of claims
  // about the DATABASE. These are the same restraint "שמתי לב" and "סידרתי"
  // already get above — a rule that eats them costs more than the lie it
  // prevents.
  check('"סגרתי איתו" (I arranged it with him) is not a claim about the database',
    validate('סגרתי איתו שהוא יביא את זה מחר.', facts([NOTHING]), base([NOTHING])).ok);
  // voice.TURN_FAILED, word for word. A negated claim is the OPPOSITE of a
  // claim, and this is the one sentence that ships when everything else has
  // already gone wrong — it must never be the thing the validator eats.
  check('"ולא סיימתי את זה" — the turn-failed wording is not a close claim',
    validate(TURN_FAILED, facts([{ kind: 'nothing', why: 'failed', userText: 'סיימתי הכל' }]),
      base([{ kind: 'nothing', why: 'failed', userText: 'סיימתי הכל' }])).ok);
}

section('rule 3 — invented tasks are rejected');
check('quoting a real title passes',
  validate('"לרוץ" עדיין פתוחה.', facts([CREATED]), base([CREATED])).ok);
check('quoting a title that exists nowhere is rejected',
  !validate('"לכתוב את הדוח" עדיין פתוחה.', facts([CREATED]), base([CREATED])).ok);
check('quoting a title from the standing reminder list passes', (() => {
  const ctx = {
    reminders: [{
      id: 7, chat_id: '1', title: 'להתקשר לרואה חשבון', notes: null,
      schedule: '{"type":"daily","time":"09:00"}', tz: TZ, requires_proof: 0,
      proof_type: 'any' as const, nag_interval_min: 20, max_nags: 3,
      next_fire_at: null, event_at: null, status: 'scheduled' as const, active: 1, from_chat_id: null, created_at: 0,
    }],
  };
  return validate('"להתקשר לרואה חשבון" מחכה לך.', facts([NOTHING], ctx), base([NOTHING])).ok;
})());

section('the reason is reported, so /diag can show why');
check('a rejection explains itself',
  (validate('קבעתי ל-08:30.', facts([CREATED]), base([CREATED])).reason ?? '').length > 0);

section('the baseline is trusted verbatim — a format example is not an invented time');
check('the bad_time example "19:30" is allowed when the model echoes it', (() => {
  const f = facts([{ kind: 'nothing', why: 'bad_time', userText: 'תזכיר לי ב-99' }]);
  const b = base([{ kind: 'nothing', why: 'bad_time', userText: 'תזכיר לי ב-99' }]);
  return validate('לא הבנתי, תן לי משהו כמו 19:30.', f, b).ok;
})());
check('a quoted span that only exists in the baseline is allowed when the model echoes it',
  validate('הערה: "פגישה ישנה" בוטלה.', facts([NOTHING]), 'הערה: "פגישה ישנה" בוטלה.').ok);
check('but a quoted span absent from BOTH facts and baseline is still rejected',
  !validate('הערה: "פגישה מומצאת" בוטלה.', facts([NOTHING]), base([NOTHING])).ok);

section('rule 3 (quotable) — the model may truthfully quote prose that is not a title');
{
  const rejected: Effect = { kind: 'photo_rejected', instanceId: 9, title: 'לרוץ', reason: 'חתול' };
  check('quoting the photo_rejected reason passes (voice.ts never quotes it, so the baseline union alone cannot cover this)',
    validate('יש שם "חתול" בתמונה, לא אתה.', facts([rejected]), base([rejected])).ok);
}
{
  const checkin: Effect = {
    kind: 'checkin_goal', id: 3, title: 'לפתוח תיק מסחר', why: null,
    lastProgress: 'מילאתי טפסים', lastProgressAt: null, lastCheckinAt: null,
  };
  check('quoting the checkin_goal progress note passes',
    validate('אז אמרת "מילאתי טפסים" בפעם שעברה?', facts([checkin]), base([checkin])).ok);
}
{
  const chat: Effect = { kind: 'nothing', why: 'chat', userText: 'אני ממש עייף היום' };
  check('quoting the user\'s own words back passes',
    validate('אמרת "אני ממש עייף היום" — מה קרה?', facts([chat]), base([chat])).ok);
}
check('a quote present in neither titles, quotable, nor the baseline is still rejected — rule 3 keeps its teeth', (() => {
  const rejected: Effect = { kind: 'photo_rejected', instanceId: 9, title: 'לרוץ', reason: 'חתול' };
  return !validate('יש שם "כלב ענק שרץ מהר מאוד" בתמונה.', facts([rejected]), base([rejected])).ok;
})());
check('quotable is one-directional: a long quote that merely CONTAINS a short reason is still rejected, not treated as a wildcard match', (() => {
  const rejected: Effect = { kind: 'photo_rejected', instanceId: 9, title: 'לרוץ', reason: 'חתול' };
  // If this were bidirectional (as titles are), "חתול".includes(quoted) is false but
  // quoted.includes("חתול") is true — a bidirectional `some` would wrongly accept it.
  return !validate('יש שם "חתול ענק שאכל את הדוח" בתמונה.', facts([rejected]), base([rejected])).ok;
})());

section('facts.ts — listed_reminders rows contribute their schedule time, not just next_fire_at');
check('the recurring time is in facts.times directly, independent of validate()\'s own baseline union', (() => {
  const row: Reminder = {
    id: 21, chat_id: '1', title: 'לשתות מים', notes: null,
    schedule: '{"type":"daily","time":"16:45"}', tz: TZ, requires_proof: 0,
    proof_type: 'any', nag_interval_min: 20, max_nags: 3,
    next_fire_at: null, event_at: null, status: 'scheduled', active: 1, from_chat_id: null, created_at: 0,
  };
  // next_fire_at is null on purpose: the only way "16:45" reaches facts.times is
  // through the schedule JSON on the effect's own row, not the reminder's next fire.
  const f = facts([{ kind: 'listed_reminders', rows: [row], openCount: 1 }]);
  return f.times.includes('16:45');
})());

section(
  'every effect round-trips when text === baseline — this proves the CLOCK/QUOTED fold ' +
    'mechanism and the CLAIM-verb gate (which reads facts.wrote, not the fold) do not throw ' +
    'or reject on any known kind. It does NOT prove facts.ts actually swept each kind\'s time ' +
    'or title: with text === baseline, every CLOCK/QUOTED match in `text` was, by definition, ' +
    'just added to the allow-lists one line earlier from `baseline` — so this loop would pass ' +
    'identically even if facts.ts swept nothing at all. See "genuine round-trips" below for that.',
);
{
  const AT = wallToUtc(2026, 8, 5, 7, 5, TZ);

  const dailyRow: Reminder = {
    id: 11, chat_id: '1', title: 'להוציא זבל', notes: null,
    schedule: '{"type":"daily","time":"09:00"}', tz: TZ, requires_proof: 0,
    proof_type: 'any', nag_interval_min: 20, max_nags: 3,
    next_fire_at: AT, event_at: null, status: 'scheduled', active: 1, from_chat_id: null, created_at: 0,
  };

  const samples: Effect[] = [
    { kind: 'reminder_created', id: 1, title: 'לרוץ', at: AT, schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false },
    { kind: 'friend_reminder_created', id: 1, title: 'לקנות חלב', at: AT, schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false, friend: 'דנה', to: '999' },
    { kind: 'friend_needs_time', friend: 'דנה', to: '999', title: 'לקנות חלב' },
    { kind: 'reminder_captured', id: 2, title: 'לקנות חלב' },
    { kind: 'reminder_scheduled', id: 2, title: 'לקנות חלב', at: AT },
    { kind: 'reminder_retimed', id: 1, title: 'לרוץ', at: AT },
  { kind: 'reminder_unchanged', id: 1, title: 'לרוץ', at: AT },
    { kind: 'reminder_deleted', id: 1, title: 'לרוץ' },
    { kind: 'instance_done', id: 9, title: 'לרוץ', streak: 4 },
    { kind: 'instance_skipped', id: 9, title: 'לרוץ', recurs: true },
  { kind: 'instance_skipped', id: 9, title: 'לרוץ', recurs: false },
    { kind: 'instance_snoozed', id: 9, title: 'לרוץ', until: AT, minutes: 10 },
    { kind: 'instance_started', id: 9, title: 'לרוץ', until: AT },
    { kind: 'reminder_annotated', id: 1, title: 'לרוץ', note: 'נעליים חדשות' },
    { kind: 'followup_suggested', instanceId: 9, title: 'לרוץ', at: AT },
    { kind: 'goal_created', id: 3, title: 'לפתוח תיק מסחר', why: null },
    { kind: 'goal_progress', id: 3, title: 'לפתוח תיק מסחר', note: 'מילאתי טפסים', previous: null },
    { kind: 'goal_closed', id: 3, title: 'לפתוח תיק מסחר', status: 'done' },
    { kind: 'checkins_set', enabled: false, perDay: null },
    { kind: 'muted', until: AT, hours: 4 },
    { kind: 'intensity_set', level: 3 },
    { kind: 'listed_reminders', rows: [dailyRow], openCount: 1 },
    { kind: 'listed_goals', rows: [] },
    { kind: 'listed_inbox', rows: [] },
    { kind: 'reminder_fired', id: 1, title: 'לרוץ', instanceId: 9, requiresProof: false },
    { kind: 'nagged', instanceId: 9, title: 'לרוץ', since: AT, round: 1, granted: 0 },
    { kind: 'gave_up', instanceId: 9, title: 'לרוץ', rounds: 3 },
    { kind: 'checkin_goal', id: 3, title: 'לפתוח תיק מסחר', why: null, lastProgress: null, lastProgressAt: null, lastCheckinAt: null },
    { kind: 'photo_accepted', instanceId: 9, title: 'לרוץ', reason: 'נעלי ריצה', streak: 2 },
    { kind: 'photo_rejected', instanceId: 9, title: 'לרוץ', reason: 'חתול' },
    { kind: 'pattern_kept' },
    { kind: 'distress', text: 'אני שבור' },
    { kind: 'nothing', why: 'no_open_task', userText: 'סיימתי' },
    { kind: 'nothing', why: 'past_time', userText: 'תזכיר לי אתמול' },
    { kind: 'nothing', why: 'bad_time', userText: 'תזכיר לי ב-99' },
    { kind: 'nothing', why: 'unknown_reminder', userText: 'תבטל' },
    { kind: 'nothing', why: 'unknown_goal', userText: 'סיימתי מטרה' },
    { kind: 'nothing', why: 'chat', userText: 'מה קורה' },
    { kind: 'needs_time', id: 1, title: 'לרוץ' },
    { kind: 'nothing', why: 'failed', userText: 'סיימתי הכל' },
    { kind: 'nothing', why: 'not_understood', userText: 'תעשה משהו' },
    { kind: 'item_done', id: 5, title: 'להחזיר ראוטר', reminderId: 1, remaining: 2 },
    { kind: 'item_done', id: 5, title: 'להחזיר ראוטר', reminderId: 1, remaining: 0 },
    { kind: 'needs_item_choice', open: [{ id: 5, reminder_id: 1, chat_id: '1', title: 'להחזיר ראוטר', position: 0, done_at: null, created_at: 0 }] },
    { kind: 'reminder_duplicate', id: 11, title: 'לקחת בגד ים', at: AT },
    // Added in 0.19.0. It was never in this loop, and it is the one baseline
    // that talks about closes in the SECOND person — so the moment CLAIM grew
    // those forms it was the baseline most likely to fail its own validator,
    // with nothing here to say so.
    { kind: 'evening_closeout', done: 2, missed: [], dropped: [], ahead: [] },
    { kind: 'evening_closeout', done: 0, missed: [], dropped: [], ahead: [] },
    { kind: 'morning_brief', rows: [], openCount: 1 },
    {
      kind: 'needs_task_choice', action: 'complete',
      open: [
        { id: 9, reminder_id: 1, chat_id: '1', title: 'לקחת בגד ים', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null, granted_min: 0 },
        { id: 10, reminder_id: 2, chat_id: '1', title: 'לזרוק זבל', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null, granted_min: 0 },
      ],
    },
  ];

  for (const e of samples) {
    const text = renderBaseline([e], TZ);
    const f = facts([e]);
    const v = validate(text, f, text);
    check(`${e.kind}${'why' in e ? `/${e.why}` : ''} does not throw and passes the fold + CLAIM gate (text === baseline)`,
      v.ok, v.reason);
  }
}

section(
  'genuine round-trips — paraphrase !== baseline, proving facts.ts actually swept the value',
);
{
  // The loop above cannot tell a real facts.ts sweep from a no-op: with
  // text === baseline, every CLOCK/QUOTED match `text` contains was just
  // folded in from `baseline` one line earlier in validate(), so the check
  // passes whether or not facts.ts ever populated facts.times/titles.
  //
  // A real model rewrite also can't distinguish the two on its own: voice.ts
  // renders every fact it uses directly into the baseline text (same digits,
  // same quoted title), so a paraphrase that repeats those exact digits/quotes
  // would ALSO pass via the baseline fold alone, sweep or no sweep — the fold
  // is not a bug, but it means it silently absorbs coverage of anything the
  // *current* wording of voice.ts happens to restate.
  //
  // To actually exercise facts.ts's own sweep, each case below pairs the real
  // Facts (from buildFacts on the real effect — proven directly against
  // facts.times/titles first) with a hand-written "lean" baseline that omits
  // the value under test, the way a future terser voice.ts wording plausibly
  // could. That forces validate()'s allow-list for the paraphrase to come
  // from facts.ts's sweep and nothing else. Each case is verified (see the
  // fix report) to fail once the corresponding facts.ts sweep line is deleted
  // — that's what makes this a real test instead of the same tautology in a
  // new costume.

  {
    // instance_snoozed: facts.ts's generic `if ('until' in e) addTime(e.until)`
    // sweep (shared with `muted`) is what must supply the snooze target time.
    const until = wallToUtc(2026, 8, 5, 10, 15, TZ);
    const snoozed: Effect = { kind: 'instance_snoozed', id: 9, title: 'לקפל כביסה', until, minutes: 15 };
    const f = facts([snoozed]);
    check('facts.times sweeps the snooze target time from `until`',
      f.times.includes('10:15'), `times: ${JSON.stringify(f.times)}`);

    const leanBaseline = 'דחיתי את זה בעוד קצת.'; // no digits, no quotes — nothing to fold
    const paraphrase = 'טוב, זזתי את זה ל-10:15, תירגע.';
    const v = validate(paraphrase, f, leanBaseline);
    check('a paraphrase naming the snooze time round-trips through facts.times, not the baseline fold',
      v.ok, v.reason);
  }
  {
    // nagged: facts.ts's generic `if ('title' in e) titles.add(e.title)` sweep
    // is what must license the model shortening the title — the bidirectional
    // title match (documented in validate.ts) exists exactly for this.
    const since = wallToUtc(2026, 8, 5, 9, 0, TZ);
    const nag: Effect = {
      kind: 'nagged', instanceId: 9, title: 'להתקשר לרואה חשבון בעניין הדוח', since, round: 2, granted: 0,
    };
    const f = facts([nag]);
    check('facts.titles sweeps the nagged instance\'s title',
      f.titles.includes('להתקשר לרואה חשבון בעניין הדוח'), `titles: ${JSON.stringify(f.titles)}`);

    const leanBaseline = 'נו? עדיין פתוח.'; // never quotes the title
    const paraphrase = 'עדיין מחכה לך "להתקשר לרואה חשבון" — תזיז את זה כבר.';
    const v = validate(paraphrase, f, leanBaseline);
    check('a shortened, truthful title paraphrase round-trips through facts.titles, not the baseline fold',
      v.ok, v.reason);
  }
  {
    // listed_reminders: the kind-specific block in facts.ts sweeps both
    // r.title and the recurring schedule.time straight off each row.
    const row: Reminder = {
      id: 31, chat_id: '1', title: 'להוציא זבל בחצר האחורית', notes: null,
      schedule: '{"type":"daily","time":"09:30"}', tz: TZ, requires_proof: 0,
      proof_type: 'any', nag_interval_min: 20, max_nags: 3,
      next_fire_at: null, event_at: null, status: 'scheduled', active: 1, from_chat_id: null, created_at: 0,
    };
    const f = facts([{ kind: 'listed_reminders', rows: [row], openCount: 0 }]);
    check('facts.times sweeps the row\'s recurring schedule time',
      f.times.includes('09:30'), `times: ${JSON.stringify(f.times)}`);
    check('facts.titles sweeps the row\'s title',
      f.titles.includes('להוציא זבל בחצר האחורית'), `titles: ${JSON.stringify(f.titles)}`);

    const leanBaseline = 'יש לך תזכורת אחת פעילה.'; // no title, no schedule time
    const paraphrase = 'יש לך "להוציא זבל" כל יום ב-09:30.';
    const v = validate(paraphrase, f, leanBaseline);
    check('a shortened title plus its recurring time round-trip through facts.ts\'s sweep, not the baseline fold',
      v.ok, v.reason);
  }
}

section('duplicateOf.title — the nested-title trap, proven with a genuine round-trip');
{
  // facts.ts sweeps top-level `title` fields automatically, but duplicateOf is
  // nested inside reminder_created. Without an explicit sweep line, a
  // truthful model paraphrase naming the existing similar reminder would be
  // rejected as an invented task. A lean, hand-written baseline (rather than
  // the real baseline) proves the allow-list comes from facts.ts's sweep, not
  // from validate()'s baseline fold.
  //
  // The own title and duplicateOf's title are deliberately chosen so NEITHER
  // is a substring of the other ("...לים" vs "...לחוף" — they diverge on the
  // last word). validate.ts's title matching is bidirectional-by-containment,
  // so if the two titles overlapped as substrings, the paraphrase could pass
  // via the top-level title alone (already swept generically) even with the
  // duplicateOf sweep deleted — masking exactly the bug this test exists to
  // catch. This was caught by actually deleting the facts.ts sweep line and
  // re-running: with overlapping titles the check below still passed
  // (false confidence); with these titles it correctly failed.
  const created: Effect = {
    kind: 'reminder_created', id: 2, title: 'לקחת בגד ים לים',
    at: new Date('2026-08-05T04:05:00Z').getTime(),   // 07:05 Asia/Jerusalem
    schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false,
    duplicateOf: {
      id: 11, title: 'לקחת בגד ים לחוף',
      // A DIFFERENT time from the reminder's own (21:00 vs 07:05). Reusing the
      // same instant would let the top-level `at` sweep cover for the nested
      // one, masking a missing sweep exactly as overlapping titles would.
      at: new Date('2026-08-05T18:00:00Z').getTime(), // 21:00 Asia/Jerusalem
    },
  };
  const f = facts([created]);
  check('facts.titles sweeps duplicateOf.title even though it is nested',
    f.titles.includes('לקחת בגד ים לחוף'), `titles: ${JSON.stringify(f.titles)}`);
  check('and facts.times sweeps its time, which is nested just as deeply',
    f.times.includes('21:00'), `times: ${JSON.stringify(f.times)}`);

  const leanBaseline = 'קבעתי ל-07:05.'; // never quotes either title, never says 21:00
  const paraphrase = 'קבעתי, אבל שים לב שכבר יש לך "לקחת בגד ים לחוף" בסביבה.';
  const v = validate(paraphrase, f, leanBaseline);
  check(
    'a paraphrase naming the existing similar reminder round-trips through facts.titles, not the baseline fold',
    v.ok, v.reason,
  );
  // The warning is worthless without the time, so the model has to be able to
  // state it even when the baseline it was handed did not.
  const withTime = validate(
    'קבעתי. יש לך גם "לקחת בגד ים לחוף" ב-21:00.', f, leanBaseline,
  );
  check('and may state the other reminder\'s time for the same reason', withTime.ok, withTime.reason);
}

section('rule 4 — an elapsed-time claim must match how long it has actually been');
{
  // From the 10.08.2026 transcript. The reminder fired at 09:00 and was
  // snoozed to 09:30; at 09:30 the bot opened with "שעה וחצי אתה גורר את
  // הטלפון למוסך". It had been thirty minutes. CLOCK only ever matched
  // HH:MM, so a false quantity written in words sailed straight through the
  // one layer whose entire job is to stop invented facts.
  const SINCE = wallToUtc(2026, 8, 10, 9, 0, TZ);
  const nag: Effect = {
    kind: 'nagged', instanceId: 9, title: 'לדבר על המוסך', since: SINCE, round: 1, granted: 0,
  };
  // Pinned so "how long has it been" is a fixed 30 minutes, not wall-clock luck.
  const NOW = wallToUtc(2026, 8, 10, 9, 30, TZ);
  const realNow = Date.now;
  Date.now = () => NOW;
  const f = facts([nag]);
  const b = base([nag]);
  Date.now = realNow;

  check('facts.elapsed carries the true elapsed minutes',
    f.elapsed.includes(30), `elapsed: ${JSON.stringify(f.elapsed)}`);

  check('the exact false claim from the transcript is rejected',
    !validate('שעה וחצי אתה גורר את הטלפון למוסך.', f, b).ok);
  check('and the rejection says what it was',
    /שעה וחצי|90/.test(validate('שעה וחצי אתה גורר את הטלפון למוסך.', f, b).reason ?? ''),
    validate('שעה וחצי אתה גורר את הטלפון למוסך.', f, b).reason);
  check('a truthful claim about the same span passes',
    validate('חצי שעה אתה גורר את הטלפון למוסך.', f, b).ok,
    validate('חצי שעה אתה גורר את הטלפון למוסך.', f, b).reason);
  check('"כבר" is the other frame that makes a duration a claim, and it is checked too',
    !validate('כבר שעתיים זה פתוח.', f, b).ok);
  check('the same frame passes on the true number',
    validate('כבר 30 דקות זה פתוח.', f, b).ok,
    validate('כבר 30 דקות זה פתוח.', f, b).reason);
  check('rounding is allowed — the model is not required to say 30 to the minute',
    validate('כבר 25 דקות זה פתוח.', f, b).ok,
    validate('כבר 25 דקות זה פתוח.', f, b).reason);

  // The whole risk of this rule is over-reach: the persona is rhetorical about
  // durations, and every line below is GOOD output from the same transcript or
  // one keystroke away from it. None of them is a claim about elapsed time, so
  // none may be touched. A rule that kills these is worse than no rule.
  check('a prescriptive duration is not a claim — "a thirty-second phone call"',
    validate('רק תרים שיחה של חצי דקה ותשאל אם יש תור.', f, b).ok,
    validate('רק תרים שיחה של חצי דקה ותשאל אם יש תור.', f, b).reason);
  check('a consequence clause is not a claim — "five minutes and you are out"',
    validate('חמש דקות ואתה בחוץ.', f, b).ok,
    validate('חמש דקות ואתה בחוץ.', f, b).reason);
  check('a forward-looking duration is not a claim — "in half an hour I am back"',
    validate('עוד חצי שעה אני פה שוב.', f, b).ok,
    validate('עוד חצי שעה אני פה שוב.', f, b).reason);
  check('"תן לזה חמש דקות שקט" is not a claim either',
    validate('תן לזה חמש דקות שקט.', f, b).ok,
    validate('תן לזה חמש דקות שקט.', f, b).reason);

  // Same fold the other three rules get: whatever voice.ts said is true by
  // construction, so the model may echo it.
  check('a duration stated by the baseline itself is allowed back',
    validate('כבר שעתיים זה פתוח.', f, 'זה פתוח כבר שעתיים.').ok);
}
{
  // Nothing this turn has a "since", so there is no elapsed time to be right
  // about — and a confident quantity is therefore invented by definition.
  const chat: Effect = { kind: 'nothing', why: 'chat', userText: 'מה קורה' };
  const f = facts([chat]);
  const b = base([chat]);
  check('facts.elapsed is empty when nothing is open',
    f.elapsed.length === 0, `elapsed: ${JSON.stringify(f.elapsed)}`);
  check('an elapsed claim with no elapsed fact behind it is rejected',
    !validate('כבר שבוע לא דיברנו.', f, b).ok);
  check('but ordinary chat with no duration in it is untouched',
    validate('נו? מה קורה איתך.', f, b).ok);
}

section('rule 4 — a goal check-in knows how long it has been, too');
{
  // 09.08.2026 14:49: "מאז יום שישי בבוקר שאמרת לה שהיא יפה לא שמענו ממך."
  // Nothing verified that. `lastProgressAt` is the fact it was reaching for
  // and facts.ts never swept it, so the model was guessing — and once rule 4
  // existed, a check-in framing that guess as a claim had no elapsed value to
  // match and got discarded wholesale. Sweeping the timestamp turns a
  // rejection into a true sentence, which is the point.
  const PROGRESS = wallToUtc(2026, 8, 7, 9, 0, TZ);   // Friday morning
  const NOW = wallToUtc(2026, 8, 9, 14, 49, TZ);      // Sunday afternoon
  const checkin: Effect = {
    kind: 'checkin_goal', id: 3, title: 'להגיד לאישתי משהו יפה', why: null,
    lastProgress: 'אמרתי לה שהיא יפה', lastProgressAt: PROGRESS, lastCheckinAt: null,
  };
  const realNow = Date.now;
  Date.now = () => NOW;
  const f = facts([checkin]);
  const b = base([checkin]);
  Date.now = realNow;

  const since = Math.round((NOW - PROGRESS) / 60_000); // 3229 minutes ≈ 2¼ days
  check('facts.elapsed carries the time since he last moved on the goal',
    f.elapsed.includes(since), `elapsed: ${JSON.stringify(f.elapsed)}`);
  check('so a truthful "it has been two days" passes',
    validate('כבר יומיים אתה שותק.', f, b).ok,
    validate('כבר יומיים אתה שותק.', f, b).reason);
  check('and an inflated one is still rejected',
    !validate('כבר שבועיים אתה שותק.', f, b).ok);
}

section('ambiguous-hour altHour never reaches validate() — it is a button label only');
{
  // Task 11: reminder_created can carry altHour (the "other reading" offered
  // as a one-tap correction). facts.ts only sweeps `at`/`until`/`since` into
  // facts.times, and voice.ts's baseline for reminder_created never mentions
  // altHour at all — so it must not cause a false rejection of the truthful
  // deterministic message, and it must not silently become an allowed time.
  const CREATED_WITH_ALT: Effect = {
    kind: 'reminder_created', id: 1, title: 'להתקשר',
    at: new Date('2026-08-06T08:00:00Z').getTime(),   // 11:00 Asia/Jerusalem
    schedule: { type: 'once', at: '2026-08-06T11:00' }, requiresProof: false,
    altHour: 23,
  };
  const f = facts([CREATED_WITH_ALT]);
  check('altHour is not swept into facts.times',
    !f.times.includes('23:00'), `times: ${JSON.stringify(f.times)}`);

  const b = base([CREATED_WITH_ALT]);
  check('the baseline never mentions the alt hour',
    !b.includes('23:00'), `baseline: ${b}`);
  check('the true baseline still passes its own validator with altHour set',
    validate(b, f, b).ok, validate(b, f, b).reason);

  // The failure case the brief warns about: the alt hour reaching the MODEL's
  // rewrite while absent from both facts.times and the baseline. That must
  // still be rejected — offering it as a button is fine, a model asserting it
  // as a clock time in prose is not.
  check('a model rewrite that invents the alt hour as a clock time is rejected',
    !validate('קבעתי ל-11:00, אולי התכוונת ל-23:00?', f, b).ok);
  // And the literal, truthful reading is unaffected by altHour being present.
  check('a truthful rewrite of the literal hour still passes',
    validate('קבעתי ל-11:00.', f, b).ok);
}


section('rule 2 reports WHAT the turn did, so a rejection is diagnosable');
{
  // gave_up closes an instance — a real write — but sat outside WROTE, so a
  // false create-claim on that turn was reported as 'claimed a write with no
  // effect'. That reads in /diag as 'the model invented a write out of
  // nothing' when what actually happened is 'the model called a close a
  // create', which is a different bug with a different fix.
  const gaveUp: Effect = { kind: 'gave_up', instanceId: 9, title: 'לרוץ', rounds: 3 };
  const v = validate('קבעתי לך את זה מחדש.', facts([gaveUp]), base([gaveUp]));
  check('a create claimed over a give-up is still rejected', !v.ok, v.reason);
  check(
    'and the reason names what the turn really did',
    (v.reason ?? '').includes('gave_up'),
    v.reason ?? '(none)',
  );
}

done();
