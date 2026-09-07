import * as db from './db';
import { applyIntent, patternFor } from './effects';
import { handleSlash } from './slash';
import { judgePhoto, route, speak, type Context } from './brain';
import { buildFacts } from './facts';
import { validate } from './validate';
import { CHECKIN_GOAL, CONVERSATION_WINDOW_MIN, GIVE_UP, NAG_LADDER, NAG_LADDER_ITEMS, nagDelayMinutes } from './persona';
import { addressesSomeoneElse, asksForNewReminder, findFutureInstant, namesSomeoneElse, parseAnswerTime, quickParse } from './quickparse';
import { readWhen } from './when';
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
import { TURN_FAILED, friendReminderHeadsUp, questionAsked, renderBaseline } from './voice';
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
      // A second way for the scheduler to be alive.
      //
      // The cron is best-effort and demonstrably drops minutes — on 01.09.2026
      // it dropped eighty in a row and a 16:30 reminder rang at 17:50. An
      // inbound message is proof the Worker itself is fine, so it is the one
      // moment the bot can notice the schedule has gone quiet and do something
      // about it without waiting for a trigger that may not come.
      //
      // Alongside his turn rather than before it: his reply must not wait on a
      // tick, and db.claimTick makes the overlap safe.
      ctx.waitUntil(catchUpTick(env).catch((e) => console.error('catchUpTick', e)));
    }
    // Always 200 fast, or Telegram retries the same update.
    return new Response('ok');
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env).catch((e) => console.error('tick', e)));
  },
};

// ---------------------------------------------------------------- incoming

/**
 * How far back the router is shown reminders that already finished.
 *
 * Two days covers "I did the garage this morning, put it back for 10:30" —
 * which he did — without turning the prompt into a diary. See db.recentlyDone.
 */
const DONE_SHOWN_MS = 2 * 24 * 3_600_000;

/**
 * How late a fire has to be before it admits to it.
 *
 * Above the platform's routine jitter — Cloudflare dropped single minutes
 * thirteen times in the 24h to 02.09.2026 — and far below an outage. See the
 * fire effect in tickChat for the arithmetic this bounds.
 */
const LATE_THRESHOLD_MIN = 3;

/**
 * How quiet the cron has to have gone before an inbound message runs the tick
 * itself.
 *
 * He is talking to the bot, which means the Worker is demonstrably alive — so
 * a minute the platform skipped can be made up off the back of his message
 * rather than waiting for the next one that happens to arrive. Bounded well
 * above the normal cadence so an ordinary conversation never becomes a second
 * scheduler; db.claimTick makes it harmless if it is.
 */
const CATCHUP_AFTER_MS = 3 * 60_000;

/**
 * How long everything that happens because of one message may take, in total.
 *
 * `gemini.budgets` bounds ONE call's ladder. Nothing bounded the turn, so
 * route() could spend its 30 seconds and speak() could then start a fresh 30
 * of its own — and on 02.09.2026 22:27 that is what happened. Routing took
 * 18.9s, reminder 71 was written correctly at 22:27:58, and then nothing was
 * sent: no bot message, no error row, no catch anywhere. The invocation was
 * killed on the wall clock, which — as CLAUDE.md already records — does not
 * throw, so every `.catch` in the file is bypassed and the turn evaporates.
 *
 * He got silence, which is the worst answer this bot can give: it is
 * indistinguishable from being down, and it lands exactly when he is waiting
 * to hear that something counted.
 *
 * 25 seconds leaves the routing ladder room to walk a slow primary and still
 * reach a fallback, and leaves the send itself comfortably inside whatever the
 * runtime allows. What gives way when it runs out is speak(), which is the
 * right thing to lose — voice.ts output is already true and already shippable.
 */
const TURN_BUDGET_MS = 25_000;

/**
 * Overridable, like GEMINI_BUDGET_MS — but zero is allowed here where it is
 * not there, and that is deliberate.
 *
 * The test rig pins `Date.now()` (harness.withNow), so no test can make time
 * actually pass. "The turn has already spent its allowance" is therefore only
 * expressible as an allowance of nothing, and it is the state that matters: it
 * is what 02.09.2026 22:27 looked like from inside sendOutcome.
 */
function turnDeadline(env: Env): number {
  const n = Number(env.GEMINI_TURN_BUDGET_MS);
  return Date.now() + (Number.isFinite(n) && n >= 0 ? n : TURN_BUDGET_MS);
}

async function buildContext(env: Env, chatId: string): Promise<Context> {
  const [settings, stats, scheduled, goals, open, friends, inbox, done, ringing] = await Promise.all([
    db.getSettings(env, chatId),
    db.stats(env, chatId),
    db.listReminders(env, chatId),
    db.listGoals(env, chatId),
    db.openInstances(env, chatId),
    // One more read per turn, on a table with single digits of rows. It buys
    // the router the only thing that can tell "תזכיר לדנה" from a reminder
    // about somebody called דנה — the list of people he is actually allowed
    // to write to. Without it here, quickparse cannot bail on the difference
    // either, and the fast path would happily file it as his own.
    db.friendsOf(env, chatId).catch(() => []),
    // listReminders filters status='scheduled', so without this read the
    // router has no idea the capture it is about to duplicate exists. See
    // Context.inbox — this is the whole of the 16.08.2026 #35/#36/#37 bug.
    db.listInbox(env, chatId).catch(() => []),
    // Reminders that already fired and closed. Neither list above shows them
    // — one filters 'scheduled', the other 'inbox' — so on 18.08.2026 the
    // router named `target_id=52` for a row it had never seen, having pulled
    // the id out of the conversation. It was right that time. Bounded hard
    // (two days, five rows) because this is prompt space paid on every turn.
    db.recentlyDone(env, chatId, Date.now() - DONE_SHOWN_MS).catch(() => []),
    // Whatever is ringing RIGHT NOW, whatever its status word says. A `once`
    // reminder flips to 'done' the moment it fires, so listReminders above
    // cannot see the one task the bot is actively chasing him about. See
    // db.ringingReminders and issues.md §4.
    db.ringingReminders(env, chatId).catch(() => []),
  ]);

  /*
   * One list, with the ringing rows folded in.
   *
   * Merged rather than carried alongside, because FIVE consumers read
   * `ctx.reminders` and every one of them wanted the same answer: `/list`,
   * remindersSummary for the router, remindersSummary for the persona,
   * resolveReminder's lookup by id, and its single-reminder fallback. A
   * second list would have meant fixing five call sites and missing the sixth.
   *
   * Deduplicated by id, because a RECURRING reminder appears in both — it
   * stays 'scheduled' across its own firing — and a row printed twice is how
   * the model comes to believe there are two of them.
   */
  const byId = new Map(scheduled.map((r) => [r.id, r]));
  for (const r of ringing) if (!byId.has(r.id)) byId.set(r.id, r);
  const reminders = [...byId.values()];
  // Only when something is actually being chased. A chat with nothing open has
  // no errands to tick off, and this would otherwise be a query per message to
  // build an empty map.
  const items = open.length
    ? await db
        .itemsForReminders(env, [...new Set(open.map((i) => i.reminder_id))])
        .catch(() => undefined)
    : undefined;
  return {
    settings, stats, reminders, goals, open, items, friends, inbox, done,
    nowLabel: formatLocal(Date.now(), settings.tz),
  };
}

