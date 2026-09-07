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
      return `קבעתי #${e.id}: "${e.title}" — ${describeSchedule(e.schedule)}. הראשונה ב-${when(e.at, tz)}.${
        // The appointment itself, when he named one. Stated rather than merely
        // stored: an event hour that lives only in the database is invisible,
        // and the persona may not mention a time the baseline never said.
        e.eventAt ? ` האירוע עצמו ב-${when(e.eventAt, tz)}.` : ''
      }${
        e.requiresProof ? ' דורש תמונה.' : ''
      }${
        e.duplicateOf
          ? ` שים לב, יש לך גם "${e.duplicateOf.title}" ב-${hhmm(e.duplicateOf.at, tz)}.`
          : ''
      }`;
    case 'friend_reminder_created':
      // No "#id". The row is in HER account and the number is hers — quoting
      // it to him would hand him an id that names nothing he can /list, /why
      // or cancel. What he needs is her name and the hour, and both of those
      // are true from where he is sitting.
      return `קבעתי ל${e.friend}: "${e.title}" — ${describeSchedule(e.schedule)}. הראשונה ב-${when(
        e.at,
        tz,
      )}.${e.requiresProof ? ' דורש תמונה.' : ''}`;
    case 'reminder_captured':
      // The day, when he gave one. Asking "ולא מתי" about a message that
      // opened with "מחר" is the bot asking for something it was handed, and
      // the persona's way out of that contradiction was to assert the schedule
      // this very sentence denies — "רשמתי. מחר בודקים." over a row with no
      // fire time. Naming the day removes the contradiction at the source.
      if (e.dayHint) {
        return untitled(e.title)
          ? `תפסתי ל${e.dayHint}, אבל לא אמרת על מה ובאיזו שעה.`
          : `תפסתי #${e.id}: "${e.title}" ל${e.dayHint}. באיזו שעה?`;
      }
      return untitled(e.title)
        ? 'תפסתי, אבל לא אמרת על מה ולא מתי. שניהם.'
        : `תפסתי #${e.id}: "${e.title}". בלי שעה בינתיים — תגיד לי מתי.`;
    // Counts and an offer. No adjectives, no motive — see patterns.ts. The
    // numbers come straight off the events table and are what makes this
    // checkable; "אתה נמנע מזה" would not be.
    case 'pattern_pushed':
      return e.at
        ? `דחית את "${e.title}" ${e.snoozes} מתוך ${e.fires} הפעמים האחרונות, ובדרך כלל סוגר את זה ב-${hhmm(
            e.at,
            tz,
          )}. להזיז לשם?`
        : `דחית את "${e.title}" ${e.snoozes} מתוך ${e.fires} הפעמים האחרונות. השעה הזאת לא עובדת — מתי כן?`;
    case 'pattern_failing':
      // Offers to DELETE. A reminder he has never once closed is not evidence
      // about him, it is a reminder that is wrong, and an accountability bot
      // that cannot say so is just noise with a streak counter.
      return `"${e.title}" ירדה ${e.dropped} פעמים בלי שנעשתה, ואף פעם לא נסגרה. לשנות שעה, או למחוק?`;
    // A decline, acknowledged and dropped. Nothing was written, so no verb
    // here may claim otherwise — and it must not be the bare "נו?", which is
    // what this used to send and which reads as being nagged for saying no.
    case 'pattern_kept':
      return 'אוקיי, משאיר.';
    // Names the friend and the errand back, because the slot is now holding
    // both and he needs to be able to see that it did. "מתי?" on its own is
    // what shipped before, and it read as the bot having forgotten the request
    // it was halfway through.
    case 'friend_needs_time':
      return `ל${e.friend}: "${e.title}". באיזו שעה?`;
    case 'friend_unknown': {
      // Names BOTH spellings on purpose. The usual cause is a script mismatch
      // he cannot see — the book holds the Telegram profile name ("amnon"),
      // he writes Hebrew ("אמנון") — so "I do not know that name" alone is a
      // dead end. Showing the stored name next to his makes the difference
      // obvious at a glance, and the command fixes it in one message.
      // Not "you have no friends": the commonest way to reach this with an
      // empty list is a request that was sent and not yet answered, and a
      // pending row is deliberately not consent (see CLAUDE.md). Saying so is
      // both true and the thing he needs to know.
      if (!e.known.length) {
        return `אין לי "${e.asked}" ברשימה. בקשה שנשלחה ועוד לא אושרה לא נחשבת. /friends יראה לך מה יש.`;
      }
      const names = e.known.map((n) => `"${n}"`).join(' · ');
      return `אין לי "${e.asked}" ברשימה. מי שיש: ${names}. אם זה אותו אדם בכתיב אחר — /friend ${e.known[0]} ${e.asked}`;
    }
    case 'window_crowded':
      // Stated, not argued with. No "are you sure", no advice — he can see the
      // number and decide for himself, and unsolicited opinions about his day
      // are how a useful prompt becomes one he mutes.
      // The label brings its own preposition — "הבוקר", "מחר בבוקר",
      // "ביום חמישי בבוקר" — because gluing a ב on the front produced
      // "בהבוקר" for today. See effects.dayPartLabel.
      return `זה ${e.count} דברים ${e.label}.`;
    case 'reminder_duplicate':
      return `כבר יש לך את זה — #${e.id} "${e.title}" ב-${hhmm(e.at, tz)}.`;
    case 'reminder_scheduled':
      return `#${e.id} "${e.title}" — נקבע ל-${when(e.at, tz)}.`;
    case 'reminder_retimed':
      return `שיניתי. #${e.id} "${e.title}" ב-${when(e.at, tz)}.`;
    // Nothing moved, and the sentence must not be able to be read as though
    // something had. It states the hour anyway: the reason he asked is that he
    // was not sure what it was set to, and "it is already like that" without
    // the hour answers the question he did not ask.
    case 'reminder_unchanged':
      return `#${e.id} "${e.title}" כבר על ${when(e.at, tz)}. לא נגעתי.`;
    case 'reminder_renamed':
      return `#${e.id} עכשיו "${e.to}" במקום "${e.from}". השעה לא זזה.`;
    case 'reminder_deleted':
      return `ביטלתי את #${e.id} "${e.title}".`;
    case 'instance_done':
      return `נסגר: "${e.title}". רצף ${e.streak}.`;
    case 'instance_skipped':
      // "להיום" is a promise about tomorrow, and only a recurring reminder can
      // keep it. A one-off that is skipped is finished — saying so is the
      // difference between a deferral and a deletion he did not know he made.
      return e.recurs
        ? `"${e.title}" ירדה להיום. בלי כישלון.`
        : `"${e.title}" ירדה. זו הייתה חד-פעמית, אז היא לא תחזור מעצמה — תגיד לי מתי אם היא עוד רלוונטית.`;
    case 'instance_superseded':
      // Short, and it names no hour: the reminder_retimed line it always rides
      // beside has just said the new one, and repeating it reads as two moves.
      return 'הצלצול הקודם ירד. השעה החדשה מחליפה אותו.';
    case 'followup_suggested':
      // A question, not a confirmation. Nothing was written and the wording
      // must not suggest otherwise.
      return `רגע — "${e.title}" מדבר על ${when(e.at, tz)}. לשים לך תזכורת גם על זה?`;
    case 'reminder_annotated':
      return `רשמתי על "${e.title}": ${e.note}`;
    case 'instance_started':
      // No streak, no congratulation, no "נסגר". He has started, not finished,
      // and the whole value of this state is that the bot still expects to
      // hear how it went.
      return `אוקיי, אתה עליה. לא מציק לך עד ${hhmm(e.until, tz)} — ואז תגיד לי מה קרה.`;
    case 'instance_snoozed':
      return `דחיתי את "${e.title}" ב-${e.minutes} דקות — ${hhmm(e.until, tz)}.`;
    case 'needs_task_choice':
      return `איזו מהן? ${e.open.map((i) => `#${i.id} "${i.title}"`).join(' · ')}`;
    case 'appointment_offer':
      // A question, not a confirmation. Nothing was written and the wording
      // must not suggest otherwise — same rule as followup_suggested above.
      return `רגע — ${when(e.at, tz)}: "${e.title}". לשים לך תזכורת?`;
    case 'item_done':
      // When that was the LAST errand, an `instance_done` rides in the same
      // array and says the rest — so this stays a tick and does not also try
      // to congratulate him twice in one message.
      return e.remaining > 0
        ? `✓ "${e.title}". נשארו ${e.remaining}.`
        : `✓ "${e.title}".`;
    case 'needs_item_choice':
      // Asking, because guessing here marks an errand he did not do.
      return `על מה מהם? ${e.open.map((i) => `"${i.title}"`).join(' · ')}`;
    case 'needs_time':
      // Names the reminder rather than asking a bare "מתי?". He may be doing
      // three things at once, and an unattributed question is one he has to
      // guess the subject of.
      return untitled(e.title) ? 'מתי?' : `מתי לשים את "${e.title}"?`;
    case 'needs_reminder_choice':
      return `איזו תזכורת? ${e.rows.map((r) => `#${r.id} "${r.title}"`).join(' · ')}`;
    case 'goal_created':
      return `רשמתי מטרה: "${e.title}".${e.why ? ` (${e.why})` : ''} אין לה שעה — אני אעלה אותה לבד.`;
    case 'goal_progress':
      return `עדכנתי את "${e.title}": ${e.note}`;
    case 'goal_closed':
      return e.status === 'done' ? `"${e.title}" — סגור.` : `הורדתי את "${e.title}".`;
    case 'profile_noted':
      return `רשמתי לפניי: ${e.note}`;
    case 'profile_known':
      // Nothing was written. "רשמתי" here would be a claim about a write that
      // did not happen, which is the one thing this whole pipeline forbids.
      return `זה כבר אצלי: ${e.note}`;
    case 'profile_forgotten':
      return `שכחתי את זה: ${e.note}`;
    case 'listed_profile':
      return e.rows.length
        ? ['מה שאני יודע עליך:', ...e.rows.map((r) => `#${r.id} ${r.note}`)].join('\n')
        : 'אני לא יודע עליך כלום עדיין. תגיד לי משהו שכדאי שאזכור.';
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
      // A multi-errand reminder reads as a checklist, not as one comma-spliced
      // sentence. Rendered on single newlines: sendBurst splits on BLANK lines,
      // and three errands arriving as three separate Telegram messages is
      // exactly the notification spam this is meant to replace.
      const list = e.items?.length
        ? `\n${e.items.map((i) => `${i.done_at ? '✓' : '☐'} ${i.title}`).join('\n')}`
        : '';
      const head = untitled(e.title)
        ? 'נו? ביקשת שאזכיר לך משהו עכשיו. לא אמרת מה.'
        : e.items?.length
          ? `נו? ${e.items.length} דברים:`
          : `נו? ${e.title}.`;
      // Somebody ELSE set this one. Without the name it arrives from nowhere,
      // about something she never asked for, which reads as a malfunction
      // rather than as a favour. Her name for him, not his for himself — see
      // the `from` field in types.ts.
      const sender = e.from ? `\n— מ${e.from}` : '';
      // The appointment itself. Stated here rather than left sitting in the
      // database, because a reminder to PREPARE for something is useless
      // without the hour it is preparing for — and because the persona may not
      // name a time the baseline never said. This is the moment the event_at
      // column exists for.
      const event = e.eventAt ? `\nהאירוע עצמו: ${when(e.eventAt, tz)}.` : '';
      /*
       * It rang late, and it says so.
       *
       * On 01.09.2026 reminder #69 was due at 16:30; Cloudflare's cron dropped
       * eighty minutes and instance 53 opened at 17:50:39 with this exact
       * sentence minus this line — word for word what it would have said on
       * time. A reminder that is silent about being late is making a claim
       * about WHEN, which is the same class of untruth as a claim about what
       * was written.
       *
       * The HOUR, not just the apology: "איחרתי" alone tells him nothing he
       * can act on, while the hour tells him which part of his day the bot
       * lost. Stated here rather than left to the persona for the usual
       * reason — speak() may not name a time the baseline never said.
       *
       * Rendered on a single newline: sendBurst splits on BLANK lines, and an
       * apology arriving as its own notification is a second ping for one
       * event.
       */
      const late = e.dueAt ? `\nאיחרתי — זה היה אמור לצלצל ב-${hhmm(e.dueAt, tz)}.` : '';
      return `${head}${list}${event}${late}${sender}${missNote(e.misses)}${proof}`;
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
          // Not "מאתמול". `openCount` is everything still open, and on a
          // morning where something fired at 08:00 and the brief goes out at
          // 08:02 that word is simply false — a claim about WHEN, which is the
          // same class of invention as a claim about what was written.
          ? `בוקר. אין כלום מתוזמן להיום, אבל ${e.openCount} עדיין פתוחות.`
          : 'בוקר. היום ריק. אם יש משהו, תגיד עכשיו.';
      }
      const lines = e.rows.map((r) => {
        const name = untitled(r.title) ? 'משהו שלא אמרת מה זה' : r.title;
        return `· ${r.next_fire_at ? `${hhmm(r.next_fire_at, tz)} ` : ''}${name}`;
      });
      const tail = e.openCount ? `\nועוד ${e.openCount} עדיין פתוחות.` : '';
      return `בוקר. היום יש לך ${e.rows.length}:\n${lines.join('\n')}${tail}`;
    }
    case 'evening_closeout': {
      const closed = e.done === 0 ? 'לא סגרת כלום היום' : `סגרת ${e.done} היום`;
      const name = (i: { title: string }) =>
        `· ${untitled(i.title) ? 'משהו שלא אמרת מה זה' : i.title}`;
      /*
       * What is still to come tonight, stated BEFORE the "אין זנבות" line can
       * be reached. The close-out runs at 21:00 and reads only backwards, so a
       * 22:00 reminder was invisible to it — and on 25.08.2026 the persona
       * turned that silence into "זהו, אין יותר להיום" an hour before the dose.
       *
       * The hour is stated, not just the title: this block is shared with the
       * persona through remindersSummary, and a time the baseline never said
       * is a time validate.ts rule 1 will not let it say either.
       */
      const ahead = e.ahead.length
        ? [
            'עוד היום:',
            ...e.ahead.map(
              (r) =>
                `· ${untitled(r.title) ? 'משהו שלא אמרת מה זה' : r.title}` +
                (r.next_fire_at ? ` ב-${hhmm(r.next_fire_at, tz)}` : ''),
            ),
          ]
        : [];
      // "אין זנבות" is a claim about the whole day, so it may only be made
      // when the evening really is empty as well.
      if (!e.missed.length && !e.dropped.length && !ahead.length) return `${closed}. אין זנבות.`;
      const parts = [`${closed}.`];
      if (e.missed.length) parts.push('עדיין פתוח:', ...e.missed.map(name));
      // Named, not counted. "2 נפלו" tells him nothing he can act on, and the
      // whole point of the button underneath is that he can act on it.
      if (e.dropped.length) parts.push('ויתרתי על אלה היום:', ...e.dropped.map(name));
      parts.push(...ahead);
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
        case 'unknown_note':
          return 'אין לי כזה דבר רשום עליך.';
        // Covers both halves of db.matchFriend returning null — nobody by that
        // name, and two people by it. Not worth telling apart: the answer to
        // both is the same list of names, and a message that guessed between
        // two friends would land in the wrong person's chat.
        case 'unknown_friend':
          return 'לא ברור לי למי מהחברים שלך התכוונת. /friends מראה את השמות שאני מכיר.';
        case 'chat':
          return 'נו?';
        // The two below must NEVER be worded as a bare "נו?". That string is
        // the bot's name, the opener of every fired reminder, and the opener
        // of every nag — on 13.08.2026 he answered a question the bot had just
        // asked him and got "נו?" back, which told him nothing about whether
        // he had been misunderstood, crashed on, or simply nagged again.
        case 'failed':
          return TURN_FAILED;
        case 'not_understood':
          return 'לא הבנתי מה לעשות עם זה. תנסח אחרת, או /help לרשימת הפקודות.';
      }
  }
}

