import * as db from './db';
import { applyIntent } from './effects';
import { handleSlash } from './slash';
import { judgePhoto, route, speak, type Context } from './brain';
import { buildFacts } from './facts';
import { validate } from './validate';
import { CHECKIN_GOAL, GIVE_UP, NAG_LADDER } from './persona';
import { findFutureInstant, quickParse } from './quickparse';
import {
  answerCallback,
  getPhotoBase64,
  react,
  sendBurst,
  sendMessage,
  settleButtons,
  withTyping,
} from './telegram';
import { buttonsFor, decode, keyboard } from './buttons';
import {
  afterQuietHours,
  computeNext,
  formatLocal,
  isQuietHour,
  localDateKey,
  localDayBounds,
  nextCheckinTime,
  planSlotInstant,
  wallParts,
  wallString,
  wallToUtc,
} from './time';
import { renderBaseline } from './voice';
import { VERSION } from './version';
import type { Effect, Env, Facts, Intent, Schedule } from './types';

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
    if (update) {
      const job = update.callback_query
        ? handleCallback(update, env)
        : handleUpdate(update, env);
      ctx.waitUntil(job.catch((e) => console.error('update', e)));
    }
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

  // Everything past here touches D1, Telegram and the model, and until this
  // guard existed only the middle of it was protected: sendOutcome has always
  // caught its own failures, but a throw in buildContext, addMessage or
  // recentMessages — the reads and writes AROUND it — unwound straight out to
  // fetch()'s `job.catch` and the turn ended without a word.
  //
  // Silence is the worst answer this bot can give. It is indistinguishable
  // from being down, and it lands exactly when he has just reported doing the
  // thing and is waiting to hear that it counted. A photo captioned "הנה הנה
  // נוסע עכשיו" went unanswered on 10.08.2026; this is the class of path that
  // can do that.
  try {
    await respondToOwner(env, chatId, msg, text, hasPhoto);
  } catch (err) {
    console.error('handleUpdate', err);
    // Says only what is certainly true. Something may well have been written
    // before the throw, so this must neither confirm nor deny the work —
    // claiming either would be the exact failure the rest of the pipeline
    // exists to prevent.
    await sendMessage(env, chatId, TURN_FAILED).catch((e) =>
      console.error('last-resort send', e),
    );
  }
}

/** The last thing he hears when a turn falls over. Honest, and claims nothing. */
const TURN_FAILED = 'נפל לי משהו באמצע ולא סיימתי את זה. תגיד שוב — ואם זה חוזר, /diag.';

/**
 * One inbound message from the owner, from acknowledgment to reply.
 *
 * Split out of handleUpdate so the whole of it sits inside one guard. The
 * gates above it (auth, slash commands) deliberately stay outside: they answer
 * for themselves and have nothing half-finished to report.
 */
async function respondToOwner(
  env: Env,
  chatId: string,
  msg: any,
  text: string,
  hasPhoto: boolean,
): Promise<void> {
  // Instant acknowledgment. The considered reply follows; this lands in ~200ms
  // and is the difference between "present" and "processing". Fires before
  // the model is ever consulted, on the user's own message — there is no
  // equivalent on the cron path, since there's no incoming message to react to.
  if (msg.message_id) await react(env, chatId, msg.message_id, '👀');

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
      const photoResult = await applyPhoto(env, chatId, ctx, photoComplete, image, text);
      effects = photoResult.effects;
      toneNote = photoResult.toneNote;
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
    // Effects already committed earlier in this turn (e.g. the first half of
    // "סיימתי, ותזכיר לי עוד שעה" before the second intent threw) are kept,
    // never overwritten — losing a real write here would be the exact "the
    // bot claims something it didn't do" bug this whole pipeline exists to
    // prevent.
    if (/תזכיר|תזכורת|תנדנד|remind/i.test(text)) {
      const id = await db.addInboxItem(env, chatId, text.slice(0, 200), ctx.settings.tz);
      effects.push({ kind: 'reminder_captured', id, title: text.slice(0, 200) });
    } else if (effects.length === 0) {
      effects = [{ kind: 'nothing', why: 'chat', userText: text }];
    }
  }

  await sendOutcome(env, chatId, ctx, effects, toneNote, 'high', history);
}