async function handleUpdate(update: any, env: Env): Promise<void> {
  /*
   * An EDIT is not a new message, and running the pipeline on one is how a
   * single errand becomes two rows.
   *
   * This read `update.message ?? update.edited_message` and treated them
   * identically, so correcting "מחר ב8" to "מחר ב9" routed a second time and
   * created a second reminder — the first one still sitting there at 8.
   *
   * Telegram gives no way to know what the text WAS, so the bot cannot undo
   * what it did the first time; the only honest options are to ignore the edit
   * or to say so. Saying so, because silence here looks exactly like the bot
   * having read it. No model call, no write, one deterministic line.
   */
  if (update.edited_message && !update.message) {
    const editChat = String(update.edited_message?.chat?.id ?? '');
    if (editChat && (await db.allowedChats(env)).has(editChat)) {
      await sendMessage(env, editChat, 'לא קורא עריכות של הודעות. תשלח לי את זה כהודעה חדשה.');
    }
    return;
  }

  const msg = update.message;
  if (!msg?.chat?.id) return;

  const chatId = String(msg.chat.id);

  // Single-user bot. Anyone else gets silence — but log the id so the owner
  // can discover their own chat_id during setup.
  if (!env.OWNER_CHAT_ID || env.OWNER_CHAT_ID === '0') {
    console.log(`chat_id = ${chatId}`);
    await sendMessage(env, chatId, `chat_id: ${chatId}\nשים אותו ב-OWNER_CHAT_ID ותפרוס מחדש.`);
    return;
  }
  const text: string = (msg.text ?? msg.caption ?? '').trim();
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  // Stickers, voice notes, location pins etc. — nothing to reason about.
  if (!text && !hasPhoto) return;

  // The owner plus anyone they invited. Everyone else falls into the
  // onboarding path below and never reaches a model call, a reminder, or any
  // of this chat's data.
  if (!(await db.allowedChats(env)).has(chatId)) {
    await greetStranger(env, chatId, text);
    return;
  }

  // Called for EVERY message, not just ones starting with "/". Bare Hebrew
  // words are commands too ("רשימה", "עזרה") — see slash.ALIASES — and the
  // whole point of them is that they cost no model call, which only holds if
  // they are answered before the router is reached. handleSlash returns null
  // for anything it does not recognise, so ordinary messages fall through
  // exactly as before.
  // The sender's Telegram name rides along for exactly one command: /friend
  // needs it so that when the other side says yes, her address book gets a
  // name for him rather than a bare chat_id. Read here because this is the
  // only place the raw Telegram message exists.
  const reply = await handleSlash(env, chatId, text, msg.from?.first_name);
  if (reply) {
    await sendMessage(env, chatId, reply);
    return;
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
    await db.recordError(env, chatId, 'handleUpdate', err, text).catch((e) =>
      console.error('recordError', e),
    );
    // Says only what is certainly true. Something may well have been written
    // before the throw, so this must neither confirm nor deny the work —
    // claiming either would be the exact failure the rest of the pipeline
    // exists to prevent.
    await sendMessage(env, chatId, TURN_FAILED).catch((e) =>
      console.error('last-resort send', e),
    );
  }
}

/**
 * The only conversation the bot has with someone it does not know.
 *
 * Ask who they are, tell the owner, then go quiet. That is the whole of it,
 * and the limits are the design:
 *
 * - TWO replies per chat in their lifetime — the question, and one
 *   acknowledgement. Message three onwards is the same silence a stranger got
 *   before any of this existed.
 * - A `denied` row is never re-prompted, so a refusal cannot be reset by
 *   messaging again.
 * - Past db.PENDING_MAX waiting strangers, nobody new is answered at all. A
 *   flood of accounts costs a bounded number of rows and a bounded number of
 *   messages to the owner, and then degrades to exactly the old behaviour.
 * - Nothing they wrote is echoed anywhere except the name they chose to give,
 *   and that only to the owner.
 *
 * Errors are swallowed: failing to greet a stranger must never become a
 * failure that reaches the owner's own turn.
 */
async function greetStranger(env: Env, chatId: string, text: string): Promise<void> {
  try {
    const pending = await db.getPending(env, chatId);

    if (!pending) {
      if (!(await db.addPending(env, chatId))) {
        console.log(`pending queue full, ignoring ${chatId}`);
        return;
      }
      await sendMessage(env, chatId, STRANGER_ASK);
      return;
    }

    // Already answered, or already refused. Either way there is nothing left
    // to say to them.
    if (pending.status !== 'asked') {
      console.log(`ignored message from ${chatId} (${pending.status})`);
      return;
    }

    // A photo or a sticker is not a name. Staying silent rather than
    // re-asking keeps this from becoming a loop they can play with.
    if (!text) return;

    const name = text.slice(0, 60);
    if (!(await db.namePending(env, chatId, name))) return;
    await sendMessage(env, chatId, STRANGER_WAIT);
    // Pushed, not left in a list to be discovered. A queue the owner has to
    // remember to check is a queue nobody is ever let out of.
    await sendMessage(
      env,
      env.OWNER_CHAT_ID,
      `מישהו חדש רוצה להיכנס: ${name} · ${chatId}\nלאשר: /allow ${name}\nלדחות: /deny ${name}`,
    );
  } catch (err) {
    console.error('greetStranger', err);
  }
}

