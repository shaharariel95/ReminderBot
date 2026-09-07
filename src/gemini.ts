import * as db from './db';
import type { Env } from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export type Part = { text: string } | { inline_data: { mime_type: string; data: string } };
export interface Turn {
  role: 'user' | 'model';
  parts: Part[];
}

interface GenerateOpts {
  system: string;
  contents: Turn[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Pass a responseSchema to force structured JSON out. */
  jsonSchema?: Record<string, unknown>;
  /**
   * A simpler schema to fall back to when the API REFUSES `jsonSchema` — a 400,
   * which means the construct is not accepted rather than the request being
   * unlucky.
   *
   * 0.27.0 made the router schema an `anyOf` union so that an action which
   * reads no free text cannot emit any (three of the five runaway-title
   * failures on record are reschedules, which never read a title). `anyOf` is
   * documented as supported and that cannot be verified from here against the
   * real endpoint — and the cost of being wrong is not a degraded turn, it is
   * `if (!res.ok) throw` below firing on the first rung of the ladder, on
   * every call, for every user, until somebody redeploys.
   *
   * So it degrades like everything else in this file. One retry, same model —
   * the model is not what refused — and if the fallback is refused too, that
   * is a real error and says so rather than looping.
   */
  jsonSchemaFallback?: Record<string, unknown>;
  /** Gemini 3.x reasoning effort. We want speed and brevity, so: low. */
  thinkingLevel?: 'low' | 'high';
  /** Gemini 2.5 equivalent, in tokens. 0 disables reasoning entirely. */
  thinkingBudget?: number;
  /**
   * This call makes the reply nicer but changes nothing about what happens.
   * When the minute is running short, these are dropped first, so the last
   * calls of a busy minute go to deciding WHAT to do rather than to how to
   * word it. A dropped `speak` costs the personality; a dropped `route` costs
   * the reminder.
   */
  decorative?: boolean;
  /**
   * Who this call is for. Threaded all the way down from the turn rather than
   * inferred here, because attribution is the whole point: a shared counter
   * showed the owner a rejection that was a guest's and let a guest spend his
   * check-in budget. Omitted only by callers that genuinely have no chat.
   */
  chatId?: string;
  /**
   * An absolute deadline shared with everything else in this turn.
   *
   * `budgets()` bounds ONE generate() — one ladder, one set of retries. It
   * cannot see that route() has already spent nineteen seconds before speak()
   * was even called, so a turn could legitimately run route's 30s and then
   * speak's fresh 30s back to back.
   *
   * Production, 02.09.2026 22:27:39. Routing took 18.9 seconds; the reminder
   * was written correctly at 22:27:58; and then nothing was sent, no error row
   * appeared, and no catch anywhere ran — the signature of an overrun killing
   * `ctx.waitUntil` without throwing. He got silence.
   *
   * Passing the same instant to both calls is what makes the budget belong to
   * the TURN rather than to each call inside it.
   */
  deadline?: number;
}

/** "2026-08-07T14:32" — the window a call is counted against. */
function minuteBucket(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16);
}

/**
 * Take one call's worth of this minute's budget for `model`, and say whether
 * we were still inside it.
 *
 * Deliberately fails OPEN: if the bookkeeping query throws, the call proceeds.
 * A broken counter costing a 429 is a bad minute; a broken counter costing
 * every reply is a broken bot.
 */
