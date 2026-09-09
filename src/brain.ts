import { generate, generateJson, type Part, type Turn } from './gemini';
import { buildSystemPrompt } from './persona';
import type { Env, Facts, Goal, Instance, Intent, Reminder, ReminderItem, Settings, Stats } from './types';
import { describeSchedule, formatLocal, wallString } from './time';
import type { Friend } from './db';

/**
 * Two-stage brain, on purpose:
 *   route()  — temperature 0.2, structured JSON, decides WHAT happens. Deterministic-ish.
 *   speak()  — temperature 1, decides HOW it is said. Never touches the database.
 * Keeping them apart means the personality can never accidentally delete a reminder,
 * and the scheduler can never accidentally sound like a form letter.
 */

/**
 * Every action the router may return. ONE list, because the union below is
 * built by partitioning it — an action that falls out of both branches cannot
 * be emitted at all, and `test/v27.test.ts` compares the partition against
 * this list for exactly that reason.
 */
const ALL_ACTIONS = [
  'create_reminder',
  'complete',
  'complete_item',
  'snooze',
  'on_my_way',
  'annotate',
  'list',
  'delete',
  'reschedule',
  'rename',
  'remember',
  'forget',
  'set_intensity',
  'chill',
  'create_goal',
  'goal_progress',
  'complete_goal',
  'drop_goal',
  'list_goals',
  'set_checkins',
  'chat',
] as const;

/**
 * The actions that READ a free-text field, verified against `applyIntent`
 * rather than assumed:
 *
 *   title   create_reminder, complete_item, annotate, rename, remember,
 *           forget, create_goal
 *   note    complete_item, annotate, remember, forget, create_goal
 *   reason  goal_progress
 *
 * Everything else is `ALL_ACTIONS` minus this list, and gets a schema with no
 * free-text property in it at all. See TEXT_FIELDS for why that matters.
 */
const TEXT_ACTIONS = [
  'create_reminder',
  'complete_item',
  'annotate',
  'rename',
  'remember',
  'forget',
  'create_goal',
  'goal_progress',
] as const;

const NO_TEXT_ACTIONS = ALL_ACTIONS.filter(
  (a) => !(TEXT_ACTIONS as readonly string[]).includes(a),
);

/*
 * The fields the model writes prose into — and the fields it runs away in.
 *
 * `maxLength` IS NOT A GUARANTEE, and this file used to say it was. The claim
 * was that responseSchema drives constrained decoding, so a bound here cannot
 * be exceeded — the same argument that makes removing a property (see `why`
 * below) a real fix. It does not transfer. `maxLength` is absent from the
 * supported-field list in Google's structured-output documentation (checked
 * 06.09.2026: for strings, only `enum` and `format` are listed), and
 * production had already said so:
 *
 *   errors #16  reschedule #69  "לנקות את הפילטרים של המזגנים_resche…"  6296
 *   errors #17  reschedule #69  "לנקות את הפילטרים של המזגנים…"         3112
 *
 * Both AFTER 0.14.1 added `maxLength: 120`, both in the field it was added to,
 * both running until the response truncated mid-string so `JSON.parse` threw
 * and the turn died. The numbers stay because they document what the code
 * slices to; the belief that they are enforced does not.
 *
 * What IS a guarantee is absence, which is the whole of the union below: three
 * of the five runaway titles on record are RESCHEDULES, and `reschedule` never
 * reads a title — `resolveReminder` matches on `target_id` and otherwise on
 * "he has exactly one reminder". The field was pure attack surface on that
 * path, and now it is not on that path.
 */
const TEXT_FIELDS = {
  title: { type: 'STRING', maxLength: 120 },
  /** One short sentence in his words — a profile fact, a detail on a
   *  reminder, a goal's reason. */
  note: { type: 'STRING', maxLength: 200 },
  /** What he said about a goal, briefly. 400 is what effects.ts slices it to. */
  reason: { type: 'STRING', maxLength: 400 },
} as const;

/*
 * `why` USED TO BE A FIELD HERE, and removing it is the fix, not an omission.
 *
 * It was read by exactly one action (create_goal, effects.ts) and offered to
 * all twenty, unbounded. Every route/apply failure between 15 and 17.08.2026
 * carried a long one — including two plain reschedules with no friend in them
 * — and the worst of them was the model writing "for_friend=אמנון.
 * in_minutes=2. schedule_type=once. for_friend=אמנון." as PROSE inside it,
 * repeating until the response truncated mid-string and JSON.parse threw. The
 * turn died and the catch-block filed the raw message as an inbox item.
 *
 * It was first "fixed" by asking the model in the prompt to leave it alone.
 * That is a request. A property that is not in the schema CANNOT be emitted,
 * which is a guarantee — and it is the ONLY guarantee this schema offers, as
 * TEXT_FIELDS above records at some cost. A goal's reason now travels in
 * `note`, which was already here and which create_goal did not use.
 */
