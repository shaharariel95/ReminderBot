/** Run with `npm run test:buttons`. */
import { buttonsFor, decode, encode, keyboard, type Callback } from '../src/buttons';
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

done();