/** Snooze minutes taken straight off a button, unlike applyIntent's model-derived
 *  path — decode() bounds hour/minute but not this, so a crafted callback_data
 *  like 's:1:999999999' would otherwise reach db.snoozeInstance unclamped. */
const clampSnooze = (minutes: number) => Math.min(720, Math.max(5, minutes));

/**
 * An inline button tap. Zero model calls: the effect is known from the payload,
 * and voice.ts already has correct Hebrew for it. This is the fastest path in
 * the bot and the reason it feels responsive.
 */
async function handleCallback(update: any, env: Env): Promise<void> {
  const q = update.callback_query;
  const chatId = String(q?.message?.chat?.id ?? '');
  const fromId = String(q?.from?.id ?? '');

  // Answer first — Telegram spins for 30s otherwise — but only for the owner.
  // This is a new unauthenticated inbound path that writes to D1, so a
  // leaked or guessed message id must not be a free write: check auth
  // before touching the database, and before even answering the spinner,
  // so a stranger's callback_query_id leaks nothing back either.
  //
  // No separate "!env.OWNER_CHAT_ID" clause: `chatId !== env.OWNER_CHAT_ID`
  // already fails closed on an unset/empty OWNER_CHAT_ID by itself. `!chatId`
  // just above guarantees chatId is a non-empty string here, and a non-empty
  // string can never `===` a falsy value ('', undefined) — so a misconfigured
  // deployment can't accidentally authorise anyone. (Verified by exhaustive
  // enumeration, not just this argument: adding the clause back never changes
  // the outcome for any chatId/fromId/OWNER_CHAT_ID combination — it is a
  // provable tautology given the other three clauses, which is also why a
  // "delete it and see if a test goes red" check can't distinguish it: no
  // input exists for which it would.)
  if (!chatId || fromId !== env.OWNER_CHAT_ID || chatId !== env.OWNER_CHAT_ID) {
    console.log(`ignored callback from ${fromId}`);
    return;
  }
  await answerCallback(env, q.id);

  const cb = decode(String(q.data ?? ''));
  const effects: Effect[] = [];

  // An undecodable payload still needs its keyboard settled — it isn't
  // exempt from "always settle," it's just the one case with nothing to do.
  if (!cb) {
    console.warn(`undecodable callback_data: ${q.data}`);
  } else {
    switch (cb.t) {
      case 'done': {
        const inst = await db.getInstance(env, cb.instance);
        if (inst && (await db.closeIfOpen(env, cb.instance, 'done', 'כפתור'))) {
          const fresh = await db.stats(env, chatId);
          effects.push({ kind: 'instance_done', id: inst.id, title: inst.title, streak: fresh.currentStreak });
        }
        break;
      }
      case 'skip': {
        const inst = await db.getInstance(env, cb.instance);
        if (inst && (await db.closeIfOpen(env, cb.instance, 'skipped', 'כפתור'))) {
          effects.push({ kind: 'instance_skipped', id: inst.id, title: inst.title });
        }
        break;
      }
      case 'snooze': {
        const inst = await db.getInstance(env, cb.instance);
        if (inst && inst.status === 'open') {
          const minutes = clampSnooze(cb.minutes);
          await db.snoozeInstance(env, cb.instance, minutes);
          effects.push({
            kind: 'instance_snoozed', id: inst.id, title: inst.title,
            until: Date.now() + minutes * 60_000, minutes,
          });
        }
        break;
      }
      case 'followup': {
        // The appointment is re-derived from the same title by the same
        // function that offered it, rather than being carried in the payload:
        // callback_data has 64 bytes and a title does not fit, and re-deriving
        // means the label he tapped and the row that gets written cannot
        // disagree about when.
        const inst = await db.getInstance(env, cb.instance);
        const settings = await db.getSettings(env, chatId);
        const at = inst ? findFutureInstant(inst.title, Date.now(), settings.tz) : null;
        if (inst && at !== null && at > Date.now()) {
          const schedule: Schedule = { type: 'once', at: wallString(at, settings.tz) };
          const id = await db.addReminder(env, {
            chat_id: chatId,
            title: inst.title,
            notes: null,
            schedule: JSON.stringify(schedule),
            tz: settings.tz,
            requires_proof: 0,
            proof_type: 'any',
            nag_interval_min: 20,
            max_nags: 3,
            next_fire_at: at,
          });
          effects.push({ kind: 'reminder_created', id, title: inst.title, at, schedule, requiresProof: false });
        }
        break;
      }

      case 'tomorrow': {
        const inst = await db.getInstance(env, cb.instance);
        if (inst) {
          // Two kinds of thing carry this button. One is still open and needs
          // closing; the other the bot already gave up on hours ago and is
          // closed already. Gating the whole branch on closeIfOpen made the
          // button a no-op for exactly the tasks that most need it — the ones
          // with no other way back.
          if (
            inst.status === 'open' &&
            (await db.closeIfOpen(env, cb.instance, 'skipped', 'נדחה למחר'))
          ) {
            effects.push({ kind: 'instance_skipped', id: inst.id, title: inst.title });
          }
          const rem = await db.getReminder(env, inst.reminder_id);
          // A recurring reminder already has tomorrow covered by its own rule —
          // overwriting it with a one-off would silently end the recurrence,
          // which is a far worse outcome than the tap doing slightly less.
          let schedule: Schedule | null = null;
          try {
            schedule = rem ? (JSON.parse(rem.schedule) as Schedule) : null;
          } catch {
            /* unparseable schedule: leave it alone */
          }
          if (rem && schedule?.type === 'once') {
            const p = wallParts(inst.fired_at, rem.tz);
            const at = wallToUtc(p.year, p.month, p.day + 1, p.hour, p.minute, rem.tz);
            const next: Schedule = { type: 'once', at: wallString(at, rem.tz) };
            if (await db.retimeReminder(env, rem.id, at, JSON.stringify(next))) {
              effects.push({ kind: 'reminder_retimed', id: rem.id, title: rem.title, at });
            }
          }
        }
        break;
      }
      case 'retime': {
        const rem = await db.getReminder(env, cb.reminder);
        if (rem) {
          const hhmm = `${String(cb.hour).padStart(2, '0')}:${String(cb.minute).padStart(2, '0')}`;
          let existing: Schedule | null = null;
          try {
            existing = JSON.parse(rem.schedule) as Schedule;
          } catch {
            /* unparseable: treated as a one-off below */
          }

          // Correcting the HOUR must not also change the KIND of reminder.
          // This branch used to write a `once` schedule unconditionally, which
          // would have turned "כל יום ב-7" into a single 19:00 reminder the
          // moment he tapped "לא, 19:00" — ending the recurrence silently,
          // which is the worst outcome a correction button could have.
          const schedule: Schedule =
            existing?.type === 'daily'
              ? { type: 'daily', time: hhmm }
              : existing?.type === 'weekly'
                ? { type: 'weekly', time: hhmm, days: existing.days }
                : { type: 'once', at: '' };
          let at: number;
          if (schedule.type === 'once') {
            const p = wallParts(Date.now(), rem.tz);
            at = wallToUtc(p.year, p.month, p.day, cb.hour, cb.minute, rem.tz);
            if (at <= Date.now()) at += 86_400_000;
            schedule.at = wallString(at, rem.tz);
          } else {
            at = computeNext(schedule, rem.tz, Date.now()) ?? Date.now();
          }

          // Gated on status inside the query, same as the other branches — a
          // retime tapped after the reminder was deleted must not un-cancel it.
          if (await db.retimeReminder(env, rem.id, at, JSON.stringify(schedule))) {
            effects.push({ kind: 'reminder_retimed', id: rem.id, title: rem.title, at });
          }
        }
        break;
      }
      case 'plan': {
        const rem = await db.getReminder(env, cb.reminder);
        if (rem && rem.status === 'inbox') {
          if (cb.slot === 'none') {
            effects.push({ kind: 'listed_inbox', rows: await db.listInbox(env, chatId) });
          } else {
            const at = planSlotInstant(cb.slot, rem.tz);
            const schedule: Schedule = { type: 'once', at: wallString(at, rem.tz) };
            if (await db.scheduleInboxItem(env, rem.id, at, JSON.stringify(schedule))) {
              effects.push({ kind: 'reminder_scheduled', id: rem.id, title: rem.title, at });
            }
          }
        }
        break;
      }
    }
  }

  // Always settle, even when the tap produced no effect (already closed,
  // stale data, undecodable payload): the user must see the tap registered
  // either way.
  await settleButtons(
    env, chatId, Number(q.message.message_id),
    String(q.message.text ?? ''),
    effects.length ? '✓' : '—',
  );
  if (effects.length) {
    // Context is only built now, after the writes: building it up front (as a
    // no-effect tap used to) wasted four D1 reads on the common case, and
    // building it before the switch made ctx.stats/ctx.open stale by the time
    // sendOutcome saw them — the instance this same tap just closed would
    // still read as open. priority 'none' — the effect and its Hebrew wording
    // are already known (voice.ts), so the whole point of a button is that it
    // never touches the model. This is what keeps a tap free of both latency
    // and quota.
    const ctx = await buildContext(env, chatId);
    await sendOutcome(env, chatId, ctx, effects, undefined, 'none');
  }
}