export const STRANGER_ASK = 'אני לא מכיר אותך. תכתוב לי שם ואעביר לאישור.';
const STRANGER_WAIT = 'רשמתי. אם יאשרו אותך — תשמע ממני. עד אז אני שותק.';

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

  /*
   * One clock for the whole turn, started here and shared by route() and
   * speak(). See TURN_BUDGET_MS: each of them used to get its own full
   * allowance, so a slow router could leave nothing for the send and the
   * invocation died on the wall clock with no catch anywhere and no message.
   *
   * Started before the context reads on purpose. The D1 round trips are part
   * of what he is waiting through, and a budget that ignores them is not a
   * budget for the thing he experiences.
   */
  const deadline = turnDeadline(env);

  // Any inbound message ends a chill period. If he is talking, he is available.
  const ctx = await buildContext(env, chatId);

  // Learn what Telegram calls whoever is in this chat, so the persona can
  // address HIM rather than the owner. Written only when it actually changed,
  // so an ordinary message costs no write; refreshed rather than written once,
  // so a rename in Telegram reaches the prompt without a command.
  //
  // This is the only place the raw Telegram sender exists, and it is on the
  // inbound path on purpose — the cron has no message to read a name from,
  // which is exactly why the name has to be stored rather than passed through.
  // Best-effort: failing to learn a name must never cost him the turn, and the
  // prompt degrades to addressing nobody, never to addressing the owner.
  const senderName: string | undefined = msg.from?.first_name;
  if (senderName && senderName !== ctx.settings.display_name) {
    await db.setDisplayName(env, chatId, senderName).catch((e) =>
      console.error('setDisplayName', e),
    );
    ctx.settings.display_name = senderName.slice(0, 60);
  }
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

  // The question the bot itself asked last turn, if it is still fresh. Read
  // off the settings row that buildContext already loaded, so an outstanding
  // question costs no extra query.
  const awaiting = image ? null : db.readAwaiting(ctx.settings.awaiting);

  try {
    // An answer to that question, applied WITHOUT a model call.
    //
    // On 13.08.2026 the bot asked "מתי לשים לך את זה?", he replied "15:00",
    // and the router — which sees six turns of flat prose and has a rule about
    // bare yes-words but none about bare times — classified it as chat. He got
    // "נו?" and the reminder never moved. A bare hour carries no clue about
    // what it answers; the only thing that knows is the bot that asked.
    const answeredAt =
      awaiting?.k === 'time' ? parseAnswerTime(text, Date.now(), ctx.settings.tz) : null;

    // Common reminder phrasings never touch the router — see quickparse.ts.
    // The friends' names go in so this can REFUSE. Every parse in that file
    // assumes the reminder is his own, so "תזכיר לדנה" has to reach the router
    // — the only thing that knows who דנה is. A chat with no friends passes an
    // empty list and behaves exactly as it always did.
    // The subject of a reminder whose hour is already settled — the answer to
    // "על מה להזכיר?".
    //
    // Gated on asksForNewReminder, which is the SAME gate quickparse and the
    // router-failure capture use, for the same reason: if he opened a new
    // request instead of answering ("תזכיר לי מחר לקנות חלב"), that is a new
    // reminder and renaming the old one with it would lose both. Anything that
    // is not a fresh request is taken as the answer, because that is what it
    // almost always is — and a rename is reversible in a way a lost reminder
    // is not.
    // Carries its target rather than reaching back for `awaiting.r` later: the
    // narrowing is done here, where the `k === 'title'` check is, so no
    // non-null assertion is needed at the use site to convince the compiler.
    /*
     * The hour for a reminder that is FOR SOMEBODY ELSE — the answer to
     * "לאמנון: … באיזו שעה?".
     *
     * This is the carry that did not exist, and its absence is the whole of
     * what made friends look broken. The addressee is stated once, in the
     * first message; the write happens in the second. Nothing joined them, so
     * "עוד שתי דקות" reached the router as a fresh request with no name in it
     * and became reminder #85 in HIS chat (07.09.2026).
     *
     * The friend comes out of the SLOT, never out of this message — his answer
     * is an hour and has no name in it, which is precisely why re-deriving the
     * addressee at write time could never work. The nickname is looked up from
     * the chat id so the synthesised intent goes through exactly the same
     * create path as everything else rather than a second one.
     *
     * Gated on asksForNewReminder like `title` and `fname`: if he opened a new
     * request instead of answering, that is a new request, and taking it as an
     * hour would lose both.
     *
     * The hour itself is NOT resolved here, and that is deliberate. It is read
     * inside friendReminder, in HER timezone, because "ב-8" means eight where
     * she is — resolving it here against his clock and passing an instant down
     * would put a second time resolver on this path, which is the bug one
     * paragraph up. This only decides whether his message contains a time at
     * all; if it does not, it is not an answer to this question and falls
     * through to the router.
     */
    const answeredForWhom =
      awaiting?.k === 'forwhom' && text && !asksForNewReminder(text)
        ? (() => {
            const f = (ctx.friends ?? []).find((x) => x.friend_chat_id === awaiting.c);
            const heard = readWhen(text, Date.now(), ctx.settings.tz);
            const hasTime =
              heard.kind === 'instant' || heard.kind === 'duration' || heard.kind === 'recurrence';
            return f && hasTime ? { nickname: f.nickname, title: awaiting.t } : null;
          })()
        : null;

    const answeredTitle =
      awaiting?.k === 'title' && text && !asksForNewReminder(text)
        ? { target: awaiting.r, title: text.slice(0, 120) }
        : null;

    // The nickname for a friendship he has just accepted — the answer to
    // "איך תקרא לו?".
    //
    // Gated on asksForNewReminder for the same reason `title` is: if he opened
    // a request instead of answering, taking it as a nickname would lose the
    // request AND write nonsense into the book. Carries the target for the
    // same reason too — the narrowing happens here, where the `k === 'fname'`
    // check is.
    const answeredFriendName =
      awaiting?.k === 'fname' && text && !asksForNewReminder(text)
        ? { friend: awaiting.c, nickname: text.trim().slice(0, 40) }
        : null;

    // Applied here and not as an Intent, deliberately. This is an edit to his
    // address book, not a write against a reminder: `/friend <name> <new>`
    // — its sibling — is likewise a plain reply with no effect and no events
    // row, and inventing a router action for it would put a name-changing verb
    // in front of the model, which is the one thing matchFriend's exactness
    // exists to keep it away from.
    if (answeredFriendName) {
      await db.setAwaiting(env, chatId, null).catch((e) => console.error('setAwaiting', e));
      const ok = await db
        .renameFriend(env, chatId, answeredFriendName.friend, answeredFriendName.nickname)
        .then(() => true)
        .catch((e) => {
          console.error('renameFriend', e);
          return false;
        });
      await sendMessage(
        env,
        chatId,
        ok
          ? `מעכשיו הוא "${answeredFriendName.nickname}" אצלי. ` +
            `"תזכיר ל${answeredFriendName.nickname}..." יעבוד.`
          : 'משהו נפל לי באמצע. /friends יראה לך מה יש, ו-/rename ישנה שם.',
      ).catch((e) => console.error('friend named', e));
      return;
    }

    // Common reminder phrasings never touch the router — see quickparse.ts.
    // The friends' names go in so this can REFUSE. Every parse in that file
    // assumes the reminder is his own, so "תזכיר לדנה" has to reach the router
    // — the only thing that knows who דנה is. A chat with no friends passes an
    // empty list and behaves exactly as it always did.
    //
    // The last argument is the one thing quickparse cannot see for itself: a
    // reminder is ringing right now, so "תזכיר לי עוד שעה" is probably a snooze
    // and a titleless create must defer to the router rather than guess.
    const fast = image
      ? null
      : quickParse(
          text,
          Date.now(),
          ctx.settings.tz,
          (ctx.friends ?? []).map((f) => f.nickname),
          ctx.open.length > 0,
        );
    const intents: Intent[] =
      awaiting?.k === 'time' && answeredAt !== null
        ? [
            {
              action: 'reschedule',
              target_id: awaiting.r,
              schedule_type: 'once',
              once_at: wallString(answeredAt, ctx.settings.tz),
            },
          ]
        : answeredForWhom !== null
          ? [
              {
                action: 'create_reminder',
                for_friend: answeredForWhom.nickname,
                title: answeredForWhom.title,
              },
            ]
        : answeredTitle !== null
          ? [{ action: 'rename', target_id: answeredTitle.target, title: answeredTitle.title }]
          : fast
          ? [fast]
          : await route(env, ctx, text, history.slice(0, -1), image ?? undefined, deadline);
    // Visible in `wrangler tail`. When the bot claims it did something it
    // didn't, this line is what tells you whether the router or the persona lied.
    console.log(`intent${fast ? ' (quickparse)' : ''}`, JSON.stringify(intents));

    const photoComplete = image ? intents.find((i) => i.action === 'complete') : undefined;

    if (!intents.length) {
      // route() hands back an empty list when the model's reply could not be
      // parsed into anything. It used to synthesise `chat` here, which meant a
      // broken router and a chatty message produced the identical "נו?" — and
      // the one case where the bot genuinely has no idea what he wants is
      // exactly the case where saying so is most useful.
      effects = [{ kind: 'nothing', why: 'not_understood', userText: text }];
    } else if (intents.some((i) => i.distress)) {
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
    // Written down, not just logged. console.error survives only as long as a
    // `wrangler tail` someone happened to be running, and Workers Logs is off —
    // which is why two missing reminders in August 2026 are still unexplained.
    await db.recordError(env, chatId, 'route/apply', err, text).catch((e) =>
      console.error('recordError', e),
    );
    // A capture must survive a broken router. Anything that looks like a
    // reminder request lands in the inbox rather than being lost to an error.
    // Effects already committed earlier in this turn (e.g. the first half of
    // "סיימתי, ותזכיר לי עוד שעה" before the second intent threw) are kept,
    // never overwritten — losing a real write here would be the exact "the
    // bot claims something it didn't do" bug this whole pipeline exists to
    // prevent.
    // The SAME question quickparse asks, and for the same reason. This used
    // to be its own bare-noun regex, so when the router timed out on "בוא נזיז
    // את התזכורת של הבשר ל15:00" (14.08.2026) the fallback answered "תפסתי
    // #30." — capturing a request to MOVE something as a brand-new inbox item.
    // Two gates asking the same question had to be fixed twice; now there is
    // one answer and one place to change it.
    // ...and only when it is HIS. `asksForNewReminder` answers "did he ask for
    // a reminder", never "whose is it", and the capture files the raw message
    // as a title in HIS inbox.
    //
    // Production, 17.08.2026: reminder #43, still in the owner's inbox three
    // days later, titled `תזכיר לאמנון "להגיד לי איזה פיצר טוב" עוד שתי דקות`.
    // The router truncated mid-string, JSON.parse threw, and the whole message
    // was filed verbatim — his row, somebody else's errand, the addressing
    // still in the title. An inbox row has no next_fire_at to age out on, so
    // it is then shown to the router on every turn forever.
    //
    // quickparse refuses exactly this shape for exactly this reason, and it
    // uses TWO gates to do it: `namesSomeoneElse` asks the address book,
    // `addressesSomeoneElse` asks the grammar. Both are needed and neither
    // subsumes the other — the production message above defeats the grammar
    // one on its own, because a quotation mark sits between the two ל-phrases
    // ("תזכיר לאמנון \"להגיד...") and CLAUDE.md records that widening the
    // pattern to cover it trades the miss for real over-refusal.
    //
    // So this asks both, the same way and in the same order. One question,
    // one answer, one place to change it — which is the lesson from
    // asksForNewReminder having had to be fixed twice.
    const notHis =
      namesSomeoneElse(text, (ctx.friends ?? []).map((f) => f.nickname)) ||
      addressesSomeoneElse(text);
    if (asksForNewReminder(text) && !notHis) {
      const id = await db.addInboxItem(env, chatId, text.slice(0, 200), ctx.settings.tz);
      effects.push({ kind: 'reminder_captured', id, title: text.slice(0, 200) });
    }
    // Appended unconditionally, including on top of effects that DID commit.
    // This used to be an `else if` that only spoke when the turn produced
    // nothing at all, so a turn where the first intent was written and the
    // second one threw read exactly like a turn where everything worked. And
    // when it did speak it said `why: 'chat'` — a bare "נו?", indistinguishable
    // from being nagged. A failure the user cannot see is a failure he debugs
    // by re-sending, which is how a half-applied turn becomes a duplicate.
    effects.push({ kind: 'nothing', why: 'failed', userText: text });
  }

  // He MENTIONED something with a time in it. Offer a reminder for it.
  //
  // Only on a turn that produced nothing else — `chat` and nothing more. If the
  // router found any real intent, or anything threw, this stays out of the way.
  // Nothing is written either: it is a question with one tap on it, because
  // rule 1 in quickparse.ts was learned by turning "אני הולך עוד 20 דקות" into
  // a reminder titled "אני הולך", and a wrong guess must cost an ignorable
  // question rather than a row he never asked for.
  if (effects.length === 1 && effects[0].kind === 'nothing' && effects[0].why === 'chat') {
    const offer = await offerAppointment(env, chatId, ctx, text).catch((e) => {
      console.error('offerAppointment', e);
      return null;
    });
    if (offer) effects = [offer];
  }

  // Remember the question this turn is about to ask — or forget the one it
  // just answered. Written only when it actually changes, so an ordinary
  // message costs no write at all.
  //
  // Clearing on ANY other turn matters as much as setting: the TTL is a
  // backstop, not the rule. If he asked something new in between, the old
  // "מתי?" is no longer what a bare hour would be answering.
  // Asked of the EFFECTS rather than pattern-matched here. This used to be two
  // hard-coded `find`s for `needs_time` and `appointment_offer`, which is why
  // `reminder_captured` — whose wording has always ended "תגיד לי מתי" —
  // registered nothing at all, and his answer became a second and third row.
  // Now the wording and the slot live together in voice.ts, so an effect that
  // asks and forgets is visible in one file instead of two.
  const question = effects.map(questionAsked).find((q) => q !== null) ?? null;
  if (question) {
    await db
      .setAwaiting(env, chatId, { ...question, at: Date.now() })
      .catch((e) => console.error('setAwaiting', e));
  } else if (awaiting) {
    await db.setAwaiting(env, chatId, null).catch((e) => console.error('setAwaiting', e));
  }

  // Somebody else's chat just gained a row. She hears about it now rather than
  // at 07:00, because a reminder she never set, arriving with no warning, is
  // indistinguishable from a bug — and because now is when she can say she
  // does not want it.
  await tellFriends(env, chatId, effects);

  await sendOutcome(env, chatId, ctx, effects, toneNote, 'high', history, 'replying', deadline);
}

