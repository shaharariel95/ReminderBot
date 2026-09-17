import { FIXED_LABELS } from './buttons';
import { PROMPT_LABELS } from './persona';
import type { Effect, Facts } from './types';
import { UNTITLED_TITLE, WROTE } from './types';
import { scanDurations } from './quickparse';

export interface Verdict {
  ok: boolean;
  reason?: string;
}

/**
 * Words that assert a database write happened. If nothing was written this turn,
 * none of them may appear. This is the single most important rule in the file:
 * a bot that says "רשמתי" when it did not is worse than a bot that says nothing.
 *
 * Invariant: no verb here may be one that voice.ts emits for an effect kind
 * that is absent from WROTE (types.ts) — otherwise the deterministic baseline
 * would fail its own validator. "שמתי" is deliberately scoped to "שמתי לך"
 * (not bare) so it doesn't fire on "שמתי לב ..." (I noticed ...); "סידרתי" is
 * dropped entirely because it collides with ordinary chat ("סידרתי לך את
 * הבלגן"). "רשמתי" already contains "שמתי" as a substring, so the common
 * claim form is still caught.
 *
 * persona.ts rule 2 ("אמת לפני אופי") states the same active/passive
 * claim-of-write principle in prose, so the model has a prompt-side reason
 * not to attempt a rewrite this lexicon will discard. If this regex changes,
 * check whether that rule's examples still cover it.
 *
 * Two additions in 0.19.0, both of them claims this lexicon could not see
 * because it only knew how to hear the bot talk about ITSELF, in the singular:
 *
 *   סגרנו על / סיכמנו — first person PLURAL. "סגרנו על #75" shipped on
 *   03.09.2026 over an inbox capture with no time and no title, immediately
 *   followed by the baseline's own "אבל על מה להזכיר לך ובאיזו שעה בדיוק?".
 *   One message that both agreed an appointment and admitted it did not know
 *   what or when. Anchored to "על" because bare "סגרנו" is how two people
 *   settle anything ("סגרנו שאתה מביא").
 *
 *   סגרת / סיימת — SECOND person. A claim about what he did is a claim about
 *   the database exactly as much as a claim about what the bot did: chat B,
 *   30.08.2026 20:01, "יפה שסגרת את זה מוקדם" over a `no_open_task` baseline —
 *   praise for closing something that was still open, and #68 fired
 *   twenty-four minutes later. Both carry the same `(?<!לא\s)` the first
 *   person forms do, because "לא סגרת את זה" is the opposite of a claim, and a
 *   trailing `(?![א-ת])` so "סגרת" cannot swallow "סגרתי".
 *
 * And note which second-person verbs are deliberately NOT here. "דחית" and
 * "ביטלת" and "קבעת" describe standing state as readily as they describe this
 * turn — "דחית את X 6 מתוך 7 הפעמים האחרונות" is `pattern_pushed`'s own
 * baseline, word for word, and it is TRUE about history while nothing was
 * written. That asymmetry is the whole reason the first-person forms are safe
 * and their twins are not: the bot can only vouch for what it did just now,
 * and only a close is an event this turn can be sure it owns.
 *
 * The residual cost is accepted with eyes open: "כבר סגרת את זה" about
 * something he closed an hour ago is true, and will now be discarded in favour
 * of the plainer baseline. A true sentence lost to a plainer true sentence is
 * a worse outcome than nothing and a much better one than a phantom
 * confirmation, which is the trade rule 2 exists to make.
 */
/**
 * The same verbs, grouped by WHICH write they assert — and which effects can
 * back each group up.
 *
 * Rule 2 used to ask only whether *something* had been written. On 14.08.2026
 * that let the bot say "הזזתי את ... ל-15:00" about a row it had just CREATED:
 * a write had happened, so the claim passed, and the message described an
 * operation that never took place. "I moved it" and "I made a new one" are
 * different claims about the database, and a user acting on the wrong one goes
 * looking for a reminder that is not where he was told it is.
 *
 * The invariant from CLAIM extends here: no verb may sit in a group whose
 * `kinds` excludes the effect voice.ts emits it for, or the deterministic
 * baseline fails its own validator. `test/validate.test.ts` renders every
 * sample and checks exactly that, which is what makes this safe to edit.
 */
