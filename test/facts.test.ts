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
  brief_hour: 8, closeout_hour: 21, last_brief_on: null, last_closeout_on: null,
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

section('duplicateOf.title — the trap: a nested title must still reach facts.titles');
{
  // facts.ts's generic sweep checks `'title' in e` at the TOP LEVEL of the
  // effect. duplicateOf is a nested object, so without an explicit sweep line
  // its title never reaches facts.titles — and a truthful model rewrite that
  // names the existing reminder would be discarded by validate.ts as an
  // invented task.
  const created: Effect = {
    kind: 'reminder_created', id: 2, title: 'לקחת בגד ים', at: AT,
    schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false,
    duplicateOf: { id: 11, title: 'לקחת בגד ים לחוף' },
  };
  const f = buildFacts(ctx(), [created], TZ);
  check(
    'duplicateOf.title is swept into facts.titles even though it is nested',
    f.titles.includes('לקחת בגד ים לחוף'),
    `titles: ${JSON.stringify(f.titles)}`,
  );
}

section('reminder_renamed — the same trap, twice: neither title sits under `title`');
{
  // A rename carries `from` and `to`, so the generic `'title' in e` sweep finds
  // NEITHER. Without the explicit line in facts.ts, the one sentence the bot
  // most needs to say here — "X is now Y" — cites two titles the validator has
  // never heard of and gets thrown away, falling back to the baseline.
  const renamed: Effect = { kind: 'reminder_renamed', id: 3, from: 'לקנות חלב', to: 'לקנות לחם' };
  const f = buildFacts(ctx(), [renamed], TZ);
  check('the OLD title is quotable', f.titles.includes('לקנות חלב'), `titles: ${JSON.stringify(f.titles)}`);
  check('the NEW title is quotable', f.titles.includes('לקנות לחם'), `titles: ${JSON.stringify(f.titles)}`);
}

section('needs_reminder_choice — the candidates it lists must be quotable');
{
  const rows = [daily, { ...daily, id: 8, title: 'לרוץ' }];
  const f = buildFacts(ctx(), [{ kind: 'needs_reminder_choice', action: 'reschedule', rows }], TZ);
  check('the first candidate is allowed', f.titles.includes('להתקשר לרואה חשבון'));
  check('the second candidate is allowed', f.titles.includes('לרוץ'));
  eq('and asking a question is not a write',
    buildFacts(ctx(), [{ kind: 'needs_reminder_choice', action: 'rename', rows: [] }], TZ).wrote, false);
}

section('needs_task_choice — instance titles come from ctx.open, already swept');
{
  const openInstances = [
    { id: 9, reminder_id: 1, chat_id: '1', title: 'לקחת בגד ים', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open' as const, proof: null, closed_at: null },
    { id: 10, reminder_id: 2, chat_id: '1', title: 'לזרוק זבל', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open' as const, proof: null, closed_at: null },
  ];
  const f = buildFacts(ctx({ open: openInstances }), [
    { kind: 'needs_task_choice', action: 'complete', open: openInstances },
  ], TZ);
  check('the first open instance title is allowed', f.titles.includes('לקחת בגד ים'));
  check('the second open instance title is allowed', f.titles.includes('לזרוק זבל'));
}

section('wrote — the gate on confirmation language');
eq('a create counts as a write',
  buildFacts(ctx(), [{ kind: 'reminder_captured', id: 1, title: 'x' }], TZ).wrote, true);
eq('a listing does not',
  buildFacts(ctx(), [{ kind: 'listed_goals', rows: [] }], TZ).wrote, false);
eq('a nothing-effect does not',
  buildFacts(ctx(), [{ kind: 'nothing', why: 'chat', userText: 'x' }], TZ).wrote, false);
eq('a bare chat turn does not', buildFacts(ctx(), [], TZ).wrote, false);
eq(
  'reminder_duplicate does not count as a write — nothing was inserted',
  buildFacts(ctx(), [{ kind: 'reminder_duplicate', id: 1, title: 'x', at: AT }], TZ).wrote,
  false,
);
eq(
  'needs_task_choice does not count as a write — it only asks a question',
  buildFacts(ctx(), [{ kind: 'needs_task_choice', action: 'complete', open: [] }], TZ).wrote,
  false,
);

done();