const CORE_FIELDS = {
  goal_id: { type: 'INTEGER' },
  checkins_enabled: { type: 'BOOLEAN' },
  checkin_per_day: { type: 'INTEGER' },
  schedule_type: { type: 'STRING', enum: ['once', 'daily', 'weekly', 'interval'] },
  time: { type: 'STRING' },
  days: { type: 'ARRAY', items: { type: 'INTEGER' } },
  interval_minutes: { type: 'INTEGER' },
  once_at: { type: 'STRING' },
  /** When the THING happens — never when to ring. See the rule below. */
  event_at: { type: 'STRING' },
  in_minutes: { type: 'INTEGER' },
  requires_proof: { type: 'BOOLEAN' },
  proof_type: { type: 'STRING', enum: ['text', 'photo', 'any'] },
  target_id: { type: 'INTEGER' },
  item_id: { type: 'INTEGER' },
  /** A nickname off the friends list above — never a chat_id. See the rule. */
  for_friend: { type: 'STRING' },
  snooze_minutes: { type: 'INTEGER' },
  chill_hours: { type: 'INTEGER' },
  intensity: { type: 'INTEGER' },
  distress: { type: 'BOOLEAN' },
} as const;

const branch = (actions: readonly string[], extra: object) => ({
  type: 'OBJECT',
  properties: { action: { type: 'STRING', enum: [...actions] }, ...extra, ...CORE_FIELDS },
  required: ['action'],
});

/*
 * TWO branches, not twenty-one, and the count is the design.
 *
 * issues.md §3 proposed a per-action discriminated union. The evidence
 * supports a much narrower cut: the failures are free text appearing on
 * actions that do not read free text, so the line to draw is that one. A
 * two-way choice with disjoint `action` enums is determined by the action
 * alone and is a far smaller ask of constrained decoding than a twenty-one-way
 * one — which matters because branch-selection quality is not something this
 * repository can measure at eleven messages a week, and every regression it
 * has shipped came from a change reasoned into existence rather than measured.
 */
const ACTION_SCHEMA = {
  anyOf: [branch(TEXT_ACTIONS, TEXT_FIELDS), branch(NO_TEXT_ACTIONS, {})],
};

/**
 * The schema as it shipped up to 0.26.0: one flat object, every property
 * available to every action.
 *
 * Kept as the FALLBACK, and it is not dead code. `anyOf` is documented as
 * supported and cannot be verified from the test rig against the real
 * endpoint; if the endpoint refuses it, `if (!res.ok) throw` in gemini.ts
 * fires on the first rung of the ladder, on every call, for every user, until
 * somebody redeploys. gemini.generate retries a 400 once with this, on the
 * same model. An optimisation is never a good enough reason for silence —
 * the same rule the model-health table is ignored under when it blocks
 * everything.
 */
const FLAT_ACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: [...ALL_ACTIONS] },
    ...TEXT_FIELDS,
    ...CORE_FIELDS,
  },
  required: ['action'],
};

/**
 * One message can ask for more than one thing — "תזכיר לי ב-7 לקום ובערב
 * להתקשר לאמא" is two reminders, not one. The router therefore always returns a
 * list, even when it has a single entry.
 */
export const ROUTER_SCHEMA = {
  type: 'OBJECT',
  properties: { actions: { type: 'ARRAY', items: ACTION_SCHEMA } },
  required: ['actions'],
};

/** @see FLAT_ACTION_SCHEMA — the shape a 400 on the union falls back to. */
export const ROUTER_SCHEMA_FLAT = {
  type: 'OBJECT',
  properties: { actions: { type: 'ARRAY', items: FLAT_ACTION_SCHEMA } },
  required: ['actions'],
};

/** More than this in one message is a misparse, not a request. */
const MAX_ACTIONS = 5;

export interface Context {
  settings: Settings;
  stats: Stats;
  reminders: Reminder[];
  goals: Goal[];
  open: Instance[];
  /**
   * Items of the reminders behind `open`, keyed by reminder_id. Only loaded
   * when something is actually open — a chat with no task being chased has
   * nothing to tick off, and this would be a query per turn for an empty map.
   */
  items?: Map<number, ReminderItem[]>;
  /**
   * People he may set a reminder FOR. Accepted edges only (db.friendsOf) — a
   * pending request is a question, not consent, and this list is what both the
   * router prompt and effects.ts resolve a name against.
   *
   * Optional so that a bare Context built for a pure test keeps compiling;
   * absent means "he has no friends", which is the state nearly every chat is
   * in and the state this file behaved as before any of it existed.
   */
  friends?: Friend[];
  /**
   * Captures with no hour yet (`status='inbox'`). Absent from `reminders`,
   * which filters `status='scheduled'` (db.listReminders) — which is why the
   * router had never once been shown one.
   *
   * On 16.08.2026 he asked for a reminder with no time, it was captured as
   * #35, he answered "מתי?" — and got #36 and #37. Not a comprehension
   * failure: the model cannot reschedule a row it cannot see, so creating
   * another was the only move available to it.
   */
  inbox?: Reminder[];
  /**
   * Reminders that already ran their course (`status='done'`), newest first.
   *
   * Absent from BOTH other lists — listReminders wants 'scheduled', listInbox
   * wants 'inbox' — so the router could not see a reminder it had watched fire
   * ten minutes earlier. On 18.08.2026 it answered `reschedule target_id=52`
   * for exactly such a row, recovering the id from the conversation, which the
   * prompt forbids outright. It happened to be right; a wrong guess would have
   * silently retimed a closed reminder he cannot see in /list.
   */
  done?: Reminder[];
  nowLabel: string;
}

/**
 * Inbox rows have no `next_fire_at` to age out on, so this list only ever
 * grows — unlike every other block in the prompt, which is bounded by the
 * passage of time. Capped rather than trimmed by date, and the remainder is
 * COUNTED rather than dropped silently: a router told it has seen everything
 * when it has not is back to inventing duplicates.
 */