const CLAIM_GROUPS: { name: string; verbs: RegExp; kinds: ReadonlySet<Effect['kind']> }[] = [
  /*
   * The create group was ONE group until 0.19.0, and holding "רשמתי" and
   * "קבעתי" as interchangeable is what licensed "סגרנו על #75" over a row
   * that had neither a time nor a title.
   *
   * Writing something down and scheduling it are different claims about the
   * database, in exactly the way "I moved it" and "I made a new one" are —
   * which is the split this whole structure exists to express. An inbox
   * capture IS written down; it is not set. The reply that shipped agreed an
   * appointment in one sentence and asked what the errand was in the next.
   */
  {
    name: 'noted',
    verbs: /רשמתי|קלטתי|שמרתי|נשמר/,
    kinds: new Set<Effect['kind']>([
      'reminder_created', 'friend_reminder_created', 'reminder_captured',
      'reminder_scheduled', 'reminder_annotated', 'goal_created', 'profile_noted',
      /*
       * A mute is a write — `muted` has been in types.WROTE since it existed —
       * and it was in no group here, so the one verb that fits it had no kind
       * to stand on. Production `rejections` #16, 07.09.2026 21:00, over
       * `instance_done, muted`:
       *
       *   רשמתי. שקט עד מחר ב-12:00.
       *   לילה טוב.
       *
       * True in both sentences. `instance_done` sits in the close group, so
       * the turn had a write and a verb for it, and still lost the message:
       * rule 2 is per-KIND, and the kind he was actually being told about was
       * in no group at all. It belongs with `noted` rather than `scheduled` —
       * a mute is recorded, not put on a clock.
       */
      'muted',
    ]),
  },
  {
    name: 'scheduled',
    /*
     * "נקבע" not after "ש", and the record is production `rejections` #21,
     * 16.09.2026 21:34 — the last message he got:
     *
     *   כרטיס לחתונה של אופיר ירד להיום.
     *   רוצה שנקבע את זה למחר או שאתה נותן לזה לברוח?
     *
     * — refused for `claimed a scheduled ("נקבע")` over a `gave_up`. It is an
     * OFFER. "נקבע" is two words sharing a spelling: the passive "it was set"
     * IS a claim about a row, and the first-person plural "let's set" is a
     * question, which asserts nothing and is the one thing that might have
     * moved a task nobody had touched in three days. He got the flat baseline
     * instead.
     *
     * "ש" is the discriminator and the only one there is — a subordinating
     * prefix puts the verb inside a proposal ("רוצה ש…", "אולי ש…"). The
     * residual cost is a claim phrased "סגרנו שנקבע ל-8", which nobody says.
     * Scoped exactly like "שמתי לך" against "שמתי לב": this is a lexicon of
     * claims about the DATABASE, and the surrounding word is what decides.
     */
    verbs: /קבעתי|שמתי לך|(?<!ש)נקבע|תזכורת נוצרה|סגרנו\s+על|סיכמנו/,
    // reminder_captured is deliberately ABSENT. Everything else that was in
    // the old create group stays: a goal, a note and an annotation are all
    // things it is fair to say were "set", and narrowing those would discard
    // true sentences for no gain.
    kinds: new Set<Effect['kind']>([
      'reminder_created', 'friend_reminder_created',
      'reminder_scheduled', 'reminder_annotated', 'goal_created', 'profile_noted',
    ]),
  },
  {
    name: 'move',
    verbs: /הזזתי|דחיתי|העברתי/,
    // reminder_scheduled belongs here too: giving an inbox item its first time
    // is as fairly described as a move as it is as a create.
    kinds: new Set<Effect['kind']>([
      'reminder_retimed', 'instance_snoozed', 'reminder_scheduled',
    ]),
  },
  {
    name: 'delete',
    verbs: /ביטלתי|מחקתי/,
    kinds: new Set<Effect['kind']>(['reminder_deleted', 'goal_closed', 'profile_forgotten']),
  },
  {
    name: 'close',
    /**
     * This group held "סימנתי" alone until 19.08.2026, and that is not how
     * anybody says it. On 18.08 at 08:57 he typed "ללכת למוסך ב10:30", the
     * router returned a RESCHEDULE, voice.ts said "שיניתי. #52 ... ב-10:30",
     * and the persona shipped "סגרתי #52 ב-10:30" — a move reported as a
     * close, straight past this rule. /list twenty seconds later showed #52
     * open at 10:30.
     *
     * The blind spot was self-inflicted: voice.ts's own close wordings are
     * "נסגר" (instance_done) and "סגרתי" (gave_up), so the verb the persona
     * was most likely to reach for was the one verb the lexicon could not see.
     *
     * Both additions are scoped, for exactly the reason "שמתי לך" is scoped
     * away from "שמתי לב": this is a lexicon of claims about the DATABASE.
     *
     *   "סגרתי איתו שיביא מחר"  — I arranged it with him. Not a write.
     *   "ולא סיימתי את זה"      — I did NOT finish. The opposite of a claim.
     *
     * The second one is not hypothetical: it is voice.TURN_FAILED, word for
     * word. An unscoped "סיימתי" made the deterministic baseline fail its own
     * validator, and the every-kind loop in test/validate.test.ts caught it
     * within a minute of the verb being added — which is what that loop is
     * for. Missing a lie is the acceptable failure here; killing a true
     * sentence, and especially killing the one sentence that ships when
     * everything else has already gone wrong, is not.
     */
    /*
     * The second-person forms sit here for the same reason their first-person
     * twins do — "יפה שסגרת" asserts a close, whoever is credited with it —
     * and carry the same scoping: not after "לא", and not swallowing "סגרתי".
     *
     * And not after a LENGTH OF TIME, which is 0.36.1 and cost three
     * messages in four days. Production `rejections` #18, #19 and #20,
     * 11.09 and 14.09 twice, every one of them `claimed a write with no
     * effect (סגרת)`:
     *
     *   חצי דקה וסגרת את זה.
     *   חמש דקות וסגרת את זה.
     *   שתי דקות עבודה וסגרת את זה.
     *
     * Hebrew puts the future perfect in the past tense: "five minutes and
     * you're done with it" is a promise about the next five minutes, not a
     * report about the last. It is also, word for word, what persona.ts asks
     * the nag ladder to produce — end on one concrete action and how little
     * it costs — so this is the rule refusing the house style, three times,
     * silently, in the messages whose whole job is to be small enough to act
     * on.
     *
     * Anchored to a time unit rather than to the bare "ו", because "דיברנו
     * וסגרת את זה" is a report and still has to be refused. Up to two words
     * may sit between the unit and the verb ("שתי דקות עבודה ו…"); more than
     * that and the two halves are no longer one clause.
     */
    verbs:
      /סימנתי|סגרתי(?!\s*(?:איתו|איתה|איתם|איתן|עם)(?![א-ת]))|(?<!לא\s)סיימתי|(?<!לא\s)(?<!(?:דקה|דקות|שניה|שנייה|שניות|רגע|שעה|שעות)(?:\s+\S+){0,2}\s+ו)(?:סגרת|סיימת)(?!\s*(?:איתו|איתה|איתם|איתן|עם)(?![א-ת]))(?![א-ת])/,
    // `gave_up` earns its place here by the CLAIM invariant, not by taste:
    // voice.ts words it "סגרתי את X ככישלון", so without it the deterministic
    // baseline would fail its own validator. The every-kind loop in
    // test/validate.test.ts is what catches that.
    kinds: new Set<Effect['kind']>([
      'instance_done', 'item_done', 'goal_closed', 'photo_accepted', 'instance_skipped',
      'gave_up',
      // Same reason as `gave_up`, one verb later: voice.ts words the close-out
      // "סגרת N היום", so the moment the second-person forms joined this group
      // the deterministic baseline failed its own validator — caught, within a
      // minute, by the every-kind loop in test/validate.test.ts.
      //
      // It is not a fudge to keep it green. A close-out is BUILT from the
      // day's closed instances; a turn that is reporting them is exactly a
      // turn entitled to use close verbs. The failure this rule was widened
      // for ("יפה שסגרת את זה מוקדם") happened over `no_open_task`, where
      // nothing of the kind is in play.
      'evening_closeout',
      // The bot really did close a ring. Without this, a persona that says
      // "סגרתי את הצלצול הקודם" over a true supersede is discarded.
      'instance_superseded',
    ]),
  },
  {
    name: 'update',
    verbs: /עדכנתי/,
    kinds: new Set<Effect['kind']>(['goal_progress', 'reminder_annotated']),
  },
];

