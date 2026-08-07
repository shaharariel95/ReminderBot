import type { Effect } from './types';
import { UNTITLED_TITLE } from './types';
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

/**
 * A reminder he asked for without ever saying what it was about.
 *
 * Quoting the fallback title back at him is the worst of both worlds — "נו?
 * תזכורת." reads like a bug and carries none of the information he actually
 * needed. Every wording below therefore says plainly that the subject is
 * missing, and the moment he answers, the router turns that answer into a
 * `rename` (see brain.ts) and the reminder gets its real title.
 */
function untitled(title: string): boolean {
  return title.trim() === UNTITLED_TITLE;
}

/**
 * Below this, a run of misses is just life. At and above it, sending the
 * identical ping for the fifth time as though it were the first is the bot
 * failing at its actual job — the point is not to remind, it is to notice.
 */
const MISS_THRESHOLD = 3;

function missNote(misses: number | undefined): string {
  if (!misses || misses < MISS_THRESHOLD) return '';
  return `\n\n${misses} פעמים ברצף שזה לא קורה. אולי השעה לא נכונה, אולי זה לא באמת חשוב לך — תחליט.`;
}

function one(e: Effect, tz: string): string {
  switch (e.kind) {
    case 'reminder_created':
      if (untitled(e.title)) {
        // Ask now, while he still remembers. In an hour he won't.
        return `קבעתי לך משהו ל-${when(e.at, tz)}. על מה להזכיר?`;
      }
      return `קבעתי: "${e.title}" — ${describeSchedule(e.schedule)}. הראשונה ב-${when(e.at, tz)}.${
        e.requiresProof ? ' דורש תמונה.' : ''
      }${e.duplicateOf ? ` שים לב, גם יש לך "${e.duplicateOf.title}" בערך באותו זמן.` : ''}`;
    case 'reminder_captured':
      return untitled(e.title)
        ? 'תפסתי, אבל לא אמרת על מה ולא מתי. שניהם.'
        : `תפסתי: "${e.title}". בלי שעה בינתיים — תגיד לי מתי.`;
    case 'reminder_duplicate':
      return `כבר יש לך את זה — #${e.id} "${e.title}" ב-${hhmm(e.at, tz)}.`;
    case 'reminder_scheduled':
      return `"${e.title}" — נקבע ל-${when(e.at, tz)}.`;
    case 'reminder_retimed':
      return `שיניתי. "${e.title}" ב-${when(e.at, tz)}.`;
    case 'reminder_renamed':
      return `עכשיו זה "${e.to}" במקום "${e.from}". השעה לא זזה.`;
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
    case 'needs_reminder_choice':
      return `איזו תזכורת? ${e.rows.map((r) => `#${r.id} "${r.title}"`).join(' · ')}`;
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
    case 'reminder_fired': {
      const proof = e.requiresProof ? '\n\nותשלח תמונה.' : '';
      const head = untitled(e.title)
        ? 'נו? ביקשת שאזכיר לך משהו עכשיו. לא אמרת מה.'
        : `נו? ${e.title}.`;
      return `${head}${missNote(e.misses)}${proof}`;
    }
    case 'nagged':
      return untitled(e.title)
        ? `נו? אותו דבר בלי שם מ-${hhmm(e.since, tz)} עדיין פתוח.`
        : `נו? "${e.title}" עדיין פתוחה מ-${hhmm(e.since, tz)}.`;
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
    case 'morning_brief': {
      if (!e.rows.length) {
        return e.openCount
          ? `בוקר. אין כלום מתוזמן להיום, אבל ${e.openCount} עדיין פתוחות מאתמול.`
          : 'בוקר. היום ריק. אם יש משהו, תגיד עכשיו.';
      }
      const lines = e.rows.map((r) => {
        const name = untitled(r.title) ? 'משהו שלא אמרת מה זה' : r.title;
        return `· ${r.next_fire_at ? `${hhmm(r.next_fire_at, tz)} ` : ''}${name}`;
      });
      const tail = e.openCount ? `\nועוד ${e.openCount} פתוחות מאתמול.` : '';
      return `בוקר. היום יש לך ${e.rows.length}:\n${lines.join('\n')}${tail}`;
    }
    case 'evening_closeout': {
      const closed = e.done === 0 ? 'לא סגרת כלום היום' : `סגרת ${e.done} היום`;
      if (!e.missed.length && !e.dropped.length) return `${closed}. אין זנבות.`;
      const name = (i: { title: string }) =>
        `· ${untitled(i.title) ? 'משהו שלא אמרת מה זה' : i.title}`;
      const parts = [`${closed}.`];
      if (e.missed.length) parts.push('עדיין פתוח:', ...e.missed.map(name));
      // Named, not counted. "2 נפלו" tells him nothing he can act on, and the
      // whole point of the button underneath is that he can act on it.
      if (e.dropped.length) parts.push('ויתרתי על אלה היום:', ...e.dropped.map(name));
      return parts.join('\n');
    }
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

/**
 * Several reminders coming due together, as one moment rather than a burst of
 * near-identical pings. Rendered as a single block on purpose: sendBurst splits
 * on blank lines, so anything separated that way arrives as separate messages —
 * which is exactly what this exists to stop.
 */
function firedTogether(items: Extract<Effect, { kind: 'reminder_fired' }>[]): string {
  const lines = items.map((e) => {
    const name = untitled(e.title) ? 'משהו שלא אמרת מה זה' : e.title;
    // The pattern still gets named here, just inline — a task on its fifth
    // consecutive miss does not stop mattering because something else fired
    // in the same minute.
    const run = e.misses && e.misses >= MISS_THRESHOLD ? ` (${e.misses} ברצף שלא)` : '';
    return `· ${name}${run}${e.requiresProof ? ' (עם תמונה)' : ''}`;
  });
  return [`נו? ${items.length} דברים עכשיו:`, ...lines].join('\n');
}

/** One message for the whole turn. Blank-line separated so sendBurst can split it. */
export function renderBaseline(effects: Effect[], tz: string): string {
  const fired = effects.filter(
    (e): e is Extract<Effect, { kind: 'reminder_fired' }> => e.kind === 'reminder_fired',
  );
  // Only when the whole turn is reminders firing. A tick that also produced,
  // say, a give-up has more to say than a list, and falls through to the
  // per-effect rendering below.
  if (fired.length > 1 && fired.length === effects.length) return firedTogether(fired);

  const parts = effects.map((e) => one(e, tz)).filter((s) => s.trim().length > 0);
  return parts.join('\n\n');
}
