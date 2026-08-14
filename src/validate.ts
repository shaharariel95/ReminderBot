import type { Effect, Facts } from './types';
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
  /רשמתי|קבעתי|שמרתי|שמתי לך|נקבע|נשמר|תזכורת נוצרה|קלטתי|סימנתי|עדכנתי|הזזתי|דחיתי|העברתי|ביטלתי|מחקתי/;

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
      'reminder_created', 'reminder_captured', 'reminder_scheduled',
      'reminder_annotated', 'goal_created', 'profile_noted',
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
    verbs: /סימנתי/,
    kinds: new Set<Effect['kind']>([
      'instance_done', 'item_done', 'goal_closed', 'photo_accepted', 'instance_skipped',
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
    const quoted = m[1].trim();
    // Titles: bidirectional, because the model legitimately shortens/lengthens them.
    const knownTitle = allowedTitles.some((t) => t.includes(quoted) || quoted.includes(t));
    // Prose (reasons, notes, the user's own words): one direction only. These are
    // never paraphrased, so letting `quoted` be the longer side would turn a short
    // entry like reason = "חתול" into a wildcard that swallows any longer quote.
    const knownProse = facts.quotable.some((q) => q.includes(quoted));
    if (!knownTitle && !knownProse) return { ok: false, reason: `invented task "${quoted}"` };
  }

  // Same fold as the two rules above: whatever voice.ts already said is true
  // by construction, so a duration it stated may be echoed back regardless of
  // how the model frames it.
  const allowedElapsed = [...facts.elapsed, ...scanDurations(baseline).map((d) => d.minutes)];

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

  return { ok: true };
}
