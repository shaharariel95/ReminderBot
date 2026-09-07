import * as db from './db';
import { describeSchedule, formatLocal, localDayBounds, scheduleWithNext } from './time';
import type { Env, ReminderItem, Schedule } from './types';
import { VERSION } from './version';
import { sendMessage } from './telegram';
import { keyboard } from './buttons';
import { modelLadder, probeLadder } from './gemini';

/**
 * The same commands, in the language the bot actually speaks.
 *
 * Two forms on purpose, and the second is the one that matters:
 *
 * "/רשימה" works when typed but will never appear in Telegram's `/` menu —
 * BotFather only accepts command names matching [a-z0-9_], so there is no way
 * to register it for autocomplete. It is supported because people type it, not
 * because it is discoverable.
 *
 * The bare word is the real fix. The friction was never the slash; it is
 * switching keyboard layout to type "list" in the middle of a Hebrew
 * conversation. "רשימה" on its own line costs no layout switch, no slash, and
 * — because handleSlash runs before the router — no Gemini call. Until now a
 * bare "רשימה" was routed by the model, which is a round trip and a quota unit
 * to answer a question the database already knows.
 *
 * Kept to unambiguous single words. Anything that could plausibly begin a real
 * sentence stays out: this map wins over the router, so a false positive here
 * silently swallows a real request.
 */
const ALIASES: Record<string, string> = {
  רשימה: '/list',
  תזכורות: '/list',
  היום: '/today',
  מטרות: '/goals',
  עזרה: '/help',
  סטטיסטיקה: '/stats',
  נתונים: '/stats',
  אינבוקס: '/inbox',
  פרופיל: '/profile',
  בדיקה: '/diag',
  תקלות: '/errors',
  שגיאות: '/errors',
  // The singulars, because he typed "/error" on 30.08.2026, was told there is
  // no such command, and typed it again with the s. A command that exists
  // under one spelling and not the obvious other one is a command he has to
  // remember rather than guess — and this is the command he reaches for when
  // something is already wrong.
  error: '/errors',
  errors: '/errors',
  תקלה: '/errors',
  שגיאה: '/errors',
  מחכים: '/pending',
  חברים: '/friends',
  // Deliberately only the LISTING. "/friend" needs a chat_id — digits, which
  // means the keyboard has already been switched — so the Hebrew alias would
  // save nothing, and a bare "חבר" is a word that can start a real sentence.
  // A false positive in this map silently swallows a request to the router.
  מזהה: '/id',
  // Deliberately NOT here: שקט → /chill. Every other alias answers a question;
  // that one takes an action — four hours of silence — off a single bare word
  // that could easily be part of something else. "תשתוק" reaches the router's
  // `chill` intent perfectly well, and that path can see the whole sentence.
};

/**
 * The command a message is asking for, in canonical `/english` form.
 *
 * Note `.toLowerCase()` is a no-op on Hebrew, so the alias lookup is
 * case-insensitive for free on the English side and unaffected on the Hebrew.
 */
function normalizeCommand(text: string): string {
  const first = text.trim().split(/\s+/)[0].toLowerCase().split('@')[0];
  if (first.startsWith('/')) return ALIASES[first.slice(1)] ?? first;
  // A bare word is only a command when it is the WHOLE message. "רשימה" is a
  // command; "רשימה של דברים לקנות" is a reminder he is asking for, and
  // stealing it from the router would lose it entirely.
  return text.trim().includes(' ') ? first : ALIASES[first] ?? first;
}

/**
 * One sentence for 'you may not run that' and 'that does not exist'.
 *
 * Shared on purpose — it is the whole of the OWNER_ONLY gate. Two different
 * replies would tell a guest which commands are real.
 */
const NO_SUCH_COMMAND = 'אין פקודה כזאת. /help לרשימה.';

/**
 * Past this, the scheduler is not merely jittery — it has stopped.
 *
 * The cron is meant to run every minute and does not: Cloudflare invoked the
 * Worker on 1251 of ~1420 minutes in the 24h to 02.09.2026, with thirteen gaps
 * of 3-5 minutes. So the threshold has to clear routine drops, or the alarm is
 * wrong every hour and he learns to scroll past it — which is exactly the
 * failure this line exists to fix, one level up.
 *
 * Five minutes clears every routine gap in that sample and is a fifth of the
 * one real outage in it.
 */
const TICK_STALE_MS = 5 * 60_000;

/**
 * The cron's health, as a sentence rather than as a timestamp.
 *
 * This is the line /diag existed to print and could not read out loud. On
 * 02.09.2026 at 20:36, twenty-eight minutes into a total cron outage — with a
 * reminder due the next afternoon that was never going to fire — it said
 *
 *     טיק אחרון: יום ד׳, 02.09.2026, 20:08
 *
 * in exactly the same voice as `d1: תקין ✓` two lines below. Every fact needed
 * to diagnose the outage was on screen and none of it was legible, because
 * subtracting one from the other was left to the reader.
 *
 * The age is ALWAYS stated, so a three-minute gap is visible without being an
 * alarm; the alarm is reserved for a gap that cannot be jitter.
 */
function tickLine(tick: number | null, tz: string): string {
  if (tick === null) return 'מעולם לא רץ!';
  const ageMs = Math.max(0, Date.now() - tick);
  const mins = Math.round(ageMs / 60_000);
  const ago = mins < 1 ? 'לפני פחות מדקה' : `לפני ${mins} דקות`;
  const stamp = `${formatLocal(tick, tz)} (${ago})`;
  return ageMs >= TICK_STALE_MS
    ? `${stamp} — הקרון לא רץ! אמור לרוץ כל דקה. תזכורות לא יצלצלו עד שזה יחזור.`
    : stamp;
}

/** Commands only the owner may run. See the gate in handleSlash for why. */
const OWNER_ONLY = new Set([
  '/diag', '/allow', '/deny', '/allowed', '/pending', '/errors',
  // Spends real quota on the shared key — eight calls a run — and prints the
  // shape of the whole ladder. Both are owner business.
  '/models',
]);