const INBOX_SHOWN = 12;

/**
 * These three renderers are shared between the router and the persona on
 * purpose. They used to exist only for the router, which meant speak() was
 * asked to "only mention tasks from the list" while never being shown a list —
 * so it invented them.
 */
export function remindersSummary(ctx: Context): string {
  if (!ctx.reminders.length) return '  (אין)';
  return ctx.reminders
    .map((r) => {
      let sched = r.schedule;
      try {
        sched = describeSchedule(JSON.parse(r.schedule));
      } catch {
        /* keep raw */
      }
      /*
       * "צלצלה — מחכה לדיווח", not "לא מתוזמן".
       *
       * A reminder with no next_fire_at used to mean one thing: an inbox
       * capture that had never been given an hour. Since ctx.reminders also
       * carries whatever is RINGING (see buildContext), it now usually means
       * the opposite — it has already gone off and is waiting on him.
       * Rendering that as "not scheduled" reads as broken, two lines above an
       * openSummary entry saying the same task is open and on its second nag.
       *
       * The discriminator is the OPEN INSTANCE, not `active` and not `status`.
       * Both of those are set to the same values by setNextFire for a fired
       * one-off as for a row that is genuinely finished — which is the whole
       * reason §4 exists. `ctx.open` is the only thing here that answers the
       * engagement question directly.
       */
      const ringing = ctx.open.some((i) => i.reminder_id === r.id);
      const next = r.next_fire_at
        ? formatLocal(r.next_fire_at, r.tz)
        : ringing
          ? 'צלצלה כבר — מחכה לדיווח'
          : 'לא מתוזמן';
      // The note is the detail that makes a nag land — what it is for, what to
      // bring. It lives on the row precisely so it is still here after the
      // conversation that produced it has been pruned away.
      // The appointment itself, when it is a different time from the ring.
      // Rendered here because this block is shared with the persona
      // (see the note above): if it is absent the persona must never mention
      // the event hour, and if it is present facts.ts has to sweep it or a
      // truthful rewrite gets discarded by validate rule 1.
      const event = r.event_at ? ` — האירוע עצמו: ${formatLocal(r.event_at, r.tz)}` : '';
      return `  #${r.id} "${r.title}" — ${sched} — הבא: ${next}${event}${
        r.requires_proof ? ' — דורש הוכחה' : ''
      }${r.notes ? ` — הערה: ${r.notes}` : ''}`;
    })
    .join('\n');
}

export function openSummary(ctx: Context): string {
  if (!ctx.open.length) return '  (אין)';
  return ctx.open
    .map((i) => {
      const head = `  instance ${i.id} → "${i.title}" (נשלח ${formatLocal(
        i.fired_at,
        ctx.settings.tz,
      )}, ${i.nag_count} נדנודים)`;
      // The errands inside the task, with their ids. Without these the router
      // cannot return a `complete_item` — it would be naming a row it has
      // never been shown, which the prompt forbids and which effects.ts would
      // refuse anyway. "החזרתי את הראוטר" is unanswerable without this line.
      const items = ctx.items?.get(i.reminder_id) ?? [];
      if (!items.length) return head;
      return [
        head,
        ...items.map((it) => `      item:${it.id} ${it.done_at ? '✓' : '☐'} "${it.title}"`),
      ].join('\n');
    })
    .join('\n');
}

/**
 * The names he may aim a reminder at, and nothing else about them.
 *
 * No chat_ids: the model never needs one and must never be in a position to
 * produce one, because an id it invented would be a row written into a
 * stranger's chat. It returns a NAME, effects.ts resolves that name against
 * this same list, and a name matching nobody — or two people — is refused.
 */
export function friendsSummary(ctx: Context): string {
  if (!ctx.friends?.length) return '  (אין)';
  return ctx.friends.map((f) => `  "${f.nickname}"`).join('\n');
}

/**
 * Captures still waiting for an hour.
 *
 * Rendered with ids because the ids are the entire point: `reschedule` is what
 * promotes one of these into a scheduled reminder, and it needs a target_id it
 * has actually been shown. Without this block the only action available to the
 * model when he finally names an hour is `create_reminder`, which is exactly
 * what produced #35, #36 and #37 for one errand.
 */
export function inboxSummary(ctx: Context): string {
  const rows = ctx.inbox ?? [];
  if (!rows.length) return '  (אין)';
  const shown = rows.slice(-INBOX_SHOWN);
  const hidden = rows.length - shown.length;
  const lines = shown.map((r) => `  #${r.id} "${r.title}" — בלי שעה`);
  // Stated rather than silently truncated: a model that believes it has seen
  // the whole list will create a duplicate of a row that was trimmed off it.
  if (hidden > 0) lines.push(`  (ועוד ${hidden} בלי שעה, לא מוצגות)`);
  return lines.join('\n');
}

/**
 * What has already happened, so the router does not have to remember it.
 *
 * Rendered with ids for the same reason inboxSummary is: the id is the entire
 * point. Naming an hour for one of these is a `reschedule` that revives it,
 * and without this block the only action available to the model is
 * `create_reminder` — or, as on 18.08.2026, quoting an id it was never shown
 * and hoping.
 *
 * Deliberately short. This is prompt space and a D1 read on every turn, and a
 * long tail of finished errands is noise the model has to read past to find
 * the two lists that describe what is actually pending.
 */