/**
 * What he hears when a turn falls over.
 *
 * Deliberately neither confirms nor denies the write. Something may well have
 * committed before the throw — applyIntent can close an instance and then fail
 * reading the streak — so "לא קרה כלום" would be exactly the false claim this
 * whole pipeline exists to prevent, and "נשמר" would be the other one. It says
 * what is certainly true, and then points at the two commands that can settle
 * it.
 *
 * Lives here rather than in index.ts so the last-resort send and the `failed`
 * effect cannot drift into two different apologies for the same event.
 */
export const TURN_FAILED =
  'נפל לי משהו באמצע ולא סיימתי את זה. תבדוק ב-/list שהכל כמו שצריך, ואם זה חוזר: /errors.';

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
    // Who set it has to survive the grouping too. Two reminders at 18:00, one
    // of them somebody else's idea, are not interchangeable lines.
    const sender = e.from ? ` (מ${e.from})` : '';
    return `· ${name}${sender}${run}${e.requiresProof ? ' (עם תמונה)' : ''}`;
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

/**
 * What she reads the moment somebody sets a reminder in her chat.
 *
 * Sent as a plain message rather than through the effects pipeline, for the
 * same reason a button never calls the model: the wording is fully determined
 * and there is nothing a rewrite could add. It is also the only message in
 * this file addressed to somebody who did not just type anything, so it says
 * who, what, when, and how to be rid of it — in that order.
 */
