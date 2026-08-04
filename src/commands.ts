import * as db from './db';
import type { Context } from './brain';
import type { Env, Intent, Schedule } from './types';
import { computeNext, describeSchedule, formatLocal, wallString } from './time';

export interface Outcome {
  /** Factual note handed to the persona to voice. */
  situation: string;
  toneNote?: string;
}

function scheduleFromIntent(intent: Intent, tz: string): Schedule | null {
  // Relative times are resolved here rather than by the model. Asking an LLM to
  // add 5 minutes to a wall clock and cross midnight/month/year boundaries
  // correctly is a coin flip; Date does it for free.
  if (intent.in_minutes && intent.in_minutes > 0) {
    return { type: 'once', at: wallString(Date.now() + intent.in_minutes * 60_000, tz) };
  }

  switch (intent.schedule_type) {
    case 'daily':
      return intent.time ? { type: 'daily', time: intent.time } : null;
    case 'weekly':
      return intent.time && intent.days?.length
        ? { type: 'weekly', time: intent.time, days: intent.days }
        : null;
    case 'interval':
      return intent.interval_minutes
        ? { type: 'interval', minutes: intent.interval_minutes }
        : null;
    case 'once':
      return intent.once_at ? { type: 'once', at: intent.once_at } : null;
    default:
      return null;
  }
}