export function doneSummary(ctx: Context): string {
  const rows = ctx.done ?? [];
  if (!rows.length) return '  (אין)';
  return rows.map((r) => `  #${r.id} "${r.title}" — כבר נסגרה`).join('\n');
}

export function goalsSummary(ctx: Context): string {
  if (!ctx.goals.length) return '  (אין)';
  return ctx.goals
    .map((g) => {
      const prog = g.last_progress
        ? ` — עדכון אחרון: "${g.last_progress}" (${formatLocal(
            g.last_progress_at ?? g.created_at,
            ctx.settings.tz,
          )})`
        : ' — אין עדיין התקדמות';
      return `  goal:${g.id} "${g.title}"${g.why ? ` (למה: ${g.why})` : ''}${prog}`;
    })
    .join('\n');
}

function contextBlock(ctx: Context): string {
  return `חברים שאפשר לקבוע להם תזכורות (רק השמות האלה):\n${friendsSummary(
    ctx,
  )}\n\nתזכורות פעילות (מתוזמנות לשעה):\n${remindersSummary(
    ctx,
  )}\n\nנתפסו אבל עדיין בלי שעה — אם הוא נוקב עכשיו בשעה לאחת מהן, זה reschedule עם ה-target_id שלה, לא תזכורת חדשה:\n${inboxSummary(
    ctx,
  )}\n\nכבר קרו והסתיימו — אם הוא נוקב עכשיו בשעה לאחת מהן, הוא רוצה אותה שוב: זה reschedule עם ה-target_id שלה, לא תזכורת חדשה:\n${doneSummary(
    ctx,
  )}\n\nמטרות מתמשכות (בלי שעה — אתה מעלה אותן ביוזמתך):\n${goalsSummary(
    ctx,
  )}\n\nמשימות פתוחות שמחכות לדיווח:\n${openSummary(ctx)}`;
}

export async function route(
  env: Env,
  ctx: Context,
  userText: string,
  history: { role: 'user' | 'bot'; text: string }[] = [],
  image?: { data: string; mimeType: string },
  /** The turn-wide deadline this call shares with speak(). See
   *  GenerateOpts.deadline — routing is the half that must NOT give way, so
   *  it gets first claim on whatever the turn has left. */
  deadline?: number,
): Promise<Intent[]> {
  // Without this, a bare "כן" is unroutable: the router can't see that the
  // previous turn was "לשים לך תזכורת ל-11?" and the reminder is silently lost.
  const convo = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'הוא' : 'אתה'}: ${m.text.replace(/\n+/g, ' ')}`)
    .join('\n');
  const system = `אתה מנתב כוונות של בוט תזכורות. אתה לא מדבר עם המשתמש — אתה רק מחזיר JSON.

השעה עכשיו, בפורמט שאתה אמור להשתמש בו: ${wallString(Date.now(), ctx.settings.tz)}
במילים: ${ctx.nowLabel} (אזור זמן ${ctx.settings.tz})

${contextBlock(ctx)}

${convo ? `השיחה האחרונה (ההודעה של "הוא" בסוף היא זו שאתה מנתב עכשיו):\n${convo}\n` : ''}
אם ההודעה הנוכחית היא אישור קצר ("כן", "יאללה", "בטח", "תן", "אוקיי") — תסתכל למעלה מה אתה הצעת לו בהודעה הקודמת, ותחזיר את הפעולה שהוא מאשר, כולל כל הפרטים מההצעה שלך. אל תחזיר "chat" על אישור.

כללי החלטה:
- "complete" — המשתמש מדווח שביצע משימה, או שולח תמונה כהוכחה. חובה target_id: ה-instance id של משימה שצלצלה ומחכה לדיווח, ואם שום דבר לא מצלצל עכשיו — ה-reminder id של תזכורת מהרשימה למעלה שעוד לא צלצלה. מותר לגמרי לסגור משהו לפני שהגיע הזמן שלו. רק אם הוא לא מתכוון לשום שורה שאתה רואה למעלה, החזר "chat".
- "complete_item" — הוא דיווח שעשה **חלק** ממשימה שיש בה כמה פריטים ("החזרתי את הראוטר" כשהמשימה היא ראוטר + מחבת + מחסני תאורה). item_id = ה-item id מהרשימה למעלה, ורק אחד שמופיע שם.
  זה לא complete — complete סוגר את כל המשימה, וזו תהיה אמירה על פריטים שהוא לא עשה.
  אם הוא דיווח על כמה פריטים בהודעה אחת — החזר איבר complete_item נפרד לכל אחד.
  אם אין פריטים ברשימה למעלה, זה לא הפעולה הזאת.