export function friendReminderHeadsUp(
  from: string,
  title: string,
  at: number,
  tz: string,
): string {
  return (
    `${from} קבע לך תזכורת: "${title}" — ${when(at, tz)}.\n` +
    'אם זה לא רלוונטי, /list ותגיד לי לבטל אותה.'
  );
}

/**
 * The question an effect's wording ASKS, as the slot that will answer it.
 *
 * Lives here, beside the sentences themselves, because the bug this exists to
 * prevent is the wording and the registration drifting apart. `voice.ts:75`
 * has said "תגיד לי מתי" since inbox capture was added, while `index.ts`
 * registered only `needs_time` and `appointment_offer` — so on 16.08.2026 the
 * bot asked "מתי?" about #35, wrote down nothing, and turned his answer into
 * #36 and #37. Three rows, one errand.
 *
 * Anything that renders a question above MUST have an arm here. That is not
 * enforceable by the compiler for effects whose wording merely happens to end
 * in a "?", so the rule is: if you write a question into renderBaseline, you
 * add it here in the same edit.
 *
 * Returns the slot WITHOUT `at` — the caller stamps it, so there is one clock.
 */
export function questionAsked(
  e: Effect,
):
  | { k: 'time'; r: number }
  | { k: 'offer'; t: string; w: number }
  | { k: 'title'; r: number }
  | { k: 'forwhom'; c: string; t: string }
  | null {
  switch (e.kind) {
    // The friend and the errand ride in the slot for the same reason the
    // appointment offer's title does: there is no row yet to point at, and
    // nothing may be written until he says when.
    case 'friend_needs_time':
      return { k: 'forwhom', c: e.to, t: e.title };
    // "מתי לשים לך את זה?" about a reminder that exists but has no hour.
    case 'needs_time':
      return { k: 'time', r: e.id };
    // "תפסתי #35 … בלי שעה בינתיים — תגיד לי מתי." Same question, different
    // road to it: this row is an inbox capture rather than a live reminder.
    // `reschedule` promotes it, which is why the slot kind is identical.
    case 'reminder_captured':
      return { k: 'time', r: e.id };
    // The title and instant ride in the slot rather than in callback_data,
    // which has 64 bytes and no room for a title. The button just says yes.
    case 'appointment_offer':
      return { k: 'offer', t: e.title, w: e.at };
    // "קבעתי לך משהו ל-09:12. על מה להזכיר?" — the hour is settled, the subject
    // is not. Only when the title really is the placeholder: a create that
    // named its subject asks nothing and must not arm a slot, or his next
    // sentence would silently rename a reminder that was already correct.
    case 'reminder_created':
      return untitled(e.title) ? { k: 'title', r: e.id } : null;
    default:
      return null;
  }
}
