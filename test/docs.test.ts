/**
 * Run with `npm run test:docs`.
 *
 * CLAUDE.md's pointers resolve to symbols that actually exist.
 *
 * The file was 1,285 lines of incident narrative and is now 524 lines of
 * rules, each ending in a pointer — `→ effects.titleFromHisWords` — to the
 * comment that carries the reasoning. That split is the fix for the file
 * having become a second, staler copy of the code comments: one question, one
 * implementation, applied to the documentation that lists that invariant as
 * enforced by nothing.
 *
 * But it trades one failure mode for another. A stale pointer is worse than a
 * stale paragraph: a paragraph that has drifted still reads as prose somebody
 * can weigh, while `→ db.recentlyDone` after a rename sends the next reader to
 * a symbol that is not there and looks like the file lying about its own
 * subject. Nothing else in this suite reads CLAUDE.md, so that drift would be
 * silent — which is the shape this repository has been bitten by often enough
 * to name it: patterns.ts producing zero rows for a month, GOAL_QUIET_AFTER
 * switched off permanently, the ladder inverted in DEFAULT_LADDER for nine
 * versions. A guarantee nobody counts is not a guarantee.
 *
 * Four pointers were already wrong the first time this ran by hand
 * (db.patternOffered, gemini.TURN_BUDGET_MS, patterns.patternFor,
 * types.Ambiguity), which is the argument for the file existing.
 *
 * Three checks, three distinct failures:
 *
 *   1. every pointer resolves            — the rename case
 *   2. extraction found pointers at all  — the vacuity case
 *   3. no token LOOKS like a pointer and silently is not — the typo case
 *
 * Check 2 is not ceremony. This whole file is `every()` over a list it built
 * itself, and `every()` over an empty list is true: a regex that stops
 * matching, or a renamed CLAUDE.md, would leave the suite green forever while
 * checking nothing. That is vacuity mode 7 from CLAUDE.md's own list — an
 * assertion that survives a change by ceasing to look at anything — and it is
 * the one this test is most likely to die of.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { check, done, section } from './harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const doc = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

/** The modules a pointer may name. Read off disk, so a new one needs no edit here. */
const MODULES = new Set(
  readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8') && // fail loudly if src/ moved
    [
      'brain', 'buttons', 'db', 'effects', 'facts', 'gemini', 'index',
      'patterns', 'persona', 'quickparse', 'slash', 'telegram', 'time',
      'types', 'validate', 'version', 'voice', 'when',
    ].filter((m) => existsSync(join(ROOT, 'src', `${m}.ts`))),
);

/**
 * Prose that has the shape of a pointer and is not one.
 *
 * Deliberately a closed list rather than a rule about which left-hand sides
 * look like modules, for the reason buttons.FIXED_LABELS is one: there is no
 * shape separating `rig.geminiHang` from `effects.applyIntent`. A closed list
 * is what makes check 3 able to say "this is a typo" instead of shrugging.
 */
const NOT_POINTERS = new Set([
  'ctx.waitUntil',          // the Workers runtime
  'AbortSignal.timeout',    // ditto
  'JSON.parse',             // the language
  'e.id',                   // a field on Effect, discussed as such
  'Context.inbox',          // a field on Context
  'ctx.open', 'ctx.reminders', // fields on the Context an intent is applied to
  'instance_skipped.recurs', // a field on an Effect kind
  'items.properties',       // a JSON-schema path, in the testing section
  'meta.last_tick',         // a database row
  'instances.status',       // a column
  'reminders.status',       // a column
  'rig.dbFailOn', 'rig.downModels', 'rig.geminiHang', 'rig.notFoundModels',
  'rig.rejectAnyOf', 'rig.retryDelaySeconds', 'rig.speakQueue', 'rig.emptyModels',
  'rig.slowModels',
  'Date.now',               // the language, discussed in the testing section
]);

/** Anything ending in a file extension is a filename, not a symbol pointer. */
const FILENAME = /\.(ts|md|sql|toml|json|js)$/;

/** Every `x.y` in backticks, which is the only form a pointer takes. */
const tokens = [...doc.matchAll(/`([A-Za-z_][\w-]*)\.([A-Za-z_]\w*)`/g)].map((m) => ({
  full: `${m[1]}.${m[2]}`,
  module: m[1],
  symbol: m[2],
}));

const pointers = tokens.filter((t) => MODULES.has(t.module) && !FILENAME.test(t.full));

// ===========================================================================
section('CLAUDE.md points at symbols that exist');
//
// The real guard. A renamed export leaves the rule here intact and the pointer
// dangling, and nothing else in the suite would notice.
{
  const source = new Map(
    [...MODULES].map((m) => [m, readFileSync(join(ROOT, 'src', `${m}.ts`), 'utf8')]),
  );

  const dangling = pointers.filter(
    (p) => !new RegExp(`\\b${p.symbol}\\b`).test(source.get(p.module)!),
  );

  check(
    `all ${pointers.length} pointers resolve against src/`,
    dangling.length === 0,
    dangling.map((d) => `${d.full}  — no \`${d.symbol}\` in src/${d.module}.ts`).join('\n        '),
  );
}

// ---------------------------------------------------------------------------
section('and the check above is actually looking at something');
//
// Vacuity mode 7, pre-empted. `dangling.length === 0` is true of an empty
// list, so without a floor here a broken regex or a renamed CLAUDE.md is
// indistinguishable from a clean bill of health.
//
// The floors sit under the current counts (112 pointers, 16 modules) with room
// to delete a few rules, but NOT the wide margin they started with. The first
// draft used 50 and 10, and the red-proof killed them: truncating MODULES to
// seven entries left 57 pointers across exactly 10 modules and BOTH floors
// passed. A floor low enough to survive a 36% collapse is decoration. Only
// check 3 caught that mutation, which is not the division of labour intended
// here — this check exists so partial extraction is red on its own terms.
{
  check(
    `extraction found ${pointers.length} pointers (floor 80)`,
    pointers.length >= 80,
    'the pointer regex, CLAUDE.md itself, or src/ has moved — this test is not checking anything',
  );

  check(
    `they span ${new Set(pointers.map((p) => p.module)).size} modules (floor 14)`,
    new Set(pointers.map((p) => p.module)).size >= 14,
    'pointers collapsed to a subset of modules — extraction is partial',
  );
}

// ---------------------------------------------------------------------------
section('nothing looks like a pointer and silently is not');
//
// The gap check 1 cannot see. A typo in the MODULE half — `effect.applyIntent`
// for `effects.applyIntent` — does not dangle, it simply fails to be extracted,
// and check 1 passes because it was never asked about it. Same failure as
// CLAUDE.md's vacuity mode 3: the list that bites is not the list you edited.
{
  const strays = tokens.filter(
    (t) => !MODULES.has(t.module) && !FILENAME.test(t.full) && !NOT_POINTERS.has(t.full),
  );

  check(
    'every `x.y` is a real pointer, a filename, or known prose',
    strays.length === 0,
    strays
      .map((s) => `${s.full}  — did you mean a module? add to NOT_POINTERS if it is prose`)
      .join('\n        '),
  );
}

done();
