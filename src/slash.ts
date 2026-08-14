import * as db from './db';
import { describeSchedule, formatLocal, localDayBounds } from './time';
import type { Env, ReminderItem, Schedule } from './types';
import { VERSION } from './version';
import { sendMessage } from './telegram';

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
  מחכים: '/pending',
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

/** Commands only the owner may run. See the gate in handleSlash for why. */
const OWNER_ONLY = new Set(['/diag', '/allow', '/deny', '/allowed', '/pending', '/errors']);

/** Slash commands handled without burning an LLM call. */
export async function handleSlash(
  env: Env,
  chatId: string,
  text: string,
): Promise<string | null> {
  const cmd = normalizeCommand(text);

  // Owner-only commands. Returning null (rather than a refusal) makes them
  // indistinguishable from commands that do not exist — a guest learns
  // nothing about what they are not allowed to do.
  //
  // /diag is on this list because it prints the API key length, the shared
  // Gemini quota, and the last discarded rewrites, which are conversation
  // content. The rest hand out access.
  if (OWNER_ONLY.has(cmd) && chatId !== env.OWNER_CHAT_ID) return null;

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
    case '/help':
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
        '/diag — בדיקת תקינות (מודל, מפתח, חיבורים, קרון)',
        '/errors — חמש התקלות האחרונות',
        '/why [מספר] — כל מה שקרה לתזכורת אחת',
        '/pending — מי מבקש להיכנס · /allow [שם] · /deny [שם] · /allowed',
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

    case '/diag': {
      const model = env.GEMINI_MODEL ?? 'gemini-3.5-flash';
      const lines = [
        // First line, because "am I even running the code I think I am"
        // precedes every other question this command answers.
        `גרסה: ${VERSION}`,
        `model: ${model}`,
        `GEMINI_API_KEY: ${env.GEMINI_API_KEY ? `set (${env.GEMINI_API_KEY.length} תווים)` : 'חסר!'}`,
        `OWNER_CHAT_ID: ${env.OWNER_CHAT_ID || 'חסר!'}`,
      ];
      const primary = env.GEMINI_MODEL ?? 'gemini-3.5-flash';
      const fallback = env.GEMINI_MODEL_FALLBACK ?? 'gemini-3.5-flash-lite';
      // Two numbers, because they answer two questions. His own is the one
      // that reconciles with the rejection list printed below and the one his
      // check-in budget is measured against; the total is what protects the
      // shared API key. Showing only the total is what put "נפסלו היום: 1"
      // above an empty list on 11.08.2026 — the rejection was a guest's.
      lines.push(
        `שימוש היום — ${primary}: שלך ${await db.usageTodayFor(env, primary, chatId)} · ` +
          `בסך הכל ${await db.usageToday(env, primary)}`,
        `${fallback}: שלך ${await db.usageTodayFor(env, fallback, chatId)} · ` +
          `בסך הכל ${await db.usageToday(env, fallback)}`,
        `תשובות שנפסלו היום: ${await db.usageTodayFor(env, '_rejections', chatId)}`,
        // The daily counters above are the axis that never binds. This is the
        // one that does, and seeing it live is the whole reason /diag exists.
        `תקרת דקה: ${env.GEMINI_RPM ?? 18} לכל מודל · בדקה הזאת: ${await db
          .rateWindowNow(env, primary)
          .catch(() => '?')}`,
      );
      // One settings read for everything below, not one per block: /diag is
      // the command you run when something is already wrong, and it should not
      // be the command that costs the most queries.
      const tz = await db
        .getSettings(env, chatId)
        .then((s) => s.tz)
        .catch(() => env.DEFAULT_TZ ?? 'Asia/Jerusalem');

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
        `טיק אחרון: ${tick === null ? 'מעולם לא רץ!' : formatLocal(tick, tz)}`,
        `צלצלו היום: ${counts['צלצלה'] ?? 0} · לא נמסרו: ${counts['לא נמסרה'] ?? 0} · ` +
          `נדנודים: ${counts['נדנוד'] ?? 0} · נסגרו: ${counts['נסגרה'] ?? 0}`,
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
      let sched = rem.schedule;
      try {
        sched = describeSchedule(JSON.parse(rem.schedule) as Schedule);
      } catch {
        /* raw */
      }

      const events = await db.eventsFor(env, id).catch(() => []);
      const head = [
        `#${rem.id} ${rem.title}`,
        `${sched} · ${rem.status}${
          rem.next_fire_at ? ` · הבא: ${formatLocal(rem.next_fire_at, tz)}` : ' · לא מתוזמן'
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
      const reminders = await db.listReminders(env, chatId);
      if (!reminders.length) return 'אין לך תזכורות פעילות.';
      const settings = await db.getSettings(env, chatId);
      // One query for every reminder's errands, not one per row. This is the
      // command he runs most, and it is also where "which of the three is
      // still open" is the actual question.
      const items = await db
        .itemsForReminders(env, reminders.map((r) => r.id))
        .catch(() => new Map<number, ReminderItem[]>());
      return reminders
        .map((r) => {
          let s = r.schedule;
          try {
            s = describeSchedule(JSON.parse(r.schedule) as Schedule);
          } catch {
            /* raw */
          }
          const next = r.next_fire_at ? formatLocal(r.next_fire_at, settings.tz) : 'לא מתוזמן';
          const head = `#${r.id} ${r.title}\n   ${s} · הבא: ${next}${
            r.requires_proof ? ' · דורש הוכחה' : ''
          }`;
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
      // Only for the owner. A guest still gets null, because the OWNER_ONLY
      // gate above returns null too, and a reply here would turn "does this
      // command exist" into a question anyone could ask by trying it.
      if (cmd.startsWith('/') && chatId === env.OWNER_CHAT_ID) {
        return `אין פקודה כזאת. /help לרשימה.`;
      }
      return null;
  }
}
