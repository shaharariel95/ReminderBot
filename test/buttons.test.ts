/** Run with `npm run test:buttons`. */
import { decode, encode, keyboard, type Callback } from '../src/buttons';
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
for (const bad of ['', 'x', 'd:', 'd:abc', 'nope:1', 's:1', 's:1:x', 'r:1:99:00', 'p:1:zzz']) {
  eq(`"${bad}" decodes to null`, decode(bad), null);
}

section('keyboard shape matches the Bot API');
const kb = keyboard([[{ text: 'עשיתי', data: { t: 'done', instance: 1 } }]]) as any;
check('has inline_keyboard rows', Array.isArray(kb.inline_keyboard));
eq('button text is preserved', kb.inline_keyboard[0][0].text, 'עשיתי');
eq('button carries callback_data', kb.inline_keyboard[0][0].callback_data, 'd:1');

done();