/** Judge a submitted photo against the open instance it is meant to prove. */
async function applyPhoto(
  env: Env,
  chatId: string,
  ctx: Context,
  intent: Intent,
  image: { data: string; mimeType: string },
  caption: string,
): Promise<{ effects: Effect[]; toneNote?: string }> {
  const inst =
    ctx.open.find((i) => i.id === intent.target_id) ?? (ctx.open.length ? ctx.open[0] : null);
  if (!inst) return { effects: [{ kind: 'nothing', why: 'no_open_task', userText: caption }] };

  const verdict = await judgePhoto(env, inst.title, image, caption);
  if (verdict.verdict !== 'accepted') {
    return {
      effects: [
        { kind: 'photo_rejected', instanceId: inst.id, title: inst.title, reason: verdict.reason },
      ],
      toneNote: 'תעיר לו על הניסיון, בעוקצנות. המשימה עדיין פתוחה ושניכם יודעים את זה.',
    };
  }
  await db.closeInstance(env, inst.id, 'done', `תמונה: ${verdict.reason}`);
  const fresh = await db.stats(env, chatId);
  return {
    effects: [
      {
        kind: 'photo_accepted', instanceId: inst.id, title: inst.title,
        reason: verdict.reason, streak: fresh.currentStreak,
      },
    ],
    toneNote: 'תן קרדיט אמיתי וקצר. הוא טרח לצלם, שזה ייחשב לו.',
  };
}

