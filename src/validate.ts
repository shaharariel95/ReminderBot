import type { Facts } from './types';

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
const CLAIM = /רשמתי|קבעתי|שמתי לך|נקבע|נשמר|תזכורת נוצרה/;

const CLOCK = /\b\d{1,2}:\d{2}\b/g;
const QUOTED = /"([^"\n]{2,80})"/g;

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

  if (!facts.wrote && CLAIM.test(text)) {
    return { ok: false, reason: `claimed a write with no effect (${CLAIM.exec(text)?.[0]})` };
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

  return { ok: true };
}
