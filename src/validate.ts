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
 */
export const CLAIM =
  /רשמתי|קבעתי|שמרתי|שמתי לך|נקבע|נשמר|תזכורת נוצרה|קלטתי|סימנתי|סגרתי(?!\s*(?:איתו|איתה|איתם|איתן|עם)(?![א-ת]))|(?<!לא\s)סיימתי|עדכנתי|הזזתי|דחיתי|העברתי|ביטלתי|מחקתי/;

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
  {
    name: 'create',
    verbs: /רשמתי|קבעתי|שמרתי|שמתי לך|נקבע|נשמר|תזכורת נוצרה|קלטתי/,
    kinds: new Set<Effect['kind']>([
      'reminder_created', 'friend_reminder_created', 'reminder_captured',
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
    verbs: /סימנתי|סגרתי(?!\s*(?:איתו|איתה|איתם|איתן|עם)(?![א-ת]))|(?<!לא\s)סיימתי/,
    // `gave_up` earns its place here by the CLAIM invariant, not by taste:
    // voice.ts words it "סגרתי את X ככישלון", so without it the deterministic
    // baseline would fail its own validator. The every-kind loop in
    // test/validate.test.ts is what catches that.
    kinds: new Set<Effect['kind']>([
      'instance_done', 'item_done', 'goal_closed', 'photo_accepted', 'instance_skipped',
      'gave_up',
    ]),
  },
  {
    name: 'update',
    verbs: /עדכנתי/,
    kinds: new Set<Effect['kind']>(['goal_progress', 'reminder_annotated']),
  },
];

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
const ELAPSED_AFTER = /^\s*(?:אתה|את)(?![א-ת])/;

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
    const knownProse = facts.quotable.some((q) => normQuote(q).includes(quoted));
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
    if (!ELAPSED_BEFORE.test(hit.before) && !ELAPSED_AFTER.test(hit.after)) continue;
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

  return { ok: true };
}
