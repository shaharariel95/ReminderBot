/** Run with `npm run test:validate`. */
import { validate } from '../src/validate';
import { buildFacts } from '../src/facts';
import { renderBaseline } from '../src/voice';
import { wallToUtc } from '../src/time';
import { check, done, section } from './harness';
import type { Context } from '../src/brain';
import type { Effect, Reminder, Settings, Stats } from '../src/types';

const TZ = 'Asia/Jerusalem';

const settings: Settings = {
  chat_id: '1', tz: TZ, intensity: 2, muted_until: null, off_limits: null,
  checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
  next_checkin_at: null,
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
      next_fire_at: null, status: 'scheduled' as const, active: 1, created_at: 0,
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
    next_fire_at: null, status: 'scheduled', active: 1, created_at: 0,
  };
  // next_fire_at is null on purpose: the only way "16:45" reaches facts.times is
  // through the schedule JSON on the effect's own row, not the reminder's next fire.
  const f = facts([{ kind: 'listed_reminders', rows: [row], openCount: 1 }]);
  return f.times.includes('16:45');
})());

section('the baseline is always true by construction — every effect survives its own validator');
{
  const AT = wallToUtc(2026, 8, 5, 7, 5, TZ);

  const dailyRow: Reminder = {
    id: 11, chat_id: '1', title: 'להוציא זבל', notes: null,
    schedule: '{"type":"daily","time":"09:00"}', tz: TZ, requires_proof: 0,
    proof_type: 'any', nag_interval_min: 20, max_nags: 3,
    next_fire_at: AT, status: 'scheduled', active: 1, created_at: 0,
  };

  const samples: Effect[] = [
    { kind: 'reminder_created', id: 1, title: 'לרוץ', at: AT, schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false },
    { kind: 'reminder_captured', id: 2, title: 'לקנות חלב' },
    { kind: 'reminder_scheduled', id: 2, title: 'לקנות חלב', at: AT },
    { kind: 'reminder_retimed', id: 1, title: 'לרוץ', at: AT },
    { kind: 'reminder_deleted', id: 1, title: 'לרוץ' },
    { kind: 'instance_done', id: 9, title: 'לרוץ', streak: 4 },
    { kind: 'instance_skipped', id: 9, title: 'לרוץ' },
    { kind: 'instance_snoozed', id: 9, title: 'לרוץ', until: AT, minutes: 10 },
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
    { kind: 'nagged', instanceId: 9, title: 'לרוץ', since: AT, round: 1 },
    { kind: 'gave_up', instanceId: 9, title: 'לרוץ', rounds: 3 },
    { kind: 'checkin_goal', id: 3, title: 'לפתוח תיק מסחר', why: null, lastProgress: null, lastProgressAt: null, lastCheckinAt: null },
    { kind: 'photo_accepted', instanceId: 9, title: 'לרוץ', reason: 'נעלי ריצה', streak: 2 },
    { kind: 'photo_rejected', instanceId: 9, title: 'לרוץ', reason: 'חתול' },
    { kind: 'distress', text: 'אני שבור' },
    { kind: 'nothing', why: 'no_time', userText: 'תזכיר לי לקום' },
    { kind: 'nothing', why: 'no_open_task', userText: 'סיימתי' },
    { kind: 'nothing', why: 'past_time', userText: 'תזכיר לי אתמול' },
    { kind: 'nothing', why: 'bad_time', userText: 'תזכיר לי ב-99' },
    { kind: 'nothing', why: 'unknown_reminder', userText: 'תבטל' },
    { kind: 'nothing', why: 'unknown_goal', userText: 'סיימתי מטרה' },
    { kind: 'nothing', why: 'chat', userText: 'מה קורה' },
  ];

  for (const e of samples) {
    const text = renderBaseline([e], TZ);
    const f = facts([e]);
    const v = validate(text, f, text);
    check(`${e.kind}${'why' in e ? `/${e.why}` : ''} baseline round-trips through its own validator`,
      v.ok, v.reason);
  }
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

done();
