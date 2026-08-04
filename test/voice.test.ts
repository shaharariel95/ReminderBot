/** Run with `npm run test:voice`. */
import { renderBaseline } from '../src/voice';
import { wallToUtc } from '../src/time';
import { check, done, section } from './harness';
import type { Effect } from '../src/types';

const TZ = 'Asia/Jerusalem';
const AT = wallToUtc(2026, 8, 5, 7, 5, TZ);

function render(e: Effect): string {
  return renderBaseline([e], TZ);
}

section('every effect renders something shippable');

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
  { kind: 'listed_reminders', rows: [], openCount: 0 },
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
  const text = render(e);
  check(`${e.kind}${'why' in e ? `/${e.why}` : ''} renders non-empty Hebrew`,
    text.trim().length > 0 && /[֐-׿]/.test(text));
}

section('facts appear verbatim, never paraphrased');
check('a created reminder states the exact clock time',
  render(samples[0]).includes('07:05'));
check('a done report states the streak',
  render(samples[5]).includes('4'));
check('nothing-effects never claim a write', (() => {
  const claims = /רשמתי|קבעתי|שמתי|נקבע|נשמר/;
  return samples.filter((e) => e.kind === 'nothing').every((e) => !claims.test(render(e)));
})());
check('a mute states the exact hours, not some other field',
  render(samples[12]).includes('ל-4 שעות'));
check('a snooze states the exact minutes, not the target clock time',
  render(samples[7]).includes('ב-10 דקות'));
check('intensity states the exact level',
  render(samples[13]).includes('רמת עוקצנות 3'));
check('goal_closed renders "done" and "dropped" differently', (() => {
  const doneText = render(samples[10]);
  const droppedText = render({ ...samples[10], status: 'dropped' } as Effect);
  return doneText !== droppedText && doneText.includes('סגור') && droppedText.includes('הורדתי');
})());

section('multiple effects join into one message');
check('two creates produce both titles', (() => {
  const t = renderBaseline([samples[0], { ...samples[0], title: 'לשתות' } as Effect], TZ);
  return t.includes('לרוץ') && t.includes('לשתות');
})());

done();
