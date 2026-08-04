import * as db from './db';
import { applyIntent } from './effects';
import { handleSlash } from './slash';
import { judgePhoto, route, speak, type Context } from './brain';
import { CHECKIN_GENERAL, CHECKIN_GOAL, GIVE_UP, NAG_LADDER } from './persona';
import { quickParse } from './quickparse';
import { getPhotoBase64, sendBurst, sendChatAction, sendMessage } from './telegram';
import { afterQuietHours, computeNext, formatLocal, isQuietHour, nextCheckinTime } from './time';
import { renderBaseline } from './voice';
import type { Effect, Env, Schedule } from './types';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') return new Response('ok');

    if (req.method !== 'POST' || url.pathname !== '/tg') {
      return new Response('not found', { status: 404 });
    }
    // Telegram echoes this header back on every webhook call. Without the check,
    // anyone who guesses the Worker URL can drive the bot.
    if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const update = (await req.json().catch(() => null)) as any;
    if (update) ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('update', e)));
    // Always 200 fast, or Telegram retries the same update.
    return new Response('ok');
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env).catch((e) => console.error('tick', e)));
  },
};

// ---------------------------------------------------------------- incoming

async function buildContext(env: Env, chatId: string): Promise<Context> {
  const [settings, stats, reminders, goals, open] = await Promise.all([
    db.getSettings(env, chatId),
    db.stats(env, chatId),
    db.listReminders(env, chatId),
    db.listGoals(env, chatId),
    db.openInstances(env, chatId),
  ]);
  return { settings, stats, reminders, goals, open, nowLabel: formatLocal(Date.now(), settings.tz) };
}

async function handleUpdate(update: any, env: Env): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg?.chat?.id) return;

  const chatId = String(msg.chat.id);

  // Single-user bot. Anyone else gets silence — but log the id so the owner
  // can discover their own chat_id during setup.
  if (!env.OWNER_CHAT_ID || env.OWNER_CHAT_ID === '0') {
    console.log(`chat_id = ${chatId}`);
    await sendMessage(env, chatId, `chat_id: ${chatId}\nשים אותו ב-OWNER_CHAT_ID ותפרוס מחדש.`);
    return;
  }
  if (chatId !== env.OWNER_CHAT_ID) {
    console.log(`ignored message from ${chatId}`);
    return;
  }

  const text: string = (msg.text ?? msg.caption ?? '').trim();
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  // Stickers, voice notes, location pins etc. — nothing to reason about.
  if (!text && !hasPhoto) return;

  if (text.startsWith('/')) {
    const reply = await handleSlash(env, chatId, text);
    if (reply) {
      await sendMessage(env, chatId, reply);
      return;
    }
  }

  await sendChatAction(env, chatId);

  // Any inbound message ends a chill period. If he is talking, he is available.
  const ctx = await buildContext(env, chatId);
  if (ctx.settings.muted_until && ctx.settings.muted_until > Date.now()) {
    await db.setMuted(env, chatId, null);
    ctx.settings.muted_until = null;
  }

  // Largest photo size is last in the array.
  const photo = hasPhoto ? msg.photo[msg.photo.length - 1] : null;
  const image = photo ? await getPhotoBase64(env, photo.file_id) : null;

  await db.addMessage(env, chatId, 'user', image ? `${text} [תמונה]`.trim() : text);
  const history = await db.recentMessages(env, chatId);

  let situation: string;
  let toneNote: string | undefined;

  try {
    // Common reminder phrasings never touch the router — see quickparse.ts.
    const fast = image ? null : quickParse(text, Date.now(), ctx.settings.tz);
    const intents =
      fast ? [fast] : await route(env, ctx, text, history.slice(0, -1), image ?? undefined);
    // Visible in `wrangler tail`. When the bot claims it did something it
    // didn't, this line is what tells you whether the router or the persona lied.
    console.log(`intent${fast ? ' (quickparse)' : ''}`, JSON.stringify(intents));

    const photoComplete = image ? intents.find((i) => i.action === 'complete') : undefined;

    if (intents.some((i) => i.distress)) {
      situation = `הוא כתב: "${text}". הוא נשמע במצוקה אמיתית.`;
      toneNote =
        'עקיפת מצוקה. תוריד את הדמות לגמרי. בלי עוקצנות, בלי רצפים, בלי משימות. תהיה בנאדם.';
    } else if (image && photoComplete) {
      const inst =
        ctx.open.find((i) => i.id === photoComplete.target_id) ??
        (ctx.open.length ? ctx.open[0] : null);
      if (!inst) {
        situation = `הוא שלח תמונה אבל אין משימה פתוחה שהיא יכולה להוכיח.`;
        toneNote = 'תשאל אותו בציניות מה זה אמור להיות.';
      } else {
        const verdict = await judgePhoto(env, inst.title, image, text);
        if (verdict.verdict === 'accepted') {
          await db.closeInstance(env, inst.id, 'done', `תמונה: ${verdict.reason}`);
          const fresh = await db.stats(env, chatId);
          situation = `הוא שלח הוכחה מצולמת ל-"${inst.title}" והיא התקבלה (${verdict.reason}). הרצף שלו עכשיו ${fresh.currentStreak}.`;
          toneNote = 'תן קרדיט אמיתי וקצר. הוא טרח לצלם, שזה ייחשב לו.';
        } else {
          situation = `הוא שלח תמונה כהוכחה ל-"${inst.title}", אבל היא לא קשורה (${verdict.reason}). המשימה נשארת פתוחה.`;
          toneNote = 'תעיר לו על הניסיון, בעוקצנות. המשימה עדיין פתוחה ושניכם יודעים את זה.';
        }
      }
    } else {
      // Applied in order, so "סיימתי, ותזכיר לי עוד שעה" closes the task before
      // the new reminder is written.
      const effects: Effect[] = [];
      for (const intent of intents) {
        effects.push(...(await applyIntent(env, chatId, ctx, intent, text)));
      }
      // Task 6 adds the model rewrite and the validator on top of this. Until
      // then the deterministic text goes out on its own, which is correct if
      // plain — never raw JSON, never a placeholder.
      situation = renderBaseline(effects, ctx.settings.tz);
      toneNote = undefined;
    }
  } catch (err) {
    console.error('route/apply', err);
    situation = `הוא כתב: "${text}". משהו אצלך בפנים נתקע ולא הצלחת להבין מה הוא רוצה.`;
    toneNote = 'תגיד לו בכנות ובקצרה שמשהו נתקע ושינסה שוב. בלי להתפלסף.';
  }

  let reply: string;
  try {
    reply = await speak(env, ctx, history, situation, toneNote);
  } catch (err) {
    console.error('speak', err);
    // Single-user bot: the owner is the only reader, so show him the real
    // error rather than a shrug. The API key travels in a header, never in
    // the URL, so it can't turn up in an error body.
    reply = `המוח שלי נפל לרגע.\n\n${String(err).slice(0, 900)}`;
  }

  const sent = await sendBurst(env, chatId, reply);
  // Store the burst as one turn so the model sees its own rhythm next time.
  if (sent.length) await db.addMessage(env, chatId, 'bot', sent.join('\n\n'));
  await db.pruneMessages(env, chatId);
}

