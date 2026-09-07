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
  ];
  for (const m of free) {
    check(`${m} is a rung`, configured.includes(m), configured.join(' · '));
  }

  /*
   * The 2.5 pair are NOT rungs, and this assertion is the one that changed.
   *
   * It used to require them, on the strength of the published free-tier list
   * on 06.09.2026. `/models` asked them directly on 08.09.2026 and both
   * answered `404 — This model ... is no longer available`. That is the whole
   * of what 0.26.0 predicted: "a previous 404 is evidence and a docs page is
   * only a claim… if they are still dead, /diag names them."
   *
   * Asserted as an ABSENCE so putting them back needs a deliberate edit here
   * as well, with something better than a listing behind it.
   */
  for (const dead of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
    check(`${dead} is retired and off the ladder`, !configured.includes(dead),
      configured.join(' · '));
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
  // Every rung is one that has ANSWERED, which is the state this whole file
  // was arguing towards. The 2.5 pair were the last two that had not, and
  // /models settled them on 08.09.2026 — see the absence check above.
  check(
    'nothing on the ladder is a known-retired id',
    !configured.some((m) => m.startsWith('gemini-2.5')),
    configured.join(' · '),
  );
}

done();