async function withinRateWindow(env: Env, model: string, decorative: boolean): Promise<boolean> {
  const limit = Number(env.GEMINI_RPM ?? 18);
  if (!Number.isFinite(limit) || limit <= 0) return true;
  // Decorative calls yield at 70% so there is always headroom left for routing.
  const ceiling = decorative ? Math.floor(limit * 0.7) : limit;
  try {
    const minute = minuteBucket(Date.now());
    const used = await db.bumpRateWindow(env, minute, model);
    if (used <= ceiling) return true;
    // Refused — so give the slot back. The bump is a RESERVATION (atomic, and
    // that is why it comes first), but a reservation nobody uses has to be
    // released or it is just a leak.
    //
    // Without this, a decorative call turned away at the 70% ceiling had still
    // consumed a slot against the FULL limit. With a ladder underneath, one
    // speak() attempt walks every rung and burns one slot per model without
    // making a single HTTP request — and those slots come straight out of the
    // budget route() is measured against, which is the call that must never be
    // dropped. The cheap message was costing the expensive one its headroom.
    //
    // Best-effort, and deliberately not awaited into the decision: failing to
    // release costs one slot for one minute, while failing the whole call
    // costs the turn.
    await db.releaseRateWindow(env, minute, model).catch((err) =>
      console.error('releaseRateWindow', err),
    );
    return false;
  } catch (err) {
    console.error('rate window bookkeeping failed, allowing the call', err);
    return true;
  }
}

/**
 * Thinking controls are the most volatile corner of this API and the two
 * generations are mutually exclusive:
 *   Gemini 2.5  → thinkingConfig.thinkingBudget (number, 0 disables)
 *   Gemini 3.x  → thinkingConfig.thinkingLevel  ("low" | "high", can't disable)
 * Sending the wrong one returns a bare 400 INVALID_ARGUMENT that doesn't name
 * the offending field, so we guess from the model id and fall back below.
 */
function thinkingConfig(model: string, opts: GenerateOpts): Record<string, unknown> {
  const gen = /gemini-(\d+)/.exec(model)?.[1];
  const isLegacy = gen === '1' || gen === '2';
  return isLegacy
    ? { thinkingBudget: opts.thinkingBudget ?? 0 }
    : { thinkingLevel: opts.thinkingLevel ?? 'low' };
}

function buildBody(
  opts: GenerateOpts,
  thinking: Record<string, unknown> | null,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 1.0,
    // Reasoning tokens are drawn from this same budget, so it has to be
    // comfortably larger than the visible reply we actually want.
    maxOutputTokens: opts.maxOutputTokens ?? 2000,
  };
  if (thinking) generationConfig.thinkingConfig = thinking;
  if (opts.jsonSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = opts.jsonSchema;
    // Not 0. Constrained decoding at zero temperature is what trips the
    // RECITATION filter; this is low enough to stay deterministic in practice.
    generationConfig.temperature = opts.temperature ?? 0.2;
  }
  return {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: opts.contents,
    generationConfig,
  };
}

/**
 * Every request carries a deadline, and the whole call carries a bigger one.
 *
 * These used to be bare `fetch`es with no signal at all, and the arithmetic of
 * that is worse than it looks: two tiers times three attempts, each of which
 * can fire a second request via the 400-retry below, is up to TWELVE unbounded
 * sequential round trips. When that overran the Worker's wall clock,
 * `ctx.waitUntil` was killed WITHOUT throwing — so no catch anywhere ran, no
 * fallback shipped, and the user got silence. On 13.08.2026 his longest
 * message of the week was answered with nothing at all.
 *
 * A slow model must cost the personality, never the reply. The per-call
 * timeout bounds one request; the budget bounds the retry ladder, which is the
 * half that actually ran away.
 */
const DEFAULT_TIMEOUT_MS = 12_000;
/**
 * Room for the primary to burn its whole per-call budget AND the fallback to
 * answer properly afterwards. At 22s the second tier inherited whatever was
 * left of a ten-second overrun, which was not enough to be worth calling.
 */
const DEFAULT_BUDGET_MS = 30_000;

/**
 * The least time worth spending a round trip on.
 *
 * Below this an attempt is theatre: it cannot finish, it burns a rate-window
 * slot, and — because the abort surfaces as "model X timed out" — it blames
 * whichever model happened to be next in the ladder. See the check in
 * generate() for the message that produced this number.
 */
const MIN_ATTEMPT_MS = 1_500;

/**
 * An abort, however the runtime chose to describe it.
 *
 * `AbortSignal.timeout` rejects with a DOMException named "TimeoutError" in
 * Workers, and the test rig raises a plain Error — matching on the name alone
 * would pass in production and quietly fail every test, which is the worst of
 * both. The message check is the belt.
 */