// ---------------------------------------------------------------- cron tick

/**
 * One tick a minute does everything:
 *   1. fire reminders that came due
 *   2. nag open instances whose timer elapsed, shrinking the ask each round
 *   3. give up on instances that blew through max_nags and mark them failed
 *   4. occasionally start a conversation nobody asked for, about a stale goal
 * There is deliberately no cron job per reminder — that pattern caps out fast
 * and makes snoozing impossible.
 */
async function tick(env: Env): Promise<void> {
  const now = Date.now();
  const chatId = env.OWNER_CHAT_ID;
  if (!chatId || chatId === '0') return;

  const due = await db.dueReminders(env, now);
  const nags = await db.dueNags(env, now);
  const settings = await db.getSettings(env, chatId);

  const checkinDue =
    settings.checkins_enabled === 1 &&
    settings.next_checkin_at !== null &&
    settings.next_checkin_at <= now;

  // The overwhelmingly common case: nothing to do. Bail before building context.
  if (!due.length && !nags.length && !checkinDue) {
    if (settings.checkins_enabled === 1 && settings.next_checkin_at === null) {
      await db.setNextCheckin(
        env,
        chatId,
        nextCheckinTime(
          now,
          settings.tz,
          settings.checkin_per_day,
          settings.quiet_start_hour,
          settings.quiet_end_hour,
        ),
      );
    }
    return;
  }

  // Everything is single-user, so one context covers the whole tick.
  const ctx = await buildContext(env, chatId);
  const muted = !!ctx.settings.muted_until && ctx.settings.muted_until > now;
  const quiet = isQuietHour(
    now,
    ctx.settings.tz,
    ctx.settings.quiet_start_hour,
    ctx.settings.quiet_end_hour,
  );

  for (const r of due) {
    // Reschedule first: if the send throws, we still don't fire twice.
    let next: number | null = null;
    try {
      next = computeNext(JSON.parse(r.schedule) as Schedule, r.tz, now);
    } catch (err) {
      console.error(`bad schedule on reminder ${r.id}`, err);
    }
    await db.setNextFire(env, r.id, next);

    const instanceId = await db.createInstance(env, r, now);
    if (muted) continue;

    const situation = `הגיע הזמן של "${r.title}".${
      r.requires_proof ? ' המשימה הזאת דורשת הוכחה — הוא צריך לשלוח תמונה או לדווח.' : ''
    } זו התזכורת הראשונה.`;
    const delivered = await say(
      env,
      ctx,
      chatId,
      situation,
      NAG_LADDER[0],
      `נו? ${r.title}.${r.requires_proof ? '\n\nותשלח תמונה.' : ''}`,
    );
    console.log(
      `fired reminder ${r.id} → instance ${instanceId}${delivered ? '' : ' (DELIVERY FAILED)'}`,
    );
  }

  if (muted) return;

  for (const inst of nags) {
    if (inst.chat_id !== chatId) continue;
    const reminder = await db.getReminder(env, inst.reminder_id);
    const maxNags = reminder?.max_nags ?? 3;
    const interval = reminder?.nag_interval_min ?? 20;

    // Don't nag at 03:00. Defer without burning a round — an ignored 3am nag
    // isn't evidence of anything except that he was asleep.
    if (quiet) {
      await db.deferNag(
        env,
        inst.id,
        afterQuietHours(now, ctx.settings.tz, ctx.settings.quiet_start_hour, ctx.settings.quiet_end_hour),
      );
      continue;
    }

    if (inst.nag_count >= maxNags) {
      await db.closeInstance(env, inst.id, 'failed');
      await say(
        env,
        ctx,
        chatId,
        `הוא התעלם מ-"${inst.title}" ${inst.nag_count} פעמים. אתה סוגר את זה ככישלון.`,
        GIVE_UP,
        `סגרתי את "${inst.title}" ככישלון להיום.`,
      );
      continue;
    }

    const level = Math.min(3, inst.nag_count + 1);
    await db.bumpNag(env, inst.id, now + interval * 60_000);
    await say(
      env,
      ctx,
      chatId,
      `"${inst.title}" עדיין פתוחה מאז ${formatLocal(inst.fired_at, ctx.settings.tz)} והוא לא דיווח כלום.`,
      NAG_LADDER[level] ?? NAG_LADDER[3],
      `נו? "${inst.title}" עדיין פתוחה.`,
    );
  }

  if (checkinDue) await maybeCheckIn(env, ctx, chatId, now, quiet, due.length + nags.length > 0);
}

