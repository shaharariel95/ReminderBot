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

async function post(env: Env, model: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
}

/** One round trip, including the thinking-parameter fallback. */
async function callOnce(env: Env, model: string, opts: GenerateOpts): Promise<Response> {
  let res = await post(env, model, buildBody(opts, thinkingConfig(model, opts)));

  // A 400 here is nearly always the thinking parameter, but the error body
  // doesn't say so. Retry once with no thinking config at all — that shape is
  // valid on every model, so the bot keeps working through future renames.
  if (res.status === 400) {
    const first = await res.text();
    const retry = await post(env, model, buildBody(opts, null));
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

function tiers(env: Env): string[] {
  const primary = env.GEMINI_MODEL ?? 'gemini-3.5-flash';
  const fallback = env.GEMINI_MODEL_FALLBACK ?? 'gemini-3.5-flash-lite';
  return primary === fallback ? [primary] : [primary, fallback];
}

export async function generate(env: Env, opts: GenerateOpts): Promise<string> {
  let lastDetail = '';

  for (const model of tiers(env)) {
    for (let attempt = 0; attempt < 3; attempt++) {
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

      const res = await callOnce(env, model, tuned);

      if (TIER_DOWN.has(res.status)) {
        lastDetail = `${model} returned ${res.status}`;
        console.warn(`gemini: ${lastDetail}, dropping a tier`);
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
        await db.recordUsage(env, model).catch(() => {});
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
    throw new Error(`gemini returned non-JSON: ${raw.slice(0, 200)}`);
  }
}