/**
 * Every claim verb there is, as one regex — DERIVED from the groups above
 * rather than written out beside them.
 *
 * It used to be a hand-maintained twin, and the note on it said so outright:
 * `validate()` does not read this, it reads CLAIM_GROUPS, so a verb added
 * here alone is a fix that does nothing and reads in review as though it did.
 * That was demonstrated rather than assumed — deleting the 0.19.0 additions
 * from the twin left the whole suite green. CLAUDE.md lists it under "one
 * question, one implementation", which is an invariant this file was violating
 * in its own second paragraph.
 *
 * Deriving it costs nothing and closes that: the two can no longer disagree,
 * and 0.36.1's three scopings are written once. Nothing in `src/` consults it
 * — it is the documented lexicon and a test fixture (test/v08.test.ts) — so
 * the union is exactly as strict as the groups are, verb for verb.
 */
export const CLAIM = new RegExp(CLAIM_GROUPS.map((g) => g.verbs.source).join('|'));

const CLOCK = /\b\d{1,2}:\d{2}\b/g;
const QUOTED = /"([^"\n]{2,80})"/g;

/**
 * Rules 1 to 4 all ask the same question — did the model INVENT this? — and
 * that question has a blind side. A rewrite that says LESS than the baseline
 * passes every one of them, because it asserts nothing.
 *
 * Production, 23.08.2026 08:30:54. Event 139 records `הוזזה` on reminder 61:
 * "ללכת למוסך" really was moved to 09:00. What shipped was
 *
 *   חצי שעה? מה קרה, האוטו צריך הפסקת קפה?
 *   תפתח את הדלת של האוטו, משם נמשיך.
 *
 * No hour, no confirmation, no rejection. He had asked to push it half an
 * hour, he believed he had snoozed it, and the row had in fact been
 * rescheduled — a fact he was never told and could only have found in /list.
 *
 * The two rules below are the other direction: not "may the model say this"
 * but "may the model leave this out". Both are floors, deliberately low. The
 * persona's whole job is to reword, and a rule that demanded fidelity would
 * discard good writing — which costs more than it saves, because a discarded
 * rewrite is invisible except as a counter in /diag.
 */

