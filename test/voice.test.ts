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
  { kind: 'listed_reminders', rows: [], openCount: 0 },
  { kind: 'listed_goals', rows: [] },
  { kind: 'listed_inbox', rows: [] },
  { kind: 'reminder_fired', id: 1, title: 'לרוץ', instanceId: 9, requiresProof: false },
  { kind: 'nagged', instanceId: 9, title: 'לרוץ', since: AT, round: 1, granted: 0 },
  { kind: 'gave_up', instanceId: 9, title: 'לרוץ', rounds: 3 },
  { kind: 'checkin_goal', id: 3, title: 'לפתוח תיק מסחר', why: null, lastProgress: null, lastProgressAt: null, lastCheckinAt: null },
  { kind: 'photo_accepted', instanceId: 9, title: 'לרוץ', reason: 'נעלי ריצה', streak: 2 },
  { kind: 'photo_rejected', instanceId: 9, title: 'לרוץ', reason: 'חתול' },
  { kind: 'morning_brief', rows: [], openCount: 0 },
  { kind: 'evening_closeout', done: [], missed: [], dropped: [], ahead: [] },
  { kind: 'profile_noted', id: 1, note: 'אני קם ב-6' },
  { kind: 'profile_known', note: 'אני קם ב-6' },
  { kind: 'profile_forgotten', note: 'אני קם ב-6' },
  { kind: 'listed_profile', rows: [] },
  { kind: 'distress', text: 'אני שבור' },
  { kind: 'nothing', why: 'no_open_task', userText: 'סיימתי' },
  { kind: 'nothing', why: 'past_time', userText: 'תזכיר לי אתמול' },
  { kind: 'nothing', why: 'bad_time', userText: 'תזכיר לי ב-99' },
  { kind: 'nothing', why: 'unknown_reminder', userText: 'תבטל' },
  { kind: 'nothing', why: 'unknown_goal', userText: 'סיימתי מטרה' },
  { kind: 'nothing', why: 'chat', userText: 'מה קורה' },
  { kind: 'nothing', why: 'unknown_friend', userText: 'תזכיר לדנה' },
  { kind: 'needs_time', id: 1, title: 'לרוץ' },
  { kind: 'nothing', why: 'failed', userText: 'סיימתי הכל' },
  { kind: 'nothing', why: 'not_understood', userText: 'תעשה משהו' },
  { kind: 'item_done', id: 5, title: 'להחזיר ראוטר', reminderId: 1, remaining: 2 },
  { kind: 'item_done', id: 5, title: 'להחזיר ראוטר', reminderId: 1, remaining: 0 },
  { kind: 'needs_item_choice', open: [{ id: 5, reminder_id: 1, chat_id: '1', title: 'להחזיר ראוטר', position: 0, done_at: null, created_at: 0 }] },
  { kind: 'reminder_duplicate', id: 11, title: 'לקחת בגד ים', at: AT },
  {
    kind: 'needs_task_choice', action: 'complete',
    open: [
      { id: 9, reminder_id: 1, chat_id: '1', title: 'לקחת בגד ים', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null, granted_min: 0 },
      { id: 10, reminder_id: 2, chat_id: '1', title: 'לזרוק זבל', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null, granted_min: 0 },
    ],
  },
];

for (const e of samples) {
  const text = render(e);
  check(`${e.kind}${'why' in e ? `/${e.why}` : ''} renders non-empty Hebrew`,
    text.trim().length > 0 && /[֐-׿]/.test(text));
}

/**
 * Look a sample up by kind, never by position.
 *
 * These assertions used to index into `samples` directly, so adding one effect
 * to the list silently renumbered every one of them — three checks below went
 * red pointing at effects they were never written about. A kind is what each
 * check actually means.
 */
function sample<K extends Effect['kind']>(kind: K): Extract<Effect, { kind: K }> {
  const found = samples.find((s) => s.kind === kind);
  if (!found) throw new Error(`no sample for kind "${kind}" — add one to samples`);
  return found as Extract<Effect, { kind: K }>;
}

section('facts appear verbatim, never paraphrased');
check('a created reminder states the exact clock time',
  render(sample('reminder_created')).includes('07:05'));
check('a done report states the streak',
  render(sample('instance_done')).includes('4'));
