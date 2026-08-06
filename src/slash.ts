import * as db from './db';
import { describeSchedule, formatLocal, localDayBounds } from './time';
import type { Env, Schedule } from './types';

/** Slash commands handled without burning an LLM call. */
export async function handleSlash(
  env: Env,
  chatId: string,
  text: string,
): Promise<string | null> {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().split('@')[0];
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
        '',
        'שליטה בי:',
        '/daily [בוקר] [ערב] — שעות הסיכום היומי. "off" מכבה.',
        '/chill [שעות] — שתיקה מוחלטת זמנית (ברירת מחדל 4). כל הודעה ממך מבטלת.',
        '/checkins on|off|1-8 — כמה אני פותח שיחות מעצמי',
        '/intensity 1|2|3 — כמה עוקצני אני',
        '/quiet [התחלה] [סוף] — שעות שקט, למשל /quiet 23 8',
        '/offlimits [טקסט] — נושאים שאסור לי לגעת בהם. בלי טקסט = מציג. "clear" = מנקה.',
        '/diag — בדיקת תקינות (מודל, מפתח, חיבורים)',
        '',
        'כל השאר בשפה חופשית:',
        '"תזכיר לי כל יום ב-7 לרוץ" · "אני רוצה לפתוח תיק מסחר"',
        '"סיימתי" · "תדחה בחצי שעה" · "תבטל את #3"',
        'או פשוט תשלח תמונה כהוכחה.',
      ].join('\n');

    case '/diag': {
      const model = env.GEMINI_MODEL ?? 'gemini-3.5-flash';
      const lines = [
        `model: ${model}`,
        `GEMINI_API_KEY: ${env.GEMINI_API_KEY ? `set (${env.GEMINI_API_KEY.length} תווים)` : 'חסר!'}`,
        `OWNER_CHAT_ID: ${env.OWNER_CHAT_ID || 'חסר!'}`,
      ];
      const primary = env.GEMINI_MODEL ?? 'gemini-3.5-flash';
      const fallback = env.GEMINI_MODEL_FALLBACK ?? 'gemini-3.5-flash-lite';
      lines.push(
        `שימוש היום — ${primary}: ${await db.usageToday(env, primary)}, ` +
          `${fallback}: ${await db.usageToday(env, fallback)}`,
        `תשובות שנפסלו היום: ${await db.usageToday(env, '_rejections')}`,
        // The daily counters above are the axis that never binds. This is the
        // one that does, and seeing it live is the whole reason /diag exists.
        `תקרת דקה: ${env.GEMINI_RPM ?? 18} לכל מודל · בדקה הזאת: ${await db
          .rateWindowNow(env, primary)
          .catch(() => '?')}`,
      );
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

    case '/list': {
      const reminders = await db.listReminders(env, chatId);
      if (!reminders.length) return 'אין לך תזכורות פעילות.';
      const settings = await db.getSettings(env, chatId);
      return reminders
        .map((r) => {
          let s = r.schedule;
          try {
            s = describeSchedule(JSON.parse(r.schedule) as Schedule);
          } catch {
            /* raw */
          }
          const next = r.next_fire_at ? formatLocal(r.next_fire_at, settings.tz) : 'לא מתוזמן';
          return `#${r.id} ${r.title}\n   ${s} · הבא: ${next}${r.requires_proof ? ' · דורש הוכחה' : ''}`;
        })
        .join('\n');
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
      return null;
  }
}