function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  const message = (err as { message?: string })?.message ?? '';
  return /Timeout|Abort/i.test(name) || /abort|timed? ?out/i.test(message);
}

function budgets(env: Env): { perCall: number; total: number } {
  const read = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    perCall: read(env.GEMINI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    total: read(env.GEMINI_BUDGET_MS, DEFAULT_BUDGET_MS),
  };
}

async function post(
  env: Env,
  model: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
    signal,
  });
}

export interface ModelProbe {
  model: string;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  /** Wall-clock milliseconds for the round trip, including a timeout. */
  ms: number;
  /** True only for a 200 that carried text back. */
  ok: boolean;
  /** Short, already-trimmed reason when it is not ok. */
  detail: string;
}

/** Long enough for the slowest rung ever measured here (12s), and no longer. */
const PROBE_TIMEOUT_MS = 12_000;

/**
 * Ask one model the cheapest possible question and time it.
 *
 * Deliberately NOT `generate()`. That walks the ladder, honours the health
 * table, drops tiers and retries — every one of which is the thing being
 * measured. This is one request to one named model, so the number it returns
 * is about that model and nothing else.
 *
 * Three things it must not do, each for the same reason: a diagnostic that
 * changes what it measures is worse than no diagnostic.
 *
 *  - **It does not write `model_health`.** A probe that 429s would otherwise
 *    write the model off for minutes — so running the health check would
 *    disable the ladder it was run to inspect.
 *  - **It does not read `model_health` either.** "Blocked" is a fact about the
 *    last few minutes, not about whether the model answers; /models states the
 *    block separately, from the table, so both facts are visible at once.
 *  - **It sends no system prompt and no schema.** Those change latency, and
 *    the question here is whether the endpoint answers at all.
 *
 * Usage IS recorded, because the call really does spend quota against the
 * shared key and a number in /diag that quietly excludes it is wrong.
 */
export async function probeModel(
  env: Env,
  model: string,
  chatId?: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ModelProbe> {
  const t0 = Date.now();
  try {
    const res = await post(
      env,
      model,
      {
        contents: [{ role: 'user', parts: [{ text: 'say OK' }] }],
        generationConfig: { maxOutputTokens: 16, temperature: 0 },
      },
      AbortSignal.timeout(Math.max(1, timeoutMs)),
    );
    const ms = Date.now() - t0;
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      // The message, not the whole envelope. Google's 404 body is 400 bytes of
      // JSON whose useful half is one sentence.
      const msg = /"message"\s*:\s*"([^"]{0,120})"/.exec(body)?.[1] ?? body.slice(0, 90);
      return { model, status: res.status, ms, ok: false, detail: msg };
    }
    await db.recordUsage(env, model, chatId).catch(() => {});
    let text = '';
    try {
      const json = JSON.parse(body);
      text = (json?.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p.text ?? '')
        .join('')
        .trim();
    } catch {
      return { model, status: res.status, ms, ok: false, detail: 'תשובה לא תקינה' };
    }
    // A 200 with no text is not a working model. MAX_TOKENS on a 16-token
    // ceiling is fine and still counts as answering.
    return text
      ? { model, status: res.status, ms, ok: true, detail: text.slice(0, 40) }
      : { model, status: res.status, ms, ok: false, detail: 'ריק' };
  } catch (err) {
    const ms = Date.now() - t0;
    return {
      model,
      status: null,
      ms,
      ok: false,
      detail: isTimeout(err) ? `נגמר הזמן אחרי ${Math.round(ms / 1000)}ש׳` : String(err).slice(0, 90),
    };
  }
}

