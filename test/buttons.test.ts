/** Run with `npm run test:buttons`. */
import { buttonsFor, decode, encode, keyboard, type Callback } from '../src/buttons';
import { formatLocal, planSlotInstant, wallToUtc } from '../src/time';
import { check, done, eq, section } from './harness';

section('round trip');
const samples: Callback[] = [
  { t: 'done', instance: 117 },
  { t: 'snooze', instance: 117, minutes: 10 },
  { t: 'snooze', instance: 999999, minutes: 720 },
  { t: 'skip', instance: 4 },
  { t: 'retime', reminder: 45, hour: 19, minute: 0 },
  { t: 'retime', reminder: 45, hour: 7, minute: 5 },
  { t: 'plan', reminder: 88, slot: 'tm' },
  { t: 'plan', reminder: 88, slot: 'none' },
];
for (const c of samples) {
  eq(`${c.t} survives a round trip`, decode(encode(c)), c);
}

section('Telegram limits');
for (const c of samples) {
  const bytes = new TextEncoder().encode(encode(c)).length;
  check(`${c.t} fits in 64 bytes (${bytes})`, bytes <= 64);
}

section('malformed input is rejected, never guessed');
for (const bad of ['', 'x', 'd:', 'd:abc', 'nope:1', 's:1', 's:1:x', 'r:1:99:00', 'r:1:10:99', 'd:1:2', 'p:1:zzz']) {
  eq(`"${bad}" decodes to null`, decode(bad), null);
}

section('keyboard shape matches the Bot API');
const kb = keyboard([[{ text: 'עשיתי', data: { t: 'done', instance: 1 } }]]) as any;
check('has inline_keyboard rows', Array.isArray(kb.inline_keyboard));
eq('button text is preserved', kb.inline_keyboard[0][0].text, 'עשיתי');
eq('button carries callback_data', kb.inline_keyboard[0][0].callback_data, 'd:1');

section('buttonsFor guards against a typo producing NaN');
const fired = buttonsFor([{ kind: 'reminder_fired', instanceId: 42 }]);
check('a well-formed fired effect yields done/snooze/skip',
  !!fired && JSON.stringify(fired).includes('"t":"done"'),
  JSON.stringify(fired));
eq('a malformed instanceId yields no buttons, not a broken one',
  buttonsFor([{ kind: 'reminder_fired', instanceId: 'abc' }]), undefined);

const captured = buttonsFor([{ kind: 'reminder_captured', id: 7 }]);
check('a well-formed capture effect yields plan slots',
  !!captured && JSON.stringify(captured).includes('"t":"plan"'),
  JSON.stringify(captured));
eq('a malformed capture id yields no buttons',
  buttonsFor([{ kind: 'reminder_captured', id: NaN }]), undefined);

section('several reminders firing at once each get their own buttons');
{
  // This was a `.find()`, so the first task got a keyboard and every other
  // task fired that minute got none — unclosable except by typing.
  const rows = buttonsFor([
    { kind: 'reminder_fired', instanceId: 9, title: 'לקחת אוכל' },
    { kind: 'reminder_fired', instanceId: 10, title: 'לזרוק זבל' },
  ]);
  check('one row per task', !!rows && rows.length === 2, JSON.stringify(rows));
  const flat = JSON.stringify(rows);
  check('the first task can be closed', flat.includes('"instance":9'), flat);
  check('the second task can be closed too', flat.includes('"instance":10'), flat);
  check('each button is labelled so they can be told apart',
    flat.includes('לקחת אוכל') && flat.includes('לזרוק זבל'), flat);

  // A single fired reminder keeps the original, unlabelled keyboard.
  const solo = buttonsFor([{ kind: 'reminder_fired', instanceId: 42, title: 'לרוץ' }]);
  check('a lone reminder still gets the plain three buttons on one row',
    !!solo && solo.length === 1 && solo[0].length === 3 && solo[0][0].text === 'עשיתי',
    JSON.stringify(solo));

  // One unusable id must not cost the other task its buttons.
  const partial = buttonsFor([
    { kind: 'reminder_fired', instanceId: 'abc', title: 'שבור' },
    { kind: 'reminder_fired', instanceId: 11, title: 'תקין' },
  ]);
  check('a task with a malformed id is skipped, the rest stay actionable',
    !!partial && partial.length === 1 && JSON.stringify(partial).includes('"instance":11'),
    JSON.stringify(partial));
  eq('and if none of them are usable, no keyboard at all',
    buttonsFor([
      { kind: 'reminder_fired', instanceId: 'abc' },
      { kind: 'reminder_fired', instanceId: NaN },
    ]),
    undefined);

  // A long title has to be cut, or Telegram wraps it into an unreadable slab.
  const long = buttonsFor([
    { kind: 'reminder_fired', instanceId: 1, title: 'להתקשר לרואה החשבון בעניין הדוח השנתי' },
    { kind: 'reminder_fired', instanceId: 2, title: 'לרוץ' },
  ]);
  check('a long title is truncated on the button',
    !!long && long[0][0].text.length <= 18, JSON.stringify(long?.[0][0].text));
}