/**
 * The only way a message reaches the user.
 *
 * baseline → model rewrite → validation → send. Every branch ends in something
 * being sent: a rejected or failed rewrite falls back to the baseline, which is
 * correct by construction.
 *
 * Returns whether the send actually reached Telegram. The send itself is
 * inside its own try: a 429 or network error here must not propagate — this
 * is called once per due reminder/nag/give-up inside a loop in `tick`, and an
 * uncaught throw here used to abort every remaining item in that tick, after
 * their state mutations (closeInstance, bumpNag) had already committed. That
 * is a reminder marked delivered that the user never received — the original
 * bug this project exists to fix.
 *
 * buildFacts/renderBaseline are pure functions over an exhaustively-typed
 * union — there is no throwing case constructible today — but they sit
 * inside the same guard as everything else here anyway: this whole function
 * exists to keep one bad turn from aborting the rest of a tick, and a future
 * edit to voice.ts or facts.ts reintroducing a throw path should degrade to
 * the generic fallback below, not take the tick down with it.
 */
async function sendOutcome(
  env: Env,
  chatId: string,
  ctx: Context,
  effects: Effect[],
  toneNote?: string,
  priority: 'high' | 'low' | 'none' = 'high',
  /**
   * Recent turns, when the caller already has them. handleUpdate reads them a
   * moment earlier to give the router conversational context, and re-reading
   * the same rows here was a second query for an identical answer — nothing is
   * written to `messages` in between. Callers without one (the cron, button
   * taps) leave it out and it is read on demand.
   */
  history?: { role: 'user' | 'bot'; text: string }[],
): Promise<boolean> {
  let facts: Facts | null = null;
  let baseline: string;
  try {
    facts = buildFacts(ctx, effects, ctx.settings.tz);
    baseline = renderBaseline(effects, ctx.settings.tz);
  } catch (err) {
    console.error('buildFacts/renderBaseline', err);
    // No facts means nothing for speak()/validate() to check a rewrite
    // against, so this skips the model entirely below and ships a message
    // that is still true, if generic — never silence, never an invented one.
    baseline = 'קרתה תקלה אצלי עם ההודעה הזאת. תבדוק /diag אם זה חוזר.';
  }

  if (!baseline.trim()) {
    // Every known effect kind renders non-empty text (see voice.ts); this is
    // defence against a future kind that doesn't, so the silence leaves a
    // trace instead of vanishing.
    console.warn('sendOutcome: empty baseline', JSON.stringify(effects));
    return false;
  }

  let text = baseline;
  if (facts && (await modelAllowed(env, priority))) {
    try {
      const [recent, notes] = await Promise.all([
        history ? Promise.resolve(history.slice(-8)) : db.recentMessages(env, chatId, 8),
        db.listProfileNotes(env, chatId).catch(() => []),
      ]);
      // Read here rather than in buildContext so the paths that never speak —
      // every button tap — do not pay for it. The notes go into `quotable` as
      // well as `profile`: the model is shown them, so it may truthfully quote
      // one back, and the validator has to know that is allowed.
      const spoken: Facts = {
        ...facts,
        profile: notes.map((n) => n.note),
        quotable: [...facts.quotable, ...notes.map((n) => n.note)],
      };
      const dressed = await withTyping(env, chatId, () =>
        speak(env, spoken, recent, baseline, toneNote),
      );
      // Same-turn baseline, never a cached or recomputed one — it's what the
      // validator's allow-lists are built from and what speak() just saw.
      const verdict = validate(dressed, spoken, baseline);
      if (verdict.ok) {
        text = dressed;
      } else {
        console.warn(`validator rejected the rewrite: ${verdict.reason}`);
        // Written down, not just counted. The console line above survives
        // only as long as a `wrangler tail` someone happened to be running;
        // this is what /diag can still read tomorrow. Best-effort — the user
        // is getting the correct baseline either way, and a failure to log
        // must never become a failure to answer.
        await db
          .recordRejection(
            env, chatId, verdict.reason ?? 'unknown', dressed,
            effects.map((e) => e.kind).join(','),
          )
          .catch((err) => console.error('recordRejection', err));
      }
    } catch (err) {
      console.error('speak', err);
    }
  }

  try {
    const rows = buttonsFor(effects, ctx.settings.tz);
    const sent = await sendBurst(env, chatId, text, rows ? keyboard(rows) : undefined);
    if (sent.length) await db.addMessage(env, chatId, 'bot', sent.join('\n\n'));
    return sent.length > 0;
  } catch (err) {
    console.error('send', err);
    return false;
  }
}