- "create_reminder" — הוא מבקש תזכורת/משימה חדשה. חלץ title קצר בלשון המשתמש.
  ה-title חייב להיות מהמילים שלו בלבד. אל תוסיף אותיות, סימנים או מילים שלא מופיעים בהודעה שלו — אם הוא כתב בעברית, ה-title כולו בעברית.
  אם אין לו כותרת ברורה (למשל "תזכיר לי עוד 5 דקות" בלי לומר על מה) — תן title כללי כמו "תזכורת" ותמשיך. אל תחזיר "chat" רק בגלל שחסרה כותרת.

  איך לבחור schedule_type:
  * "עוד X דקות/שעות", "בעוד רבע שעה", "תוך שעה" → schedule_type="once" + **in_minutes** (מספר דקות בלבד).
    אל תחשב בעצמך תאריך ושעה — פשוט תחזיר את מספר הדקות ואני אחשב. "עוד 3 דקות" → in_minutes=3. "עוד שעתיים" → in_minutes=120.
  * שעה מפורשת היום/מחר ("ב-22:36", "מחר ב-9") → schedule_type="once" + once_at="YYYY-MM-DDTHH:MM" לפי השעון שקיבלת למעלה.
  * "כל יום ב-X" → "daily" + time.
  * "כל שני ורביעי ב-X" → "weekly" + time + days (0=ראשון..6=שבת).
  * "כל X דקות שוב ושוב" (חזרתי!) → "interval" + interval_minutes.
    שים לב: "עוד 20 דקות" זה once עם in_minutes=20, ולא interval. interval זה רק כשהוא רוצה שזה יחזור על עצמו בלי סוף.

  **מתי הדבר קורה מול מתי לצלצל**: לפעמים הוא אומר שני זמנים שונים — מתי האירוע עצמו, ומתי הוא רוצה שתזכיר לו עליו.
  "קבעתי טיפול ליום שלישי ב-8:30, תזכיר לי בשני בערב" → once_at הוא **שני בערב** (מתי לצלצל), ו-**event_at="2026-08-18T08:30"** (מתי הטיפול).
  אל תמזג אותם ואל תבחר אחד. אם הוא אמר רק זמן אחד — זה once_at, ו-event_at לא קיים בכלל.
  event_at לבד, בלי שעת צלצול, זה לא שימושי — אם הוא נקב רק בשעת האירוע, שים אותה ב-once_at.

  requires_proof=true אם הוא ביקש שתדרוש הוכחה או אם זו משימה פיזית שקל לשקר לגביה.
  **תזכורת לחבר**: אם הוא מבקש להזכיר למישהו אחר — "תזכיר לאמנון לדבר עם שחר", "תזכיר לדנה לקנות חלב" — תמיד תוסיף **for_friend**.
  **מה לשים ב-for_friend: בדיוק את השם שהוא כתב, כמו שהוא כתב אותו.** לא שם מהרשימה, לא תיקון, לא תרגום. אם הוא כתב "אמנון" — for_friend="אמנון", גם אם ברשימה כתוב "amnon" וגם אם הרשימה ריקה לגמרי.
  זה לא מסוכן: אתה לא בוחר למי לשלוח. אתה רק מדווח את מי הוא ציין. אני מחפש את השם ברשימה בעצמי, ואם הוא לא מתאים בדיוק לאחד מהם אני לא כותב כלום ואומר לו את השמות שיש. אין שום מצב שמשהו נכתב אצל אדם אחר בגלל השם שתחזיר.
  לכן אסור לך להשמיט for_friend רק כי השם לא ברשימה. אם תשמיט אותו, התזכורת תיפול עליו במקום על החבר, והוא יקבל אישור על משהו שהוא לא ביקש. זה הכי גרוע.
  chat_id לעולם לא — לא ברשימה ולא בתשובה.
  בלי for_friend התזכורת היא שלו. "תזכיר לי" זה תמיד שלו.
- "snooze" — דחייה של משימה שכבר צלצלה ומחכה לדיווח. target_id = instance id, snooze_minutes.
- "on_my_way" — הוא בדרך, יצא, התחיל, עושה את זה עכשיו ("נוסע", "בדרך", "יוצא עכשיו", "על זה", תמונה של הדרך). target_id = instance id.
  זה לא complete — הוא לא סיים, והוא עוד יצטרך לדווח. זה גם לא snooze — snooze זה "לא עכשיו", וזה בדיוק ההפך.
- "reschedule" — הזזה של תזכורת קיימת שעוד לא צלצלה, לזמן אחר ("תעביר את זה ל-8", "תדחה את הריצה למחר בבוקר", "בעצם ב-21:00"). target_id = reminder id מהרשימה למעלה, ואת הזמן החדש באותם שדות של create_reminder (in_minutes / once_at / time+days).
  זה לא create_reminder — אל תיצור תזכורת חדשה כשהוא רק מזיז אחת קיימת, אחרת יהיו לו שתיים.
  זה גם לא snooze — snooze זה למשימה פתוחה שכבר צלצלה, reschedule זה לתזכורת שעדיין מחכה.
- "annotate" — פרט שמסביר תזכורת קיימת: בשביל מה היא, מה להביא, את מי לשאול. בדרך כלל זו התשובה שלו לשאלה ששאלת ("מה איבדת שם?" → "בשר אחי"). target_id = reminder id + note = הפרט, קצר, במילים שלו.
  זה לא rename — הכותרת נשארת. זה לא remember — remember זה עובדה קבועה עליו, וזה פרט על משימה אחת.
- "rename" — שינוי הניסוח של תזכורת קיימת בלי לגעת בשעה ("תשנה את זה ל'לקחת את הכלב'", "זה לא חלב זה לחם", וגם תשובה לשאלה שלך "על מה התזכורת?"). target_id = reminder id + title = הנוסח החדש.
- "delete" — ביטול תזכורת. target_id = reminder id.
- "list" — הוא שואל מה יש לו (תזכורות).
- "remember" — הוא מספר לך עובדה קבועה על עצמו, כזאת שתישאר נכונה גם בעוד חודש: "אני קם ב-6", "יום שלישי זה יום ארוך אצלי", "אני שונא לרוץ בבוקר", "אשתי עובדת במשמרות". note = העובדה במילים שלו, קצר.
  זה לא תזכורת (אין שעה שצריך לצלצל בה) וזה לא מטרה (אין מה להשיג). זה רק כדי שתכיר אותו.
  אירוע חד-פעמי ("היום אני עייף", "אתמול הייתי חולה") זה **לא** remember — זה chat.