/** Words worth requiring: short ones ("את", "לי") carry no identity. */
function contentWords(s: string): string[] {
  return s
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
}

/**
 * Does `text` name this errand at all?
 *
 * ONE shared word is the bar, not the whole title. Production message #545 is
 * a good rewrite of the title "לקחת תרופה":
 *
 *   נו, לקחת את התרופה? שלוק מים וסגרנו.
 *
 * — the title is not a substring of it (he wrote "את ה" into the middle), and
 * "רעמוו נשק במאי, להיום" had a junk word in it that the persona was right to
 * drop. Requiring every word would have discarded both. Requiring one catches
 * the thing that actually went wrong: a message that fires a reminder and
 * shares nothing whatsoever with the errand it is supposedly about.
 */
function mentions(text: string, titles: string[]): boolean {
  return titles.some((t) => contentWords(t).some((w) => text.includes(w)));
}

/**
 * When a length of time is a CLAIM about how long something has been going,
 * rather than a figure of speech.
 *
 * This distinction is the whole rule, and it has to be drawn narrowly. The
 * persona is rhetorical about durations by design — "רק תרים שיחה של חצי
 * דקה", "חמש דקות ואתה בחוץ", "עוד חצי שעה אני פה שוב" are all good lines
 * from the same transcript that produced the bug this rule exists for, and
 * not one of them asserts anything. A rule that discards those costs more
 * than the lie it prevents, so only two frames count:
 *
 *   כבר / עברו / מזה   before the phrase — unambiguously "it has been X"
 *   אתה / את           straight after it  — "שעה וחצי אתה גורר את הטלפון"
 *
 * The second is deliberately spelled without a ו: "חמש דקות ואתה בחוץ" is a
 * consequence, "שעה וחצי אתה גורר" is an accusation, and that one letter is
 * the only thing separating them. Everything else is left alone. Missing a
 * lie is the acceptable failure here; killing a true sentence is not.
 */
