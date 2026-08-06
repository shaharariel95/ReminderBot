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

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      await sendChatAction(env, chatId);
      // Long enough to read as typing, short enough not to feel laggy.
      await new Promise((r) => setTimeout(r, Math.min(1600, 500 + chunks[i].length * 22)));
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
