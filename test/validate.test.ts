/** Run with `npm run test:validate`. */
import { validate } from '../src/validate';
import { buildFacts } from '../src/facts';
import { check, done, section } from './harness';
import type { Context } from '../src/brain';
import type { Effect, Settings, Stats } from '../src/types';

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

const CREATED: Effect = {
  kind: 'reminder_created', id: 1, title: 'לרוץ',
  at: new Date('2026-08-05T04:05:00Z').getTime(),   // 07:05 Asia/Jerusalem
  schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false,
};
const NOTHING: Effect = { kind: 'nothing', why: 'chat', userText: 'מה קורה' };

section('rule 1 — invented times are rejected');
check('a time that matches the facts passes',
  validate('קבעתי ל-07:05, אל תתלונן.', facts([CREATED])).ok);
check('a time that does not appear is rejected',
  !validate('קבעתי ל-08:30, אל תתלונן.', facts([CREATED])).ok);
check('a reply with no time at all passes',
  validate('סגור.', facts([CREATED])).ok);

section('rule 2 — phantom confirmations are rejected');
for (const claim of ['רשמתי לך', 'קבעתי', 'שמתי לך תזכורת', 'זה נשמר', 'נקבע']) {
  check(`"${claim}" is rejected when nothing was written`,
    !validate(claim + '.', facts([NOTHING])).ok);
}
check('the same claim passes when something WAS written',
  validate('רשמתי.', facts([CREATED])).ok);

section('rule 3 — invented tasks are rejected');
check('quoting a real title passes',
  validate('"לרוץ" עדיין פתוחה.', facts([CREATED])).ok);
check('quoting a title that exists nowhere is rejected',
  !validate('"לכתוב את הדוח" עדיין פתוחה.', facts([CREATED])).ok);
check('quoting a title from the standing reminder list passes', (() => {
  const ctx = {
    reminders: [{
      id: 7, chat_id: '1', title: 'להתקשר לרואה חשבון', notes: null,
      schedule: '{"type":"daily","time":"09:00"}', tz: TZ, requires_proof: 0,
      proof_type: 'any' as const, nag_interval_min: 20, max_nags: 3,
      next_fire_at: null, status: 'scheduled' as const, active: 1, created_at: 0,
    }],
  };
  return validate('"להתקשר לרואה חשבון" מחכה לך.', facts([NOTHING], ctx)).ok;
})());

section('the reason is reported, so /diag can show why');
check('a rejection explains itself',
  (validate('קבעתי ל-08:30.', facts([CREATED])).reason ?? '').length > 0);

done();