/**
 * An unprompted message about a goal that has gone quiet.
 * Skipped whenever he is already being chased about something — piling a
 * check-in on top of an open nag is how a bot goes from useful to noise.
 */
async function maybeCheckIn(
  env: Env,
  ctx: Context,
  chatId: string,
  now: number,
  quiet: boolean,
  busy: boolean,
): Promise<void> {
  const s = ctx.settings;
  const reschedule = (from: number) =>
    db.setNextCheckin(
      env,
      chatId,
      nextCheckinTime(from, s.tz, s.checkin_per_day, s.quiet_start_hour, s.quiet_end_hour),
    );

  if (quiet || busy || ctx.open.length > 0) {
    await reschedule(now);
    return;
  }

  const goal = await db.stalestGoal(env, chatId);

  if (!goal) {
    // Nothing to ask about. Stay silent rather than manufacture a topic.
    if (!ctx.reminders.length) {
      await reschedule(now);
      return;
    }
    await say(env, ctx, chatId, `אתה פותח שיחה מיוזמתך. אין לו מטרות רשומות, רק תזכורות.`, CHECKIN_GENERAL);
    await reschedule(Date.now());
    return;
  }

  const lastSeen = goal.last_progress_at
    ? `בפעם האחרונה שדיברתם על זה (${formatLocal(goal.last_progress_at, s.tz)}) הוא אמר: "${goal.last_progress}"`
    : 'הוא עוד לא דיווח על שום התקדמות במטרה הזאת';
  const since = goal.last_checkin_at
    ? `שאלת על זה לאחרונה ב-${formatLocal(goal.last_checkin_at, s.tz)}`
    : 'עוד לא שאלת על זה מעולם';

  await say(
    env,
    ctx,
    chatId,
    `אתה פותח שיחה מיוזמתך על המטרה "${goal.title}"${goal.why ? ` (הסיבה שלו: ${goal.why})` : ''}.
${lastSeen}. ${since}.`,
    CHECKIN_GOAL,
  );

  await db.markGoalCheckin(env, goal.id);
  await reschedule(Date.now());
}

/**
 * Voice a situation and send it.
 *
 * `fallback` is the whole point of this function's shape. Wording a reminder is
 * the model's job, but *delivering* it is not allowed to depend on the model
 * being reachable: Gemini's free tier rate-limits, and this used to swallow the
 * error, leaving a reminder that had already been marked as fired and a user
 * who was never told anything. Pass a fallback for anything the user is owed;
 * omit it for messages nobody asked for, where silence is the better failure.
 */
async function say(
  env: Env,
  ctx: Context,
  chatId: string,
  situation: string,
  toneNote: string,
  fallback?: string,
): Promise<boolean> {
  let text: string;
  try {
    const history = await db.recentMessages(env, chatId, 8);
    text = await speak(env, ctx, history, situation, toneNote);
  } catch (err) {
    console.error('say/speak', err);
    if (!fallback) return false;
    console.warn('say: delivering plain fallback instead');
    text = fallback;
  }

  try {
    const sent = await sendBurst(env, chatId, text);
    if (sent.length) await db.addMessage(env, chatId, 'bot', sent.join('\n\n'));
    return sent.length > 0;
  } catch (err) {
    console.error('say/send', err);
    return false;
  }
}