export async function applyIntent(
  env: Env,
  chatId: string,
  ctx: Context,
  intent: Intent,
  userText: string,
): Promise<Outcome> {
  const tz = ctx.settings.tz;

  switch (intent.action) {
    case 'create_reminder': {
      const schedule = scheduleFromIntent(intent, tz);
      if (!schedule) {
        return {
          situation: `הוא ביקש תזכורת חדשה אבל לא היה ברור מתי בדיוק. הבקשה שלו: "${userText}"
חשוב: לא נוצרה שום תזכורת. אסור לך להגיד שרשמת, שמת, או קבעת משהו.`,
          toneNote: 'תבקש ממנו את החסר במשפט אחד. אל תשאל שלוש שאלות.',
        };
      }
      const title = intent.title?.trim() || 'תזכורת';
      let next: number | null;
      try {
        next = computeNext(schedule, tz, Date.now());
      } catch {
        return {
          situation: `הוא ביקש תזכורת אבל הזמן שהוא נתן לא חוקי: "${userText}"`,
          toneNote: 'תבקש ממנו שעה תקינה, בקצרה.',
        };
      }
      if (next === null) {
        return {
          situation: `הוא ביקש תזכורת לזמן שכבר עבר: "${userText}"
חשוב: לא נוצרה שום תזכורת.`,
          toneNote: 'תעיר לו על זה בקצרה ותבקש תאריך עתידי.',
        };
      }

      const id = await db.addReminder(env, {
        chat_id: chatId,
        title,
        notes: null,
        schedule: JSON.stringify(schedule),
        tz,
        requires_proof: intent.requires_proof ? 1 : 0,
        proof_type: intent.proof_type ?? 'any',
        nag_interval_min: 20,
        max_nags: 3,
        next_fire_at: next,
      });

      return {
        situation: `נוצרה תזכורת #${id}: "${title}", ${describeSchedule(schedule)}. היא באמת נשמרה במסד הנתונים. הפעם הראשונה: ${formatLocal(
          next,
          tz,
        )}.${intent.requires_proof ? ' דורשת הוכחה.' : ''}`,
        toneNote:
          'אשר שקלטת, בעוקצנות קלה. חובה לציין את השעה המדויקת שרשומה למעלה — זה מה שנותן לו לוודא שנקלט נכון.',
      };
    }

    case 'complete': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) {
        return {
          situation: `הוא טוען שביצע משהו אבל אין משימה פתוחה שמתאימה. מה שהוא כתב: "${userText}"`,
          toneNote: 'תגיד לו שאין לך מושג על מה הוא מדבר, בקצרה ובציניות.',
        };
      }
      await db.closeInstance(env, inst.id, 'done', userText.slice(0, 500) || 'דיווח');
      const fresh = await db.stats(env, chatId);
      return {
        situation: `הוא סגר את "${inst.title}". הרצף שלו עכשיו ${fresh.currentStreak}.`,
        toneNote:
          'תן לו קרדיט אמיתי וקצר. מותר חצי עקיצה על כמה זמן זה לקח, אבל שהשורה התחתונה תהיה שאתה מרוצה.',
      };
    }

    case 'snooze': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) {
        return {
          situation: `הוא ביקש לדחות אבל אין משימה פתוחה.`,
          toneNote: 'תעיר לו שאין מה לדחות.',
        };
      }
      const mins = Math.min(720, Math.max(5, intent.snooze_minutes ?? 30));
      await db.snoozeInstance(env, inst.id, mins);
      return {
        situation: `הוא דחה את "${inst.title}" ב-${mins} דקות. זה הנדנוד ה-${inst.nag_count + 1} על המשימה הזאת.`,
        toneNote:
          'תסכים לדחות בלי ויכוח, אבל שהוא ירגיש שרשמת. ואז תציע לו חתיכה זעירה מהמשימה שהוא כן יכול לעשות עכשיו, בזמן שהוא מחכה.',
      };
    }

    case 'list': {
      const list = ctx.reminders.length
        ? ctx.reminders
            .map((r) => {
              let s = r.schedule;
              try {
                s = describeSchedule(JSON.parse(r.schedule));
              } catch {
                /* raw */
              }
              return `#${r.id} ${r.title} — ${s}`;
            })
            .join('\n')
        : 'אין לו אף תזכורת פעילה.';
      return {
        situation: `הוא ביקש לראות את הרשימה. התזכורות שלו:\n${list}\nמשימות פתוחות כרגע: ${ctx.open.length}.`,
        toneNote:
          'הצג את הרשימה כמו שהיא, שורה לכל תזכורת, עם משפט פתיחה קצר משלך. כאן מותר לך לחרוג ממגבלת 3 המשפטים.',
      };
    }

    case 'delete': {
      if (!intent.target_id) {
        return {
          situation: `הוא ביקש לבטל תזכורת אבל לא ברור איזו: "${userText}"`,
          toneNote: 'תשאל איזו, בקצרה.',
        };
      }
      const rem = ctx.reminders.find((r) => r.id === intent.target_id);
      const ok = await db.deleteReminder(env, chatId, intent.target_id);
      return {
        situation: ok
          ? `בוטלה התזכורת "${rem?.title ?? intent.target_id}".`
          : `הוא ניסה לבטל תזכורת שלא קיימת.`,
        toneNote: ok
          ? 'אשר את הביטול. מותר משפט אחד של "מעניין למה דווקא זאת".'
          : 'תגיד לו שאין כזאת.',
      };
    }

    case 'create_goal': {
      if (!intent.title) {
        return {
          situation: `הוא תיאר שאיפה אבל לא ברור מה בדיוק: "${userText}"`,
          toneNote: 'תבקש ממנו לנסח את זה במשפט אחד.',
        };
      }
      const id = await db.addGoal(env, chatId, intent.title, intent.why ?? null);
      return {
        situation: `נוספה מטרה מתמשכת #${id}: "${intent.title}"${
          intent.why ? ` (הסיבה שלו: ${intent.why})` : ''
        }. אין לה שעה — אתה תעלה אותה מיוזמתך מדי פעם.`,
        toneNote:
          'אשר שרשמת, ותגיד לו בבירור שאתה תשאל על זה שוב בלי שהוא יבקש. אם מתאים, תבקש ממנו צעד ראשון קטן.',
      };
    }

    case 'goal_progress': {
      const goal = ctx.goals.find((g) => g.id === intent.goal_id) ?? null;
      if (!goal) {
        return {
          situation: `הוא סיפר על התקדמות אבל לא ברור באיזו מטרה: "${userText}"`,
          toneNote: 'תשאל על איזו מטרה מדובר, בקצרה.',
        };
      }
      const note = (intent.reason ?? userText).slice(0, 400);
      await db.recordGoalProgress(env, goal.id, note);
      return {
        situation: `עדכון על המטרה "${goal.title}": ${note}${
          goal.last_progress ? `\nהעדכון הקודם היה: "${goal.last_progress}"` : ''
        }`,
        toneNote:
          'תגיב לעדכון ספציפית — תשווה למה שהוא אמר קודם אם יש. אם זה קידום אמיתי תן קרדיט. אם זה דשדוש תעקוץ ותציע צעד קטן אחד.',
      };
    }

    case 'complete_goal': {
      const goal = ctx.goals.find((g) => g.id === intent.goal_id);
      if (!goal || !(await db.setGoalStatus(env, chatId, goal.id, 'done'))) {
        return {
          situation: `הוא אמר שסיים מטרה אבל לא ברור איזו: "${userText}"`,
          toneNote: 'תשאל איזו.',
        };
      }
      return {
        situation: `הוא סגר את המטרה "${goal.title}" אחרי ${goal.checkin_count} פעמים ששאלת עליה.`,
        toneNote:
          'זה רגע אמיתי. תן לו קרדיט מלא בלי עוקץ בשורה הראשונה. מותר עוקץ קטן על כמה זמן זה לקח רק בשורה השנייה.',
      };
    }

    case 'drop_goal': {
      const goal = ctx.goals.find((g) => g.id === intent.goal_id);
      if (!goal || !(await db.setGoalStatus(env, chatId, goal.id, 'dropped'))) {
        return {
          situation: `הוא ביקש להוריד מטרה אבל לא ברור איזו: "${userText}"`,
          toneNote: 'תשאל איזו.',
        };
      }
      return {
        situation: `הוא ויתר על המטרה "${goal.title}". היא ירדה מהרשימה ולא תעלה שוב.`,
        toneNote:
          'תקבל את זה בלי להתווכח ובלי להשפיל. משפט אחד. מותר לך להגיד שזה בסדר לוותר על דברים במפורש.',
      };
    }

    case 'list_goals': {
      const list = ctx.goals.length
        ? ctx.goals
            .map(
              (g) =>
                `#${g.id} ${g.title}${g.last_progress ? ` — אחרון: ${g.last_progress}` : ' — אין התקדמות'}`,
            )
            .join('\n')
        : 'אין לו מטרות רשומות.';
      return {
        situation: `הוא ביקש לראות את המטרות שלו:\n${list}`,
        toneNote: 'הצג שורה לכל מטרה עם משפט פתיחה קצר משלך. מותר לחרוג ממגבלת האורך.',
      };
    }

    case 'set_checkins': {
      const enabled = intent.checkins_enabled ?? true;
      await db.setCheckins(env, chatId, enabled, intent.checkin_per_day);
      return {
        situation: enabled
          ? `הוא הפעיל שיחות יזומות${
              intent.checkin_per_day ? `, ${intent.checkin_per_day} ביום` : ''
            }.`
          : `הוא כיבה שיחות יזומות. מעכשיו אתה מדבר רק כשמדברים אליך או כשיש תזכורת.`,
        toneNote: 'אשר בקצרה, בטון שלך.',
      };
    }

    case 'chill': {
      const hours = Math.min(72, Math.max(1, intent.chill_hours ?? 4));
      const until = Date.now() + hours * 3_600_000;
      await db.setMuted(env, chatId, until);
      return {
        situation: `הוא ביקש שתשתוק ל-${hours} שעות. אתה שקט עד ${formatLocal(until, tz)}. תזכורות ימשיכו להיווצר, פשוט לא תשלח נדנודים.`,
        toneNote: 'תסכים בלי ויכוח. אתה יכול להיות קצת דרמטי לגבי זה, אבל תסכים.',
      };
    }

    case 'set_intensity': {
      const level = Math.min(3, Math.max(1, intent.intensity ?? 2));
      await db.setIntensity(env, chatId, level);
      const names = { 1: 'רך', 2: 'רגיל', 3: 'נודניק רציני' } as Record<number, string>;
      return {
        situation: `הוא שינה את רמת העוקצנות ל-${level} (${names[level]}).`,
        toneNote: 'אשר בקצרה, בטון החדש.',
      };
    }

    case 'chat':
    default: {
      const nothingOnRecord = ctx.reminders.length === 0 && ctx.goals.length === 0;
      return {
        situation: `הוא כתב לך: "${userText}".
לא בוצעה שום פעולה במסד הנתונים — לא נוצרה תזכורת, לא נשמרה מטרה, שום דבר. אסור לך לרמוז שכן.
${
  nothingOnRecord
    ? 'אין לו אף תזכורת ואף מטרה רשומה. אתה לא יודע על שום משימה שלו.'
    : 'התזכורות והמטרות הרשומות שלו מופיעות למעלה — רק עליהן מותר לדבר.'
}`,
        toneNote: nothingOnRecord
          ? 'אתה לא יודע על מה הוא עובד, אז אל תמציא לו משימות. תשאל אותו מה יושב עליו, או תציע לו לרשום מטרה. שאלה אחת, קצרה.'
          : 'אם הוא מתרץ — תפרק את התירוץ החלש ביותר. אם הוא שואל כמה זמן משהו ייקח — תן הערכה מפורקת עם מספרים. בסוף תנחת על פעולה קטנה אחת מתוך מה שרשום אצלך.',
      };
    }
  }
}

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
        '/list — התזכורות שלך (אלה עם שעה)',
        '/goals — המטרות שלך (אלה בלי שעה)',
        '/stats — רצף, בוצעו, נפלו',
        '',
        'שליטה בי:',
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
      const model = env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite';
      const lines = [
        `model: ${model}`,
        `GEMINI_API_KEY: ${env.GEMINI_API_KEY ? `set (${env.GEMINI_API_KEY.length} תווים)` : 'חסר!'}`,
        `OWNER_CHAT_ID: ${env.OWNER_CHAT_ID || 'חסר!'}`,
      ];
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