/**
 * Tell the other side that a reminder was just set for them.
 *
 * Plain sendMessage, no model, no validator: the wording is fully determined
 * (voice.friendReminderHeadsUp) and this is the bot reporting a write rather
 * than talking to her — the same reason a button never calls the model.
 *
 * Best-effort, and deliberately AFTER the write. The row is hers either way;
 * a failed heads-up costs one message and the reminder still fires with his
 * name on it. The reverse — announcing before writing — would be the one
 * thing this codebase forbids.
 *
 * Note what is NOT claimed to him: his own confirmation says the reminder was
 * set, never that she was told. If this throws, nothing he was told stops
 * being true.
 */
async function tellFriends(env: Env, chatId: string, effects: Effect[]): Promise<void> {
  for (const e of effects) {
    if (e.kind !== 'friend_reminder_created') continue;
    try {
      // His name in HER address book, not the one he used for her: she is the
      // one reading it. Falls back to his chat_id rather than to silence — a
      // number she can look up beats a reminder from nobody.
      const mine = (await db.friendName(env, e.to, chatId)) ?? chatId;
      const theirs = await db.getSettings(env, e.to);
      await sendMessage(env, e.to, friendReminderHeadsUp(mine, e.title, e.at, theirs.tz));
    } catch (err) {
      console.error('tellFriends', err);
    }
  }
}

/** Snooze minutes taken straight off a button, unlike applyIntent's model-derived
 *  path — decode() bounds hour/minute but not this, so a crafted callback_data
 *  like 's:1:999999999' would otherwise reach db.snoozeInstance unclamped. */
const clampSnooze = (minutes: number) => Math.min(720, Math.max(5, minutes));

/**
 * Will this reminder ring again of its own accord?
 *
 * The question `reminders.status` cannot answer: a one-off that has fired and
 * a recurring reminder that has finished for the day both read 'done' with
 * next_fire_at NULL (issues.md §4). The schedule is the only thing that knows,
 * and it has to be asked at the moment of the skip — see the `recurs` comment
 * on instance_skipped in types.ts.
 *
 * An unparseable schedule is treated as NOT recurring, which is the answer
 * that promises him less. Being told an errand will not come back when it
 * quietly does is a surprise he can fix in one message; the reverse is a task
 * that disappears while he is waiting for it.
 */
async function reminderRecurs(env: Env, reminderId: number): Promise<boolean> {
  const rem = await db.getReminder(env, reminderId).catch(() => null);
  if (!rem) return false;
  try {
    return (JSON.parse(rem.schedule) as Schedule).type !== 'once';
  } catch {
    return false;
  }
}

/**
 * An inline button tap. Zero model calls: the effect is known from the payload,
 * and voice.ts already has correct Hebrew for it. This is the fastest path in
 * the bot and the reason it feels responsive.
 */