check('nothing-effects never claim a write', (() => {
  const claims = /רשמתי|קבעתי|שמתי|נקבע|נשמר/;
  return samples.filter((e) => e.kind === 'nothing').every((e) => !claims.test(render(e)));
})());
check('a mute states the exact hours, not some other field',
  render(sample('muted')).includes('ל-4 שעות'));
check('a snooze states the exact minutes, not the target clock time',
  render(sample('instance_snoozed')).includes('ב-10 דקות'));
check('intensity states the exact level',
  render(sample('intensity_set')).includes('רמת עוקצנות 3'));
check('goal_closed renders "done" and "dropped" differently', (() => {
  const doneText = render(sample('goal_closed'));
  const droppedText = render({ ...sample('goal_closed'), status: 'dropped' } as Effect);
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
        { id: 9, reminder_id: 1, chat_id: '1', title: 'לקחת בגד ים', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null, granted_min: 0 },
        { id: 10, reminder_id: 2, chat_id: '1', title: 'לזרוק זבל', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null, granted_min: 0 },
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

  const naggedUntitled = render({ kind: 'nagged', instanceId: 9, title: UNTITLED_TITLE, since: AT, round: 1, granted: 0 });
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

section('reminders due together render as one block, not one message each');
{
  const two: Effect[] = [
    { kind: 'reminder_fired', id: 1, title: 'לקחת אוכל', instanceId: 9, requiresProof: false },
    { kind: 'reminder_fired', id: 2, title: 'לזרוק זבל', instanceId: 10, requiresProof: false },
  ];
  const text = renderBaseline(two, TZ);
  check('both tasks are named', text.includes('לקחת אוכל') && text.includes('לזרוק זבל'), text);
  // sendBurst splits on blank lines, so a blank line here would put them back
  // into two messages and undo the entire point of grouping them.
  check('and there is no blank line for sendBurst to split on', !text.includes('\n\n'), JSON.stringify(text));
  check('the count is stated', text.includes('2'), text);

  const withProof = renderBaseline(
    [two[0], { ...two[1], requiresProof: true } as Effect],
    TZ,
  );
  check('a task needing a photo is marked individually, not for the whole group',
    withProof.includes('לזרוק זבל (עם תמונה)') && !withProof.includes('לקחת אוכל (עם תמונה)'),
    withProof);

  // A single reminder must be untouched by any of this.
  check('one reminder alone still renders the plain wording',
    renderBaseline([two[0]], TZ) === 'נו? לקחת אוכל.', renderBaseline([two[0]], TZ));

  // A tick that fired two reminders AND gave up on something has more to say
  // than a list, so it falls through to per-effect rendering.
  const mixed = renderBaseline(
    [...two, { kind: 'gave_up', instanceId: 4, title: 'לרוץ', rounds: 3 }],
    TZ,
  );
  check('a mixed tick is not collapsed into the group wording',
    mixed.includes('לרוץ') && mixed.includes('\n\n'), mixed);
}

section('the daily messages describe the day without claiming to have changed it');
{
  const reminder = (id: number, title: string, at: number) => ({
    id, chat_id: '1', title, notes: null, schedule: '{"type":"once","at":"x"}',
    tz: TZ, requires_proof: 0, proof_type: 'any' as const, nag_interval_min: 20,
    max_nags: 3, next_fire_at: at, event_at: null, status: 'scheduled' as const, active: 1,
    from_chat_id: null, created_at: 0,
  });
  const brief = renderBaseline([{
    kind: 'morning_brief',
    rows: [reminder(1, 'לרוץ', AT), reminder(2, 'להתקשר לרואה חשבון', AT + 3_600_000)],
    openCount: 1,
  }], TZ);
  check('the brief names every reminder', brief.includes('לרוץ') && brief.includes('להתקשר לרואה חשבון'), brief);
  check('and states the time of each', brief.includes('07:05') && brief.includes('08:05'), brief);
  check('and mentions what is still open from before', brief.includes('1'), brief);
  // morning_brief is NOT in WROTE — it reads rows, it does not write any.
  check('the brief claims no write', !CLAIM.test(brief), brief);
  check('an empty day still says something rather than nothing',
    renderBaseline([{ kind: 'morning_brief', rows: [], openCount: 0 }], TZ).trim().length > 0);

  const inst = (id: number, title: string, status: 'open' | 'failed' | 'done') => ({
    id, reminder_id: 1, chat_id: '1', title, fired_at: AT, next_nag_at: null,
    nag_count: 0, status, proof: null, closed_at: null, granted_min: 0,
  });

  const closeout = renderBaseline([{
    kind: 'evening_closeout', done: [inst(20, 'לבקש מצחי את המייל', 'done'), inst(21, 'לרוץ', 'done')],
    missed: [inst(9, 'לזרוק זבל', 'open')], dropped: [], ahead: [],
  }], TZ);
  check('the close-out counts what was closed', closeout.includes('2'), closeout);
  check('and names what was not', closeout.includes('לזרוק זבל'), closeout);
  /*
   * This was `!CLAIM.test(closeout)` until 0.19.0, and CLAIM outgrew it.
   *
   * The lexicon gained the second-person forms because "יפה שסגרת את זה
   * מוקדם" shipped over a `no_open_task` baseline — and the close-out's own
   * wording is "סגרת N היום", which is TRUE: it is a tally read off the day's
   * closed instances, not a claim about this turn. The two are the same three
   * letters and opposite facts.
   *
   * What was being guarded here is narrower than the whole lexicon and always
   * was: a report must not say the BOT did something. That is first person,
   * and it is what this now asserts. The full "does the baseline pass its own
   * validator" check lives where it belongs — the every-kind loop in
   * test/validate.test.ts, which evening_closeout was missing from entirely.
   */
  const FIRST_PERSON_CLAIM = /רשמתי|קבעתי|שמרתי|שמתי לך|קלטתי|סימנתי|סגרתי|סיימתי|עדכנתי|הזזתי|דחיתי|העברתי|ביטלתי|מחקתי/;
  check('the close-out claims nothing the BOT did', !FIRST_PERSON_CLAIM.test(closeout), closeout);
  check('and "לא סגרת כלום היום" is not read as a claim either', !CLAIM.test(
    renderBaseline([{ kind: 'evening_closeout', done: [], missed: [], dropped: [], ahead: [] }], TZ),
  ));

  // The gap this section exists for: a task nagged the full ladder and given
  // up on used to be reachable only as a NUMBER. "2 נפלו" is not something he
  // can act on, and there is a button underneath it that assumes he can.
  const withDropped = renderBaseline([{
    kind: 'evening_closeout', done: [],
    missed: [], dropped: [inst(11, 'לרוץ', 'failed'), inst(12, 'להתקשר לאמא', 'failed')], ahead: [],
  }], TZ);
  check('tasks the bot gave up on are named, not counted',
    withDropped.includes('לרוץ') && withDropped.includes('להתקשר לאמא'), withDropped);
  check('and are distinguished from the ones still open',
    !withDropped.includes('עדיין פתוח'), withDropped);

  const both = renderBaseline([{
    kind: 'evening_closeout', done: [inst(20, 'לקנות חלב', 'done')],
    missed: [inst(9, 'לזרוק זבל', 'open')], dropped: [inst(11, 'לרוץ', 'failed')], ahead: [],
  }], TZ);
  check('a day with both kinds lists both, separately',
    both.includes('עדיין פתוח') && both.includes('ויתרתי') &&
    both.includes('לזרוק זבל') && both.includes('לרוץ'), both);

  // The close-out reads backwards — a tally, what is still open, what was
  // given up on. On 25.08.2026 at 21:00 that produced "זהו, אין יותר להיום"
  // over a dose scheduled for 22:00 the same evening, because the baseline
  // said nothing about the rest of the night and the persona filled the gap.
  const tonight = renderBaseline([{
    kind: 'evening_closeout', done: [inst(20, 'לקנות חלב', 'done')], missed: [], dropped: [],
    ahead: [{
      id: 63, chat_id: '1', title: 'לקחת תרופה', notes: null,
      schedule: '{"type":"daily","time":"22:00"}', tz: TZ, requires_proof: 0, proof_type: 'any',
      nag_interval_min: 20, max_nags: 3, next_fire_at: AT, event_at: null,
      status: 'scheduled', active: 1, from_chat_id: null, created_at: AT,
    }],
  }], TZ);
  check('what is still due tonight is named', tonight.includes('לקחת תרופה'), tonight);
  check('with the hour, so the persona may state it too',
    /\d{2}:\d{2}/.test(tonight), tonight);
  check('and a day with something still ahead is not "no loose ends"',
    !tonight.includes('אין זנבות'), tonight);

  const clean = renderBaseline([{
    kind: 'evening_closeout',
    done: [inst(20, 'לקנות חלב', 'done'), inst(21, 'לרוץ', 'done'), inst(22, 'לזרוק זבל', 'done')],
    missed: [], dropped: [], ahead: [],
  }], TZ);
  check('a day with no loose ends says so', clean.includes('אין זנבות'), clean);
  const nothing = renderBaseline([{ kind: 'evening_closeout', done: [], missed: [], dropped: [], ahead: [] }], TZ);
  check('and a day with nothing closed does not pretend otherwise',
    nothing.includes('לא סגרת כלום'), nothing);
}

section('a reminder that keeps not happening says so');
{
  const fire = (misses?: number) =>
    renderBaseline([{ kind: 'reminder_fired', id: 1, title: 'לרוץ', instanceId: 9, requiresProof: false, ...(misses === undefined ? {} : { misses }) }], TZ);

  check('a first miss changes nothing — a bad day is not a pattern', fire(1) === fire(), fire(1));
  check('two is still not a pattern', fire(2) === fire(), fire(2));
  check('three in a row is', fire(3) !== fire(), fire(3));
  check('and the run is stated as a number he can argue with', fire(4).includes('4'), fire(4));
  // reminder_fired is not in WROTE, so the extra sentence is bound by the same
  // lexicon rule as the rest of it.
  check('the pattern note claims no write', !CLAIM.test(fire(5)), fire(5));

  const grouped = renderBaseline([
    { kind: 'reminder_fired', id: 1, title: 'לרוץ', instanceId: 9, requiresProof: false, misses: 4 },
    { kind: 'reminder_fired', id: 2, title: 'לזרוק זבל', instanceId: 10, requiresProof: false },
  ], TZ);
  check('a long run is still named when several fire at once',
    grouped.includes('4'), grouped);
  check('and the task without a run is not accused of one',
    !/לזרוק זבל.*ברצף/.test(grouped), grouped);
}

section('being told something twice is not the same as writing it down');
{
  const stored = render({ kind: 'profile_noted', id: 1, note: 'אני קם ב-6' });
  const known = render({ kind: 'profile_known', note: 'אני קם ב-6' });
  check('storing a new fact confirms it plainly', stored.includes('אני קם ב-6'), stored);
  check('and re-stating a known one reads differently', stored !== known, known);
  // profile_noted IS in WROTE and may say "רשמתי". profile_known is NOT, and
  // saying it there would be a claim about a write that did not happen — the
  // one thing this whole pipeline exists to make impossible.
  check('the "already knew that" wording contains no CLAIM verb', !CLAIM.test(known), known);
  check('but it still repeats the fact back', known.includes('אני קם ב-6'), known);
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
      open: [{ id: 9, reminder_id: 1, chat_id: '1', title: 'לקחת בגד ים', fired_at: AT, next_nag_at: null, nag_count: 0, status: 'open', proof: null, closed_at: null, granted_min: 0 }],
    })));
}

section('reminder_created with duplicateOf warns about the near-duplicate');
check('the created reminder still states its own title and time, plus the existing similar one', (() => {
  const t = render({
    kind: 'reminder_created', id: 2, title: 'לקחת בגד ים', at: AT,
    schedule: { type: 'once', at: '2026-08-05T07:05' }, requiresProof: false,
    duplicateOf: { id: 11, title: 'לקחת בגד ים לחוף', at: AT },
  });
  return t.includes('לקחת בגד ים') && t.includes('לקחת בגד ים לחוף');
})());
check('without duplicateOf, nothing is said about a similar reminder',
  !render(sample('reminder_created')).includes('גם יש לך') && sample('reminder_created').kind === 'reminder_created' && sample('reminder_created').duplicateOf === undefined);

section('multiple effects join into one message');
check('two creates produce both titles', (() => {
  const t = renderBaseline([sample('reminder_created'), { ...sample('reminder_created'), title: 'לשתות' } as Effect], TZ);
  return t.includes('לרוץ') && t.includes('לשתות');
})());

done();
