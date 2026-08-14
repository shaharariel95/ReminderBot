import { generate, generateJson, type Part, type Turn } from './gemini';
import { buildSystemPrompt } from './persona';
import type { Env, Facts, Goal, Instance, Intent, Reminder, ReminderItem, Settings, Stats } from './types';
import { describeSchedule, formatLocal, wallString } from './time';

/**
 * Two-stage brain, on purpose:
 *   route()  — temperature 0.2, structured JSON, decides WHAT happens. Deterministic-ish.
 *   speak()  — temperature 1, decides HOW it is said. Never touches the database.
 * Keeping them apart means the personality can never accidentally delete a reminder,
 * and the scheduler can never accidentally sound like a form letter.
 */

const ACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: {
      type: 'STRING',
      enum: [
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
      ],
    },
    title: { type: 'STRING' },
    note: { type: 'STRING' },
    why: { type: 'STRING' },
    goal_id: { type: 'INTEGER' },
    checkins_enabled: { type: 'BOOLEAN' },
    checkin_per_day: { type: 'INTEGER' },
    schedule_type: { type: 'STRING', enum: ['once', 'daily', 'weekly', 'interval'] },
    time: { type: 'STRING' },
    days: { type: 'ARRAY', items: { type: 'INTEGER' } },
    interval_minutes: { type: 'INTEGER' },
    once_at: { type: 'STRING' },
    in_minutes: { type: 'INTEGER' },
    requires_proof: { type: 'BOOLEAN' },
    proof_type: { type: 'STRING', enum: ['text', 'photo', 'any'] },
    target_id: { type: 'INTEGER' },
    item_id: { type: 'INTEGER' },
    snooze_minutes: { type: 'INTEGER' },
    chill_hours: { type: 'INTEGER' },
    intensity: { type: 'INTEGER' },
    distress: { type: 'BOOLEAN' },
    reason: { type: 'STRING' },
  },
  required: ['action'],
} as const;

/**
 * One message can ask for more than one thing — "תזכיר לי ב-7 לקום ובערב
 * להתקשר לאמא" is two reminders, not one. The router therefore always returns a
 * list, even when it has a single entry.
 */
const ROUTER_SCHEMA = {
  type: 'OBJECT',
  properties: { actions: { type: 'ARRAY', items: ACTION_SCHEMA } },
  required: ['actions'],
} as const;

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
  nowLabel: string;
}

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
      const next = r.next_fire_at ? formatLocal(r.next_fire_at, r.tz) : 'לא מתוזמן';
      // The note is the detail that makes a nag land — what it is for, what to
      // bring. It lives on the row precisely so it is still here after the
      // conversation that produced it has been pruned away.
      return `  #${r.id} "${r.title}" — ${sched} — הבא: ${next}${
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
  return `תזכורות פעילות (מתוזמנות לשעה):\n${remindersSummary(
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
- "complete" — המשתמש מדווח שביצע משימה, או שולח תמונה כהוכחה. חובה target_id = ה-instance id הרלוונטי מהרשימה למעלה. אם אין משימה פתוחה מתאימה, החזר "chat".
- "complete_item" — הוא דיווח שעשה **חלק** ממשימה שיש בה כמה פריטים ("החזרתי את הראוטר" כשהמשימה היא ראוטר + מחבת + מחסני תאורה). item_id = ה-item id מהרשימה למעלה, ורק אחד שמופיע שם.
  זה לא complete — complete סוגר את כל המשימה, וזו תהיה אמירה על פריטים שהוא לא עשה.
  אם הוא דיווח על כמה פריטים בהודעה אחת — החזר איבר complete_item נפרד לכל אחד.
  אם אין פריטים ברשימה למעלה, זה לא הפעולה הזאת.
- "create_reminder" — הוא מבקש תזכורת/משימה חדשה. חלץ title קצר בלשון המשתמש.
  אם אין לו כותרת ברורה (למשל "תזכיר לי עוד 5 דקות" בלי לומר על מה) — תן title כללי כמו "תזכורת" ותמשיך. אל תחזיר "chat" רק בגלל שחסרה כותרת.

  איך לבחור schedule_type:
  * "עוד X דקות/שעות", "בעוד רבע שעה", "תוך שעה" → schedule_type="once" + **in_minutes** (מספר דקות בלבד).
    אל תחשב בעצמך תאריך ושעה — פשוט תחזיר את מספר הדקות ואני אחשב. "עוד 3 דקות" → in_minutes=3. "עוד שעתיים" → in_minutes=120.
  * שעה מפורשת היום/מחר ("ב-22:36", "מחר ב-9") → schedule_type="once" + once_at="YYYY-MM-DDTHH:MM" לפי השעון שקיבלת למעלה.
  * "כל יום ב-X" → "daily" + time.
  * "כל שני ורביעי ב-X" → "weekly" + time + days (0=ראשון..6=שבת).
  * "כל X דקות שוב ושוב" (חזרתי!) → "interval" + interval_minutes.
    שים לב: "עוד 20 דקות" זה once עם in_minutes=20, ולא interval. interval זה רק כשהוא רוצה שזה יחזור על עצמו בלי סוף.

  requires_proof=true אם הוא ביקש שתדרוש הוכחה או אם זו משימה פיזית שקל לשקר לגביה.
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
- **מטרה** = שאיפה מתמשכת בלי שעה. "אני רוצה לפתוח תיק מסחר", "אני לומד בבא בתרא", "אני רוצה לחזור לחדר כושר". → create_goal (+why אם הוא אמר למה זה חשוב לו).
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
    maxOutputTokens: 2000,
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
): Promise<string> {
  const ctx: Context = {
    settings: facts.settings, stats: facts.stats, reminders: facts.reminders,
    goals: facts.goals, open: facts.open, nowLabel: facts.nowLabel,
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
    (facts.elapsed.length
      ? `\n\n## כמה זמן זה כבר פתוח — המספר הזה ולא אחר\n${facts.elapsed
          .map((m) => `${m} דקות`)
          .join(' · ')}`
      : '') +
    (toneNote ? `\n\n## הנחיית טון לתשובה הזאת\n${toneNote}` : '') +
    `\n\nכתוב מחדש את מה שכתוב ב"מה שקרה עכשיו" בקול שלך.
מותר לך לשנות ניסוח, להוסיף עוקץ, ולפצל להודעות קצרות מופרדות בשורה ריקה — לפי כלל האורך שכתוב למעלה ב"מבנה ההודעה" (אישור קצר = הודעה אחת).
אסור לך להוסיף שעה, תאריך, שם משימה, או מספר שלא מופיעים שם. אם תוסיף — כל התשובה שלך תיזרק.
רק את ההודעות עצמן, בלי הקדמות ובלי מרכאות מסביב.`;

  const contents: Turn[] = history.map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('model' as const),
    parts: [{ text: m.text }],
  }));
  while (contents.length && contents[0].role === 'model') contents.shift();
  if (!contents.length || contents[contents.length - 1].role === 'model') {
    contents.push({ role: 'user', parts: [{ text: '(המשך)' }] });
  }

  // Decorative: the baseline this rewrites is already true and already
  // shippable, so when the minute's budget runs short this is the call that
  // should go, leaving room for the routing that decides what actually happens.
  return generate(env, {
    system, contents, temperature: 1.05, maxOutputTokens: 2000, decorative: true,
  });
}