section('ambiguous-hour correction button');
{
  const buttons = buttonsFor([{ kind: 'reminder_created', id: 12, altHour: 23 }]);
  check('a reminder_created effect with altHour offers a retime button',
    !!buttons && JSON.stringify(buttons).includes('"t":"retime"'),
    JSON.stringify(buttons));
  const decoded = buttons ? decode(encode(buttons[0][0].data)) : null;
  eq('the button payload decodes back to the same retime', decoded, { t: 'retime', reminder: 12, hour: 23, minute: 0 });
}
{
  // 12 + 12 = 24, which must wrap to 00, not encode as the literal "24".
  const buttons = buttonsFor([{ kind: 'reminder_created', id: 5, altHour: 0 }]);
  eq('midnight (hour 0) round-trips through encode/decode, not "24"',
    buttons ? decode(encode(buttons[0][0].data)) : null,
    { t: 'retime', reminder: 5, hour: 0, minute: 0 });
}
eq('a reminder_created effect with no altHour offers no correction button',
  buttonsFor([{ kind: 'reminder_created', id: 12 }]), undefined);
eq('a malformed id with altHour set yields no buttons, not a broken one',
  buttonsFor([{ kind: 'reminder_created', id: NaN, altHour: 23 }]), undefined);

section('inbox slots say the time they actually mean');
{
  // He tapped "מחר בבוקר" on 09.08.2026 and got 09:00, having asked for 10:00.
  // The button never said 09:00 anywhere — the hour lived only in
  // slotToInstant, so there was nothing on screen to disagree with.
  const TZ = 'Asia/Jerusalem';
  const NOW = wallToUtc(2026, 8, 9, 14, 55, TZ);
  const rows = buttonsFor([{ kind: 'reminder_captured', id: 7 }], TZ, NOW);
  const labels = (rows ?? []).flat().map((b) => b.text);

  check('the evening slot names its hour', labels.some((l) => l.includes('20:00')), labels.join(' | '));
  check('the tomorrow slot names its hour', labels.some((l) => l.includes('09:00')), labels.join(' | '));
  check('the "in an hour" slot names the hour it lands on',
    labels.some((l) => l.includes('15:55')), labels.join(' | '));
  check('"no time" stays a slot with nothing to promise',
    labels.some((l) => l.includes('בלי זמן')), labels.join(' | '));

  // The assertion that matters: the label and the write share one source, so
  // they cannot drift apart later. Anything else is a comment that happens to
  // render.
  for (const slot of ['eve', 'tm', 'hr'] as const) {
    const btn = (rows ?? []).flat().find(
      (b) => b.data.t === 'plan' && b.data.slot === slot,
    );
    const at = planSlotInstant(slot, TZ, NOW);
    check(`the ${slot} label matches what tapping it schedules`,
      btn !== undefined && btn.text.includes(formatLocal(at, TZ).slice(-5)),
      `${btn?.text} vs ${formatLocal(at, TZ)}`);
  }
}

done();