- "forget" — הוא מבקש שתמחק עובדה כזאת ("תשכח שאני קם ב-6", "זה כבר לא נכון"). note = מה למחוק, או target_id אם הוא נקב במספר.

הבחנה חשובה בין תזכורת למטרה:
- **תזכורת** = משהו עם שעה. "תזכיר לי ב-7 לרוץ". → create_reminder.
- **מטרה** = שאיפה מתמשכת בלי שעה. "אני רוצה לפתוח תיק מסחר", "אני לומד בבא בתרא", "אני רוצה לחזור לחדר כושר". → create_goal (+note עם הסיבה, אם הוא אמר למה זה חשוב לו — משפט אחד קצר).
  אם הוא מתאר שאיפה בלי זמן — זו מטרה, לא תזכורת. אל תמציא לו שעה.
- "goal_progress" — הוא מספר משהו על מטרה קיימת (התקדם, נתקע, שינה כיוון). goal_id + reason = מה שהוא אמר, בקצרה.
- "complete_goal" / "drop_goal" — הוא סיים או ויתר על מטרה. goal_id.
- "list_goals" — הוא שואל מה המטרות שלו.
- "set_checkins" — הוא מבקש שתפסיק/תתחיל ליזום שיחות, או שתעשה את זה יותר/פחות. checkins_enabled, checkin_per_day.
- "chill" — הוא מבקש שתפסיק לנדנד לזמן מה. chill_hours (ברירת מחדל 4).
- "set_intensity" — הוא מבקש שתהיה יותר/פחות נודניק. intensity: 1 רך, 2 רגיל, 3 אגרסיבי.
- "chat" — כל השאר.
- distress=true אם הוא נשמע באמת במצוקה, שחוק, חולה, אבל, או מתאר משהו כבד. זה גובר על הכל.
- אל תמציא target_id או goal_id שלא מופיעים ברשימה למעלה. target_id מתייחס ל-instance או reminder; goal_id רק למטרות.

אל תכתוב ערכים של שדות כטקסט חופשי בשום שדה — שדה זה שדה. אם רצית for_friend, תמלא for_friend.

פורמט הפלט: תמיד אובייקט עם המפתח "actions" שהוא **מערך**.
הודעה אחת יכולה לבקש כמה דברים. כל בקשה נפרדת = איבר נפרד במערך, לפי הסדר שבו הוא אמר אותן.
- "תזכיר לי ב-7 לקום וגם ב-9 להתקשר לרופא" → שני איברים, כל אחד create_reminder עם השעה שלו.
- "סיימתי את הכביסה, ותזכיר לי עוד שעה לתלות" → שני איברים: complete, ואז create_reminder.
- בקשה אחת = מערך עם איבר אחד. אל תפצל בקשה אחת לשניים, ואל תאחד שתי בקשות לאחת.
- אל תחזור על אותה פעולה פעמיים. מקסימום ${MAX_ACTIONS} איברים.`;

  const parts: Part[] = [];
  if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  parts.push({ text: userText || '(שלח תמונה בלי טקסט)' });

  const raw = await generateJson<{ actions?: Intent[] } | Intent>(env, {
    system,
    contents: [{ role: 'user', parts }],
    jsonSchema: ROUTER_SCHEMA as unknown as Record<string, unknown>,
    jsonSchemaFallback: ROUTER_SCHEMA_FLAT as unknown as Record<string, unknown>,
    maxOutputTokens: 2000,
    /*
     * `thinkingLevel: 'high'` WAS HERE, in 0.16.0, and reverting it is the
     * fix rather than a retreat.
     *
     * The reasoning was sound on paper: this call classifies an intent,
     * resolves an id against five context lists, and — before Stage 1 — did
     * date arithmetic, all inside constrained decoding with nowhere to work.
     * `errors` #16 is the model saying so in its own words, 6296 characters of
     * correct reasoning written into `title` because that was the only string
     * it could reach.
     *
     * Production answered on both counts within the hour:
     *
     *   - routing went from seconds to **18.9s**, and the turn died on the
     *     wall clock with no message, no error row, and no catch anywhere.
     *     That is what the turn-wide `deadline` below now bounds — but a
     *     nineteen-second router is not worth having even when it is survivable.
     *   - it did not even buy the thing it was for. Reminder 71's title still
     *     came back "ללכת לישון / : ללכת לישון".
     *
     * And the premise had already expired: Stage 1's precedence flip means the
     * model's arithmetic no longer decides anything, so the hard reasoning it
     * was being given room for is not asked of it any more. The scratchpad is
     * a schema problem (issues.md §3, a discriminated union per action), not a
     * thinking-budget problem.
     */
    deadline,
    chatId: ctx.settings.chat_id,
  });

  // Models drop the wrapper occasionally. A bare action object is still a valid
  // answer and losing it would mean losing a reminder.
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { actions?: Intent[] }).actions)
      ? (raw as { actions: Intent[] }).actions
      : (raw as Intent).action
        ? [raw as Intent]
        : [];

  // Returns EMPTY when the model gave back nothing usable, rather than
  // synthesising `chat`. Those are different facts: "he was making
  // conversation" is an answer, "I could not parse the router's reply" is a
  // failure, and collapsing them meant the second one reached the user as a
  // bare "נו?" and reached the logs as nothing at all. The caller decides what
  // to say about an empty list — see respondToOwner.
  return list.filter((a) => a && typeof a.action === 'string').slice(0, MAX_ACTIONS);
}

/**
 * Judge a photo against a task. Deliberately lenient: the point is friction,
 * not forensics, and a bot that rejects real proof gets uninstalled.
 */
export async function judgePhoto(
  env: Env,
  title: string,
  image: { data: string; mimeType: string },
  caption: string,
  /** Whose photo this is, so the call lands on their side of the usage table. */
  chatId?: string,
): Promise<{ verdict: 'accepted' | 'rejected'; reason: string }> {
  const schema = {
    type: 'OBJECT',
    properties: {
      verdict: { type: 'STRING', enum: ['accepted', 'rejected'] },
      reason: { type: 'STRING' },
    },
    required: ['verdict', 'reason'],
  };
  try {
    return await generateJson<{ verdict: 'accepted' | 'rejected'; reason: string }>(env, {
      system: `אתה בודק הוכחות. המשימה: "${title}".
