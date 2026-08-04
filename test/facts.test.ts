/** Run with `npm run test:facts`. */
import { buildFacts } from '../src/facts';
import { wallToUtc } from '../src/time';
import { check, done, eq, section } from './harness';
import type { Context } from '../src/brain';
import type { Effect, Reminder, Settings, Stats } from '../src/types';

const TZ = 'Asia/Jerusalem';
const AT = wallToUtc(2026, 8, 5, 7, 5, TZ);

const settings: Settings = {
  chat_id: '1', tz: TZ, intensity: 2, muted_until: null, off_limits: null,
  checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
  next_checkin_at: null,
};
const stats: Stats = { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 3 };

const daily: Reminder = {
  id: 7, chat_id: '1', title: 'להתקשר לרואה חשבון', notes: null,
  schedule: '{"type":"daily","time":"09:00"}', tz: TZ, requires_proof: 0,
  proof_type: 'any', nag_interval_min: 20, max_nags: 3,
  next_fire_at: AT, status: 'scheduled', active: 1, created_at: 0,
};

function ctx(over: Partial<Context> = {}): Context {
  return { settings, stats, reminders: [], goals: [], open: [], nowLabel: 'עכשיו', ...over };
}

section('times the model is allowed to say');
{
  const f = buildFacts(ctx({ reminders: [daily] }), [], TZ);
  check('the next fire time is allowed', f.times.includes('07:05'));
  check('a recurring rule time is allowed', f.times.includes('09:00'));
}
{
  const created: Effect = {
    kind: 'reminder_created', id: 1, title: 'לרוץ', at: AT,
    schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false,
  };
  const f = buildFacts(ctx(), [created], TZ);
  check('a time produced this turn is allowed', f.times.includes('07:05'));
  check('an unrelated time is not', !f.times.includes('13:37'));
}

section('titles the model is allowed to quote');
{
  const f = buildFacts(ctx({ reminders: [daily] }), [], TZ);
  check('a standing reminder title is allowed', f.titles.includes('להתקשר לרואה חשבון'));
}
{
  const listed: Effect = { kind: 'listed_inbox', rows: [{ ...daily, id: 9, title: 'לקנות חלב' }] };
  const f = buildFacts(ctx(), [listed], TZ);
  check('titles inside a listing are allowed', f.titles.includes('לקנות חלב'));
}

section('wrote — the gate on confirmation language');
eq('a create counts as a write',
  buildFacts(ctx(), [{ kind: 'reminder_captured', id: 1, title: 'x' }], TZ).wrote, true);
eq('a listing does not',
  buildFacts(ctx(), [{ kind: 'listed_goals', rows: [] }], TZ).wrote, false);
eq('a nothing-effect does not',
  buildFacts(ctx(), [{ kind: 'nothing', why: 'chat', userText: 'x' }], TZ).wrote, false);
eq('a bare chat turn does not', buildFacts(ctx(), [], TZ).wrote, false);

done();
