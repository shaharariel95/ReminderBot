/**
 * Run with `npm run test:v34`.
 *
 * `/models` — ask every rung of the ladder the same trivial question and time
 * it.
 *
 * The command exists because "promote by measuring" was a rule with no
 * instrument behind it. 0.16.0 promoted two models on the strength of their
 * version numbers and lost two reminders inside forty minutes; the correction
 * was to demote them and write "measure first" into three files. But measuring
 * meant deploying a model low, waiting a day and reading `usage` — which only
 * ever reports the rungs that were REACHED. The lower six stay unmeasured no
 * matter how long you wait, which is precisely why two dead ids sat on the
 * ladder from 19.08 to 06.09 without anybody being able to tell.
 *
 * The three things this must not do are all the same rule: a diagnostic that
 * changes what it measures is worse than no diagnostic.
 *
 *   - it must not WRITE `model_health`, or running the health check would
 *     rest the ladder it was run to inspect
 *   - it must not READ it either, or a model resting from a 429 a minute ago
 *     would be reported as broken
 *   - it must not walk the ladder — `generate()` drops tiers, retries and
 *     honours blocks, every one of which is the thing being measured
 *
 * And it is parallel, not sequential, which is the opposite of what it looks
 * like it should be. See probeLadder: waiting buys nothing because the free
 * tier meters per minute PER MODEL and this sends one request to each, while
 * sequential over two rungs measured at 12s apiece runs past the invocation's
 * lifetime — and an invocation killed on the wall clock does not throw, so the
 * report would simply never arrive.
 */
import { handleSlash } from '../src/slash';
import { probeLadder, modelLadder, errorMessage } from '../src/gemini';
import * as db from '../src/db';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const OWNER = '12345';
const GUEST = '701531870';
const TZ = 'Asia/Jerusalem';
const NOW = Date.parse('2026-09-08T09:00:00Z');

