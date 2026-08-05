import * as db from './db';
import { applyIntent } from './effects';
import { handleSlash } from './slash';
import { judgePhoto, route, speak, type Context } from './brain';
import { buildFacts } from './facts';
import { validate } from './validate';
import { CHECKIN_GOAL, GIVE_UP, NAG_LADDER } from './persona';
import { quickParse } from './quickparse';
import { getPhotoBase64, sendBurst, sendChatAction, sendMessage } from './telegram';
import { afterQuietHours, computeNext, formatLocal, isQuietHour, nextCheckinTime } from './time';
import { renderBaseline } from './voice';
import type { Effect, Env, Intent, Schedule } from './types';

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

  let effects: Effect[] = [];
  let toneNote: string | undefined;

  try {
    // Common reminder phrasings never touch the router — see quickparse.ts.
    const fast = image ? null : quickParse(text, Date.now(), ctx.settings.tz);
    const intents = fast
      ? [fast]
      : await route(env, ctx, text, history.slice(0, -1), image ?? undefined);
    // Visible in `wrangler tail`. When the bot claims it did something it
    // didn't, this line is what tells you whether the router or the persona lied.
    console.log(`intent${fast ? ' (quickparse)' : ''}`, JSON.stringify(intents));

    const photoComplete = image ? intents.find((i) => i.action === 'complete') : undefined;

    if (intents.some((i) => i.distress)) {
      effects = [{ kind: 'distress', text }];
      toneNote =
        'עקיפת מצוקה. תוריד את הדמות לגמרי. בלי עוקצנות, בלי משימות. תהיה בנאדם.';
    } else if (image && photoComplete) {
      effects = await applyPhoto(env, chatId, ctx, photoComplete, image, text);
    } else {
      // Applied in order, so "סיימתי, ותזכיר לי עוד שעה" closes the task before
      // the new reminder is written.
      for (const intent of intents) {
        effects.push(...(await applyIntent(env, chatId, ctx, intent, text)));
      }
      if (effects.length > 1) {
        toneNote = 'קרו כמה דברים. תתייחס לכולם בתשובה אחת קצרה, בלי לחזור על עצמך.';
      }
    }
  } catch (err) {
    console.error('route/apply', err);
    // A capture must survive a broken router. Anything that looks like a
    // reminder request lands in the inbox rather than being lost to an error.
    if (/תזכיר|תזכורת|תנדנד|remind/i.test(text)) {
      const id = await db.addInboxItem(env, chatId, text.slice(0, 200), ctx.settings.tz);
      effects = [{ kind: 'reminder_captured', id, title: text.slice(0, 200) }];
    } else {
      effects = [{ kind: 'nothing', why: 'chat', userText: text }];
    }
  }

  await sendOutcome(env, chatId, ctx, effects, toneNote);
  await db.pruneMessages(env, chatId);
}

/** Judge a submitted photo against the open instance it is meant to prove. */
async function applyPhoto(
  env: Env,
  chatId: string,
  ctx: Context,
  intent: Intent,
  image: { data: string; mimeType: string },
  caption: string,
): Promise<Effect[]> {
  const inst =
    ctx.open.find((i) => i.id === intent.target_id) ?? (ctx.open.length ? ctx.open[0] : null);
  if (!inst) return [{ kind: 'nothing', why: 'no_open_task', userText: caption }];

  const verdict = await judgePhoto(env, inst.title, image, caption);
  if (verdict.verdict !== 'accepted') {
    return [
      { kind: 'photo_rejected', instanceId: inst.id, title: inst.title, reason: verdict.reason },
    ];
  }
  await db.closeInstance(env, inst.id, 'done', `תמונה: ${verdict.reason}`);
  const fresh = await db.stats(env, chatId);
  return [
    {
      kind: 'photo_accepted', instanceId: inst.id, title: inst.title,
      reason: verdict.reason, streak: fresh.currentStreak,
    },
  ];
}

/**
 * The only way a message reaches the user.
 *
 * baseline → model rewrite → validation → send. Every branch ends in something
 * being sent: a rejected or failed rewrite falls back to the baseline, which is
 * correct by construction.
 */
async function sendOutcome(
  env: Env,
  chatId: string,
  ctx: Context,
  effects: Effect[],
  toneNote?: string,
): Promise<void> {
  const facts = buildFacts(ctx, effects, ctx.settings.tz);
  const baseline = renderBaseline(effects, ctx.settings.tz);
  if (!baseline.trim()) return;

  let text = baseline;
  try {
    const history = await db.recentMessages(env, chatId, 8);
    const dressed = await speak(env, facts, history, baseline, toneNote);
    // Same-turn baseline, never a cached or recomputed one — it's what the
    // validator's allow-lists are built from and what speak() just saw.
    const verdict = validate(dressed, facts, baseline);
    if (verdict.ok) {
      text = dressed;
    } else {
      console.warn(`validator rejected the rewrite: ${verdict.reason}`);
      await db.recordRejection(env);
    }
  } catch (err) {
    console.error('speak', err);
  }

  const sent = await sendBurst(env, chatId, text);
  if (sent.length) await db.addMessage(env, chatId, 'bot', sent.join('\n\n'));
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

    await sendOutcome(env, chatId, ctx,
      [{ kind: 'reminder_fired', id: r.id, title: r.title, instanceId, requiresProof: r.requires_proof === 1 }],
      NAG_LADDER[0]);
    console.log(`fired reminder ${r.id} → instance ${instanceId}`);
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
      await sendOutcome(env, chatId, ctx,
        [{ kind: 'gave_up', instanceId: inst.id, title: inst.title, rounds: inst.nag_count }],
        GIVE_UP);
      continue;
    }

    const level = Math.min(3, inst.nag_count + 1);
    await db.bumpNag(env, inst.id, now + interval * 60_000);
    await sendOutcome(env, chatId, ctx,
      [{ kind: 'nagged', instanceId: inst.id, title: inst.title, since: inst.fired_at, round: level }],
      NAG_LADDER[level] ?? NAG_LADDER[3]);
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

  // No goal means nothing real to ask about. Staying silent beats manufacturing
  // a topic — an unprompted "what's on your plate?" with nothing behind it is
  // exactly what reads as a broken bot.
  if (!goal) {
    await reschedule(now);
    return;
  }

  await sendOutcome(env, chatId, ctx,
    [{ kind: 'checkin_goal', id: goal.id, title: goal.title, why: goal.why,
       lastProgress: goal.last_progress, lastProgressAt: goal.last_progress_at,
       lastCheckinAt: goal.last_checkin_at }],
    CHECKIN_GOAL);

  await db.markGoalCheckin(env, goal.id);
  await reschedule(Date.now());
}