async function handleCallback(update: any, env: Env): Promise<void> {
  const q = update.callback_query;
  const chatId = String(q?.message?.chat?.id ?? '');
  const fromId = String(q?.from?.id ?? '');

  // Answer first — Telegram spins for 30s otherwise — but only for someone
  // allowed. This is an unauthenticated inbound path that writes to D1, so a
  // leaked or guessed message id must not be a free write: check auth
  // before touching the database, and before even answering the spinner,
  // so a stranger's callback_query_id leaks nothing back either.
  //
  // Both ids are checked and both must be the SAME allowed chat. `fromId` is
  // who tapped and `chatId` is where the keyboard lives; allowing them to
  // differ would let one guest act inside another's chat, which is the
  // multi-user version of the leak this whole pass exists to close.
  // db.allowedChats always contains the owner, so an unset or empty
  // OWNER_CHAT_ID still cannot authorise a stranger.
  const allowed = await db.allowedChats(env);
  if (!chatId || fromId !== chatId || !allowed.has(chatId)) {
    console.log(`ignored callback from ${fromId}`);
    return;
  }
  await answerCallback(env, q.id);

  const cb = decode(String(q.data ?? ''));
  const effects: Effect[] = [];
  /**
   * A plain sentence this tap produced, outside the effects pipeline.
   *
   * The friend taps are administrative — like /allow, they change who may
   * talk to whom rather than what is on anybody's list. There is no reminder
   * to describe, nothing for voice.ts to word, and nothing a model rewrite
   * could add. They still count as "something happened", which is why the
   * tick below is driven by this as well as by `effects`.
   */
  let note: string | null = null;

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
          effects.push({
            kind: 'instance_skipped', id: inst.id, title: inst.title,
            recurs: await reminderRecurs(env, inst.reminder_id),
          });
          /*
           * Declining it is the plainest statement in the product that a
           * reminder is not working — and until 0.20.0 it was the one path
           * that never asked the question. patternFor hung off `snooze` and
           * off the give-up, so a reminder he said no to three times running
           * produced nothing at all. Combined with behaviourOf not counting
           * `דילג` either, that is most of why patterns.ts had never once
           * fired in production. See issues.md §8.
           *
           * The cooldown inside patternFor is what keeps this from becoming
           * the noise it exists to reduce, and the appended question rides on
           * a reply he was already getting — no extra notification.
           */
          effects.push(
            ...(await patternFor(
              env, chatId, await buildContext(env, chatId), inst.reminder_id, inst.title,
              'skipped',
            )),
          );
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
            // A tap carries one instant and one title by construction; there
            // is no second time in a button for an event hour to come from.
            event_at: null,
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
          const closed =
            inst.status === 'open' &&
            (await db.closeIfOpen(env, cb.instance, 'skipped', 'נדחה למחר'));
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
          let rearmed = false;
          if (rem && schedule?.type === 'once') {
            const p = wallParts(inst.fired_at, rem.tz);
            const at = wallToUtc(p.year, p.month, p.day + 1, p.hour, p.minute, rem.tz);
            const next: Schedule = { type: 'once', at: wallString(at, rem.tz) };
            if (await db.retimeReminder(env, rem.id, at, JSON.stringify(next))) {
              rearmed = true;
              effects.push({ kind: 'reminder_retimed', id: rem.id, title: rem.title, at });
            }
          }
          // Pushed AFTER the re-arm, not before it, because `recurs` is a claim
          // about whether he will hear about this again — and on this button
          // the answer usually comes from the retime two lines up rather than
          // from the schedule. Emitting it first would have forced the guess.
          if (closed) {
            effects.push({
              kind: 'instance_skipped', id: inst.id, title: inst.title,
              recurs: rearmed || (schedule !== null && schedule.type !== 'once'),
            });
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
      // The two taps that can end a check-in loop. Both go through
      // setGoalStatus, which is chat-scoped, so a guessed goal id cannot reach
      // another chat's row.
      // "כן" to a reminder offered for something he only mentioned. The title
      // and instant come from the awaiting slot rather than from the payload —
      // callback_data has 64 bytes and a Hebrew title does not fit.
      // "Leave it as it is." Writes nothing on purpose — its whole job is to
      // let him decline an unsolicited question in one tap instead of by
      // silence, which this bot is otherwise inclined to read as avoidance.
      // The cooldown was already recorded when the question was asked.
      case 'keep': {
        // Pushed onto the SHARED array, not sent from in here. Both this
        // branch and `rdrop` used to declare their own `const effects`,
        // shadowing the one the tail reads — so the tail saw an empty list and
        // settled the keyboard with "—", the marker that means nothing
        // happened, on a tap that had just deleted a reminder.
        //
        // And this used to answer `{nothing, why:'chat'}`, which voice.ts
        // words as the bare "נו?" — the bot's own nag opener, handed back to a
        // man who had just tapped "leave it as it is". CLAUDE.md is explicit
        // that "נו?" is not available as a fallback, and this reached it
        // through a route that is technically legitimate, which is exactly why
        // nothing caught it.
        //
        // `pattern_kept` writes nothing and is deliberately outside WROTE. The
        // cooldown was already recorded when the question was asked.
        effects.push({ kind: 'pattern_kept' });
        break;
      }

      // Delete a reminder its own history says has never once worked. Goes
      // through the same chat-scoped delete every other path uses, so a
      // replayed or forged payload cannot reach another chat's row.
      case 'rdrop': {
        // Into the shared array, so the tail settles the keyboard with "✓" and
        // sends once. This used to shadow `effects` with a local const and
        // send from in here, which left the outer array empty — the tap
        // deleted the reminder and the message said nothing had happened.
        effects.push(
          ...(await applyIntent(
            env, chatId, await buildContext(env, chatId),
            { action: 'delete', target_id: cb.reminder }, '',
          )),
        );
        break;
      }

      case 'offer': {
        const settings = await db.getSettings(env, chatId);
        const pending = db.readAwaiting(settings.awaiting);
        if (pending?.k === 'offer' && pending.w > Date.now()) {
          const schedule: Schedule = { type: 'once', at: wallString(pending.w, settings.tz) };
          const id = await db.addReminder(env, {
            chat_id: chatId,
            title: pending.t,
            notes: null,
            schedule: JSON.stringify(schedule),
            tz: settings.tz,
            requires_proof: 0,
            proof_type: 'any',
            nag_interval_min: 20,
            max_nags: 3,
            next_fire_at: pending.w,
            // As above: the offer slot holds a title and an instant, nothing more.
            event_at: null,
          });
          // Consumed, so a second tap on the same message cannot write it twice.
          await db.setAwaiting(env, chatId, null).catch(() => {});
          effects.push({
            kind: 'reminder_created', id, title: pending.t, at: pending.w,
            schedule, requiresProof: false,
          });
        }
        break;
      }
      // One errand out of several. The instance stays open until the last
      // tick, which is the entire point — a task with three things in it had
      // only "עשיתי", and tapping that after doing two was a false report.
      case 'item': {
        const item = await db.getItem(env, cb.item);
        // chat_id is on the row precisely so this check needs no join.
        if (item && item.chat_id === chatId && (await db.completeItem(env, item.id))) {
          const remaining = await db.openItemCount(env, item.reminder_id);
          effects.push({
            kind: 'item_done', id: item.id, title: item.title,
            reminderId: item.reminder_id, remaining,
          });
          if (remaining === 0) {
            const open = await db.openInstances(env, chatId);
            const inst = open.find((i) => i.reminder_id === item.reminder_id);
            if (inst && (await db.closeIfOpen(env, inst.id, 'done', 'כל הפריטים'))) {
              const fresh = await db.stats(env, chatId);
              effects.push({
                kind: 'instance_done', id: inst.id, title: inst.title,
                streak: fresh.currentStreak,
              });
            }
          }
        }
        break;
      }
      // Yes or no to a friend request. The pair plus the row's own status is
      // the whole authorisation: db.acceptFriend only touches a row that is
      // `pending` AND aimed at the chat that tapped, so a replayed or guessed
      // payload changes nothing — and a second tap on the same message
      // reports nothing, so the requester cannot be told twice.
      case 'facc': {
        if (await db.acceptFriend(env, chatId, cb.from)) {
          const mine = await db.friendName(env, chatId, cb.from);
          // ASK what to call him, rather than leaving him under the name
          // acceptFriend just wrote.
          //
          // That name is the requester's Telegram profile string — "Shahar",
          // "amnon" — or the raw chat_id when Telegram gave no name at all. It
          // is the only row in this bot named by somebody other than the
          // person who has to type it, and db.matchFriend is exact-match
          // because guessing sends a message to the wrong chat. The result was
          // that the requester's side of every friendship worked (he chose the
          // nickname in /friend) and the accepter's side did not.
          //
          // The provisional name is left in place on purpose: an unanswered
          // question must leave a usable edge, not a blank one. This refines
          // it, it does not create it.
          note =
            `${mine ?? cb.from} בפנים. איך תקרא לו? תכתוב לי שם עכשיו ` +
            `— זה השם שתשתמש בו כדי לקבוע לו תזכורות.`;
          await db
            .setAwaiting(env, chatId, { k: 'fname', c: cb.from, at: Date.now() })
            .catch((e) => console.error('setAwaiting fname', e));
          // Best-effort: the person who has been waiting has to hear it, but a
          // blocked bot on his side must not undo her acceptance.
          const theirs = await db.friendName(env, cb.from, chatId);
          await sendMessage(
            env,
            cb.from,
            `${theirs ?? chatId} אישר. אפשר לקבוע לו תזכורות — "תזכיר ל${theirs ?? chatId}...".`,
          ).catch((err) => console.error('friend accepted notice', err));
        }
        break;
      }
      case 'frej': {
        // Nothing is sent to the requester. He asked, she said no, and a
        // message telling him so is a second thing she did not agree to; his
        // side simply stays pending forever, which is what "no answer" looks
        // like everywhere else in this bot.
        if (await db.declineFriend(env, chatId, cb.from)) {
          note = 'לא נורא. לא אשאל אותך על זה שוב.';
        }
        break;
      }
      case 'gdone':
      case 'gdrop': {
        const status = cb.t === 'gdone' ? 'done' : 'dropped';
        const goal = (await db.listGoals(env, chatId)).find((g) => g.id === cb.goal);
        if (goal && (await db.setGoalStatus(env, chatId, goal.id, status))) {
          effects.push({ kind: 'goal_closed', id: goal.id, title: goal.title, status });
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
    effects.length || note ? '✓' : '—',
  );
  if (note) await sendMessage(env, chatId, note).catch((e) => console.error('callback note', e));
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
    // A button tap is him acting, not him ignoring.
    await sendOutcome(env, chatId, ctx, effects, undefined, 'none', undefined, 'replying');
  }
}


/**
 * Did he just mention something that wants a reminder?
 *
 * `findFutureInstant` already reads an instant out of arbitrary prose — it was
 * written for the follow-up offer after a task that was ARRANGING something
 * gets closed, and the job here is identical: he said a time out loud, and the
 * bot noticed. "יש לי מחר ב-9 בבוקר אימון" resolves today with no new parsing.
 *
 * Three guards, all of them about not being annoying:
 *  - the instant must be in the future (a past one is a story, not a plan)
 *  - nothing already scheduled near it, or this offers him what he has
 *  - a title must survive cleanTitle, or the offer says nothing useful
 */
async function offerAppointment(
  env: Env,
  chatId: string,
  ctx: Context,
  text: string,
): Promise<Effect | null> {
  const at = findFutureInstant(text, Date.now(), ctx.settings.tz);
  if (at === null || at <= Date.now()) return null;

  const nearby = await db.findNearbyReminders(env, chatId, at, FOLLOWUP_QUIET_WINDOW_MS);
  if (nearby.length) return null;

  const title = titleFromMention(text);
  if (!title) return null;
  return { kind: 'appointment_offer', title, at };
}

/** Anything within this of the mentioned time counts as "already handled". */
const FOLLOWUP_QUIET_WINDOW_MS = 4 * 3_600_000;

/**
 * His own words, minus the time phrase and the sentence frame around it.
 *
 * Kept crude on purpose. The offer quotes this back with a button under it, so
 * a clumsy title costs him one glance and a tap; the alternative — asking the
 * model to extract a subject — costs a round trip on a message that produced
 * nothing else, which is exactly the message least worth spending quota on.
 */
function titleFromMention(text: string): string | null {
  const t = text
    .replace(/(?:^|\s)(?:יש לי|יש לנו|קבעתי|קבענו|אני צריך|אני חייב|צריך)(?=\s)/g, ' ')
    .replace(/(?:^|\s)ו?ב?(?:מחרתיים|מחר|היום|בבוקר|בערב|בצהריים|בלילה)(?=$|[\s.,!?])/g, ' ')
    .replace(/(?:^|\s)ו?ב\s*-?\s*\d{1,2}(?::\d{2})?(?=$|[\s.,!?])/g, ' ')
    .replace(/(?:^|\s)ו?ב?יום\s+(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // One word is usually the whole point ("אימון"); nothing left means the
  // message was pure scheduling noise and there is nothing to offer about.
  return t.length >= 2 ? t.slice(0, 120) : null;
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

  const verdict = await judgePhoto(env, inst.title, image, caption, chatId);
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
  /**
   * Is this turn CHASING him or ANSWERING him?
   *
   * The only thing it changes is whether speak() is shown the elapsed-minutes
   * block. That block exists so a nag can state a true number instead of
   * inventing one; handed to a turn where he has just replied it becomes an
   * invitation to editorialise about how long he took, and on 16.08.2026 it
   * produced "למה לקח לך 69 דקות להבין מתי זה?" — aimed at a cooperative answer
   * to the bot's own question.
   *
   * Defaults to 'chasing' so every cron path keeps behaving exactly as it did;
   * the reply paths opt out explicitly.
   */
  stance: 'chasing' | 'replying' | 'summarising' = 'chasing',
  /**
   * When the turn this belongs to runs out of time.
   *
   * Absent on the cron paths, which are not answering anybody and can take the
   * full per-call ladder. Present on every reply path, where route() has
   * already spent part of it — see TURN_BUDGET_MS.
   */
  deadline?: number,
): Promise<boolean> {
  // The reminder's own history, written here because this is the single point
  // every path converges on — webhook, button tap and cron alike — and it runs
  // after the writes have committed. Best-effort: a history row that fails must
  // never cost him the message it was describing.
  await db.recordEvents(env, chatId, effects).catch((e) => console.error('recordEvents', e));

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

  /*
   * A turn that THREW is reported in voice.ts's words and nobody else's.
   *
   * `applyIntent` can close an instance and then throw before producing an
   * effect, so the failure wording is written to confirm and deny nothing —
   * it says what is certain and points at /list and /errors. Handing that
   * sentence to a model whose entire licence is to rephrase it invites the one
   * thing it was written to avoid.
   *
   * That is not a worry, it is `rejections` #8. On 23.08.2026 07:47 the router
   * returned unparseable JSON (`errors` #14), the turn failed, and the persona
   * rewrote "משהו נפל לי באמצע" into
   *
   *   העברתי את #60 ללכת למוסך להיום ב-08:47. בלי תירוצים, כן?
   *
   * — an invented move, an invented hour, about a reminder that had not been
   * touched. Rule 1 caught it because 08:47 was an hour the turn did not know.
   * Nothing would have caught "העברתי את #60" on its own if the model had
   * happened to pick an hour off the context, and there is no reason to keep
   * running that race for a message the user reads as an apology anyway.
   */
  const turnFailed = effects.some((e) => e.kind === 'nothing' && e.why === 'failed');

  /*
   * Out of time is the same answer as out of quota: ship the baseline.
   *
   * Checked BEFORE the call rather than left to the deadline to clamp inside
   * generate(), so a turn with nothing left spends no round trip, no D1 reads
   * for the profile and history, and no typing indicator. The whole point is
   * that the message goes out NOW.
   *
   * This is the line that would have answered him on 02.09.2026 22:27 — the
   * reminder was already written and correct, and the only thing between him
   * and being told so was a persona call the turn could not afford.
   */
  const outOfTime = deadline !== undefined && Date.now() >= deadline;
  if (outOfTime) console.warn('turn out of budget before speak(); shipping the baseline');

  let text = baseline;
  if (facts && !turnFailed && !outOfTime && (await modelAllowed(env, priority, chatId))) {
    try {
      const [recent, notes] = await Promise.all([
        history ? Promise.resolve(history.slice(-8)) : db.recentMessages(env, chatId, 8),
        db.listProfileNotes(env, chatId).catch(() => []),
      ]);
      // Read here rather than in buildContext so the paths that never speak —
      // every button tap — do not pay for it. The notes go into `quotable` as
      // well as `profile`: the model is shown them, so it may truthfully quote
      // one back, and the validator has to know that is allowed.
      // The conversation goes into `quotable` for the same reason the notes
      // do, and CLAUDE.md states the rule outright: anything the model is
      // SHOWN has to be swept, or the validator discards truthful rewrites for
      // repeating what the prompt handed them — silently, as a rejection count
      // in /diag rather than an error.
      //
      // `recent` is passed straight to speak() four lines down, so these are
      // literally the turns the model just read. Quoting him back is the most
      // natural thing a rewrite does, and it was scored as an invented task:
      // production 19.08.2026, chat A, `invented task "לשחרר"` on an
      // evening_closeout, minutes after he typed "שחרר אין פה באמת משימה".
      // facts.ts sweeps `userText` for the `nothing` kind alone, and that was
      // a closeout. Two more of the seven rejections on record are this shape.
      //
      // Rule 3 keeps its teeth: `quotable` is matched one-directionally, so a
      // quote only passes when some message actually CONTAINS it. A task
      // nobody ever mentioned is still rejected.
      const spoken: Facts = {
        ...facts,
        profile: notes.map((n) => n.note),
        quotable: [
          ...facts.quotable,
          ...notes.map((n) => n.note),
          ...recent.map((m) => m.text),
        ],
      };
      const dressed = await withTyping(env, chatId, () =>
        speak(env, spoken, recent, baseline, toneNote, stance, deadline),
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
      await db.recordError(env, chatId, 'speak', err).catch(() => {});
    }
  }

  try {
    const rows = buttonsFor(effects, ctx.settings.tz);
    const sent = await sendBurst(env, chatId, text, rows ? keyboard(rows) : undefined);
    if (sent.length) await db.addMessage(env, chatId, 'bot', sent.join('\n\n'));
    return sent.length > 0;
  } catch (err) {
    console.error('send', err);
    await db.recordError(env, chatId, 'send', err).catch(() => {});
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
async function modelAllowed(
  env: Env,
  priority: 'high' | 'low' | 'none',
  chatId: string,
): Promise<boolean> {
  if (priority === 'none') return false;
  if (priority === 'high') return true;
  const limit = Number(env.GEMINI_SOFT_LIMIT ?? '200');
  if (!Number.isFinite(limit) || limit <= 0) return true;
  // Measured against HIS OWN usage, not the shared total. The total was what
  // this compared before, which meant a guest burning the day's calls silently
  // switched off the owner's check-ins — with nothing anywhere to say why they
  // had stopped. The shared API key is still protected, by the per-minute rate
  // window in gemini.ts, which is the axis that actually binds.
  //
  // Fail open: if the usage query throws, a check-in still gets the model
  // rather than being silently suppressed forever by a broken read.
  try {
    // Every model, not one of them. The ladder spreads a day's work across
    // several rungs (see gemini.modelLadder), so a single-model counter reads
    // a fraction of what he actually spent — and this budget, which is the
    // only thing that ever throttles unprompted check-ins, would stop binding
    // altogether the day the ladder got longer.
    const used = await db.usageTodayAll(env, chatId);
    return used < limit;
  } catch (err) {
    console.error('modelAllowed: usage read failed, allowing', err);
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

/**
 * One minute of work, for everybody.
 *
 * The two due-queries below used to read the WHOLE table with no chat filter,
 * and the loop that followed sent everything to env.OWNER_CHAT_ID. That was
 * harmless only because nobody else could create a row: the moment a second
 * person existed, their reminders would have fired correctly and been
 * delivered, titles and all, into the owner's chat.
 *
 * The filtering is done in SQL rather than here, and that matters: both
 * queries carry `LIMIT 25`, so rows belonging to a chat that is no longer
 * allowed would otherwise sit at the front of the result set forever and
 * starve the people who are.
 *
 * Each chat is its own failure domain. One user's broken turn must not swallow
 * another user's reminders, for exactly the reason one failed send never
 * aborts the rest of a tick.
 */
/**
 * Run a tick off the back of an inbound message, but only if the cron has
 * actually gone quiet.
 *
 * Deliberately reads the clock and decides here rather than always calling
 * `tick` and letting the claim sort it out. The claim would sort it out — but
 * every message would then pay for a write to `meta` and the reasoning "why
 * does an ordinary conversation touch the scheduler" would be invisible. A
 * healthy cron is left to do its own job.
 */
async function catchUpTick(env: Env): Promise<void> {
  const last = await db.lastTick(env).catch(() => null);
  /*
   * Only on EVIDENCE that the scheduler was alive and has gone quiet.
   *
   * "Never ticked at all" is deliberately not evidence, and the first version
   * of this treated it as the strongest evidence there is. It is not: it is
   * also the state of a Worker deployed ninety seconds ago, of a fresh
   * database, and of every test rig — three of which promptly started firing
   * reminders in the middle of unrelated webhook turns, which is exactly what
   * this would do in production to a bot whose first cron had simply not
   * arrived yet.
   *
   * A cron that has never run once is a misconfiguration, not a stall, and it
   * already has a loud reader: /diag says "מעולם לא רץ!". Quietly propping it
   * up from the webhook path would keep the bot limping — answering when
   * spoken to, silent the rest of the day — while hiding the one fact that
   * explains it.
   */
  if (last === null || Date.now() - last < CATCHUP_AFTER_MS) return;
  console.log(`cron looks quiet (last tick ${last === null ? 'never' : `${Date.now() - last}ms ago`}) — catching up`);
  await tick(env);
}

async function tick(env: Env): Promise<void> {
  const now = Date.now();

  /*
   * Claimed before any work, not merely stamped.
   *
   * The stamp still does its original job — /diag can distinguish "the
   * scheduler is dead" from "the scheduler ran and something inside it threw",
   * which look identical from his side and are completely different bugs.
   *
   * What is new is that losing the claim ENDS the tick. There are three
   * triggers now (the every-minute cron, the five-minute catch-up, and a
   * webhook that notices the cron has gone quiet), and `tick` reads the due
   * rows before it
   * writes anything — so two that overlap between the read and the write would
   * both fire, both nag, and both send. One conditional UPDATE covers all of
   * that, including the unprompted paths nobody has written yet.
   *
   * Fails CLOSED, unlike most best-effort bookkeeping here: if the claim query
   * throws we do not know whether another tick is running, and a duplicate
   * ping is worse than a minute's delay on a cadence that retries in sixty
   * seconds anyway.
   */
  const claimed = await db
    .claimTick(env, now)
    .catch((e) => {
      console.error('claimTick', e);
      return false;
    });
  if (!claimed) return;

  // The deploy ping is the owner's, not every user's — it is the bot
  // reporting on itself. Before the per-chat work, so a tick with nothing
  // else to do still delivers it.
  await announceDeploy(env, env.OWNER_CHAT_ID);

  const chats = [...(await db.allowedChats(env))];
  if (!chats.length) return;

  const [due, nags] = await Promise.all([
    db.dueReminders(env, now, chats),
    db.dueNags(env, now, chats),
  ]);

  for (const chatId of chats) {
    await tickChat(
      env, chatId, now,
      due.filter((r) => r.chat_id === chatId),
      nags.filter((i) => i.chat_id === chatId),
    ).catch(async (err) => {
      console.error(`tick ${chatId}`, err);
      await db.recordError(env, chatId, 'tick', err).catch(() => {});
    });
  }
}

async function tickChat(
  env: Env,
  chatId: string,
  now: number,
  due: Awaited<ReturnType<typeof db.dueReminders>>,
  nags: Awaited<ReturnType<typeof db.dueNags>>,
): Promise<void> {
  const settings = await db.getSettings(env, chatId);

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
  const fired: Extract<Effect, { kind: 'reminder_fired' }>[] = [];
  // A chill DEFERS a fire, it does not consume one.
  //
  // `if (muted) continue` used to sit inside this loop, after createInstance —
  // so during a chill the schedule advanced and an instance opened for a
  // message that never went out. sendOutcome never ran, so there was no
  // `צלצלה` event either, and `if (muted) return` below skipped the nags. When
  // the chill lifted, next_nag_at was long past and the first thing he heard
  // about that reminder was `נו? "X" עדיין פתוחה מ-08:00` — a nag for
  // something he was never sent. A one-off was worse: computeNext returns null
  // for it, setNextFire marked it 'done', and the reminder was simply gone.
  //
  // An instance means "he was told, and we are waiting to hear back". If he
  // was not told, there is nothing to wait for and nothing to nag about. So
  // the whole block is skipped and the rows stay due — bounded, because
  // `chill` clamps to 72 hours, so a deferred row cannot sit here forever.
  for (const r of muted ? [] : due) {
    // When it was SUPPOSED to ring, captured BEFORE setNextFire moves the
    // schedule on. It is the idempotency key for this dose (migrations/017)
    // and the only way the fire below can know it is late.
    const dueAt = r.next_fire_at;

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
    // The first nag is a persona decision (see NAG_BACKOFF_MIN), not the
    // reminder's stored interval — which was 20 minutes on every row ever
    // created and produced four pings in one hour on 13.08.2026.
    const instanceId = await db.createInstance(
      env, r, now,
      now + nagDelayMinutes(0) * 60_000,
      dueAt,
    );
    // Somebody else already opened this dose. The row is theirs, the send is
    // theirs, and going on would ping him twice for one errand.
    if (instanceId === null) {
      console.log(`reminder ${r.id} already fired for slot ${dueAt} — skipping`);
      continue;
    }
    console.log(`fired reminder ${r.id} → instance ${instanceId}${misses ? ` (${misses} missed)` : ''}`);
    // Ticks from the LAST time this fired are cleared before it goes out
    // again, or a daily three-errand reminder arrives on day two already
    // showing all three done. Items hang off the reminder, not the instance
    // (see migrations/011), which is what makes this line necessary — and
    // best-effort, because a stale ✓ in one message is worth far less than
    // everyone's reminders.
    await db.resetItems(env, r.id).catch((e) => console.error('resetItems', e));
    const items = await db.listItems(env, r.id).catch(() => []);

    // Whoever set this, as SHE calls him — read now rather than stored on the
    // row, because she may have renamed him since (see migrations/013). Null
    // when he set it himself, and also when the friendship has since ended:
    // in that case the reminder still fires, unattributed, because it is her
    // row and deleting it behind her back would be the bigger surprise.
    const from = r.from_chat_id
      ? await db.friendName(env, chatId, r.from_chat_id).catch(() => null)
      : null;
    fired.push({
      kind: 'reminder_fired', id: r.id, title: r.title, instanceId,
      requiresProof: r.requires_proof === 1,
      // The appointment this reminder is ABOUT, when it is a different time
      // from the ring. This is the moment the field earns its keep: a reminder
      // that goes off on Monday evening saying "להתכונן לטיפול" and does not
      // say the appointment is 08:30 has told him to prepare for an hour he
      // then has to go and look up.
      //
      // Dropped once it is in the past, so a daily reminder whose appointment
      // has been and gone stops announcing it.
      ...(r.event_at && r.event_at > now ? { eventAt: r.event_at } : {}),
      /*
       * Late, and saying so.
       *
       * Cloudflare's cron is best-effort: 1251 of ~1420 minutes in the 24h to
       * 02.09.2026, and on 01.09 it skipped eighty in a row. Reminder #69 was
       * due at 16:30 and instance 53 records fired_at 17:50:39 — and it opened
       * with "נו? לנקות את הפילטרים של המזגנים", word for word what it would
       * have said on time.
       *
       * That is a false claim about WHEN, which is the class this whole
       * pipeline exists to prevent; it arrived through the one door nobody had
       * built a guard on, because until migrations/017 the scheduled instant
       * was not on the row to compare against.
       *
       * Only past LATE_THRESHOLD_MIN. Single dropped minutes are routine (13
       * gaps of 3-5 minutes in that same sample), and a reminder that
       * apologises every morning for scheduling jitter is noise — which is how
       * a true statement stops being read.
       */
      ...(dueAt !== null && now - dueAt >= LATE_THRESHOLD_MIN * 60_000
        ? { dueAt, lateBy: Math.round((now - dueAt) / 60_000) }
        : {}),
      ...(misses > 0 ? { misses } : {}),
      ...(items.length ? { items } : {}),
      ...(from ? { from } : {}),
    });
  }

  // Every instance above is already committed, so a failed send costs a
  // message, never a fired reminder.
  if (fired.length) {
    ctx = await buildContext(env, chatId);
    const delivered = await sendOutcome(env, chatId, ctx, fired, NAG_LADDER[0]);
    if (!delivered) {
      console.log(`DELIVERY FAILED for ${fired.length} fired reminder(s)`);
      // "Marked delivered, never received" is the bug this project was started
      // for, and this was the only line that ever noticed it happening — into a
      // log that is not enabled. Now it survives to /diag and /why.
      await db
        .recordDeliveryFailure(env, chatId, fired.map((f) => f.id), now)
        .catch((e) => console.error('recordDeliveryFailure', e));
    }
  }

  if (muted) return;

  // He is mid-conversation. Hold the round rather than talking over him.
  //
  // On 16.08.2026 five messages stacked up while he was actively answering,
  // one of them asking why he had taken 69 minutes — at the moment he was
  // cooperating. A bot that interrupts is not being persistent, it is being
  // noise, and noise is how a good prompt gets muted.
  //
  // Read once for the whole loop, and only when something is actually due to
  // nag: an ordinary tick with nothing pending never pays for this query.
  const spokeAt = nags.length ? await db.lastInboundAt(env, chatId).catch(() => null) : null;
  const talking =
    spokeAt !== null && now - spokeAt < CONVERSATION_WINDOW_MIN * 60_000;

  for (const inst of nags) {
    if (inst.chat_id !== chatId) continue;

    // deferNag, NOT bumpNag — the same "defer without burning a round" the
    // quiet-hours branch below uses. nag_count drives the ladder and gave_up,
    // so burning a round here would let a chatty hour exhaust his patience
    // budget without a single nag having been delivered.
    //
    // And bounded: it defers to the END of the window, not by a fresh interval
    // each time. The moment he stops typing the ladder resumes on its own.
    // Pushing next_nag_at forward on every inbound message instead would leave
    // the instance open forever, nag_count frozen and gave_up unreachable —
    // a reminder that has quietly stopped being one.
    if (talking) {
      await db.deferNag(env, inst.id, spokeAt! + CONVERSATION_WINDOW_MIN * 60_000);
      continue;
    }

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
      // The second caller of patternFor, and the one the `failing` pattern was
      // actually written for. Its only caller used to be the `snooze` branch —
      // but `failing` needs dones === 0 and failures >= FAILURE_FLOOR, and a
      // reminder that runs the ladder out is one he IGNORED. Ignoring never
      // produces a snooze, so the detector could only fire for a reminder he
      // both ignores AND occasionally pushes. Production `events` holds no
      // `ויתרתי` rows at all.
      //
      // Raised HERE, on the give-up itself, for the same reason the push
      // pattern is raised on the snooze: this is the moment the bot has spent
      // a whole ladder and got nothing, so the question makes sense, and it
      // rides along on a message he was already getting. `true` counts the
      // give-up committing right now — sendOutcome writes its event after this
      // line, so without it FAILURE_FLOOR would quietly be one higher.
      const alsoAsk = await patternFor(env, chatId, ctx, inst.reminder_id, inst.title, 'failed');
      await sendOutcome(env, chatId, ctx,
        [{ kind: 'gave_up', instanceId: inst.id, title: inst.title, rounds: inst.nag_count }, ...alsoAsk],
        GIVE_UP);
      continue;
    }

    const level = Math.min(3, inst.nag_count + 1);
    // Widening, not fixed. Each round buys more time AND asks for less (see
    // NAG_LADDER), so the escalation lands as patience rather than as volume.
    await db.bumpNag(env, inst.id, now + nagDelayMinutes(inst.nag_count + 1) * 60_000);
    ctx = await buildContext(env, chatId);
    // Level 1 asks the bot to shrink the task. It can only name a PART when a
    // part actually exists — otherwise it would be inventing a decomposition,
    // which is the same unverifiable claim as naming a motive. Items are
    // already in the prompt (openSummary) when there are any.
    const hasItems = (ctx.items?.get(inst.reminder_id)?.length ?? 0) > 0;
    const tone =
      level === 1 && hasItems ? NAG_LADDER_ITEMS : (NAG_LADDER[level] ?? NAG_LADDER[3]);
    await sendOutcome(env, chatId, ctx,
      [{
        kind: 'nagged', instanceId: inst.id, title: inst.title, since: inst.fired_at,
        round: level, granted: inst.granted_min ?? 0,
      }],
      tone);
  }

  /*
   * The daily messages keep his quiet hours, exactly as check-ins do.
   *
   * They were the one unprompted path that did not. The owner's row is
   * quiet_end_hour = 9 against brief_hour = 8, so the bot opened every single
   * morning an hour inside the window he had asked it to stay out of — and
   * "unprompted" is the whole distinction quiet hours draw. A reminder firing
   * at 08:30 is his own instruction and still fires; a good-morning is not.
   *
   * A hold, not a cancellation: markDailySent runs inside the two senders, so
   * skipping here leaves the day unmarked and dailyDue picks it up on the
   * first tick after the window closes. DAILY_GRACE_HOURS still bounds it, so
   * a brief cannot arrive at lunchtime.
   */
  /*
   * ...and they also keep out of the way of an actual reminder.
   *
   * Chat B, 01.09.2026: the morning brief at 08:00:41 and a nag at 08:00:55,
   * fourteen seconds apart, naming the same two tasks. One tick, two senders,
   * no coordination. The brief's whole job is to say what today holds; saying
   * it immediately after ringing about one of those things is not a summary,
   * it is the same message twice.
   *
   * A hold on exactly the same terms as the quiet-hours one above — markDailySent
   * runs inside the senders, so the day stays unmarked and the next tick, sixty
   * seconds later, sends it with nothing in the way. DAILY_GRACE_HOURS still
   * bounds how long that can go on, so a reminder that fires every morning at
   * the brief hour costs the brief a minute, never the day.
   */
  const chasing = due.length > 0 || nags.length > 0;
  if (briefDue && !quiet && !chasing) await sendMorningBrief(env, chatId, now, settings.tz);
  if (closeoutDue && !quiet && !chasing) await sendEveningCloseout(env, chatId, now, settings.tz);

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
  await sendOutcome(
    env, chatId, ctx,
    [{ kind: 'morning_brief', rows, openCount: open.length }],
    // 'summarising': this REPORTS a day, it does not chase. See the close-out
    // below, and brain.ts where the stance is spent.
    undefined, 'high', undefined, 'summarising',
  );
}

async function sendEveningCloseout(env: Env, chatId: string, now: number, tz: string): Promise<void> {
  await db.markDailySent(env, chatId, 'closeout', localDateKey(now, tz));
  const { from, to } = localDayBounds(now, tz);
  const [tally, missed, dropped, ahead] = await Promise.all([
    db.dayTally(env, chatId, from, now),
    db.openInstances(env, chatId),
    db.droppedBetween(env, chatId, from, now),
    // The rest of TONIGHT. Everything else here looks backwards, which is how
    // a close-out at 21:00 came to announce "אין יותר להיום" over a reminder
    // due at 22:00 — see the effect's own comment in types.ts.
    db.remindersBetween(env, chatId, now, to),
  ]);
  // A day with something still ahead in it is worth closing out even if
  // nothing has happened yet: "nothing so far, and here is what is left" is a
  // useful message, and it is the one the old guard suppressed entirely.
  if (!tally.done && !missed.length && !dropped.length && !ahead.length) return;
  const ctx = await buildContext(env, chatId);
  await sendOutcome(
    env, chatId, ctx,
    [{ kind: 'evening_closeout', done: tally.done, missed, dropped, ahead }],
    /*
     * 'summarising', not the default 'chasing'.
     *
     * 04.09.2026 21:00, over #78 which had been open since 14:59: "נו? 'להזמין
     * אוכל ללילה' פתוח כבר 361 דקות. כמה זמן לוקח לבחור המבורגר?" — a nag, sent
     * from the summary slot, two hours before the nag ladder would have
     * allowed one (NAG_BACKOFF_MIN had backed off to 360, putting the next at
     * 23:31, inside quiet hours). nag_count said 2; he had received three.
     */
    undefined, 'high', undefined, 'summarising',
  );
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

  // The progress note is dropped once a run of check-ins has gone unanswered.
  // "בפעם שעברה שלחת בלי הכנה והיא שמחה ממש" was replayed on the 11th, twice
  // on the 12th, the 13th and the 14th — a memory repeated that far past its
  // moment stops reading as "I remember you" and starts reading as a stuck
  // tape. Passing null here also keeps it out of `facts.quotable`, so the model
  // cannot reach for it either.
  const stale = goal.checkin_count >= db.STALE_PROGRESS_AFTER;
  await sendOutcome(env, chatId, ctx,
    [{ kind: 'checkin_goal', id: goal.id, title: goal.title, why: goal.why,
       lastProgress: stale ? null : goal.last_progress,
       lastProgressAt: stale ? null : goal.last_progress_at,
       lastCheckinAt: goal.last_checkin_at }],
    CHECKIN_GOAL, 'low');

  await db.markGoalCheckin(env, goal.id);
  await reschedule(Date.now());
}
