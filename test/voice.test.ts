/** Run with `npm run test:voice`. */
import { renderBaseline } from '../src/voice';
import { CLAIM } from '../src/validate';
import { wallToUtc } from '../src/time';
import { check, done, section } from './harness';
import type { Effect } from '../src/types';
import { UNTITLED_TITLE } from '../src/types';

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
  { kind: 'reminder_duplicate', id: 11, title: 'לקחת בגד ים', at: AT },
  {
    kind: 'needs_task_choice', action: 'complete',
    open: [
      { id: 9, reminder_id: 1, chat_id: '1', title: 'לקחת בגד ים', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null },
      { id: 10, reminder_id: 2, chat_id: '1', title: 'לזרוק זבל', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null },
    ],
  },
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
check('reminder_duplicate names the existing reminder and its time',
  render({ kind: 'reminder_duplicate', id: 11, title: 'לקחת בגד ים', at: AT }).includes('לקחת בגד ים') &&
  render({ kind: 'reminder_duplicate', id: 11, title: 'לקחת בגד ים', at: AT }).includes('07:05'));
check('needs_task_choice lists every open instance, not just one',
  (() => {
    const t = render({
      kind: 'needs_task_choice', action: 'complete',
      open: [
        { id: 9, reminder_id: 1, chat_id: '1', title: 'לקחת בגד ים', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null },
        { id: 10, reminder_id: 2, chat_id: '1', title: 'לזרוק זבל', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null },
      ],
    });
    return t.includes('לקחת בגד ים') && t.includes('לזרוק זבל');
  })());

section('a reminder with no subject never has the fallback title read back at it');
{
  const firedUntitled = render({ kind: 'reminder_fired', id: 1, title: UNTITLED_TITLE, instanceId: 9, requiresProof: false });
  const firedNamed = render({ kind: 'reminder_fired', id: 1, title: 'לרוץ', instanceId: 9, requiresProof: false });
  // "נו? תזכורת." is the exact string this section exists to prevent: it reads
  // like a bug and carries none of the information he needed at 07:00.
  check('the fired wording does not just quote the fallback title',
    firedUntitled !== 'נו? תזכורת.' && firedUntitled !== firedNamed,
    `got: ${firedUntitled}`);
  check('it says out loud that the subject is missing',
    firedUntitled.includes('לא אמרת מה'), `got: ${firedUntitled}`);
  check('and a normally-titled reminder is untouched by any of this',
    firedNamed === 'נו? לרוץ.', `got: ${firedNamed}`);

  const createdUntitled = render({
    kind: 'reminder_created', id: 1, title: UNTITLED_TITLE, at: AT,
    schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false,
  });
  check('the confirmation asks what it is about, while he still remembers',
    createdUntitled.includes('על מה'), `got: ${createdUntitled}`);
  check('and still states the exact time it was set for',
    createdUntitled.includes('07:05'), `got: ${createdUntitled}`);

  const naggedUntitled = render({ kind: 'nagged', instanceId: 9, title: UNTITLED_TITLE, since: AT, round: 1 });
  check('the nag does not quote the fallback title either',
    !naggedUntitled.includes(`"${UNTITLED_TITLE}"`), `got: ${naggedUntitled}`);
  check('but still states when it has been open since',
    naggedUntitled.includes('07:05'), `got: ${naggedUntitled}`);

  const capturedUntitled = render({ kind: 'reminder_captured', id: 2, title: UNTITLED_TITLE });
  check('a subject-less, time-less capture asks for both',
    !capturedUntitled.includes(`"${UNTITLED_TITLE}"`), `got: ${capturedUntitled}`);

  // reminder_fired and nagged are NOT in WROTE, so the reworded versions are
  // subject to the same lexicon rule as everything else on that side.
  check('the untitled fired wording contains no CLAIM verb', !CLAIM.test(firedUntitled));
  check('the untitled nag wording contains no CLAIM verb', !CLAIM.test(naggedUntitled));
}

section('WROTE invariant — neither new non-writing effect uses a CLAIM verb');
{
  // reminder_duplicate and needs_task_choice are deliberately absent from
  // WROTE (types.ts): nothing was inserted for either. If voice.ts's wording
  // for them contained a CLAIM verb, the deterministic baseline would reject
  // itself the instant facts.wrote is false. Imported straight from
  // validate.ts (rather than hand-copied) so the two can never silently
  // diverge — this project has already had the prompt and the lexicon drift
  // apart once.
  check('reminder_duplicate\'s baseline contains no CLAIM verb',
    !CLAIM.test(render({ kind: 'reminder_duplicate', id: 11, title: 'לקחת בגד ים', at: AT })));
  check('needs_task_choice\'s baseline contains no CLAIM verb',
    !CLAIM.test(render({
      kind: 'needs_task_choice', action: 'complete',
      open: [{ id: 9, reminder_id: 1, chat_id: '1', title: 'לקחת בגד ים', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null }],
    })));
}

section('reminder_created with duplicateOf warns about the near-duplicate');
check('the created reminder still states its own title and time, plus the existing similar one', (() => {
  const t = render({
    kind: 'reminder_created', id: 2, title: 'לקחת בגד ים', at: AT,
    schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false,
    duplicateOf: { id: 11, title: 'לקחת בגד ים לחוף' },
  });
  return t.includes('לקחת בגד ים') && t.includes('לקחת בגד ים לחוף');
})());
check('without duplicateOf, nothing is said about a similar reminder',
  !render(samples[0]).includes('גם יש לך') && samples[0].kind === 'reminder_created' && samples[0].duplicateOf === undefined);

section('multiple effects join into one message');
check('two creates produce both titles', (() => {
  const t = renderBaseline([samples[0], { ...samples[0], title: 'לשתות' } as Effect], TZ);
  return t.includes('לרוץ') && t.includes('לשתות');
})());

done();
