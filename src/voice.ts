import type { Effect } from './types';
import { describeSchedule, formatLocal } from './time';

/**
 * Deterministic Hebrew for every effect.
 *
 * This is what the user reads whenever the model is unavailable, rate-limited,
 * or caught inventing something. It is therefore written blunt rather than
 * funny: a flat true sentence always lands, a failed joke does not. The model's
 * job is to make these better, never to make them true.
 */

/** "07:05" — the exact string the model is later allowed to echo. */
function hhmm(ts: number, tz: string): string {
  const label = formatLocal(ts, tz);
  return /(\d{2}:\d{2})/.exec(label)?.[1] ?? label;
}

function when(ts: number, tz: string): string {
  return formatLocal(ts, tz);
}

function one(e: Effect, tz: string): string {
  switch (e.kind) {
    case 'reminder_created':
      return `קבעתי: "${e.title}" — ${describeSchedule(e.schedule)}. הראשונה ב-${when(e.at, tz)}.${
        e.requiresProof ? ' דורש תמונה.' : ''
      }${e.duplicateOf ? ` שים לב, גם יש לך "${e.duplicateOf.title}" בערך באותו זמן.` : ''}`;
    case 'reminder_captured':
      return `תפסתי: "${e.title}". בלי שעה בינתיים — תגיד לי מתי.`;
    case 'reminder_duplicate':
      return `כבר יש לך את זה — #${e.id} "${e.title}" ב-${hhmm(e.at, tz)}.`;
    case 'reminder_scheduled':
      return `"${e.title}" — נקבע ל-${when(e.at, tz)}.`;
    case 'reminder_retimed':
      return `שיניתי. "${e.title}" ב-${when(e.at, tz)}.`;
    case 'reminder_deleted':
      return `ביטלתי את "${e.title}".`;
    case 'instance_done':
      return `נסגר: "${e.title}". רצף ${e.streak}.`;
    case 'instance_skipped':
      return `"${e.title}" ירדה להיום. בלי כישלון.`;
    case 'instance_snoozed':
      return `דחיתי את "${e.title}" ב-${e.minutes} דקות — ${hhmm(e.until, tz)}.`;
    case 'needs_task_choice':
      return `איזו מהן? ${e.open.map((i) => `#${i.id} "${i.title}"`).join(' · ')}`;
    case 'goal_created':
      return `רשמתי מטרה: "${e.title}".${e.why ? ` (${e.why})` : ''} אין לה שעה — אני אעלה אותה לבד.`;
    case 'goal_progress':
      return `עדכנתי את "${e.title}": ${e.note}`;
    case 'goal_closed':
      return e.status === 'done' ? `"${e.title}" — סגור.` : `הורדתי את "${e.title}".`;
    case 'checkins_set':
      return e.enabled
        ? `שיחות יזומות פעילות${e.perDay ? `, ${e.perDay} ביום` : ''}.`
        : 'כיביתי שיחות יזומות. תזכורות ממשיכות.';
    case 'muted':
      return `שקט ל-${e.hours} שעות, עד ${hhmm(e.until, tz)}.`;
    case 'intensity_set':
      return `רמת עוקצנות ${e.level}.`;
    case 'listed_reminders':
      return e.rows.length
        ? [
            'התזכורות שלך:',
            ...e.rows.map((r) => {
              let s = r.schedule;
              try {
                s = describeSchedule(JSON.parse(r.schedule));
              } catch {
                /* raw */
              }
              return `#${r.id} ${r.title} — ${s}${
                r.next_fire_at ? ` · ${when(r.next_fire_at, tz)}` : ''
              }`;
            }),
            e.openCount ? `פתוחות עכשיו: ${e.openCount}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : 'אין לך תזכורות פעילות.';
    case 'listed_goals':
      return e.rows.length
        ? ['המטרות שלך:', ...e.rows.map((g) => `#${g.id} ${g.title}`)].join('\n')
        : 'אין לך מטרות רשומות.';
    case 'listed_inbox':
      return e.rows.length
        ? ['בלי שעה:', ...e.rows.map((r) => `#${r.id} ${r.title}`)].join('\n')
        : 'האינבוקס ריק.';
    case 'reminder_fired':
      return `נו? ${e.title}.${e.requiresProof ? '\n\nותשלח תמונה.' : ''}`;
    case 'nagged':
      return `נו? "${e.title}" עדיין פתוחה מ-${hhmm(e.since, tz)}.`;
    case 'gave_up':
      return `סגרתי את "${e.title}" ככישלון להיום.`;
    case 'checkin_goal':
      return e.lastProgress
        ? `מה קורה עם "${e.title}"? בפעם שעברה אמרת: ${e.lastProgress}`
        : `מה קורה עם "${e.title}"?`;
    case 'photo_accepted':
      return `התקבל: "${e.title}" — ${e.reason}. רצף ${e.streak}.`;
    case 'photo_rejected':
      return `זה לא "${e.title}". רואים ${e.reason}. המשימה עדיין פתוחה.`;
    case 'distress':
      return 'אני פה. מה קורה?';
    case 'nothing':
      switch (e.why) {
        case 'no_time':
          return 'מתי?';
        case 'past_time':
          return 'הזמן הזה כבר עבר. תן לי משהו עתידי.';
        case 'bad_time':
          return 'לא הבנתי את השעה. תן לי אותה כמו 19:30.';
        case 'no_open_task':
          return 'אין לי משימה פתוחה שמתאימה לזה.';
        case 'unknown_reminder':
          return 'אין לי תזכורת כזאת.';
        case 'unknown_goal':
          return 'לא ברור לי על איזו מטרה מדובר.';
        case 'chat':
          return 'נו?';
      }
  }
}

/** One message for the whole turn. Blank-line separated so sendBurst can split it. */
export function renderBaseline(effects: Effect[], tz: string): string {
  const parts = effects.map((e) => one(e, tz)).filter((s) => s.trim().length > 0);
  return parts.join('\n\n');
}
