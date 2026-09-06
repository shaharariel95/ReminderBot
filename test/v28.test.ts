/**
 * Run with `npm run test:v28`.
 *
 * issues.md §6, scored against the `rejections` table rather than argued.
 *
 * §6 says validate.ts "discards good writing" and proposes replacing the
 * rewrite with composition. The first half is true and measurable. All 13
 * rejections on record, 11.08 to 03.09.2026, sorted by which rule fired:
 *
 *   rule 1  #1 #4 #5 #8       invented an hour            all four CORRECT
 *   rule 2  #10               claimed a write             CORRECT
 *   rule 3  #2 #3             invented task "המשך"        correct — and both
 *                                                         are the (המשך) turn,
 *                                                         fixed at its root
 *   rule 3  #6 #7 #9 #13      invented task               ALL FOUR WRONG
 *   rule 5  #12               dropped the hour            wrong (§6's example)
 *   rule 6  #11               never named the errand      CORRECT
 *
 * Rule 3 is where the damage is: four false positives against two true ones,
 * and the two true ones caught a bug that no longer exists. What it fires on
 * is a QUOTED PHRASE that is not a known title — and Hebrew uses quotation
 * marks for scare-quotes and reported speech at least as often as for naming
 * a thing:
 *
 *   #6   "...או שאתה אומר לי "לא היום" ונשחרר"      a BUTTON LABEL
 *   #7   "קל כל כך לדבר על "לשחרר" כשאין כלום"      its own earlier offer
 *   #9   "אבל "עוד שעה בערך" זה לא באמת שעה"        his own words
 *   #13  "בלי תירוצים של "קר מדי" או "חם מדי""      a hypothetical excuse
 *
 * #9 was closed by normQuote. This version closes #6, and ONLY #6, because it
 * is the only one of the four with a deterministic answer: "לא היום" is a
 * string the bot itself renders on a button, in that chat, in that message.
 * A phrase he can literally tap is not an invented task, and admitting it
 * cannot admit a false claim — which is the test any change to this file has
 * to pass, since a rejection costs prose and a miss costs the one rule.
 *
 * #7 and #13 are left firing on purpose. There is no structural difference
 * between quoting a rhetorical excuse and naming a task that does not exist,
 * and the asymmetry above says which way to be wrong.
 */
import { FIXED_LABELS } from '../src/buttons';
import { validate } from '../src/validate';
import type { Facts } from '../src/types';
import { check, done, eq, section } from './harness';

const bare = (over: Partial<Facts> = {}): Facts => ({
  times: [],
  titles: [],
  quotable: [],
  effects: [],
  wrote: false,
  elapsed: [],
  elapsedRaw: [],
  elapsedSpansQuiet: false,
  elapsedSpansGranted: false,
  ...over,
} as Facts);

// ===========================================================================
section('a phrase the bot puts on a button is not an invented task');
//
// rejections #6, 18.08.2026 14:33. The nag offered him the out and quoted the
// button he would tap to take it; rule 3 called it an invented task and the
// flat baseline shipped instead.
{
  const text =
    'בוא נחתוך את זה: או שאתה פותר סעיף אחד קטן עכשיו, או שאתה אומר לי "לא היום" ונשחרר. מה בוחר?';
  const v = validate(text, bare(), 'נו? יש משהו פתוח.');
  check(`the #6 message is accepted — ${JSON.stringify(v)}`, v.ok, JSON.stringify(v));
}

// ---------------------------------------------------------------------------
section('every fixed label, and nothing beyond them');
{
  // Written out rather than looped over FIXED_LABELS. A loop over the same
  // constant the implementation reads asserts that a list agrees with itself:
  // the red-proof emptied the list and this section stayed green, because the
  // loop simply had less to iterate. These are the strings, typed by hand.
  const EXPECTED = [
    'מחר', 'לא היום', 'עשיתי', 'הכל', 'עוד 10 דק׳', '10 דק׳',
    'תשאיר', 'תמחק את זה', 'תוריד את זה', 'בלי זמן', 'עוד שעה', 'הערב',
  ];
  eq('the exported list is exactly these', [...FIXED_LABELS].sort().join('|'),
    [...EXPECTED].sort().join('|'));
  for (const label of EXPECTED) {
    const v = validate(`תגיד לי "${label}" ואני משחרר.`, bare(), 'נו?');
    check(`"${label}" is quotable`, v.ok, JSON.stringify(v));
  }

  // The labels are a CLOSED list, not a licence to quote anything short.
  // Every one of these is the shape rule 3 exists for: a task named in quotes
  // that no row anywhere holds.
  for (const invented of ['ללכת לרופא', 'להוציא את הכלב', 'לשלם את הארנונה']) {
    const v = validate(`מה עם "${invented}"?`, bare(), 'נו?');
    check(`"${invented}" is still an invented task`, !v.ok, JSON.stringify(v));
  }
}

// ---------------------------------------------------------------------------
section('the labels do not become a wildcard for anything containing one');
//
// The prose branch of rule 3 matches one direction — a known entry may CONTAIN
// the quote — so a short allow-list entry is exactly the wildcard risk
// validate.ts already warns about ("reason = חתול swallows any longer quote").
// "מחר" is two letters and appears inside a great many real sentences.
//
// NO CLAIM VERB in the sentence. The first draft was 'קבעתי את "..." ל-8', and
// it passed against a bidirectional prose match — because rule 2 rejected it
// for the bare "קבעתי" long before rule 3 was reached. It was asserting that
// rule 2 works.
{
  const v = validate('מה עם "מחר בבוקר ללכת למוסך"?', bare(), 'נו?');
  check('a longer quote that merely starts with a label is still rejected',
    !v.ok, JSON.stringify(v));
}

// ---------------------------------------------------------------------------
section('the rule still catches what it was written for');
//
// rejections #2 and #3 — the phantom task the synthetic "(המשך)" turn produced.
// The root cause is fixed (brain.speak no longer hands the model a word he
// could have typed), but the rule that caught it has to keep working.
{
  const v = validate(
    'שיטת ה"המשך" זו הימנעות קלאסית של עצלנים מקצועיים.',
    bare(),
    'נו? יש משהו פתוח.',
  );
  eq('the (המשך) phantom is still rejected', v.ok, false);
}

done();