/**
 * Reminders always get the model. Unprompted check-ins are the first thing to
 * degrade when the daily budget is running down — they are the least important
 * message the user receives, and a blunt one is no worse than none. Button taps
 * ('none') never get the model at all: the effect and its Hebrew are already
 * fully known, so there is nothing for a rewrite to add — only latency and
 * quota to spend.
 */
async function modelAllowed(env: Env, priority: 'high' | 'low' | 'none'): Promise<boolean> {
  if (priority === 'none') return false;
  if (priority === 'high') return true;
  const limit = Number(env.GEMINI_SOFT_LIMIT ?? '200');
  if (!Number.isFinite(limit) || limit <= 0) return true;
  // Fail open: if the usage query throws, a check-in still gets the model
  // rather than being silently suppressed forever by a broken read.
  try {
    const used = await db.usageToday(env, env.GEMINI_MODEL ?? 'gemini-3.5-flash');
    return used < limit;
  } catch (err) {
    console.error('modelAllowed: usageToday failed, allowing', err);
    return true;
  }
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
/**
 * Tell him a deploy landed, once, the minute it lands.
 *
 * A Worker has no start-up hook — every invocation looks exactly like the last
 * one, and nothing anywhere fires when new code goes live. So the tick works
 * it out: db.claimVersion writes the compiled-in VERSION and reports whether
 * that changed anything. It changed something exactly once per deploy, and
 * that call is the one that gets to speak.
 *
 * Sent with a bare sendMessage on purpose. No model call, no validator, no
 * quota, no persona — this is the bot reporting on itself rather than talking
 * to him, and it is the one message that must still arrive on the deploy where
 * everything else is broken.
 *
 * Quiet hours are deliberately not consulted. An unprompted 03:00 nag is rude;
 * a 03:00 deploy confirmation is a reply to something he did thirty seconds
 * ago.
 *
 * Wrapped whole: a bot that cannot announce its own deploy must still run
 * every reminder in that tick.
 */
async function announceDeploy(env: Env, chatId: string): Promise<void> {
  try {
    if (!(await db.claimVersion(env, VERSION))) return;
    console.log(`deployed version ${VERSION}`);
    await sendMessage(env, chatId, `עליתי מחדש. גרסה ${VERSION}.`);
  } catch (err) {
    console.error('announceDeploy', err);
  }
}

async function tick(env: Env): Promise<void> {
  const now = Date.now();
  const chatId = env.OWNER_CHAT_ID;
  if (!chatId || chatId === '0') return;

  // Before the early bail below, because on a quiet minute — which is almost
  // every minute — the tick returns long before it would get here otherwise.
  await announceDeploy(env, chatId);

  // Three independent reads, and this runs 1,440 times a day whether or not
  // there is anything to do — the overwhelmingly common outcome is that all
  // three come back empty and the tick bails just below.
  const [due, nags, settings] = await Promise.all([
    db.dueReminders(env, now),
    db.dueNags(env, now),
    db.getSettings(env, chatId),
  ]);

  const checkinDue =
    settings.checkins_enabled === 1 &&
    settings.next_checkin_at !== null &&
    settings.next_checkin_at <= now;

  // Housekeeping, once a day, at an hour nobody is awake for. This used to run
  // on every inbound message — a DELETE against a 200-row table, on the user's
  // latency path, to remove almost always nothing. It is maintenance, not part
  // of answering him, and the cron is where maintenance belongs.
  const wall = wallParts(now, settings.tz);
  if (wall.hour === 4 && wall.minute === 0) {
    await db.pruneMessages(env, chatId).catch((e) => console.error('prune', e));
  }

  const briefDue = dailyDue(settings.brief_hour, settings.last_brief_on, now, settings.tz);
  const closeoutDue = dailyDue(settings.closeout_hour, settings.last_closeout_on, now, settings.tz);

  // The overwhelmingly common case: nothing to do. Bail before building context.
  if (!due.length && !nags.length && !checkinDue && !briefDue && !closeoutDue) {
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

  // Everything is single-user, so one context covers the whole tick — except
  // that `due` and `nags` below each write to the rows the context describes
  // (setNextFire/createInstance, closeInstance/bumpNag) before sending. `ctx`
  // is therefore re-fetched right before each send that follows a write in
  // this tick, so a second due reminder's "מצב נוכחי" reflects the instance
  // the first one just opened, and a give-up's streak reflects the close that
  // just happened — instead of describing the tick as it stood before any of
  // this tick's own writes landed. Phase 2's morning brief/evening close-out
  // will make multi-item ticks the normal case, not the exception.
  let ctx = await buildContext(env, chatId);
  const muted = !!ctx.settings.muted_until && ctx.settings.muted_until > now;
  const quiet = isQuietHour(
    now,
    ctx.settings.tz,
    ctx.settings.quiet_start_hour,
    ctx.settings.quiet_end_hour,
  );

  // Everything that comes due in one tick is, from his side of the screen,
  // "the 7:00 stuff" — two reminders at the same time should read as one
  // moment with two things in it, not as two notifications a minute apart.
  // They are collected here and sent as a single message below; each keeps its
  // own effect (and therefore its own row, its own instance and its own
  // buttons), because grouping is a presentation decision and must not blur
  // which task he actually closed.
  const fired: Effect[] = [];
  for (const r of due) {
    // Reschedule first: if the send throws, we still don't fire twice.
    let next: number | null = null;
    try {
      next = computeNext(JSON.parse(r.schedule) as Schedule, r.tz, now);
    } catch (err) {
      console.error(`bad schedule on reminder ${r.id}`, err);
    }
    await db.setNextFire(env, r.id, next);

    // Read the run of past misses BEFORE opening this one, so the instance
    // being created now cannot count itself.
    const misses = await db.missStreak(env, r.id).catch(() => 0);
    const instanceId = await db.createInstance(env, r, now);
    console.log(`fired reminder ${r.id} → instance ${instanceId}${misses ? ` (${misses} missed)` : ''}`);
    if (muted) continue;
    fired.push({
      kind: 'reminder_fired', id: r.id, title: r.title, instanceId,
      requiresProof: r.requires_proof === 1,
      ...(misses > 0 ? { misses } : {}),
    });
  }

  // Every instance above is already committed, so a failed send costs a
  // message, never a fired reminder.
  if (fired.length) {
    ctx = await buildContext(env, chatId);
    const delivered = await sendOutcome(env, chatId, ctx, fired, NAG_LADDER[0]);
    if (!delivered) console.log(`DELIVERY FAILED for ${fired.length} fired reminder(s)`);
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
      ctx = await buildContext(env, chatId);
      await sendOutcome(env, chatId, ctx,
        [{ kind: 'gave_up', instanceId: inst.id, title: inst.title, rounds: inst.nag_count }],
        GIVE_UP);
      continue;
    }

    const level = Math.min(3, inst.nag_count + 1);
    await db.bumpNag(env, inst.id, now + interval * 60_000);
    ctx = await buildContext(env, chatId);
    await sendOutcome(env, chatId, ctx,
      [{ kind: 'nagged', instanceId: inst.id, title: inst.title, since: inst.fired_at, round: level }],
      NAG_LADDER[level] ?? NAG_LADDER[3]);
  }

  if (briefDue) await sendMorningBrief(env, chatId, now, settings.tz);
  if (closeoutDue) await sendEveningCloseout(env, chatId, now, settings.tz);

  if (checkinDue) await maybeCheckIn(env, ctx, chatId, now, quiet, due.length + nags.length > 0);
}

/** How late a once-a-day message may be before it is dropped rather than sent. */
const DAILY_GRACE_HOURS = 2;

/**
 * Is a once-a-day message due right now?
 *
 * The grace window matters: the cron runs every minute, so being hours past
 * the hour means the worker was down. A morning brief delivered at 14:00 is
 * not a late brief, it is a wrong one — better to skip the day than to open
 * with "בוקר" in the afternoon.
 */
function dailyDue(
  hour: number | null,
  lastOn: string | null,
  now: number,
  tz: string,
): boolean {
  if (hour === null) return false;
  if (lastOn === localDateKey(now, tz)) return false;
  const current = wallParts(now, tz).hour;
  return current >= hour && current < hour + DAILY_GRACE_HOURS;
}

/**
 * Both daily messages mark themselves sent BEFORE sending. A failed send costs
 * one message; a failed mark would repeat that message every minute until the
 * hour rolled past.
 */
async function sendMorningBrief(env: Env, chatId: string, now: number, tz: string): Promise<void> {
  await db.markDailySent(env, chatId, 'brief', localDateKey(now, tz));
  const { to } = localDayBounds(now, tz);
  const [rows, open] = await Promise.all([
    db.remindersBetween(env, chatId, now, to),
    db.openInstances(env, chatId),
  ]);
  // Nothing scheduled and nothing hanging over — an empty brief every morning
  // is how a useful message turns into one that gets muted.
  if (!rows.length && !open.length) return;
  const ctx = await buildContext(env, chatId);
  await sendOutcome(env, chatId, ctx, [
    { kind: 'morning_brief', rows, openCount: open.length },
  ]);
}

async function sendEveningCloseout(env: Env, chatId: string, now: number, tz: string): Promise<void> {
  await db.markDailySent(env, chatId, 'closeout', localDateKey(now, tz));
  const { from } = localDayBounds(now, tz);
  const [tally, missed, dropped] = await Promise.all([
    db.dayTally(env, chatId, from, now),
    db.openInstances(env, chatId),
    db.droppedBetween(env, chatId, from, now),
  ]);
  if (!tally.done && !missed.length && !dropped.length) return;
  const ctx = await buildContext(env, chatId);
  await sendOutcome(env, chatId, ctx, [
    { kind: 'evening_closeout', done: tally.done, missed, dropped },
  ]);
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
    CHECKIN_GOAL, 'low');

  await db.markGoalCheckin(env, goal.id);
  await reschedule(Date.now());
}