function seed(rig: Rig, chat: string): void {
  rig.db
    .prepare(
      `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
        quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
        last_brief_on, last_closeout_on)
       VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(chat, TZ);
}

/** A ladder small enough to reason about, with one of each outcome in it. */
/**
 * The rig serves any call with no responseSchema from `speakQueue`, and the
 * probe deliberately sends no schema — so one stub reply per rung has to be
 * queued or the stub throws instead of answering. Queued generously: an
 * unconsumed entry is harmless, a missing one looks exactly like a model that
 * failed.
 */
function queueReplies(rig: Rig, n = 8): void {
  for (let i = 0; i < n; i++) rig.speakQueue.push('OK');
}

function ladderRig(): Rig {
  const rig = createRig({ tz: TZ });
  seed(rig, OWNER);
  rig.env.GEMINI_MODEL = 'fast-one';
  rig.env.GEMINI_MODEL_FALLBACK = 'fast-two';
  rig.env.GEMINI_MODELS = 'fast-one,fast-two,busy-one,missing-one';
  return rig;
}

// ===========================================================================
section('it reports every rung, in ladder order, with a time on each');
{
  const rig = ladderRig();
  queueReplies(rig);
  rig.downModels.add('busy-one');       // 429
  rig.notFoundModels.add('missing-one'); // 404

  const out = (await withNow(NOW, () => handleSlash(rig.env, OWNER, '/models'))) ?? '';

  const ladder = modelLadder(rig.env);
  eq('the rig ladder is four deep', ladder.length, 4);
  for (let i = 0; i < ladder.length; i++) {
    check(`rung ${i + 1} is named — ${ladder[i]}`, out.includes(`${i + 1}. ${ladder[i]}`), out);
  }
  // Either unit: milliseconds under a second, seconds above it. Matching only
  // one of them would make this a test of how fast the rig happens to be.
  const TOOK = (m: string) => new RegExp(`${m} · (?:\\d+ms|[\\d.]+ש׳) ✓`);
  check(`the two that answered are marked ✓ — ${JSON.stringify(out)}`,
    TOOK('fast-one').test(out) && TOOK('fast-two').test(out), out);
  check('the 429 is reported as 429, not as a duration',
    /busy-one · 429 ✗/.test(out), out);
  check('and the 404 as 404', /missing-one · 404 ✗/.test(out), out);
  check('with a tally', /ענו: 2\/4/.test(out), out);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the probe does not rest the ladder it was run to inspect');
//
// The failure this guards is self-inflicting and silent: a 429 during the
// probe writes a block, the block lasts minutes, and the next real message
// then skips a model that was fine — so running the health check breaks the
// thing it reports on. `generate()` writes those blocks on purpose; this must
// not.
{
  const rig = ladderRig();
  queueReplies(rig);
  rig.downModels.add('busy-one');
  rig.notFoundModels.add('missing-one');

  await withNow(NOW, () => handleSlash(rig.env, OWNER, '/models'));

  const health = await db.modelHealth(rig.env);
  eq('no model was written off by the probe', health.size, 0);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('...and it reports a model that IS blocked, without asking the table');
//
// The other direction. A block is a fact about the last few minutes; whether
// the endpoint answers is a different fact. Both are printed, and they are
// allowed to disagree — that disagreement is the useful part, because it says
// "this rung is fine now and is being skipped anyway".
{
  const rig = ladderRig();
  queueReplies(rig);
  await db.blockModel(rig.env, 'fast-two', NOW + 5 * 60_000, 1, '429');

  const out = (await withNow(NOW, () => handleSlash(rig.env, OWNER, '/models'))) ?? '';

  check(`fast-two still answered — ${JSON.stringify(out)}`,
    /fast-two · (?:\d+ms|[\d.]+ש׳) ✓/.test(out), out);
  check('and the block is stated alongside', out.includes('חסום עד'), out);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('every model is asked exactly once');
//
// One request per model is what makes the per-minute-per-model limit
// irrelevant, and it is also what makes the numbers comparable. A retry
// anywhere in here would report the SECOND attempt's latency.
{
  const rig = ladderRig();
  queueReplies(rig);
  rig.downModels.add('busy-one');
  await withNow(NOW, () => handleSlash(rig.env, OWNER, '/models'));

  const counts = new Map<string, number>();
  for (const m of rig.modelsCalled) counts.set(m, (counts.get(m) ?? 0) + 1);
  for (const m of modelLadder(rig.env)) {
    eq(`${m} was asked once`, counts.get(m) ?? 0, 1);
  }
  rig.restore();
}

// ---------------------------------------------------------------------------
section('it says whether the rung that leads is the one that was fastest');
//
// The actionable half. Worded as "if this repeats, consider it" rather than as
// advice: one probe is one sample, and promoting on a single fast round trip
// is the version-number mistake with a stopwatch instead of a changelog.
{
  const rig = ladderRig();
  queueReplies(rig);
  const out = (await withNow(NOW, () => handleSlash(rig.env, OWNER, '/models'))) ?? '';
  check(`it names a fastest — ${JSON.stringify(out)}`, out.includes('הכי מהיר:'), out);
  check('and compares it against rung 1',
    out.includes('הראשון בסולם'), out);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the probe asks the same question production asks');
//
// 0.35.0, and the first real run is what found it. `/models` shipped in 0.34.0
// sending `maxOutputTokens: 16` and no thinkingConfig at all, and on
// 08.09.2026 it scored gemini-3.7-flash, gemini-3.6-flash and gemini-3.8-flash
// as `ריק` — HTTP 200, no candidates. Those are the thinking generation:
// sixteen tokens went entirely on reasoning and the answer never began.
//
// Three working models reported broken by the one command whose whole job is
// not to lie about them. `buildBody` states the rule three lines above itself
// — "reasoning tokens are drawn from this same budget" — and the probe was
// written past it.
//
// So the assertion is not "2000 is a good number". It is that the probe uses
// the SAME numbers the real calls use, because a probe measuring a different
// configuration measures a different thing.
{
  const rig = ladderRig();
  queueReplies(rig);
  await withNow(NOW, () => handleSlash(rig.env, OWNER, '/models'));

  const calls = rig.geminiCalls;
  check(`every rung was asked — ${calls.length}`, calls.length === 4, String(calls.length));
  for (const c of calls) {
    eq('with production\'s token ceiling', c.generationConfig?.maxOutputTokens, 2000);
    check('and production\'s thinking level, not the API default',
      c.generationConfig?.thinkingConfig?.thinkingLevel === 'low' ||
        c.generationConfig?.thinkingConfig?.thinkingBudget === 0,
      JSON.stringify(c.generationConfig?.thinkingConfig));
  }
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the reason is read out of the error, not the opening brace');
//
// The first version was /"message"\s*:\s*"([^"]{0,120})"/, and a bounded run of
// non-quote characters must still find the closing quote INSIDE the bound — so
// any message longer than 120 characters matched nothing and fell through to
// the raw body. Google pretty-prints its errors, so the report gained four
// lines of `{ "error": {` and lost the sentence. Production, 08.09.2026: the
// 429 explaining a spent daily quota rendered as its own opening brace.
{
  const long =
    'You exceeded your current quota, please check your plan and billing details. ' +
    'For more information on this error, visit https://ai.google.dev/gemini-api/docs/rate-limits ' +
    'and review the free tier limits for your project.';
  const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: long } }, null, 2);

  const out = errorMessage(body);
  check(`it starts with the sentence — ${JSON.stringify(out)}`,
    out.startsWith('You exceeded your current quota'), out);
  check('and not with the envelope', !out.includes('"error"') && !out.startsWith('{'), out);
  check('on one line', !out.includes('\n'), JSON.stringify(out));
  check('bounded', out.length <= 140, String(out.length));

  // A short one still works — the old regex handled these, and the fix must
  // not trade one for the other.
  eq('a short message is unchanged',
    errorMessage('{"error":{"code":404,"message":"model not found"}}'), 'model not found');
  // And a body that is not the expected shape degrades to the body itself
  // rather than to an empty line — flattened, because THIS is the path the
  // whitespace collapse exists for. A matched message cannot contain a real
  // newline (JSON escapes them), so asserting the collapse on the happy path
  // is unfalsifiable; the red-proof scored it green until it moved here.
  const gateway = errorMessage('<html>\n  502 Bad Gateway\n  nginx\n</html>');
  check(`an unparseable body still says something — ${JSON.stringify(gateway)}`,
    gateway.length > 0, 'empty');
  check('on one line, so it cannot break the list layout',
    !gateway.includes('\n'), JSON.stringify(gateway));
}

// ---------------------------------------------------------------------------
section('a 200 with no answer in it is not a working model');
//
// The shape a safety block arrives in: HTTP 200, no candidates, nothing to
// read. `res.ok` is true and the model is useless. This is 0.15.0's
// finishReason lesson at one remove — a status line is not an answer — and
// without it the report would print a latency next to a tick for a rung that
// returns nothing at all.
{
  const rig = ladderRig();
  queueReplies(rig);
  rig.emptyModels.add('fast-two');

  const out = (await withNow(NOW, () => handleSlash(rig.env, OWNER, '/models'))) ?? '';
  check(`fast-two is not ticked — ${JSON.stringify(out)}`,
    !/fast-two · (?:\d+ms|[\d.]+ש׳) ✓/.test(out), out);
  // The finishReason rides along, because 'ריק' alone was not diagnosable:
  // three rungs said it on 08.09.2026 and the cause was this probe's own token
  // ceiling, which a MAX_TOKENS here would have named on sight.
  check('and it says the reply was empty, WITH the finishReason',
    out.includes('ריק (') && out.includes(')'), out);
  check('the others are unaffected', /ענו: 3\/4/.test(out), out);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('nothing answering is called what it is');
{
  const rig = ladderRig();
  queueReplies(rig);
  rig.geminiDown = true;
  const out = (await withNow(NOW, () => handleSlash(rig.env, OWNER, '/models'))) ?? '';
  check(`it blames the key or the network, not the models — ${JSON.stringify(out)}`,
    out.includes('מפתח או רשת'), out);
  check('and does not name a fastest', !out.includes('הכי מהיר:'), out);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('a guest gets the same answer as for a command that does not exist');
//
// The OWNER_ONLY gate. Two different refusals would tell a guest which
// commands are real — and this one spends the shared key's quota.
{
  const rig = ladderRig();
  queueReplies(rig);
  seed(rig, GUEST);
  const out = (await withNow(NOW, () => handleSlash(rig.env, GUEST, '/models'))) ?? '';
  eq('refused with the shared wording', out, 'אין פקודה כזאת. /help לרשימה.');
  eq('and no model was called at all', rig.modelsCalled.length, 0);
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the probe spends quota and says so in the usage table');
//
// It really does call the API, so a `usage` number that quietly excluded it
// would be wrong — and that number is what /diag reports and what the soft
// limit is measured against.
{
  const rig = ladderRig();
  queueReplies(rig);
  rig.notFoundModels.add('missing-one');
  // Both the write and the READ inside withNow. `usageTodayFor` derives the
  // day key from Date.now(), so asserting outside the pinned clock compares
  // today's row against tomorrow's key and returns 0 — which looks exactly
  // like the usage never being recorded. CLAUDE.md lists this as one of the
  // seven ways a test here has been vacuous; this one was failing rather than
  // passing, which is the lucky direction.
  await withNow(NOW, async () => {
    await handleSlash(rig.env, OWNER, '/models');
    eq('the ones that answered are counted',
      await db.usageTodayFor(rig.env, 'fast-one', OWNER), 1);
    // A 404 spends no quota worth recording — nothing was generated.
    eq('the one that 404d is not', await db.usageTodayFor(rig.env, 'missing-one', OWNER), 0);
  });
  rig.restore();
}

// ---------------------------------------------------------------------------
section('probeLadder returns results in ladder order even when they finish out of order');
//
// The stagger and the parallelism together mean the SLOWEST rung can resolve
// last while sitting first in the list. The report is read as "rung 1, rung
// 2..." so the order has to come from the ladder, never from the finishing
// times.
{
  const rig = ladderRig();
  queueReplies(rig);
  // The first rung hangs until its own timeout; the rest answer immediately.
  rig.hangModels.add('fast-one');

  /*
   * RACED against a timer, not merely awaited.
   *
   * `rig.geminiHang` settles only when the caller's own AbortSignal fires, so
   * a probe that lost its timeout would produce a promise that never settles —
   * and an awaited never-settling promise makes the suite HANG rather than go
   * red. The red-proof caught exactly that: raising the per-model timeout to
   * ten minutes was scored GREEN because the runner was killed before it could
   * print a failure. A test that cannot fail is not a test.
   */
  const raced = await withNow(NOW, () =>
    Promise.race([
      probeLadder(rig.env, OWNER, 50),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3000)),
    ]),
  );
  check('the probe settled instead of hanging — its timeout is what does that',
    raced !== 'hung', String(raced));
  const probes = raced === 'hung' ? [] : raced;
  eq('four results', probes.length, 4);
  eq('in ladder order', probes.map((p) => p.model).join(','), modelLadder(rig.env).join(','));
  check('the hung one is reported as not ok', !probes[0].ok, JSON.stringify(probes[0]));
  rig.restore();
}

done();