const ELAPSED_BEFORE = /(?:כבר|עברו|מזה)\s*$/;
/*
 * Hebrew puts the marker AFTER the quantity at least as often as before it,
 * and until 0.19.0 only the "אתה" frame was here. The consequence was that
 * rule 4 fired essentially never — zero rejections in a month, against a
 * production nag that read "93 דקות שהיא פתוחה", which is the exact shape it
 * could not see. A safety rule that has quietly stopped running is worse than
 * one that was never written, because it is counted.
 *
 * Both additions are as unambiguous as the frames already here. "X עברו" is
 * "X passed" and nothing else; "X שזה פתוח" is "X that it has been open".
 * Everything vaguer is still left alone — "קח 90 דקות" is not an accusation,
 * and killing it would cost a true sentence to catch nothing.
 */
const ELAPSED_AFTER = /^\s*(?:אתה|את|עברו|עברה|עבר)(?![א-ת])/;
/** "…שזה פתוח", "…שהיא פתוחה" — the openness predicate, spelled out rather
 *  than approximated as ש+anything, which would swallow "90 דקות שיהיה לך". */
const ELAPSED_OPEN_AFTER =
  /^\s*ש(?:זה|היא|הוא|הם|הן)\s+(?:פתוח|פתוחה|פתוחים|פתוחות|מחכה|מחכים|תלוי|תלויה|תקוע|תקועה)/;

/**
 * The model is allowed to round. It is reading a wall clock and writing
 * Hebrew, not reporting a stopwatch, so "חצי שעה" for 31 minutes is true and
 * "שעה וחצי" for 30 is not. The floor of 10 minutes keeps short spans from
 * being held to an impossible standard; the 25% keeps long ones honest.
 */
function nearEnough(claimed: number, actual: number): boolean {
  return Math.abs(claimed - actual) <= Math.max(10, actual * 0.25);
}

/**
 * Fold away the punctuation a quote survives without.
 *
 * `rejections` #9, chat B, 23.08.2026. He typed
 *
 *   ...תזכיר לי עוד 'שעה בערך
 *
 * — a stray apostrophe, almost certainly a slipped keystroke. The persona
 * quoted him back cleanly as "עוד שעה בערך" and rule 3 scored it an invented
 * task, because facts.quotable was compared with a raw `includes`. What was
 * discarded was a GOOD rewrite: it pushed back on a vague time and asked for a
 * real one, and he got the flat baseline instead.
 *
 * Only quote marks, apostrophes, the Hebrew geresh/gershayim and runs of
 * whitespace are folded. Letters, digits and every other character still have
 * to match, so a task nobody mentioned is as invented as it ever was.
 */
