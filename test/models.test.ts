/**
 * Run with `npm run test:models`.
 *
 * The model ladder. One API key, a free tier that says "not now" per model per
 * minute, and several models sharing it — so the only question these ask is
 * whether a 429 costs a reply, and how many round trips are burned
 * rediscovering a limit the bot already hit two minutes ago.
 */
import { generate, modelLadder } from '../src/gemini';
import { handleSlash } from '../src/slash';
import * as db from '../src/db';
import { check, createRig, done, eq, section, withNow } from './harness';

const CHAT = '12345';

/** One ordinary (non-router) call. */
async function ask(rig: ReturnType<typeof createRig>, reply = 'בסדר'): Promise<string> {
  rig.speakQueue.push(reply);
  return generate(rig.env, {
    system: 'test',
    contents: [{ role: 'user', parts: [{ text: 'שלום' }] }],
    chatId: CHAT,
  });
}

/** A rig whose ladder is exactly these models, in this order. */
function ladderRig(models: string[]) {
  const rig = createRig();
  rig.env.GEMINI_MODEL = models[0];
  rig.env.GEMINI_MODEL_FALLBACK = models[1];
  rig.env.GEMINI_MODELS = models.join(',');
  return rig;
}

// ---------------------------------------------------------------------------

section('the ladder is longer than two, and starts where it is told to');
{
  const rig = createRig();
  rig.env.GEMINI_MODEL = 'gemini-3.5-flash';
  rig.env.GEMINI_MODEL_FALLBACK = 'gemini-3.5-flash-lite';
  delete rig.env.GEMINI_MODELS;

  const ladder = modelLadder(rig.env);
  eq('the configured model leads', ladder[0], 'gemini-3.5-flash');
  check('and its fallback is next', ladder[1] === 'gemini-3.5-flash-lite', ladder.join(', '));
  // The whole point of the change: a 429 on both used to end the ladder.
  check('there is more below them', ladder.length > 2, ladder.join(', '));
  check('with no repeats', new Set(ladder).size === ladder.length, ladder.join(', '));

  // An explicit ladder wins, and an operator's chosen primary is never
  // silently dropped out of it.
  rig.env.GEMINI_MODELS = 'a-model,b-model';
  rig.env.GEMINI_MODEL = 'c-model';
  const explicit = modelLadder(rig.env);
  eq('an explicit primary still leads', explicit[0], 'c-model');
  check('followed by the configured ladder', explicit.includes('a-model') && explicit.includes('b-model'), explicit.join(', '));
  rig.restore();
}

section('a 429 costs the next model, not the reply');
{
  const rig = ladderRig(['one', 'two', 'three']);
  rig.downModels.add('one');

  const text = await ask(rig);
  eq('he still got an answer', text, 'בסדר');
  eq('the first was tried', rig.modelsCalled[0], 'one');
  eq('and the second answered', rig.modelsCalled[1], 'two');
  rig.restore();
}

section('the model that said no is written down');
{
  const rig = ladderRig(['one', 'two']);
  rig.downModels.add('one');
  await withNow(1_000_000, () => ask(rig));

  const health = await db.modelHealth(rig.env);
  const row = health.get('one');
  check('there is a row for it', !!row, [...health.keys()].join(', '));
  check('blocked into the future', (row?.blocked_until ?? 0) > 1_000_000, JSON.stringify(row));
  eq('with the reason on it', row?.reason, '429');
  // The one that worked must not be marked. A ladder that writes off every
  // model it touches empties itself in one bad minute.
  eq('and nothing against the one that answered', health.has('two'), false);
  rig.restore();
}

section('a blocked model is skipped without a round trip');
{
  const rig = ladderRig(['one', 'two']);
  rig.downModels.add('one');
  await withNow(1_000_000, () => ask(rig));
  const afterFirst = rig.modelsCalled.length;

  // Same minute, second message. The block is what this is for: rediscovering
  // the limit costs a round trip out of a budget that has to leave room for an
  // answer, and with a ladder several deep it is one per model per turn.
  await withNow(1_060_000, () => ask(rig));
  const second = rig.modelsCalled.slice(afterFirst);
  eq('the blocked one was not called again', second.includes('one'), false);
  eq('the working one was', second[0], 'two');
  rig.restore();
}

section('the block expires, and the next message is the probe');
{
  const rig = ladderRig(['one', 'two']);
  rig.downModels.add('one');
  await withNow(1_000_000, () => ask(rig));

  const until = (await db.modelHealth(rig.env)).get('one')?.blocked_until ?? 0;
  const afterFirst = rig.modelsCalled.length;

  // It has come back up in the meantime — which is the case that matters, and
  // the one nothing but an actual request can discover.
  rig.downModels.delete('one');
  await withNow(until + 1, () => ask(rig));

  const second = rig.modelsCalled.slice(afterFirst);
  eq('it is asked again once the wait is over', second[0], 'one');
  // And a model that answers is forgiven completely: the next bad minute
  // starts at one strike, not at five.
  eq('and the strike is cleared', (await db.modelHealth(rig.env)).has('one'), false);
  rig.restore();
}

