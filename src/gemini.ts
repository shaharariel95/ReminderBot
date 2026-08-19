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
    const used = await db.bumpRateWindow(env, minuteBucket(Date.now()), model);
    return used <= ceiling;
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
 */
const DEFAULT_LADDER = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
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
  const deadline = Date.now() + total;

  for (const model of tiers) {
    if (Date.now() >= deadline) break;
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) {
        lastDetail = `budget of ${total}ms exhausted on ${model}`;
        console.warn(`gemini: ${lastDetail}`);
        break;
      }
      const tuned: GenerateOpts = { ...opts };
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
      if (!res.ok) {
        throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }

      const json = (await res.json()) as any;
      const parts = json?.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .map((p: any) => p.text ?? '')
        .join('')
        .trim();
      if (text) {
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

      const reason = json?.candidates?.[0]?.finishReason ?? 'unknown';
      const u = json?.usageMetadata ?? {};
      lastDetail =
        `${model} finishReason=${reason} prompt=${u.promptTokenCount ?? '?'} ` +
        `thoughts=${u.thoughtsTokenCount ?? 0} out=${u.candidatesTokenCount ?? 0} ` +
        `attempt=${attempt + 1}`;

      if (!RETRYABLE.has(reason)) {
        const hint =
          reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT'
            ? ' — blocked by safety filters'
            : '';
        throw new Error(`gemini returned no text (${lastDetail})${hint}`);
      }
      console.warn(`gemini: empty response, retrying — ${lastDetail}`);
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
