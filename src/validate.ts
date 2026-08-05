import type { Facts } from './types';

export interface Verdict {
  ok: boolean;
  reason?: string;
}

/**
 * Words that assert a database write happened. If nothing was written this turn,
 * none of them may appear. This is the single most important rule in the file:
 * a bot that says "רשמתי" when it did not is worse than a bot that says nothing.
 */
const CLAIM = /רשמתי|קבעתי|שמתי|נקבע|נשמר|תזכורת נוצרה|סידרתי/;

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
 */
export function validate(text: string, facts: Facts): Verdict {
  const allowedTimes = new Set(facts.times.map(normTime));
  for (const m of text.match(CLOCK) ?? []) {
    if (!allowedTimes.has(normTime(m))) {
      return { ok: false, reason: `invented time ${m} (allowed: ${[...allowedTimes].join(', ') || 'none'})` };
    }
  }

  if (!facts.wrote && CLAIM.test(text)) {
    return { ok: false, reason: `claimed a write with no effect (${CLAIM.exec(text)?.[0]})` };
  }

  const allowedTitles = facts.titles.map((t) => t.trim());
  for (const m of text.matchAll(QUOTED)) {
    const quoted = m[1].trim();
    const known = allowedTitles.some((t) => t.includes(quoted) || quoted.includes(t));
    if (!known) return { ok: false, reason: `invented task "${quoted}"` };
  }

  return { ok: true };
}