section('a model that keeps refusing is asked less often');
{
  const rig = ladderRig(['one', 'two']);
  rig.downModels.add('one');

  await withNow(1_000_000, () => ask(rig));
  const first = (await db.modelHealth(rig.env)).get('one')!;
  const firstWait = first.blocked_until - 1_000_000;

  await withNow(first.blocked_until + 1, () => ask(rig));
  const second = (await db.modelHealth(rig.env)).get('one')!;
  const secondWait = second.blocked_until - (first.blocked_until + 1);

  eq('the strikes are counted', second.strikes, 2);
  check(
    'and the second wait is longer than the first',
    secondWait > firstWait,
    `${firstWait}ms then ${secondWait}ms`,
  );
  rig.restore();
}

section('Google says when to come back, and that is what is used');
{
  const rig = ladderRig(['one', 'two']);
  rig.downModels.add('one');
  // A per-MINUTE limit says "retry in 56s". Waiting five minutes for that is
  // four minutes of answering with the weaker model for no reason.
  rig.retryDelaySeconds = 56;
  await withNow(1_000_000, () => ask(rig));

  const row = (await db.modelHealth(rig.env)).get('one')!;
  const wait = row.blocked_until - 1_000_000;
  check('the wait is about a minute', wait >= 50_000 && wait <= 70_000, `${wait}ms`);
  rig.restore();
}

section('every model blocked is not the same as no models');
{
  const rig = ladderRig(['one', 'two']);
  const now = 2_000_000;
  // Both written off a moment ago — a whole minute of 429s, or a health table
  // left stale by a bad deploy.
  await db.blockModel(rig.env, 'one', now + 600_000, 3, '429');
  await db.blockModel(rig.env, 'two', now + 600_000, 3, '429');

  const text = await withNow(now, () => ask(rig));
  // Silence is the worst answer this bot can give, and a bookkeeping table is
  // never a good enough reason for it. Blocks are an optimisation; when they
  // rule out everything, they are ignored.
  eq('it asked anyway', text, 'בסדר');
  check('starting at the top of the ladder', rig.modelsCalled[0] === 'one', rig.modelsCalled.join(', '));
  rig.restore();
}

section('an unknown model prunes itself for a long time');
{
  const rig = ladderRig(['typo-model', 'two']);
  rig.notFoundModels.add('typo-model');
  await withNow(1_000_000, () => ask(rig));

  const row = (await db.modelHealth(rig.env)).get('typo-model')!;
  eq('written off as a 404', row.reason, '404');
  // A retired or misspelled id is not coming back in five minutes. Retrying it
  // every message is a wasted round trip per turn, forever — /diag is where it
  // is supposed to become visible instead.
  check(
    'and for hours, not minutes',
    row.blocked_until - 1_000_000 > 60 * 60_000,
    `${row.blocked_until - 1_000_000}ms`,
  );
  rig.restore();
}

section('/diag says which models are out and until when');
{
  const rig = ladderRig(['one', 'two']);
  const at = 1_700_000_000_000;
  await db.blockModel(rig.env, 'one', at + 300_000, 2, '429');

  const out = (await withNow(at, () => handleSlash(rig.env, CHAT, '/diag'))) ?? '';
  check('the ladder is printed', out.includes('two'), `got: ${out}`);
  // The number in /diag used to be the only way to see a rate limit, and it
  // could only ever say "a lot". This is what turns "the bot feels dumb today"
  // into a fact with a time on it.
  check('and so is the block', /one/.test(out) && /429/.test(out), `got: ${out}`);
  rig.restore();
}

section('the daily budget counts the whole ladder, not one rung of it');
{
  const rig = createRig();
  await withNow(1_700_000_000_000, async () => {
    await db.recordUsage(rig.env, 'one', CHAT);
    await db.recordUsage(rig.env, 'two', CHAT);
    await db.recordUsage(rig.env, 'three', CHAT);
    // Spread across three models, a per-model counter reads 1 where the day's
    // real spend is 3 — and GEMINI_SOFT_LIMIT, which gates unprompted
    // check-ins, would never bind again.
    eq('all of it is his', await db.usageTodayAll(rig.env, CHAT), 3);

    await db.recordRejection(rig.env, CHAT, 'invented time', 'שטויות', 'nothing');
    // Rejections share the usage table. Charging him for the times the
    // validator caught the model lying would be billing him for a bug.
    eq('and a rejection is not a model call', await db.usageTodayAll(rig.env, CHAT), 3);
  });
  rig.restore();
}

done();
