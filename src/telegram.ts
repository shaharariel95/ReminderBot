import type { Env } from './types';

const API = 'https://api.telegram.org';

async function call(env: Env, method: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: any };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description}`);
  return json.result;
}

export async function sendMessage(
  env: Env,
  chatId: string,
  text: string,
  replyMarkup?: unknown,
): Promise<number | null> {
  const trimmed = text.trim().slice(0, 4000);
  if (!trimmed) return null;
  const res = await call(env, 'sendMessage', {
    chat_id: chatId,
    text: trimmed,
    // No parse_mode on purpose: the model writes plain prose and stray
    // asterisks or underscores would otherwise 400 the whole request.
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return res?.message_id ?? null;
}

/**
 * How long to pause before the next message in a burst.
 *
 * The old value was `500 + len*22` capped at 1.6s — about 45 characters per
 * second, faster than anyone types, and the cap flattened every message over
 * 50 characters to the same delay. ~22 chars/sec with jitter reads as a person.
 */
export function pacingDelay(len: number, rand: () => number = Math.random): number {
  const base = 700 + len * 45;
  const jittered = base * (0.8 + rand() * 0.4);
  return Math.round(Math.min(5000, Math.max(900, jittered)));
}

/** Total time a burst may spend pacing, so a long reply cannot stall the worker. */
const BURST_BUDGET_MS = 15_000;

async function realSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The wait `sendBurst` uses between chunks. Production never touches this;
 * the test harness swaps it for something instant (see `setBurstSleepForTests`)
 * so a multi-chunk reply doesn't cost real wall-clock time in the suite —
 * nothing in the tests asserts sendBurst's actual pacing, only pacingDelay's
 * return value and the chunk/markup behaviour, so stubbing it changes no
 * assertion's meaning.
 */
let burstSleep: (ms: number) => Promise<void> = realSleep;

/** Test-only seam — see `burstSleep` above. */
export function setBurstSleepForTests(fn: (ms: number) => Promise<void>): void {
  burstSleep = fn;
}

/**
 * Send a reply as a burst of short messages instead of one block.
 * The model separates them with a blank line. The rhythm is a real part of the
 * personality — one long paragraph reads like a form letter no matter how
 * good the words are.
 */
export async function sendBurst(
  env: Env,
  chatId: string,
  text: string,
  replyMarkup?: unknown,
): Promise<string[]> {
  const chunks = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

  if (!chunks.length) return [];

  let spent = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      const delay = Math.min(pacingDelay(chunks[i].length), BURST_BUDGET_MS - spent);
      if (delay > 0) {
        await sendChatAction(env, chatId);
        await burstSleep(delay);
        spent += delay;
      }
    }
    await sendMessage(env, chatId, chunks[i], i === chunks.length - 1 ? replyMarkup : undefined);
  }
  return chunks;
}

/** Must fire before any other work or Telegram spins for 30 seconds. */
export async function answerCallback(env: Env, id: string, text?: string): Promise<void> {
  try {
    await call(env, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  } catch {
    /* cosmetic */
  }
}

/**
 * Strip the buttons and stamp the outcome into the original message. Without
 * this, a button tapped a week later produces a real write and a false streak.
 */
export async function settleButtons(
  env: Env,
  chatId: string,
  messageId: number,
  originalText: string,
  suffix: string,
): Promise<void> {
  // editMessageText both rewrites the body and drops the keyboard in one call.
  // (editMessageCaption is for media messages and fails on a text message.)
  try {
    await call(env, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `${originalText}\n\n${suffix}`.slice(0, 4000),
      reply_markup: { inline_keyboard: [] },
    });
  } catch (err) {
    // "message is not modified" and "message to edit not found" are both
    // expected in normal use; the buttons still need to go.
    console.warn('settleButtons', err);
    await call(env, 'editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
}

/** A reaction on the user's own message — instant acknowledgment, ~200ms. */
export async function react(env: Env, chatId: string, messageId: number, emoji: string): Promise<void> {
  try {
    await call(env, 'setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
  } catch {
    /* cosmetic */
  }
}

export async function sendChatAction(env: Env, chatId: string): Promise<void> {
  try {
    await call(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {
    /* cosmetic only */
  }
}

/**
 * A `setTimeout` wait that can be cancelled early. `cancel()` both clears the
 * pending native timer (so it never fires and never keeps the process alive)
 * and resolves the promise immediately — clearing the timer alone would leave
 * `promise` unresolved forever, since nothing else would ever call `resolve`.
 */
function cancellableDelay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let id: ReturnType<typeof setTimeout>;
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    id = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(id);
      resolveFn();
    },
  };
}

/**
 * Keep the typing indicator alive for the duration of `fn`.
 *
 * Telegram's indicator expires after about five seconds. A single
 * sendChatAction before an eight-second model call therefore shows typing, then
 * dead air, then a message — which reads as broken rather than thoughtful.
 *
 * `intervalMs` defaults to Telegram's ~5s expiry minus headroom, but is a
 * parameter so a test can use a short interval and prove the heartbeat
 * actually re-fires without sleeping for real seconds.
 *
 * Cancellation matters here: setting a flag does not interrupt an in-flight
 * `setTimeout`, so a naive version would still block up to `intervalMs` in
 * the `finally` after `fn()` has already resolved — adding dead air to every
 * single reply on the one task whose entire point is removing dead air. The
 * heartbeat loop only ever awaits a `cancellableDelay`, so `cancel()` here
 * always returns it (and the loop) immediately.
 */
export async function withTyping<T>(
  env: Env,
  chatId: string,
  fn: () => Promise<T>,
  intervalMs = 4000,
): Promise<T> {
  let live = true;
  // Boxed in an object rather than a bare `let`: a bare `(() => void) | null`
  // variable reassigned only inside the `beat` closure gets narrowed by TS's
  // control-flow analysis to `null` at the read site below (a known quirk
  // with closures over union-typed lets), which is a type error, not a
  // runtime one — a plain property access sidesteps it.
  const state: { cancel: (() => void) | null } = { cancel: null };

  const beat = async () => {
    while (live) {
      await sendChatAction(env, chatId);
      if (!live) break;
      const { promise, cancel } = cancellableDelay(intervalMs);
      state.cancel = cancel;
      await promise;
      state.cancel = null;
    }
  };

  // A failure inside the heartbeat must never surface as an unhandled
  // rejection or reject into the caller. sendChatAction already swallows its
  // own errors; this is defence against anything else in the loop throwing.
  const pump = beat().catch((err) => {
    console.error('withTyping heartbeat', err);
  });

  try {
    return await fn();
  } finally {
    live = false;
    state.cancel?.();
    await pump;
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Download a Telegram photo and return it base64-encoded for Gemini. */
export async function getPhotoBase64(
  env: Env,
  fileId: string,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const file = await call(env, 'getFile', { file_id: fileId });
    const path: string | undefined = file?.file_path;
    if (!path) return null;
    const res = await fetch(`${API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // Telegram photos are always JPEG; documents may vary.
    const mimeType = res.headers.get('content-type') ?? 'image/jpeg';
    return { data: toBase64(buf), mimeType: mimeType.split(';')[0] };
  } catch (err) {
    console.error('getPhotoBase64', err);
    return null;
  }
}