/** Slash commands handled without burning an LLM call. */
export async function handleSlash(
  env: Env,
  chatId: string,
  text: string,
  /**
   * What Telegram says this sender is called. Used for exactly one thing: the
   * name the OTHER side gets for him when a friend request is accepted, so
   * that her reminders do not arrive from a bare chat_id. Optional, because
   * every other command works without knowing who is typing, and because
   * Telegram does not promise it — the chat_id is the fallback, and it is
   * ugly rather than wrong.
   */
  senderName?: string,
): Promise<string | null> {
  const cmd = normalizeCommand(text);

  /**
   * Did he type a SLASH, as opposed to a bare Hebrew word that ALIASES turned
   * into one?
   *
   * This distinction is what lets the two refusals below answer at all.
   * `normalizeCommand('בדיקה')` is '/diag', and "בדיקה" is also just a Hebrew
   * word — answering "no such command" to it would swallow ordinary
   * conversation, which is the exact failure ALIASES is documented as
   * guarding against. A leading "/" is unambiguous: nobody types it by
   * accident mid-sentence.
   */
  const typedSlash = text.trim().startsWith('/');

  /**
   * Owner-only commands, answered exactly the way a command that does not
   * exist is answered.
   *
   * This used to `return null`, on the theory that any reply would turn "does
   * this command exist" into a question anyone could ask by trying it. The
   * theory was right and the implementation inverted it: null meant the
   * message fell through to the ROUTER, and on 09.08.2026 chat B
   * typed /diag — which /help was advertising to him at the time — and the
   * persona improvised "הכל עובד" plus a health report nothing had checked.
   * A fabricated diagnostic discloses more than "no such command" does, and
   * it costs a model call to produce.
   *
   * Sharing one sentence with the `default` arm is what makes the gate real:
   * /diag and /xyzzy are now literally indistinguishable to a guest.
   *
   * /diag is on this list because it prints the API key length, the shared
   * Gemini quota, and the last discarded rewrites, which are conversation
   * content. The rest hand out access.
   */
  if (OWNER_ONLY.has(cmd) && chatId !== env.OWNER_CHAT_ID) {
    return typedSlash ? NO_SUCH_COMMAND : null;
  }

  switch (cmd) {
    case '/allow':
    case '/deny': {
      // The rest of the line, not just the next word: names have spaces.
      const target = text.trim().slice(cmd.length).trim();
      if (!target) return 'מי? שם מתוך /pending, או chat_id.';

      // A name is what the owner actually recognises; the id is the fallback
      // for someone who never went through onboarding.
      let chatId = /^\d{1,20}$/.test(target) ? target : null;
      if (!chatId) {
        const matches = await db.findPending(env, target);
        if (!matches.length) return `אין לי "${target}" ברשימה. /pending יראה לך מי מחכה.`;
        // Two people with the same name is the one case where guessing hands
        // access to the wrong person.
        if (matches.length > 1) {
          return [
            `יש כמה בשם "${target}". תבחר לפי מספר:`,
            ...matches.map((m) => `· ${m.name} — ${m.chat_id}`),
          ].join('\n');
        }
        chatId = matches[0].chat_id;
      }

      if (cmd === '/deny') {
        // Remembered, so their next message does not restart the whole
        // conversation and ask you about them again.
        await db.denyPending(env, chatId);
      } else {
        await db.clearPending(env, chatId);
      }

      const current = await db.allowedChats(env);
      // The owner is implicit in `allowedChats` and must never end up in the
      // stored list — writing them in would make a later /deny look like it
      // could remove them.
      current.delete(env.OWNER_CHAT_ID);
      // `chatId`, never `target` — target may be a name, and a name in the
      // allow list would match nobody and silently grant access to no one.
      if (cmd === '/allow') current.add(chatId);
      else current.delete(chatId);
      await db.setAllowedChats(env, [...current]);

      if (cmd === '/allow') {
        // They have been waiting in silence by design, so somebody has to
        // tell them it changed. Best-effort: a blocked bot must not turn the
        // owner's confirmation into an error.
        await sendMessage(env, chatId, 'אושרת. אני נו? — תגיד לי מה להזכיר לך.').catch((err) =>
          console.error('welcome', err),
        );
        return `${target} (${chatId}) ברשימה. אמרתי לו.`;
      }
      return `${target} (${chatId}) לא נכנס. לא אשאל אותך עליו שוב.`;
    }

    case '/pending': {
      const rows = await db.listPending(env);
      if (!rows.length) return 'אף אחד לא מחכה.';
      return [
        'מחכים לאישור:',
        ...rows.map((p) => `· ${p.name ?? '(עוד לא אמר שם)'} — ${p.chat_id}`),
        '',
        'לאישור: /allow [שם] · לדחייה: /deny [שם]',
      ].join('\n');
    }

    case '/allowed': {
      const list = [...(await db.allowedChats(env))].filter((id) => id !== env.OWNER_CHAT_ID);
      return list.length
        ? ['מי שיכול לדבר איתי חוץ ממך:', ...list.map((id) => `· ${id}`)].join('\n')
        : 'רק אתה. להוספה: /allow [chat_id]';
    }
  }

  switch (cmd) {
    case '/start':
      return [
        'יאללה. אני נו?',
        '',
        'תזכורות זה דברים עם שעה — "תזכיר לי כל יום ב-7 לרוץ", "תנדנד לי על החשבונות בחמישי ב-18:00 ותדרוש תמונה".',
        'מטרות זה דברים בלי שעה — "אני רוצה לפתוח תיק מסחר". על אלה אני אשאל אותך לבד, בלי שתבקש.',
        '',
        'כשסיימת משהו — תגיד לי, או תשלח תמונה.',
        '',
        'רשימת הפקודות: /help',
      ].join('\n');
    case '/help': {
      /**
       * The owner-only block, printed only to the owner.
       *
       * OWNER_ONLY above returns null so those commands are indistinguishable
       * from commands that do not exist — and then this list handed all six of
       * them to everybody, which made the whole gate ceremonial. Worse, the
       * `default` arm's "no such command" reply was owner-gated too, so a
       * guest who read one here and typed it fell through to the ROUTER.
       *
       * Production, 09.08.2026, chat B, straight after reading /help:
       *
       *   user  /diag
       *   bot   מה אתה מריץ בדיקות עכשיו?
       *         הכל עובד. יש לך תזכורת אחת ללכת לאגרוף תאילנדי ב-18:00...
       *
       * "הכל עובד" is a claim about system health that nothing checked. It was
       * also the last message that user ever sent.
       */
      const owner = chatId === env.OWNER_CHAT_ID;
      const ownerOnly = owner
        ? [
            '/diag — בדיקת תקינות (מודל, מפתח, חיבורים, קרון)',
        '/models — בודק כל מודל בסולם ומודד כמה זמן לקח',
            '/errors — חמש התקלות האחרונות',
            '/pending — מי מבקש להיכנס · /allow [שם] · /deny [שם] · /allowed',
          ]
        : [];
      return [
        'רשימות:',
        '/today — מה יש היום, ומה עוד פתוח',
        '/list — התזכורות שלך (אלה עם שעה)',
        '/goals — המטרות שלך (אלה בלי שעה)',
        '/inbox — דברים שתפסתי בלי שעה',
        '/stats — רצף, בוצעו, נפלו',
        '/profile — מה אני יודע עליך',
        '',
        'שליטה בי:',
        '/remember [טקסט] — עובדה קבועה עליך שכדאי שאזכור',
        '/daily [בוקר] [ערב] — שעות הסיכום היומי. "off" מכבה.',
        '/chill [שעות] — שתיקה מוחלטת זמנית (ברירת מחדל 4). כל הודעה ממך מבטלת.',
        '/checkins on|off|1-8 — כמה אני פותח שיחות מעצמי',
        '/intensity 1|2|3 — כמה עוקצני אני',
        '/quiet [התחלה] [סוף] — שעות שקט, למשל /quiet 23 8',
        '/offlimits [טקסט] — נושאים שאסור לי לגעת בהם. בלי טקסט = מציג. "clear" = מנקה.',
        '/why [מספר] — כל מה שקרה לתזכורת אחת',
        ...ownerOnly,
        '',
        'חברים — תזכורות שאתה קובע לאנשים אחרים:',
        '/id — המספר שלך, זה מה שחבר צריך כדי להוסיף אותך',
        '/friend [chat_id] [כינוי] — מבקש להוסיף מישהו. הוא צריך לאשר.',
        '/friends — מי ברשימה, ומי מחכה לתשובה שלך',
        '/rename — משנה איך אתה קורא למישהו ברשימה',
        '/unfriend [כינוי] — מוריד, לשני הכיוונים',
        'ואז פשוט: "תזכיר לדנה מחר ב-8 לקחת את הרכב לטסט"',
        '',
        'הכל עובד גם בעברית, עם או בלי לוכסן:',
        'רשימה · היום · מטרות · עזרה · אינבוקס · תקלות',
        '',
        'כמה דברים בתזכורת אחת:',
        '"תזכיר לי להחזיר ראוטר, לקנות מחבת, ללכת למחסני תאורה מחר ב8"',
        'כל אחד מהם נסגר בנפרד — בכפתור, או "החזרתי את הראוטר".',
        '',
        'כל השאר בשפה חופשית:',
        '"תזכיר לי כל יום ב-7 לרוץ" · "אני רוצה לפתוח תיק מסחר"',
        '"סיימתי" · "תדחה בחצי שעה" · "תבטל את #3"',
        'או פשוט תשלח תמונה כהוכחה.',
      ].join('\n');
    }

    /**
     * The number somebody else needs in order to add you.
     *
     * Not owner-only: the only id it will ever print is the id of the chat it
     * was typed in, so a guest reading his own tells him nothing he could not
     * already see in any Telegram client — and without it there is no way to
     * become somebody's friend at all.
     */
    case '/id':
      return [
        `ה-chat_id שלך: ${chatId}`,
        '',
        'זה מה שחבר צריך כדי להוסיף אותך:',
        `/friend ${chatId} [כינוי]`,
      ].join('\n');

    /**
     * Ask somebody to be a friend, or rename one you already have.
     *
     * Nothing here grants anything. The row lands as `pending` and the other
     * side has to tap yes — see migrations/013 — because what a friendship
     * grants is the right to write a row into your chat and make your phone
     * go off at 07:00, and that is not a thing anyone gets to hand out on
     * somebody else's behalf.
     */
    /*
     * Repair a name he cannot type — which is every reverse edge written
     * before 0.29.0, and any whose owner skipped the question at accept time.
     *
     * It exists because `/friend <name> <new>` cannot do this job. That path
     * resolves <name> through matchFriend FIRST, so renaming a book entry
     * spelled "Shahar" required typing "Shahar" — the repair for a name he
     * could not type required typing it. Copy-pasting out of /friends was the
     * only way through and nothing said so.
     *
     * With exactly one friend there is nothing to disambiguate, so it asks
     * the same question the accept flow asks and reuses the same slot. With
     * more it LISTS rather than picking: matchFriend returns null on a tie
     * because sending to the wrong friend is a message in a stranger's chat,
     * and this must not become the one place that guesses instead.
     */
    case '/rename': {
      const friends = await db.friendsOf(env, chatId);
      if (!friends.length) {
        return 'אין לך עדיין חברים ברשימה. /friend [chat_id] [כינוי] מוסיף אחד.';
      }
      const rest = text.trim().slice(cmd.length).trim();
      if (!rest && friends.length === 1) {
        await db.setAwaiting(env, chatId, { k: 'fname', c: friends[0].friend_chat_id, at: Date.now() });
        return `עכשיו הוא "${friends[0].nickname}". איך תקרא לו? תכתוב לי שם.`;
      }
      if (!rest) {
        return (
          'למי? ' +
          friends.map((f) => `"${f.nickname}"`).join(', ') +
          '\n/rename [השם הנוכחי] [השם החדש]'
        );
      }
      const [first, ...tail] = rest.split(/\s+/);
      const nickname = tail.join(' ').trim();
      const existing = db.matchFriend(friends, first);
      if (!existing) {
        /*
         * With exactly one friend there is nothing to disambiguate, so a single
         * word that is NOT his current name can only be the new one.
         *
         * The comment above already says this, and 0.29.0 wired it to the
         * no-argument form only. `/rename אחי` — the obvious way to type it —
         * fell through to matchFriend, which read "אחי" as "which friend",
         * found nothing and answered `אין לי "אחי" ברשימה. יש: "אמנון"`
         * (production, 07.09.2026 19:22). So repairing a name he could not type
         * still required typing it: the exact bug 0.29.0 was written to fix,
         * surviving one branch to the left of the fix.
         *
         * Only when `nickname` is empty. "/rename אחי בוקר" is genuinely
         * ambiguous between a two-word new name and a rename of somebody
         * called "אחי", and this must not become the one place that guesses.
         */
        if (friends.length === 1 && !nickname) {
          await db.renameFriend(env, chatId, friends[0].friend_chat_id, first);
          return `מעכשיו הוא "${first}" אצלי.`;
        }
        return `אין לי "${first}" ברשימה. יש: ${friends.map((f) => `"${f.nickname}"`).join(', ')}`;
      }
      if (!nickname) {
        await db.setAwaiting(env, chatId, { k: 'fname', c: existing.friend_chat_id, at: Date.now() });
        return `איך תקרא ל"${existing.nickname}"? תכתוב לי שם.`;
      }
      await db.renameFriend(env, chatId, existing.friend_chat_id, nickname);
      return `מעכשיו הוא "${nickname}" אצלי.`;
    }

    case '/friend': {
      const rest = text.trim().slice(cmd.length).trim();
      const [first, ...tail] = rest.split(/\s+/);
      const nickname = tail.join(' ').trim();
      if (!first) return 'מי? /friend [chat_id] [כינוי]. את ה-chat_id שלו הוא מקבל מ-/id.';

      // A name rather than an id means he is renaming somebody already in the
      // book. Kept in the same command on purpose: the reverse edge created at
      // acceptance is named after his Telegram name (see db.acceptFriend), and
      // this is the only way to fix that.
      if (!/^\d{1,20}$/.test(first)) {
        const existing = db.matchFriend(await db.friendsOf(env, chatId), first);
        if (!existing) return `אין לי "${first}" ברשימה. /friends יראה לך את מי שיש.`;
        if (!nickname) return `${existing.nickname} כבר קיים. /friend ${first} [כינוי חדש] כדי לשנות לו את השם.`;
        await db.renameFriend(env, chatId, existing.friend_chat_id, nickname);
        return `מעכשיו הוא "${nickname}" אצלי.`;
      }
      if (!nickname) return 'וגם כינוי — איך תקרא לו. /friend [chat_id] [כינוי].';

      // The guest list is what bounds who can be MADE to receive a message on
      // somebody else's say-so. Everyone else gets exactly the silence
      // greetStranger gives them, and a friend request must not be a way
      // around it.
      if (!(await db.allowedChats(env)).has(first)) {
        return 'אני לא מכיר את המספר הזה. הוא צריך לדבר איתי קודם ולקבל אישור.';
      }

      const ask = await db.requestFriend(env, chatId, first, nickname, senderName);
      if (!ask.ok) {
        switch (ask.kind) {
          case 'self':
            return 'זה אתה.';
          case 'already':
            return `${nickname} כבר חבר שלך. /friends יראה לך את כולם.`;
          // Said no once. Asking again is the nagging this prevents — the same
          // rule a denied stranger gets in `pending`.
          case 'declined':
            return 'הוא כבר ענה על זה, ולא. לא אשאל אותו שוב.';
          case 'full':
            return `יש לך כבר ${db.FRIEND_MAX} חברים. תוריד אחד עם /unfriend.`;
        }
      }
      if (ask.kind === 'accepted') {
        // He was answering a request of hers, not opening one of his own.
        await sendMessage(env, first, `${senderName ?? chatId} אישר אותך. אתם חברים.`).catch((err) =>
          console.error('friend accept notice', err),
        );
        return `${nickname} כבר ביקש את זה ממך — אז זהו, אתם חברים. עכשיו אפשר "תזכיר ל${nickname}...".`;
      }

      // Best-effort, like the /allow welcome: a blocked bot must not turn his
      // confirmation into an error. He is told what was written either way,
      // and what was written is a pending row and nothing else.
      await sendMessage(
        env,
        first,
        [
          `${senderName ?? chatId} (${chatId}) רוצה להוסיף אותך כחבר.`,
          'אם תאשר, הוא יוכל לקבוע לך תזכורות — ואתה לו.',
        ].join('\n'),
        keyboard([
          [
            { text: 'מאשר', data: { t: 'facc', from: chatId } },
            { text: 'לא', data: { t: 'frej', from: chatId } },
          ],
        ]),
      ).catch((err) => console.error('friend request', err));

      return ask.kind === 'again'
        ? `שלחתי לו את זה שוב, בתור "${nickname}". עד שהוא יאשר אני לא כותב לו כלום.`
        : `שאלתי אותו. אצלי הוא "${nickname}" — אבל עד שהוא יאשר אני לא כותב לו כלום.`;
    }

    case '/friends': {
      const book = await db.friendBook(env, chatId);
      const incoming = await db.incomingFriendRequests(env, chatId);
      const lines: string[] = [];

      const mine = book.filter((f) => f.status === 'accepted');
      if (mine.length) {
        lines.push('החברים שלך:', ...mine.map((f) => `· ${f.nickname} — ${f.friend_chat_id}`));
      }
      const waiting = book.filter((f) => f.status === 'pending');
      if (waiting.length) {
        lines.push('', 'ביקשת, עוד לא ענו:', ...waiting.map((f) => `· ${f.nickname} — ${f.friend_chat_id}`));
      }
      if (incoming.length) {
        // Answerable from here, not only from the button on a message that may
        // be a hundred messages back: naming him is the same "yes" the button
        // sends, and it arrives with his own name for the person instead of
        // the one derived at acceptance. See db.requestFriend.
        lines.push(
          '',
          'מחכים לתשובה שלך:',
          ...incoming.map((f) => `· ${f.chat_id}`),
          'לאשר: /friend [chat_id] [כינוי]',
        );
      }
      if (!lines.length) return `אין לך חברים אצלי. /id ייתן לך את המספר שלך, /friend [chat_id] [כינוי] מוסיף.`;
      return lines.join('\n');
    }

    case '/unfriend': {
      const target = text.trim().slice(cmd.length).trim();
      if (!target) return 'את מי? /unfriend [כינוי].';
      const friends = await db.friendsOf(env, chatId);
      const hit = /^\d{1,20}$/.test(target)
        ? friends.find((f) => f.friend_chat_id === target) ?? null
        : db.matchFriend(friends, target);
      if (!hit) return `אין לי "${target}" ברשימה. /friends יראה לך את מי שיש.`;
      // Both directions. Leaving his edge behind leaves him still able to
      // write reminders into a chat that has just removed him.
      await db.removeFriend(env, chatId, hit.friend_chat_id);
      return `${hit.nickname} ירד. אף אחד מכם לא יכול לקבוע לשני יותר.`;
    }

    case '/diag': {
      const ladder = modelLadder(env);
      const model = ladder[0] ?? 'gemini-3.5-flash';
      // One settings read for everything below, not one per block: /diag is
      // the command you run when something is already wrong, and it should
      // not be the command that costs the most queries.
      const tz = await db
        .getSettings(env, chatId)
        .then((s) => s.tz)
        .catch(() => env.DEFAULT_TZ ?? 'Asia/Jerusalem');
      const lines = [
        // First line, because "am I even running the code I think I am"
        // precedes every other question this command answers.
        `גרסה: ${VERSION}`,
        `מודלים: ${ladder.join(' · ')}`,
        `GEMINI_API_KEY: ${env.GEMINI_API_KEY ? `set (${env.GEMINI_API_KEY.length} תווים)` : 'חסר!'}`,
        `OWNER_CHAT_ID: ${env.OWNER_CHAT_ID || 'חסר!'}`,
      ];
      const primary = ladder[0] ?? model;
      // Which models are out, and until when.
      //
      // This is the line that turns "the bot feels stupid today" into a fact
      // with a time on it. A blocked model is invisible from the outside — the
      // reply still arrives, just from further down the ladder — and a 404
      // from a typo in wrangler.toml looks exactly the same as a quota. It is
      // also the safety valve on the ladder's self-pruning: a model that
      // writes itself off for six hours has to be sayable somewhere.
      const health = await db.modelHealth(env).catch(() => new Map());
      const blocked = [...health.values()]
        .filter((h) => h.blocked_until > Date.now())
        .map((h) => `${h.model} (${h.reason ?? '?'}) עד ${formatLocal(h.blocked_until, tz)}`);
      lines.push(blocked.length ? `חסומים כרגע: ${blocked.join(' · ')}` : 'חסומים כרגע: אין');

      // Whether the router's union schema is actually in force.
      //
      // It degrades to the flat schema on a 400 and the reply still arrives,
      // so this is the one symptom there is. A date here means the `anyOf`
      // union was refused and the guarantee it buys — an action that reads no
      // free text cannot emit any — is not applying. "לא קרה" is the healthy
      // answer, and it is the same reason blocked models are named above.
      const refused = await db.schemaRefusal(env).catch(() => null);
      lines.push(
        refused
          ? `סכימת הראוטר נדחתה: ${refused.model} ב-${formatLocal(refused.at, tz)} — רץ על הסכימה השטוחה`
          : 'סכימת הראוטר: תקינה (לא נדחתה מעולם)',
      );

      // Two numbers, because they answer two questions. His own is the one
      // that reconciles with the rejection list printed below and the one his
      // check-in budget is measured against; the total is what protects the
      // shared API key. Showing only the total is what put "נפסלו היום: 1"
      // above an empty list on 11.08.2026 — the rejection was a guest's.
      //
      // Summed across the ladder rather than shown per model: with six rungs,
      // a per-model line is six lines of ones and twos that answer nothing,
      // and the budget they are measured against is now the sum too.
      lines.push(
        `שימוש היום — שלך ${await db.usageTodayAll(env, chatId)} · ` +
          `בסך הכל ${await db.usageTodayAll(env)}`,
        `תשובות שנפסלו היום: ${await db.usageTodayFor(env, db.REJECTION_COUNTER, chatId)}`,
        // The daily counters above are the axis that never binds. This is the
        // one that does, and seeing it live is the whole reason /diag exists.
        `תקרת דקה: ${env.GEMINI_RPM ?? 18} לכל מודל · בדקה הזאת (${primary}): ${await db
          .rateWindowNow(env, primary)
          .catch(() => '?')}`,
      );
      // The cron. This is the subsystem that actually failed in August 2026 —
      // a reminder on the 13th and another on the 14th simply never fired —
      // and it was the one thing /diag could say nothing whatsoever about. The
      // last tick separates "the scheduler is dead" from "the scheduler ran
      // and something inside it threw"; the two counts separate "it never came
      // due" from "it came due and never reached him", which are the only two
      // shapes a missing reminder can have.
      const tick = await db.lastTick(env).catch(() => null);
      const { from, to } = localDayBounds(Date.now(), tz);
      const counts: Record<string, number> = await db
        .eventCounts(env, chatId, from, to)
        .catch(() => ({}));
      lines.push(
        `טיק אחרון: ${tickLine(tick, tz)}`,
        `צלצלו היום: ${counts['צלצלה'] ?? 0} · לא נמסרו: ${counts['לא נמסרה'] ?? 0} · ` +
          `נדנודים: ${counts['נדנוד'] ?? 0} · נסגרו: ${counts['נסגרה'] ?? 0} · ` +
          `ירדו: ${counts['דילג'] ?? 0}`,
        // The unprompted messages that are not about one reminder. Counted
        // here because the line above was the whole answer to "how much did
        // this thing talk to me today", and on 04.09.2026 it was short by one:
        // he got three pressure messages and it reported two.
        `הודעות יומיות: בוקר ${counts['סיכום בוקר'] ?? 0} · ערב ${counts['סיכום ערב'] ?? 0} · ` +
          `מטרות ${counts['בדיקת מטרה'] ?? 0}`,
      );

      /*
       * Whether patterns.ts has ever said anything, and when.
       *
       * It had not — not once, across 55 instances in a month — and no reader
       * anywhere could have shown that. A whole file (a mode calculation, a
       * cooldown, three effect kinds, button wiring) was inert and silent,
       * which is exactly the shape of the goal-check-in bug 0.19.0 closed one
       * file over.
       *
       * /diag already names blocked models for this reason: an optimisation
       * or a threshold that has quietly switched a feature off is invisible
       * until something counts it out loud. "מעולם לא" is the whole point of
       * the line — a zero here is the finding, not the absence of one.
       */
      const lastPattern = await db.lastPatternOffer(env, chatId).catch(() => null);
      lines.push(
        `הצעות דפוס: ${lastPattern === null ? 'מעולם לא' : formatLocal(lastPattern, tz)}`,
      );

      // The count above says how often the model lied; these say what it said.
      // Without them the number is something to worry about rather than
      // something to fix — which is exactly what "3" meant on 10.08.2026.
      const rejected = await db.recentRejections(env, chatId, 3).catch(() => []);
      if (rejected.length) {
        lines.push('', 'אחרונות שנפסלו:');
        for (const r of rejected) {
          lines.push(
            `· ${formatLocal(r.at, tz)} — ${r.reason}`,
            `  "${r.text.replace(/\s+/g, ' ').slice(0, 120)}"`,
          );
        }
      }
      try {
        const t0 = Date.now();
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'say OK' }] }] }),
          },
        );
        const body = await res.text();
        lines.push(`gemini: HTTP ${res.status} ב-${Date.now() - t0}ms`);
        if (!res.ok) lines.push(body.slice(0, 600));
        else lines.push('gemini: תקין ✓');
      } catch (err) {
        lines.push(`gemini: ${String(err).slice(0, 400)}`);
      }
      try {
        await db.getSettings(env, chatId);
        lines.push('d1: תקין ✓');
      } catch (err) {
        lines.push(`d1: ${String(err).slice(0, 300)}`);
      }
      return lines.join('\n');
    }

    /**
     * The last few things that blew up.
     *
     * Owner-only, alongside /diag: it prints internals and other people's
     * message text is never in it, but the stage tags and error strings are
     * the bot's own guts.
     *
     * This exists because "something went wrong" was, until now, the entire
     * available information. Every catch site wrote to console.error and
     * nowhere else, Workers Logs is off, and so the honest answer to "why
     * didn't my reminder arrive" was that nobody could know. It is also where
     * the `נפל לי משהו באמצע` message points him.
     */
    /**
     * Ask every rung of the ladder the same trivial question and time it.
     *
     * The command exists because "promote by measuring" was a rule with no
     * instrument behind it. 0.16.0 promoted two models on the strength of
     * their version numbers and cost two reminders; the correction was to
     * demote them and write "measure first" into three files. Measuring still
     * meant deploying a model low, waiting a day, and reading the `usage`
     * table — which only reports the rungs that were actually REACHED, so the
     * lower ones stay unmeasured no matter how long you wait. This asks them
     * directly.
     *
     * Owner-only, and it spends eight calls of real quota per run.
     *
     * The order printed is the LADDER order, numbered, because the answer this
     * is run to get is "is rung 1 still the right rung 1" — and that question
     * is about position, not about the alphabet.
     */
    case '/models': {
      const probes = await probeLadder(env, chatId);
      const health = await db.modelHealth(env).catch(() => new Map());
      const ladder = modelLadder(env);
      const tz = await db
        .getSettings(env, chatId)
        .then((s) => s.tz)
        .catch(() => env.DEFAULT_TZ || 'Asia/Jerusalem');
      // Milliseconds under a second, seconds above it. "0.4ש׳" and "0.0ש׳"
      // are the same line to a tired reader, and the whole point of this
      // command is comparing two numbers at a glance.
      const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}ש׳`);

      const lines = [`בדיקת מודלים — ${probes.length} בסולם`, ''];
      probes.forEach((p, i) => {
        // The two rungs that have names in the config are worth marking: they
        // are what /diag calls "the model" and what somebody debugging at
        // 02:00 will change.
        const role = i === 0 ? ' ★' : i === 1 ? ' ☆' : '';
        const blocked = (health.get(p.model)?.blocked_until ?? 0) > Date.now();
        const head = p.ok
          ? `${i + 1}. ${p.model} · ${secs(p.ms)} ✓${role}`
          : `${i + 1}. ${p.model} · ${p.status ?? '—'} ✗${role}`;
        lines.push(head);
        if (!p.ok) lines.push(`    ${p.detail}`);
        // Stated separately from the probe result, and it can disagree with
        // it: a model can answer this fine while still being rested from a
        // 429 a minute ago. Both facts matter and neither implies the other.
        if (blocked) lines.push(`    חסום עד ${formatLocal(health.get(p.model)!.blocked_until, tz)}`);
      });

      const ok = probes.filter((p) => p.ok);
      lines.push('', `ענו: ${ok.length}/${probes.length}`);
      if (ok.length) {
        const fastest = ok.reduce((a, b) => (a.ms <= b.ms ? a : b));
        lines.push(`הכי מהיר: ${fastest.model} — ${secs(fastest.ms)}`);
        // The actionable sentence, and the only reason to run this twice.
        // Deliberately worded as a prompt to go and measure properly rather
        // than as advice: one probe is one sample, and promoting on a single
        // fast round trip is the same mistake as promoting on a version
        // number, with a stopwatch instead of a changelog.
        if (fastest.model !== ladder[0]) {
          lines.push(
            `הראשון בסולם הוא ${ladder[0]}. אם זה חוזר על עצמו כמה פעמים — שווה לשקול החלפה.`,
          );
        } else {
          lines.push('הראשון בסולם הוא גם הכי מהיר.');
        }
      }
      // All of them failing is much more likely to be the key, the network or
      // this probe than eight models going down at once — say so, instead of
      // printing eight identical error lines and letting him infer it.
      if (!ok.length) lines.push('אף אחד לא ענה — זה נראה כמו מפתח או רשת, לא כמו המודלים.');
      return lines.join('\n');
    }

    case '/errors': {
      const rows = await db.recentErrors(env, chatId, 5).catch(() => []);
      if (!rows.length) return 'אין תקלות רשומות. זה או טוב או חדש.';
      const tz = await db
        .getSettings(env, chatId)
        .then((s) => s.tz)
        .catch(() => env.DEFAULT_TZ ?? 'Asia/Jerusalem');
      return [
        'תקלות אחרונות:',
        ...rows.flatMap((r) => {
          const line = `· ${formatLocal(r.at, tz)} — ${r.stage}`;
          const detail = `  ${r.message.replace(/\s+/g, ' ').slice(0, 160)}`;
          // What he had sent when it broke. A report that reads "what he
          // asked" then "what failed" is diagnosable; a bare message is not.
          return r.user_text ? [line, `  ← "${r.user_text.replace(/\s+/g, ' ').slice(0, 80)}"`, detail] : [line, detail];
        }),
      ].join('\n');
    }

    /**
     * Everything that ever happened to one reminder.
     *
     * NOT owner-only: it answers a question about his own row, and the chat
     * check below is what makes that safe — db.getReminder looks up by primary
     * key alone, so without it a guessed id would read another chat's history.
     *
     * This is the command that would have settled "why did #18 never fire" in
     * ten seconds instead of by re-reading a chat export and inferring.
     */
    case '/why': {
      const arg = text.trim().split(/\s+/)[1] ?? '';
      const id = Number(arg.replace(/^#/, ''));
      if (!Number.isInteger(id) || id <= 0) return 'איזו תזכורת? /why [מספר] — המספרים ב-/list.';

      const rem = await db.getReminder(env, id);
      if (!rem || rem.chat_id !== chatId) return `אין לי תזכורת #${id}.`;

      const tz = rem.tz || env.DEFAULT_TZ || 'Asia/Jerusalem';
      let sch: Schedule | null = null;
      try {
        sch = JSON.parse(rem.schedule) as Schedule;
      } catch {
        /* raw */
      }

      const events = await db.eventsFor(env, id).catch(() => []);
      // The status sits between the recurrence and the next fire, so the two
      // halves are composed separately — but the "does it repeat" question is
      // still asked in one place. See time.scheduleWithNext.
      const nextTxt = rem.next_fire_at ? formatLocal(rem.next_fire_at, tz) : 'לא מתוזמן';
      const recurrence = sch && sch.type !== 'once' ? `${describeSchedule(sch)} · ` : '';
      const head = [
        `#${rem.id} ${rem.title}`,
        `${recurrence}${rem.status} · ${
          rem.next_fire_at ? `הבא: ${nextTxt}` : 'לא מתוזמן'
        }`,
      ];
      if (!events.length) {
        // Distinguished from "no such reminder" on purpose. An empty history
        // on a row that exists is itself the finding — it means nothing ever
        // happened to it, which is exactly what a reminder that never fired
        // looks like.
        return [...head, '', 'אין היסטוריה. כלומר: מעולם לא קרה לזה כלום.'].join('\n');
      }
      return [
        ...head,
        '',
        ...events.map((e) => `· ${formatLocal(e.at, tz)} — ${e.kind}`),
      ].join('\n');
    }

    case '/list': {
      /*
       * Scheduled AND ringing, deduplicated — the same merge buildContext
       * makes, for the same reason.
       *
       * `listReminders` alone filters `status = 'scheduled'`, and a `once`
       * reminder goes to 'done' the moment it fires. So on 02.09.2026, with
       * #69 ringing and on its second nag, this command printed nothing at all
       * — and this is the command the failure message itself points him at
       * ("תבדוק ב-/list שהכל כמו שצריך"). See db.ringingReminders, issues.md §4.
       */
      const [scheduled, ringing] = await Promise.all([
        db.listReminders(env, chatId),
        db.ringingReminders(env, chatId).catch(() => []),
      ]);
      const byId = new Map(scheduled.map((r) => [r.id, r]));
      for (const r of ringing) if (!byId.has(r.id)) byId.set(r.id, r);
      const reminders = [...byId.values()];
      if (!reminders.length) return 'אין לך תזכורות פעילות.';
      const openIds = new Set(ringing.map((r) => r.id));
      const settings = await db.getSettings(env, chatId);
      // One query for every reminder's errands, not one per row. This is the
      // command he runs most, and it is also where "which of the three is
      // still open" is the actual question.
      const items = await db
        .itemsForReminders(env, reminders.map((r) => r.id))
        .catch(() => new Map<number, ReminderItem[]>());
      return reminders
        .map((r) => {
          // The parsed schedule, not its rendering: scheduleWithNext needs to
          // know whether it RECURS, and a one-off's description is the same
          // instant it would then print again as "הבא:". An unparseable row
          // keeps the old behaviour of showing the raw column.
          let sch: Schedule | null = null;
          try {
            sch = JSON.parse(r.schedule) as Schedule;
          } catch {
            /* raw */
          }
          // Same three-way reading as remindersSummary: a row with no next
          // fire is either ringing right now or was never armed, and calling
          // the first one "לא מתוזמן" is how /list came to look broken.
          const next = r.next_fire_at
            ? formatLocal(r.next_fire_at, settings.tz)
            : openIds.has(r.id)
              ? 'צלצלה כבר — מחכה לדיווח'
              : 'לא מתוזמן';
          const head = `#${r.id} ${r.title}\n   ${
            sch ? scheduleWithNext(sch, next, ' · ', 'הבא: ') : `${r.schedule} · הבא: ${next}`
          }${r.requires_proof ? ' · דורש הוכחה' : ''}`;
          const own = items.get(r.id) ?? [];
          return own.length
            ? [head, ...own.map((i) => `   ${i.done_at ? '✓' : '☐'} ${i.title}`)].join('\n')
            : head;
        })
        .join('\n');
    }

    case '/remember': {
      const note = text.trim().slice('/remember'.length).trim();
      if (!note) {
        return 'תגיד לי מה לזכור. למשל: /remember אני קם ב-6 כל בוקר';
      }
      const id = await db.addProfileNote(env, chatId, note);
      return id === null
        ? `זה כבר אצלי: ${note.slice(0, db.PROFILE_NOTE_MAX)}`
        : `רשמתי לפניי: ${note.slice(0, db.PROFILE_NOTE_MAX)}`;
    }

    case '/profile': {
      const rest = text.trim().slice('/profile'.length).trim();
      if (rest.toLowerCase() === 'clear') {
        await db.clearProfile(env, chatId);
        return 'ניקיתי הכל. אני לא יודע עליך כלום.';
      }
      const forget = /^forget\s+(\d+)$/i.exec(rest);
      if (forget) {
        const ok = await db.deleteProfileNote(env, chatId, Number(forget[1]));
        return ok ? 'שכחתי.' : 'אין לי כזה מספר.';
      }
      const notes = await db.listProfileNotes(env, chatId);
      if (!notes.length) {
        return 'אני לא יודע עליך כלום עדיין.\nלהוספה: /remember [משהו קבוע עליך]';
      }
      return [
        'מה שאני יודע עליך:',
        ...notes.map((n) => `#${n.id} ${n.note}`),
        '',
        'למחיקה: /profile forget [מספר] · לניקוי הכל: /profile clear',
      ].join('\n');
    }

    case '/today': {
      const settings = await db.getSettings(env, chatId);
      const { from, to } = localDayBounds(Date.now(), settings.tz);
      // From the start of the day, not from now: what already fired today is
      // still part of "today", and leaving it out makes the list look wrong.
      const [rows, open] = await Promise.all([
        db.remindersBetween(env, chatId, from, to),
        db.openInstances(env, chatId),
      ]);
      const lines: string[] = [];
      if (rows.length) {
        lines.push('היום:');
        for (const r of rows) {
          const at = r.next_fire_at ? formatLocal(r.next_fire_at, settings.tz) : '';
          lines.push(`#${r.id} ${r.title}${at ? ` · ${at}` : ''}`);
        }
      } else {
        lines.push('היום ריק.');
      }
      if (open.length) {
        lines.push('', 'פתוחות עכשיו:');
        for (const i of open) lines.push(`#${i.id} ${i.title}`);
      }
      return lines.join('\n');
    }

    case '/daily': {
      const parts = text.trim().split(/\s+/);
      const settings = await db.getSettings(env, chatId);
      const show = (h: number | null) => (h === null ? 'כבוי' : `${h}:00`);
      if (parts.length < 2) {
        return [
          `סיכום בוקר: ${show(settings.brief_hour)}`,
          `סיכום ערב: ${show(settings.closeout_hour)}`,
          '',
          'לשינוי: /daily 8 21 — בוקר ב-8, ערב ב-21.',
          'לכיבוי: /daily off',
        ].join('\n');
      }
      if (parts[1].toLowerCase() === 'off') {
        await db.setDailyHours(env, chatId, null, null);
        return 'כיביתי את שני הסיכומים. תזכורות ממשיכות כרגיל.';
      }
      const brief = Number(parts[1]);
      const closeout = Number(parts[2]);
      const valid = (n: number) => Number.isInteger(n) && n >= 0 && n <= 23;
      if (!valid(brief) || !valid(closeout)) {
        return 'תן לי שתי שעות שלמות בין 0 ל-23. למשל: /daily 8 21';
      }
      await db.setDailyHours(env, chatId, brief, closeout);
      return `סיכום בוקר ב-${brief}:00, סיכום ערב ב-${closeout}:00.`;
    }

    case '/quiet': {
      const parts = text.trim().split(/\s+/);
      const settings = await db.getSettings(env, chatId);
      if (parts.length < 3) {
        return `שעות שקט כרגע: ${settings.quiet_start_hour}:00 עד ${settings.quiet_end_hour}:00.\nלשינוי: /quiet 23 8`;
      }
      const start = Number(parts[1]);
      const end = Number(parts[2]);
      const valid = (n: number) => Number.isInteger(n) && n >= 0 && n <= 23;
      if (!valid(start) || !valid(end)) return 'תן לי שתי שעות שלמות בין 0 ל-23. למשל: /quiet 23 8';
      await db.setQuietHours(env, chatId, start, end);
      return `שקט מ-${start}:00 עד ${end}:00. תזכורות שקבעת לשעות האלה עדיין יצלצלו — זה על אחריותך.`;
    }

    case '/offlimits': {
      const rest = text.trim().slice('/offlimits'.length).trim();
      const settings = await db.getSettings(env, chatId);
      if (!rest) {
        return settings.off_limits
          ? `נושאים שאני לא נוגע בהם:\n${settings.off_limits}\n\nלשינוי: /offlimits [טקסט]. לניקוי: /offlimits clear`
          : 'אין נושאים אסורים כרגע.\nלהגדרה: /offlimits [טקסט חופשי, למשל: משקל, כסף, העבודה הקודמת]';
      }
      if (rest.toLowerCase() === 'clear' || rest === 'נקה') {
        await db.setOffLimits(env, chatId, null);
        return 'נוקה. שוב הכל על השולחן.';
      }
      await db.setOffLimits(env, chatId, rest);
      return `רשום. לא נוגע ב: ${rest}`;
    }
    case '/goals': {
      const goals = await db.listGoals(env, chatId);
      if (!goals.length) return 'אין לך מטרות רשומות. תגיד לי משהו שאתה רוצה להשיג.';
      return goals
        .map(
          (g) =>
            `#${g.id} ${g.title}${g.last_progress ? `\n   אחרון: ${g.last_progress}` : '\n   אין התקדמות'}`,
        )
        .join('\n');
    }
    case '/inbox': {
      const items = await db.listInbox(env, chatId);
      if (!items.length) return 'האינבוקס ריק.';
      return ['דברים שתפסתי בלי שעה:', ...items.map((i) => `#${i.id} ${i.title}`)].join('\n');
    }
    case '/checkins': {
      const arg = text.trim().split(/\s+/)[1]?.toLowerCase();
      if (arg === 'off') {
        await db.setCheckins(env, chatId, false);
        return 'סגור. לא אתחיל שיחות מעצמי. תזכורות ימשיכו כרגיל.';
      }
      if (arg === 'on' || arg === undefined) {
        await db.setCheckins(env, chatId, true);
        return 'מעכשיו אני שואל אותך לבד מדי פעם.';
      }
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 1 || n > 8) return 'תן לי on, off, או מספר בין 1 ל-8.';
      await db.setCheckins(env, chatId, true, n);
      return `${n} פעמים ביום. אל תתלונן.`;
    }
    case '/stats': {
      const s = await db.stats(env, chatId);
      return `רצף נוכחי: ${s.currentStreak}\n7 ימים: ${s.done7} בוצעו / ${s.failed7} נפלו\n30 יום: ${s.done30} בוצעו / ${s.failed30} נפלו`;
    }
    case '/chill': {
      const n = Number(text.trim().split(/\s+/)[1]);
      const hours = Number.isFinite(n) ? Math.min(72, Math.max(1, n)) : 4;
      await db.setMuted(env, chatId, Date.now() + hours * 3_600_000);
      return `בסדר. שקט ל-${hours} שעות. אני לא הולך לשום מקום.`;
    }
    case '/intensity': {
      const n = Number(text.trim().split(/\s+/)[1]);
      if (!Number.isFinite(n) || n < 1 || n > 3) return 'תן לי מספר: 1 (רך), 2 (רגיל), 3 (נודניק).';
      await db.setIntensity(env, chatId, n);
      return n === 3 ? 'קיבלתי. אל תתלונן אחר כך.' : 'קיבלתי.';
    }
    default:
      // A slash the bot does not know used to fall straight through to the
      // router as ordinary chat: one Gemini call, one quota unit, and almost
      // certainly "נו?" back — which is how a typo'd command became
      // indistinguishable from being nagged.
      //
      // Answered for EVERYONE, which is the opposite of what this used to do.
      // It was owner-gated on the theory that replying would turn "does this
      // command exist" into a question anyone could ask by trying it — but the
      // OWNER_ONLY gate above also returns null, so both land here and get the
      // identical sentence. There is nothing to tell apart: /diag and /xyzzy
      // are the same answer to a guest, which is exactly the indistinguishable
      // the gate was after.
      //
      // Gating it was actively worse than the leak it feared. A guest's null
      // fell through to the ROUTER, and on 09.08.2026 chat B typed
      // /diag — advertised to him by /help, which used to print it — and got
      // "הכל עובד" plus an improvised health report from the persona. A
      // fabricated diagnostic is a bigger disclosure than "no such command",
      // and it cost a model call to produce.
      if (typedSlash) return NO_SUCH_COMMAND;
      return null;
  }
}