/**
 * Probe the whole ladder and return the results IN LADDER ORDER.
 *
 * Started in parallel, with a small stagger, and that is a decision worth
 * stating because the obvious alternative — one at a time, with a pause
 * between — is what it looks like it should do.
 *
 * Waiting buys nothing. The free tier meters requests per minute PER MODEL
 * against the key, so asking each model exactly once cannot approach any
 * model's limit; `GEMINI_RPM` is 18 and this sends one.
 *
 * And waiting costs everything: this runs inside a Worker invocation, whose
 * lifetime is the thing `TURN_BUDGET_MS` exists to respect. Sequential, with
 * two rungs that have been measured burning a full 12s each, runs past it —
 * and an invocation killed on the wall clock does not throw, so the report
 * would simply never arrive. Parallel makes the total the SLOWEST rung rather
 * than the sum.
 *
 * The stagger is the one concession: eight simultaneous requests on one key
 * could plausibly meet a project-wide concurrency limit, and a 429 caused by
 * the probe is a lie about the model. 200ms apart keeps that unlikely, and if
 * it ever happens it is visible as a pattern — every rung 429 at once — rather
 * than as one bad number.
 */
export async function probeLadder(
  env: Env,
  chatId?: string,
  /** Per model, not for the whole run — they overlap. Lowered by tests so a
   *  model that never answers fails in milliseconds instead of hanging the
   *  suite for twelve seconds, which is the trap `rig.geminiHang` exists to
   *  set. */
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ModelProbe[]> {
  const ladder = modelLadder(env);
  return Promise.all(
    ladder.map(
      (m, i) =>
        new Promise<ModelProbe>((resolve) => {
          setTimeout(() => resolve(probeModel(env, m, chatId, timeoutMs)), i * 200);
        }),
    ),
  );
}

/** One round trip, including the thinking-parameter fallback. */
async function callOnce(
  env: Env,
  model: string,
  opts: GenerateOpts,
  /** What is left of this generate()'s whole budget, not just this request's. */
  timeoutMs: number,
): Promise<Response> {
  // Both requests below share one deadline on purpose: the retry is part of
  // this attempt, not a fresh grant of time.
  const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
  let res = await post(env, model, buildBody(opts, thinkingConfig(model, opts)), signal);

  // A 400 here is nearly always the thinking parameter, but the error body
  // doesn't say so. Retry once with no thinking config at all — that shape is
  // valid on every model, so the bot keeps working through future renames.
  if (res.status === 400) {
    const first = await res.text();
    const retry = await post(env, model, buildBody(opts, null), signal);
    if (retry.ok) {
      console.warn(`gemini: ${model} rejected thinkingConfig, continuing without it`);
      return retry;
    }
    // A 400 that survives dropping thinkingConfig may be about the SCHEMA
    // instead — see GenerateOpts.jsonSchemaFallback. generate() owns that
    // fallback rather than this function, because it has to narrow the schema
    // for the rest of the LADDER and not merely for this one call. So hand the
    // refusal back instead of ending the turn here. When there is nothing left
    // to fall back to, the throw below is still the right answer and still
    // carries both bodies, which is what made this diagnosable at all.
    if (opts.jsonSchemaFallback && opts.jsonSchema !== opts.jsonSchemaFallback) return retry;
    throw new Error(
      `gemini 400 for model "${model}": ${first.slice(0, 400)} ` +
        `| retry without thinkingConfig: ${(await retry.text()).slice(0, 400)}`,
    );
  }
  return res;
}

/**
 * Empty responses that are worth retrying rather than surfacing:
 *   RECITATION — the copy-detection filter misfiring. Common with a
 *                responseSchema at temperature 0, because constrained decoding
 *                produces a near-deterministic token sequence that looks
 *                memorised. A little randomness usually clears it.
 *   MAX_TOKENS — reasoning consumed the budget; more room usually clears it.
 *   OTHER      — unexplained; cheap enough to try again.
 */
const RETRYABLE = new Set(['RECITATION', 'MAX_TOKENS', 'OTHER']);

/**
 * 429 (quota), 503 (overloaded), and 404 (unknown/retired model — e.g. a typo
 * in wrangler.toml) all mean "this model is unavailable right now" — drop a
 * tier at once rather than burning retries on it. 400 is deliberately not
 * here: callOnce already retries a 400 without thinkingConfig, and treating
 * it as a tier-down would mask genuine bad requests.
 */
const TIER_DOWN = new Set([429, 503, 404]);

/**
 * The free-tier models, best first.
 *
 * Every one of these has its own per-minute quota against the same API key, so
 * a ladder is not redundancy — it is capacity. Two rungs deep, a busy minute
 * ran out of models and the turn fell back to the deterministic baseline while
 * four other free models sat there unasked.
 *
 * Ids that do not exist are self-pruning: a 404 writes the model off for the
 * best part of a day (see blockFor) and /diag names it, so a rename upstream
 * costs one wasted round trip a day and a visible line, rather than a silent
 * failure. That is the trade this default is chosen under — verify the current
 * free-tier list before editing, because the published names move.
 *
 * The moral for whoever adds a rung: it is not enough to believe an id is
 * real. Deploy it, then read /diag. A dead id costs a round trip a day and
 * silently shortens the ladder underneath a busy minute, which is precisely
 * the minute the extra rungs exist for.
 *
 * THIS LIST AND `wrangler.toml` MUST AGREE, RUNG FOR RUNG.
 *
 * They did not, for nine versions. 0.16.2 measured 3.7 and 3.6 burning the
 * full 12s per-call timeout, cost two reminders, and demoted them — in
 * wrangler.toml. This array kept them at the top, under a comment reading
 * "best first", and it is the ladder any deployment without GEMINI_MODEL and
 * GEMINI_MODELS actually walks. Two lists that must agree and only one of
 * which anyone edits is the `CLAIM` / `CLAIM_GROUPS` shape from 0.19.0, and
 * `test/v26.test.ts` now asserts the two produce an identical ladder rather
 * than merely holding the same names.
 *
 * The order below is measurement, then evidence, then a docs page:
 *
 *   3.5-flash, 3.5-flash-lite   measured fast, and carry ~all the traffic
 *   3.7-flash, 3.6-flash        slow (12s), but have answered in production
 *   3.1-flash-lite, 3.8-flash   published free-tier, never called here
 *   2.5-flash-lite, 2.5-flash   404'd in production on 19.08.2026
 *
 * The 2.5 pair were deleted for those 404s and are back at the bottom because
 * the published list carries them with a free tier again (checked 06.09.2026).
 * A previous 404 is evidence and a docs page is only a claim, so they go last:
 * if they are still dead, blockFor writes them off for six hours and /diag
 * names them, which is exactly what makes a stale id here cheap.
 *
 * `gemini-3.8-flash` is the highest number published and is deliberately sixth
 * — the docs describe it as built for "long-horizon software engineering",
 * which is a thinking model, which is the 18.9-second failure mode this bot
 * has already paid for once. Promote by measuring, never by version number.
 */
const DEFAULT_LADDER = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

/**
 * The ladder this deployment will actually walk, in order, without repeats.
 *
 * GEMINI_MODEL and GEMINI_MODEL_FALLBACK still mean what they always meant and
 * still come first — they are what /diag calls "the model", what the soft
 * limit was written against, and what somebody debugging at 02:00 will change.
 * GEMINI_MODELS is the rest of the ladder under them.
 */
export function modelLadder(env: Env): string[] {
  const listed = (env.GEMINI_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const ladder = [
    env.GEMINI_MODEL,
    env.GEMINI_MODEL_FALLBACK,
    ...(listed.length ? listed : DEFAULT_LADDER),
  ].filter((m): m is string => !!m);
  return [...new Set(ladder)];
}

/**
 * How long a model that just refused is left alone.
 *
 * 429 is the only one Google tells us about, and it tells us precisely — the
 * body carries a RetryInfo with the wait in it, and honouring that is the
 * difference between a one-minute detour and a five-minute one. Absent that,
 * five minutes is the guess.
 *
 * 404 is not a rate limit at all: the id is retired, or misspelled in
 * wrangler.toml. Nothing about it changes in five minutes, so it goes away for
 * hours — which is only safe because /diag prints it.
 *
 * `strikes` doubles the wait each consecutive time, which is what separates
 * the two shapes of 429 the free tier produces. A model merely over its
 * per-minute limit answers again on the first probe and the row is deleted; a
 * model whose DAILY quota is gone refuses every probe, and ends up asked twice
 * an hour instead of twice a minute.
 */
function blockFor(status: number, retryMs: number | null, strikes: number): number {
  const n = Math.min(Math.max(strikes, 1), 4);
  if (status === 404) return Math.min(24 * 3_600_000, 6 * 3_600_000 * n);
  const base = status === 503 ? 60_000 : (retryMs ?? 5 * 60_000);
  return Math.min(30 * 60_000, Math.max(30_000, base * 2 ** (n - 1)));
}

/**
 * The wait Google asked for, in ms, out of a 429 body — or null.
 *
 * Parsed with a regex rather than by walking the JSON: this runs on an error
 * path, the shape of `error.details` has changed before, and a parse failure
 * here must degrade to the default guess rather than throw inside a catch.
 */
function retryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (!m) return null;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

export async function generate(env: Env, opts: GenerateOpts): Promise<string> {
  let lastDetail = '';
  // The schema actually in flight. Starts as the caller's and is narrowed to
  // jsonSchemaFallback if the endpoint refuses it — for the rest of the ladder,
  // not just the retry, so a turn that also drops a tier does not rediscover
  // the same refusal on the next model.
  let schema = opts.jsonSchema;
  const { perCall, total } = budgets(env);

  // One read of the health table per generate(), against a table with as many
  // rows as there are models. It buys back a wasted round trip per blocked
  // model per turn, which with a ladder this long is the difference between a
  // 429 costing a moment and a 429 costing the whole budget.
  const health = await db.modelHealth(env);
  const ladder = modelLadder(env);
  const usable = ladder.filter((m) => (health.get(m)?.blocked_until ?? 0) <= Date.now());
  // Everything written off at once — a whole minute of 429s, or a health table
  // left stale by something worse. The blocks are an optimisation, and an
  // optimisation is never a good enough reason for silence: ask anyway.
  const tiers = usable.length ? usable : ladder;
  if (!usable.length) console.warn('gemini: every model is blocked, ignoring the health table');
  // One deadline for the whole ladder. Checked before each attempt rather than
  // relied on to fire mid-request, so an exhausted budget costs no round trip
  // at all — and so the error names the budget instead of surfacing as an
  // opaque AbortError from somewhere inside the retry loop.
  //
  // Clamped to the TURN's deadline when the caller has one. Whichever runs out
  // first wins: this call may not outlive the turn it belongs to, and a turn
  // with time to spare does not extend it.
  const deadline = Math.min(Date.now() + total, opts.deadline ?? Infinity);

  for (const model of tiers) {
    if (Date.now() >= deadline) break;
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = deadline - Date.now();
      /*
       * Not "is there time", but "is there ENOUGH time".
       *
       * A round trip that cannot complete is worth less than the honest report
       * that the budget is gone — and it actively lies about which model is at
       * fault. Production, 02.09.2026 22:43: two slow models spent 24 of a 25
       * second turn, and what he was shown was
       *
       *     gemini exhausted every tier (gemini-3.5-flash timed out after 635ms)
       *
       * naming the one model that had been answering in two seconds all week.
       * It did not time out. It was handed the scraps.
       *
       * CLAUDE.md states this rule for the ladder budget already — "the second
       * tier inherits a scrap of time and is not worth calling" — and the
       * turn-wide deadline added in 0.16.1 re-created the exact condition it
       * warns about, one level up.
       */
      if (left < MIN_ATTEMPT_MS) {
        lastDetail =
          left <= 0
            ? `budget of ${total}ms exhausted before ${model}`
            : `only ${left}ms left, too little to ask ${model}`;
        console.warn(`gemini: ${lastDetail}`);
        break;
      }
      const tuned: GenerateOpts = { ...opts, jsonSchema: schema };
      if (attempt > 0) {
        // Nudge off the deterministic path, and widen the ceiling.
        const base = opts.temperature ?? (opts.jsonSchema ? 0.2 : 1.0);
        tuned.temperature = Math.min(1.4, base + 0.35 * attempt);
        tuned.maxOutputTokens = (opts.maxOutputTokens ?? 2000) * (1 + attempt);
      }

      // Checked per attempt rather than per call, because each retry is a
      // real request against the same quota.
      if (!(await withinRateWindow(env, model, opts.decorative === true))) {
        lastDetail = `${model} is out of this minute's budget`;
        console.warn(`gemini: ${lastDetail}, dropping a tier without calling it`);
        break; // same handling as a 429, minus the wasted round trip
      }

      let res: Response;
      try {
        res = await callOnce(env, model, tuned, Math.min(perCall, left));
      } catch (err) {
        // A timeout is a transient condition, not a fatal one, and it was the
        // only one treated as fatal. 429/503/404 drop a tier, RECITATION and
        // MAX_TOKENS retry — a slow model got to end the whole turn instead.
        // /errors showed five straight "aborted due to timeout" against
        // route/apply on 14.08.2026, each one a message that simply failed,
        // with the faster fallback model sitting right there unasked.
        //
        // Dropping a tier rather than retrying the same model: whatever just
        // took the full per-call budget is not the one to ask again, and the
        // fallback exists precisely for the minute the primary is struggling.
        if (isTimeout(err)) {
          lastDetail = `${model} timed out after ${Math.min(perCall, left)}ms`;
          console.warn(`gemini: ${lastDetail}, dropping a tier`);
          break;
        }
        throw err;
      }

      if (TIER_DOWN.has(res.status)) {
        lastDetail = `${model} returned ${res.status}`;
        // Written down as well as stepped over. Without this the same 429 is
        // rediscovered on the next message, and the one after that — one
        // wasted round trip per blocked model per turn, out of a budget that
        // has to leave room for an answer. See migrations/014: the expiry IS
        // the probe, and a success wipes the record.
        const strikes = (health.get(model)?.strikes ?? 0) + 1;
        const wait = blockFor(
          res.status,
          res.status === 429 ? retryDelayMs(await res.text().catch(() => '')) : null,
          strikes,
        );
        await db
          .blockModel(env, model, Date.now() + wait, strikes, String(res.status))
          .catch((err) => console.error('blockModel', err));
        console.warn(`gemini: ${lastDetail}, dropping a tier and resting it ${Math.round(wait / 1000)}s`);
        break; // next model, not next attempt — retrying a quota error is pointless
      }
      /*
       * A 400 on a request carrying the union schema is the API saying it will
       * not accept that SHAPE — not that the model is busy, and not that this
       * message was bad. Dropping a tier would be pointless (every rung would
       * refuse it identically) and throwing would take the whole turn down.
       *
       * Retry once, same model, with the flat schema this file shipped up to
       * 0.26.0. `schema` is narrowed for the remainder of the ladder as well,
       * so a turn that also falls through to a second model does not rediscover
       * the same refusal there.
       *
       * Deliberately NOT remembered across turns. A schema the endpoint refuses
       * is a deploy-time mistake, and the cost of rediscovering it is one round
       * trip; the cost of hiding it is a broken deploy that looks healthy. The
       * model-health table exists for conditions that CLEAR on their own, and
       * this one does not.
       *
       * `schema !== opts.jsonSchemaFallback` is the same rule callOnce states
       * one level down, and callOnce's copy is the one that BITES: it only
       * hands a 400 back when there is still something to fall back to, so by
       * the time this line runs the condition already holds. Removing either
       * alone leaves the suite green. Removing both turns one refused schema
       * into 48 round trips — three attempts on each of eight rungs, twice
       * over — which is the loop the pair exists to prevent, and why the
       * red-proof for this version removes them together.
       */
      if (res.status === 400 && schema && opts.jsonSchemaFallback && schema !== opts.jsonSchemaFallback) {
        lastDetail = `${model} refused the response schema (400)`;
        console.warn(`gemini: ${lastDetail}, retrying with the flat schema`);
        // Written down, not just logged. The fallback WORKS, so a refused
        // union produces a good reply and no symptom whatsoever — the
        // guarantee would simply be off, silently, until somebody looked.
        // /diag reads this. Same argument as naming blocked models.
        await db.noteSchemaRefusal(env, model).catch((err) =>
          console.error('noteSchemaRefusal', err),
        );
        schema = opts.jsonSchemaFallback;
        continue; // same model, same attempt budget — the model is not at fault
      }
      if (!res.ok) {
        throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }

      const json = (await res.json()) as any;
      const parts = json?.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .map((p: any) => p.text ?? '')
        .join('')
        .trim();
      const finish = json?.candidates?.[0]?.finishReason ?? 'unknown';
      /*
       * A response that ran out of room mid-string is NOT an answer, and this
       * is the line that used to decide it was.
       *
       * `MAX_TOKENS` has been in RETRYABLE since RETRYABLE existed. It was
       * unreachable: the check below was `if (text)`, and a runaway that hit
       * the ceiling has plenty of text in it — just not text that parses. So
       * it returned, `JSON.parse` threw in generateJson, the turn died, and
       * the catch-block in respondToOwner filed his raw sentence as an inbox
       * row. That is errors #13, #14, #15, #16 and #17 — five turns, two
       * retries and four ladder rungs sitting unused each time.
       *
       * Scoped to `jsonSchema` deliberately. A truncated PERSONA line is still
       * Hebrew and still shippable, and it already has a validator and a
       * deterministic baseline behind it; discarding it would trade a clipped
       * sentence for no sentence. A truncated JSON object is worth nothing to
       * anybody. The retry above widens maxOutputTokens and nudges the
       * temperature, which is also what breaks the repetition loop these
       * spills actually are.
       */
      const truncated = !!opts.jsonSchema && finish === 'MAX_TOKENS';
      if (text && !truncated) {
        // Best-effort: a usage-tracking failure must never break a working reply.
        await db.recordUsage(env, model, opts.chatId).catch(() => {});
        // It answered, so whatever was held against it is over. Only written
        // when there was actually a row — otherwise every successful call
        // would cost a DELETE against a table that is empty on a good day.
        if (health.has(model)) {
          await db.clearModelBlock(env, model).catch((err) => console.error('clearModelBlock', err));
        }
        return text;
      }

      const u = json?.usageMetadata ?? {};
      lastDetail =
        `${model} finishReason=${finish} prompt=${u.promptTokenCount ?? '?'} ` +
        `thoughts=${u.thoughtsTokenCount ?? 0} out=${u.candidatesTokenCount ?? 0} ` +
        `chars=${text.length} attempt=${attempt + 1}`;

      if (!RETRYABLE.has(finish)) {
        const hint =
          finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT'
            ? ' — blocked by safety filters'
            : '';
        throw new Error(`gemini returned no text (${lastDetail})${hint}`);
      }
      // Two different conditions land here now, and telling them apart in the
      // log is the whole point of having chased this one: an EMPTY response is
      // a filter or a reasoning overrun, a TRUNCATED one is the model using a
      // string field as a scratchpad (see brain.ACTION_SCHEMA).
      console.warn(
        `gemini: ${truncated ? 'truncated' : 'empty'} response, retrying — ${lastDetail}`,
      );
    }
  }

  throw new Error(`gemini exhausted every tier (${lastDetail})`);
}

export async function generateJson<T>(env: Env, opts: GenerateOpts): Promise<T> {
  const raw = await generate(env, opts);
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Very occasionally the model fences the JSON despite responseMimeType.
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) return JSON.parse(m[0]) as T;
    // 200 chars was not enough to diagnose the 15-17.08.2026 truncations: the
    // response was cut off mid-string and the error was ALSO cut off, so
    // whether the model or the slice had truncated it could not be told apart
    // from /errors alone. The whole point of this row is being readable later.
    throw new Error(`gemini returned non-JSON (${raw.length} chars): ${raw.slice(0, 800)}`);
  }
}