תקבל תמונה. השאלה היחידה: האם התמונה מתיישבת באופן סביר עם זה שהמשימה בוצעה?
היה סלחני — אם זה יכול להיות הוכחה סבירה, קבל. דחה רק אם התמונה בבירור לא קשורה בכלל.
reason: משפט אחד קצר בעברית שמתאר מה רואים בתמונה.`,
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: image.mimeType, data: image.data } },
            { text: caption || '(בלי כיתוב)' },
          ],
        },
      ],
      jsonSchema: schema as unknown as Record<string, unknown>,
      maxOutputTokens: 1500,
      chatId,
    });
  } catch (err) {
    console.error('judgePhoto', err);
    return { verdict: 'accepted', reason: 'לא הצלחתי לנתח את התמונה' };
  }
}

/**
 * Rewrite a already-correct message in character.
 *
 * `baseline` is the deterministic text from voice.ts. The model's only job is to
 * make it sound like נו? — it is explicitly not allowed to add facts, because
 * anything it adds is unverifiable and validate.ts will throw the whole reply
 * away for it.
 */
export async function speak(
  env: Env,
  facts: Facts,
  history: { role: 'user' | 'bot'; text: string }[],
  baseline: string,
  toneNote?: string,
  /** See sendOutcome. Decides what the turn may DO with the elapsed block. */
  stance: 'chasing' | 'replying' | 'summarising' = 'chasing',
  /** What is left of the turn. This call is the one that gives way — the
   *  baseline it rewrites is already true and already shippable. */
  deadline?: number,
): Promise<string> {
  const ctx: Context = {
    settings: facts.settings, stats: facts.stats, reminders: facts.reminders,
    goals: facts.goals, open: facts.open, nowLabel: facts.nowLabel,
    // Without this, openSummary renders instances with no errands under them —
    // while NAG_LADDER_ITEMS is telling the model to name one of them by name.
    items: facts.items,
  };
  const system =
    buildSystemPrompt(
      facts.settings, facts.stats, facts.nowLabel,
      remindersSummary(ctx), goalsSummary(ctx), openSummary(ctx),
      facts.profile,
    ) +
    `\n\n## מה שקרה עכשיו — זו האמת, אל תוסיף עליה\n${baseline}` +
    // Stated outright rather than left to be derived from a start time and a
    // wall clock. Asked to do that subtraction on 10.08.2026 the model wrote
    // "שעה וחצי אתה גורר את הטלפון למוסך" thirty minutes in. validate.ts now
    // catches that, but catching it costs the whole rewrite — this is what
    // stops it being written. Omitted entirely when nothing is open: an empty
    // heading is an invitation to fill it.
    //
    // The number STAYS on a reply turn. Withholding it was tried on 17.08.2026
    // and is worse: openSummary still carries fired_at, so the model can still
    // do the subtraction — it just does it badly, which is the bug directly
    // above, and every catch costs the whole rewrite. What changes is
    // permission to WEAPONISE it. On 16.08.2026 this block produced "למה לקח לך
    // 69 דקות להבין מתי זה?" aimed at a cooperative answer to the bot's own
    // question. He is here and talking; the span is background, not a charge.
    (facts.elapsed.length
      ? `\n\n## כמה זמן זה כבר פתוח — המספר הזה ולא אחר\n${facts.elapsed
          .map((m) => `${m} דקות`)
          .join(' · ')}` +
        (stance === 'replying'
          ? '\nהוא ענה לך עכשיו — המספר הזה הוא רקע בלבד. אל תשאל אותו למה זה לקח כל כך הרבה, ואל תנקר לו בזה. אם הוא לא רלוונטי לתשובה, אל תזכיר אותו בכלל.'
          : '') +
        /*
         * The third stance, and it exists because of one message.
         *
         * Production 04.09.2026 21:00, the evening close-out over #78, which
         * had been open since 14:59: "נו? 'להזמין אוכל ללילה' פתוח כבר 361
         * דקות. כמה זמן לוקח לבחור המבורגר?" Every fact in it is true — 361 is
         * the exact span, and rule 4 rightly passed it. It is a NAG, sent from
         * the summary slot.
         *
         * Two things are wrong with that and neither is the number. A close-out
         * reports a day; and the nag ladder had deliberately backed off to 360
         * minutes, so the next real nag was due at 23:31 — inside quiet hours,
         * where it would have been held. He got the pressure anyway, through a
         * path with no ladder, no nag_count and no ceiling. `nag_count` said 2.
         * He had received three.
         *
         * Withholding the number instead was tried on 17.08.2026 for the reply
         * stance and is worse: openSummary carries fired_at, so the model does
         * the subtraction regardless and does it badly. So this says the same
         * thing 'replying' says — the span is context, not a charge — without
         * the false claim that he has just answered.
         */
        (stance === 'summarising'
          ? '\nזה סיכום — לא נדנוד. המספר הזה הוא רקע: תזכיר מה פתוח, אל תלחץ עליו על זה עכשיו ואל תשאל אותו כמה זמן זה לוקח. הנדנודים קורים בזמנים שלהם, לא כאן.'
          : '') +
        // The span crossed his quiet hours, so the number above already has
        // the night taken out of it (facts.addElapsed). Said out loud because
        // the model can see fired_at in openSummary and would otherwise
        // "correct" the smaller number back up — which is how 26.08.2026
        // opened with "התרופה מאתמול גוררת חוב של 600 דקות" for a reminder
        // that rang at 22:00 and was slept through, as intended.
        (facts.elapsedSpansQuiet
          ? '\nהמספר הזה כבר לא כולל את שעות השקט — הוא ישן אז. זה נפתח אתמול, אז תגיד "מאתמול" ואל תגלגל לו את הלילה כחוב.'
          : '') +
        // Said for the same reason as the line above and NOT by the same line:
        // the model can subtract fired_at from the clock and would otherwise
        // "correct" the smaller figure upward. What it must not do is charge
        // him for the part the bot itself agreed to — production 18:03,
        // "93 דקות ש… פתוחה", sixty of which were a snooze granted at 17:02.
        (facts.elapsedSpansGranted
          ? '\nהמספר הזה כבר לא כולל את הזמן שאתה בעצמך נתת לו כשהוא ביקש דחייה. אל תחזיר אותו למספר הגדול ואל תזקוף לחובתו זמן שהסכמת לו.'
          : '')
      : '') +
    (toneNote ? `\n\n## הנחיית טון לתשובה הזאת\n${toneNote}` : '') +
    `\n\nכתוב מחדש את מה שכתוב ב"מה שקרה עכשיו" בקול שלך.
מותר לך לשנות ניסוח, להוסיף עוקץ, ולפצל להודעות קצרות מופרדות בשורה ריקה — לפי כלל האורך שכתוב למעלה ב"מבנה ההודעה" (אישור קצר = הודעה אחת).
אסור לך להוסיף שעה, תאריך, שם משימה, או מספר שלא מופיעים שם. אם תוסיף — כל התשובה שלך תיזרק.
אם יש מספר תזכורת (כמו #28) במה שקרה עכשיו — תשאיר אותו. זה מה שהוא מצטט לך אחר כך.
רק את ההודעות עצמן, בלי הקדמות ובלי מרכאות מסביב.`;

  const contents: Turn[] = history.map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('model' as const),
    parts: [{ text: m.text }],
  }));
  while (contents.length && contents[0].role === 'model') contents.shift();
  if (!contents.length || contents[contents.length - 1].role === 'model') {
    /*
     * The API needs the last turn to be `user`, and every UNPROMPTED message —
     * a fire, a nag, the daily brief, the close-out — ends on a bot turn. So
     * one has to be synthesised. What it says is load-bearing.
     *
     * It used to be the bare string "(המשך)", and the model read that as his
     * word and answered IT instead of rewriting the baseline. Production,
     * chat B, 25.08.2026 22:00 — this is the "לקחת תרופה" reminder FIRING:
     *
     *   המשך למה בדיוק? הכל נקי פה.
     *   או שתביא משימה חדשה, או שתשחרר אותי לראות טלוויזיה.
     *
     * and its nag half an hour later: "מה המשך? הכל סגור. לך לישון." A
     * reminder that goes off, never names the errand, and asserts that nothing
     * is open. `rejections` #2 and #3 are the same phantom months earlier,
     * caught only because the model happened to put quotes round it — rule 3
     * sees a quoted invention and nothing sees an unquoted one.
     *
     * The replacement is not a nicer filler word. Any word he could plausibly
     * have typed has this failure mode; the fix is to say outright that he did
     * not type anything, so there is nothing to answer and the only thing left
     * to do is the rewrite the system prompt asked for.
     */
    contents.push({
      role: 'user',
      parts: [{
        text:
          '[הודעה מהמערכת, לא ממנו] הוא לא אמר עכשיו כלום — אתה זה שפותח. ' +
          'אל תתייחס להודעה הזאת ואל תצטט אותה. נסח את מה שכתוב ב"מה שקרה עכשיו" בקול שלך.',
      }],
    });
  }

  // Decorative: the baseline this rewrites is already true and already
  // shippable, so when the minute's budget runs short this is the call that
  // should go, leaving room for the routing that decides what actually happens.
  return generate(env, {
    system, contents, temperature: 1.05, maxOutputTokens: 2000, decorative: true,
    deadline,
    chatId: facts.settings.chat_id,
  });
}