function normQuote(s: string): string {
  return s.replace(/["'`״׳]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Is this reply the PROMPT rather than an answer to it?
 *
 * Two shapes, and they are two because the 14.09.2026 leak had two halves and
 * only one of them quotes anything (persona.PROMPT_LABELS has the transcript):
 *
 *   - a line that opens with one of the prompt's own section labels, used as a
 *     LABEL — followed by a colon, a dash, or nothing else on the line. The
 *     anchoring is what keeps "מה שקרה עכשיו" usable as the ordinary Hebrew
 *     phrase it also is: a sentence puts it in the middle, a heading puts it
 *     at the start and then stops.
 *
 *   - a bulleted LIST. The "הנחיות:" half echoed no heading — the model coined
 *     that word itself — so the only thing that gives it away is that it is a
 *     document. persona.ts tells it "בלי כותרות, בלי בולטים, בלי מספור" and
 *     voice.ts writes every list it has with "·", so an ASCII bullet is never
 *     something either end of this pipeline produces.
 *
 *     TWO of them, not one. A single "- " line is a dash in ordinary Hebrew
 *     prose and refusing it would cost whole rewrites for punctuation; two is
 *     already a list and no longer a WhatsApp message.
 *
 *     One known cost, accepted: persona.ts renders his profile notes as "- x"
 *     lines, so a rewrite that reads two of them back as a list is refused.
 *     That rewrite was already breaking "בלי בולטים" and the baseline it loses
 *     to is true — which is the trade the whole file makes.
 *
 * Markdown headings ("## …") are caught by the same bullet scan on purpose —
 * `#` is excluded from it, because voice.ts opens lines with "#80" and a
 * reminder id is not a heading. A hash followed by a SPACE is, and nothing
 * here writes one.
 */
const BULLET_LINE = /^[ \t]*(?:[-*•]|#{1,6})[ \t]+\S/gmu;

function scaffolding(text: string): string | null {
  for (const label of PROMPT_LABELS) {
    // Escaped for the same reason FIXED_LABELS is matched literally: these are
    // prose strings from another file and one of them growing a "(" one day
    // must not turn into a regex that throws inside the send path.
    const re = new RegExp(`^[ \\t]*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*(?:[:：—–-]|$)`, 'mu');
    if (re.test(text)) return `heading "${label}"`;
  }
  const bullets = text.match(BULLET_LINE);
  if (bullets && bullets.length >= 2) return `${bullets.length} bullet lines`;
  return null;
}

/** Normalise "7:05" and "07:05" to the same key. */
function normTime(s: string): string {
  const [h, m] = s.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

/**
 * Check model output against what actually happened. A failure is not an error —
 * the caller ships the deterministic baseline instead and logs the reason.
 *
 * `baseline` is this turn's deterministic Hebrew (see voice.ts). It is true by
 * construction — including things that aren't facts at all, like the format
 * example "כמו 19:30" in the bad_time reply — so anything it says is folded
 * into the allow-lists too. Without this, the validator could reject the very
 * text it is supposed to fall back to.
 *
 * CLOCK and QUOTED are /g regexes; `.match`/`.matchAll` are used everywhere
 * (never a bare `.exec` loop shared across calls) so a stale `lastIndex` can
 * never make one of the two scans silently skip matches.
 */
export function validate(text: string, facts: Facts, baseline: string): Verdict {
  // Rule 8, and it runs first because it is not a question about facts at all:
  // is this a chat message, or is it the prompt coming back? See
  // persona.PROMPT_LABELS for the two messages that bought it. Deliberately
  // NOT folded against the baseline the way rules 1, 3 and 4 are — voice.ts
  // never writes a heading and never writes a bullet list, so there is nothing
  // here a true baseline could legitimise.
  const scaffold = scaffolding(text);
  if (scaffold) return { ok: false, reason: `wrote the prompt back (${scaffold})` };

  const allowedTimes = new Set(facts.times.map(normTime));
  for (const m of baseline.match(CLOCK) ?? []) allowedTimes.add(normTime(m));

  for (const m of text.match(CLOCK) ?? []) {
    if (!allowedTimes.has(normTime(m))) {
      return { ok: false, reason: `invented time ${m} (allowed: ${[...allowedTimes].join(', ') || 'none'})` };
    }
  }

  // Rule 2, per KIND of write rather than merely "a write happened". A turn
  // that wrote nothing fails every group, so the original rule is subsumed.
  const kinds = new Set(facts.effects.map((e) => e.kind));
  for (const group of CLAIM_GROUPS) {
    const hit = group.verbs.exec(text);
    if (!hit) continue;
    if ([...group.kinds].some((k) => kinds.has(k))) continue;
    return {
      ok: false,
      reason: facts.wrote
        ? `claimed a ${group.name} ("${hit[0]}") but the turn did: ${[...kinds].join(', ')}`
        : `claimed a write with no effect (${hit[0]})`,
    };
  }

  const allowedTitles = facts.titles.map((t) => t.trim());
  for (const m of baseline.matchAll(QUOTED)) allowedTitles.push(m[1].trim());

  for (const m of text.matchAll(QUOTED)) {
    const quoted = normQuote(m[1]);
    // Titles: bidirectional, because the model legitimately shortens/lengthens them.
    const knownTitle = allowedTitles.some(
      (raw) => {
        const t = normQuote(raw);
        return t.includes(quoted) || quoted.includes(t);
      },
    );
    // Prose (reasons, notes, the user's own words): one direction only. These are
    // never paraphrased, so letting `quoted` be the longer side would turn a short
    // entry like reason = "חתול" into a wildcard that swallows any longer quote.
    //
    // FIXED_LABELS is folded in here rather than in facts.ts because it is not a
    // fact about this turn — it is a property of the validator, like `baseline`
    // above, and it has to hold for every caller rather than only for the ones
    // that went through buildFacts. See buttons.ts for why a button label cannot
    // be an invented task, and `rejections` #6 for what it cost.
    const knownProse = [...facts.quotable, ...FIXED_LABELS].some(
      (q) => normQuote(q).includes(quoted),
    );
    if (!knownTitle && !knownProse) return { ok: false, reason: `invented task "${quoted}"` };
  }

  // Same fold as the two rules above: whatever voice.ts already said is true
  // by construction, so a duration it stated may be echoed back regardless of
  // how the model frames it.
  // facts.elapsed is the WAKING span (facts.ts discounts quiet hours). The raw
  // span rides alongside it here and only here: it is equally true, the model
  // can derive it from fired_at in openSummary, and rejecting a rewrite for
  // saying something true costs the whole message.
  const allowedElapsed = [
    ...facts.elapsed,
    ...facts.elapsedRaw,
    ...scanDurations(baseline).map((d) => d.minutes),
  ];

  for (const hit of scanDurations(text)) {
    if (
      !ELAPSED_BEFORE.test(hit.before) &&
      !ELAPSED_AFTER.test(hit.after) &&
      !ELAPSED_OPEN_AFTER.test(hit.after)
    ) {
      continue;
    }
    if (!allowedElapsed.some((actual) => nearEnough(hit.minutes, actual))) {
      return {
        ok: false,
        reason: `invented elapsed time ${hit.minutes}m (actual: ${
          allowedElapsed.length ? allowedElapsed.map((m) => `${m}m`).join(', ') : 'nothing is open'
        })`,
      };
    }
  }

  // Rule 5 — a MOVE may not drop the hour it moved to.
  //
  // Deliberately not every write. On a create the operation is legible without
  // the clock ("קבעתי #64") and rule 2 already guarantees a create really
  // happened; on a delete or a close there is no hour to state. A move is the
  // one case where the new time IS the entire content of the confirmation —
  // the row existed before and exists after, and the only thing that changed
  // is the number he was not told.
  //
  // Any of the baseline's own times satisfies it, so the persona may say
  // "מ-08:30 ל-09:00" or just "ל-09:00" as it prefers.
  const MOVED: ReadonlySet<Effect['kind']> = new Set<Effect['kind']>([
    'reminder_retimed', 'instance_snoozed',
  ]);
  if (facts.effects.some((e) => MOVED.has(e.kind) && WROTE.has(e.kind))) {
    const stated = (baseline.match(CLOCK) ?? []).map(normTime);
    if (stated.length && !(text.match(CLOCK) ?? []).map(normTime).some((t) => stated.includes(t))) {
      return { ok: false, reason: `dropped the hour it wrote (${stated.join(', ')})` };
    }
  }

  // Rule 6 — a reminder that FIRES must name the errand.
  //
  // The fire is the message that has to stand on its own: it is the first
  // thing he hears about this errand in this instance, and one that does not
  // say what to do has sent him to go and look it up.
  //
  // Nags are deliberately NOT covered, and the reason is Hebrew rather than
  // taste. A nag is a follow-up inside a thread he is already in, so it refers
  // back rather than repeating — production, 20.08.2026 13:02, against the
  // title "לנקות פילטרים למזגנים":
  //
  //   נו? רק להרים את הפלסטיק של המזגן מעל הראש שלך. אל תסתכל עליו.
  //
  // — a good nag that shares no whole word with the title (המזגן/למזגנים,
  // תנקה/לנקות). Substring matching cannot see through a prefix and a plural,
  // and a rule that discarded that would cost more than the lie it prevents.
  // The nag half of this failure is closed at its root instead, in brain.speak.
  //
  // Untitled reminders are skipped — voice.ts words those "ביקשת שאזכיר לך
  // משהו עכשיו. לא אמרת מה", which has no errand in it to require. Items count
  // alongside the title, because a multi-errand fire renders as the checklist
  // and the persona may reasonably speak to that instead.
  for (const e of facts.effects) {
    if (e.kind !== 'reminder_fired') continue;
    if (!e.title || e.title === UNTITLED_TITLE) continue;
    if (!mentions(text, [e.title, ...(e.items ?? []).map((i) => i.title)])) {
      return { ok: false, reason: `never named the errand ("${e.title}")` };
    }
  }

  /*
   * Rule 7 — a close-out that closed something must NAME something it closed.
   *
   * Production, 09.09.2026 21:00. One instance closed that day, at 10:09,
   * nothing else in play, so the baseline was "סגרת 1 היום. אין זנבות." What
   * shipped was
   *
   *   אוקיי, המשימה נסגרה.
   *   יש לך 39 ברצף. נחמד.
   *
   * — eleven hours after his last message, over an unnamed "המשימה", with the
   * baseline's own "היום" gone. Rules 1-4 have nothing to say: no time, no
   * quote, no number outside the allow-list, and `evening_closeout` is in the
   * close group's kinds because a close-out really is entitled to close verbs.
   * Rules 5 and 6 do not reach it either. It is the blind side those two were
   * written for, one effect kind further along — a rewrite that says LESS
   * asserts nothing checkable, and an unnamed close reads as a fresh
   * confirmation of a write that did not happen this turn.
   *
   * The obvious narrower version — require the name only when the rewrite uses
   * a close VERB — was rejected, and the production message is the argument:
   * it says "נסגרה", which is in no group here and would have to be added,
   * followed by the next inflection. issues.md §6 is about exactly that
   * treadmill. Requiring the identity instead needs no lexicon at all.
   *
   * The bar is `mentions`, the same one-shared-word floor rule 6 uses, and it
   * is satisfied by naming ANY of the day's closes — the persona is free to
   * pick the interesting one and to drop the rest, which the baseline itself
   * does past CLOSEOUT_NAMED. Untitled instances are skipped for the same
   * reason rule 6 skips them: there is no errand in "משהו שלא אמרת מה זה" to
   * require.
   */
  for (const e of facts.effects) {
    if (e.kind !== 'evening_closeout') continue;
    const named = e.done.map((i) => i.title).filter((t) => t && t !== UNTITLED_TITLE);
    if (!named.length) continue;
    if (!mentions(text, named)) {
      return { ok: false, reason: `close-out never named what it closed ("${named[0]}")` };
    }
  }

  return { ok: true };
}
