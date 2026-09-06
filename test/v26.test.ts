/**
 * Run with `npm run test:v26`.
 *
 * The model ladder, re-verified against the published free-tier list on
 * 06.09.2026 — and the thing that verification found.
 *
 * `wrangler.toml` was corrected in 0.16.2, after 3.7 and 3.6 each burned the
 * full 12s per-call timeout and cost two reminders. `DEFAULT_LADDER` in
 * gemini.ts was NOT, and it is the ladder any deployment without
 * GEMINI_MODEL/GEMINI_MODELS actually walks. It still led with
 * `gemini-3.7-flash`, under a comment reading "the free-tier models, best
 * first" — the revert applied to one of the two places that say what the
 * ladder is.
 *
 * That is the `CLAIM` / `CLAIM_GROUPS` shape from 0.19.0 one more time: two
 * lists that must agree, only one of which anybody edits. The guard below is
 * therefore not "the ladder contains X" — it is that the two lists produce
 * THE SAME LADDER, so editing either alone is red.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { modelLadder } from '../src/gemini';
import { check, done, eq, section } from './harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const toml = readFileSync(join(HERE, '..', 'wrangler.toml'), 'utf8');
const readVar = (name: string) =>
  new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];

/** What production walks. */
const configured = modelLadder({
  GEMINI_MODEL: readVar('GEMINI_MODEL'),
  GEMINI_MODEL_FALLBACK: readVar('GEMINI_MODEL_FALLBACK'),
  GEMINI_MODELS: readVar('GEMINI_MODELS'),
} as any);

/** What a deployment with none of those vars set walks. */
const fallback = modelLadder({} as any);

// ===========================================================================
section('the two places that define the ladder define the same ladder');
//
// Not set-equality. ORDER, because order is the whole of what 0.16.2 fixed:
// the old DEFAULT_LADDER held all four of the right models and led with the
// wrong one.
{
  eq(
    'DEFAULT_LADDER and wrangler.toml agree, rung for rung',
    fallback.join(' · '),
    configured.join(' · '),
  );
  check(
    `and it leads with the model that was measured fast — ${fallback[0]}`,
    fallback[0] === 'gemini-3.5-flash',
    fallback.join(' · '),
  );
}

// ---------------------------------------------------------------------------
section('the ladder is as deep as the free tier is wide');
//
// Verified against ai.google.dev/gemini-api/docs/models and the pricing page
// on 06.09.2026: eight Flash / Flash-Lite ids are published with a free tier.
// Four of them were configured. The free tier meters requests per minute PER
// MODEL against one key, so the four that were missing were not redundancy
// sitting idle — they were capacity that did not exist.
{
  const free = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ];
  for (const m of free) {
    check(`${m} is a rung`, configured.includes(m), configured.join(' · '));
  }
  check('every rung is distinct', new Set(configured).size === configured.length,
    configured.join(' · '));
}

// ---------------------------------------------------------------------------
section('a newer model is not thereby a better one');
//
// The 0.16.2 lesson, written so it survives the next release rather than
// naming a version family. `gemini-3.8-flash` is the highest number on the
// list and the docs describe it as built for "long-horizon software
// engineering" — a thinking model, which is the 18.9-second failure mode this
// bot has already paid for once. It is on the ladder as capacity, at the
// depth its measurement record justifies: none.
//
// Promote by measuring: deploy low, read /diag and `usage`, then move it up.
{
  const rank = (m: string) => Number(/gemini-(\d+\.\d+)/.exec(m)?.[1] ?? 0);
  const newest = [...configured].sort((a, b) => rank(b) - rank(a))[0];
  check(
    `the newest id on the ladder does not lead it — ${newest} vs ${configured[0]}`,
    configured[0] !== newest,
    configured.join(' · '),
  );
  check(
    'the two rungs with a production record come before the four with none',
    configured.indexOf('gemini-3.7-flash') < configured.indexOf('gemini-3.1-flash-lite') &&
      configured.indexOf('gemini-3.6-flash') < configured.indexOf('gemini-3.8-flash'),
    configured.join(' · '),
  );
  // The 2.5 pair 404'd in production on 19.08.2026 and were deleted for it.
  // The published list says they are free-tier today, so they are back — LAST,
  // because a previous 404 is evidence and a docs page is only a claim. If
  // they 404 again, blockFor writes them off for six hours and /diag names
  // them, which is the whole reason a stale id here is cheap.
  check(
    'the two that 404\'d in August sit at the bottom',
    configured.indexOf('gemini-2.5-flash-lite') >= configured.length - 2 &&
      configured.indexOf('gemini-2.5-flash') >= configured.length - 2,
    configured.join(' · '),
  );
}

done();
