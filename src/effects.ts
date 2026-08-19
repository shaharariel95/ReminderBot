import * as db from './db';
import type { Context } from './brain';
import type { Effect, Env, Intent, Reminder, ReminderItem, Schedule } from './types';
import { UNTITLED_TITLE } from './types';
import { computeNext, localDateKey, localDayBounds, wallParts, wallString, wallToUtc } from './time';
import { findFutureInstant, findNamedTime, parseDuration } from './quickparse';
import { detectPattern } from './patterns';

/**
 * How long the nag ladder holds off after he says he is on it. Long enough to
 * get there and do the thing; short enough that "בדרך" cannot become a way of
 * never being asked again.
 */
export const ON_MY_WAY_GRACE_MIN = 30;

/** Reminders whose next_fire_at lands within this many ms count as "the same time". */
const DUPLICATE_WINDOW_MS = 60_000;

/**
 * Comparison key for two titles: trim, collapse internal whitespace, strip
 * punctuation (replaced with a space so hyphenated words don't fuse), and
 * lowercase (a no-op on Hebrew, which has no case).
 */
function normalizeTitle(title: string): string {
  return title
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** The fallback title quickparse/the router use when no subject was extracted —
 *  two unrelated captures can both carry it, so it must not be allowed to
 *  near-match anything on title similarity alone. */
const GENERIC_TITLE = normalizeTitle(UNTITLED_TITLE);
function isGenericTitle(normalized: string): boolean {
  return normalized === GENERIC_TITLE;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * "Similar enough to warn about, not identical." Token (Jaccard) overlap
 * catches reordered/partially-shared phrasing; the containment check catches
 * one title being a strict elaboration of the other ("לקחת בגד ים" vs "לקחת
 * בגד ים לים"). The length-3 floor on the shorter side keeps a one-word
 * generic-ish title (but not GENERIC_TITLE itself, handled separately) from
 * matching everything that happens to contain it.
 */
function isNearMatch(normA: string, normB: string): boolean {
  const tokensA = new Set(normA.split(' ').filter(Boolean));
  const tokensB = new Set(normB.split(' ').filter(Boolean));
  if (jaccard(tokensA, tokensB) >= 0.5) return true;
  const [shorter, longer] = normA.length <= normB.length ? [normA, normB] : [normB, normA];
  return shorter.length >= 3 && longer.includes(shorter);
}

/**
 * "להחזיר ראוטר, לקנות מחבת לטבון,ללכת למחסני תאורה" → three things to tick
 * off. Anything else → nothing, and the title stays exactly as he typed it.
 *
 * The rule is deliberately narrow, because over-splitting is the worse error.
 * A checklist he did not ask for turns one task into three ticks he has to
 * clear before the bot stops chasing him; a title with commas in it is just
 * what he wrote. So a split has to be obviously a list of ERRANDS:
 *
 *   - 2 to MAX_ITEMS comma-separated parts, each with something in it
 *   - at least two of them starting with an infinitive ל
 *
 * That last condition is what does the work. "להחזיר ראוטר, לקנות מחבת, ללכת
 * למחסני תאורה" has three; "לקנות חלב, ביצים ולחם" has one, and stays a single
 * shopping errand — which is correct, because that is one trip to one shop.
 */
export function splitIntoItems(title: string): string[] {
  const parts = title
    .split(/\s*[,;]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  if (parts.length < 2 || parts.length > db.MAX_ITEMS) return [];
  // The Hebrew infinitive marker, followed by a real letter. Two of them means
  // he listed actions, not the parts of one action.
  const verbs = parts.filter((p) => /^ל[א-ת]/.test(p)).length;
  return verbs >= 2 ? parts : [];
}

/**
 * A title the model returned, with anything he never typed taken back out.
 *
 * On 17.08.2026 the router answered "תזכיר לאמנון לדבר עם שחר עוד שתי דקות"
 * with the title "לדבר עם שחרy", and the next attempt with "לדבר עם שחרyil" —
 * stray Latin letters (hex 79 69 6C) appended to an otherwise correct Hebrew
 * title. His message contained no Latin at all. Nothing downstream could
 * notice: the title is whatever the model says it is, and every check in
 * validate.ts compares the REPLY against the effect, so a corrupted title is
 * simply reported faithfully.
 *
 * The rule is narrow and is about honesty rather than tidiness: the router may
 * re-word him — dropping "תזכיר לאמנון" from the front is exactly its job —
 * but it may not introduce a SCRIPT he never used. A title is quoted back to
 * him, filed under his name, and read out when it fires; letters he did not
 * type are the bot putting words in his mouth.
 *
 * Deliberately not a general character filter. "תזכיר לי לשלוח email" keeps
 * its email, because the Latin is his. Only a script absent from the source
 * is removed, and if that empties the title the caller's own fallback applies.
 */
export function titleFromHisWords(title: string, userText: string): string {
  // Nothing to compare against: button and cron paths have no message.
  if (!userText.trim()) return title;
  if (/[A-Za-z]/.test(userText)) return title;
  if (!/[A-Za-z]/.test(title)) return title;
  return title.replace(/[A-Za-z]+/g, '').replace(/\s{2,}/g, ' ').trim();
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
      return intent.interval_minutes ? { type: 'interval', minutes: intent.interval_minutes } : null;
    case 'once':
      return intent.once_at ? { type: 'once', at: intent.once_at } : null;
    default:
      return null;
  }
}

/**
 * Which reminder a reschedule/rename is aimed at.
 *
 * Reads by id rather than searching ctx.reminders so that inbox captures —
 * which have no fire time and so never appear there — can still be renamed and
 * scheduled. The chat_id check is not ceremony: db.getReminder looks up by
 * primary key alone, so without it a target_id the model hallucinated could
 * point at another chat's row. Cancelled reminders are deliberately NOT
 * filtered here — retimeReminder and renameReminder both exclude them in their
 * WHERE clause, and one guard that is tested beats two that can disagree about
 * which message the user gets.
 */
async function resolveReminder(
  env: Env,
  chatId: string,
  ctx: Context,
  intent: Intent,
): Promise<Reminder | null> {
  if (intent.target_id) {
    const r = await db.getReminder(env, intent.target_id);
    return r && r.chat_id === chatId ? r : null;
  }
  // "תעביר את זה ל-8" with exactly one reminder on file is unambiguous.
  return ctx.reminders.length === 1 ? ctx.reminders[0] : null;
}

/**
 * A task he just closed was ARRANGING something — offer the thing itself.
 *
 * "לדבר על המוסך לוודא שאני מגיע בבוקר של יום חמישי לטיפול וטסט" was closed on
 * Monday morning. The call was made, the appointment was confirmed, and
 * nothing whatsoever existed for Thursday — the bot watched the entire
 * arrangement happen and had no way to notice the appointment inside it.
 *
 * Never writes. The suggestion is a question with a button under it, so an
 * assumed hour (see PERIOD_HOUR) costs a tap to accept and nothing to ignore.
 * Anything already on the books near that time is left alone: offering a
 * reminder he already has is noise, and noise is how a good prompt gets muted.
 */
async function suggestFollowup(
  env: Env,
  chatId: string,
  ctx: Context,
  instanceId: number,
  title: string,
): Promise<Effect[]> {
  const at = findFutureInstant(title, Date.now(), ctx.settings.tz);
  if (at === null || at <= Date.now()) return [];
  const nearby = await db.findNearbyReminders(env, chatId, at, FOLLOWUP_QUIET_WINDOW_MS);
  if (nearby.length) return [];
  return [{ kind: 'followup_suggested', instanceId, title, at }];
}

/**
 * Parts of a day, for the crowding check. Deliberately coarse: he does not
 * think in 90-minute buckets, he thinks "tomorrow morning".
 */
const DAY_PARTS: [number, number, string][] = [
  [5, 12, 'בוקר'],
  [12, 17, 'צהריים'],
  [17, 22, 'ערב'],
];

/** Below this a "busy window" is just a day with things in it. */
const CROWDED_AT = 4;

/**
 * Is the part of the day this reminder landed in already full?
 *
 * An observation attached to a write that already succeeded, so every failure
 * path here is silent — he asked for a reminder, he got one, and a throw while
 * counting his morning must never turn that into an error.
 */
async function crowdingFor(
  env: Env,
  chatId: string,
  tz: string,
  at: number,
): Promise<Effect[]> {
  try {
    const p = wallParts(at, tz);
    const part = DAY_PARTS.find(([lo, hi]) => p.hour >= lo && p.hour < hi);
    if (!part) return [];
    const from = wallToUtc(p.year, p.month, p.day, part[0], 0, tz);
    const to = wallToUtc(p.year, p.month, p.day, part[1], 0, tz);
    const rows = await db.remindersBetween(env, chatId, from, to);
    // The row just written is already in this count, which is what he will see
    // in /list — reporting one fewer reads as the bot being wrong about
    // something he can check in two taps.
    if (rows.length < CROWDED_AT) return [];
    const when = localDateKey(at, tz) === localDateKey(Date.now(), tz) ? 'ה' : 'מחר ב';
    return [{ kind: 'window_crowded', count: rows.length, label: `${when}${part[2]}` }];
  } catch (err) {
    console.error('crowdingFor', err);
    return [];
  }
}

/** How far back the behavioural record is read. */
const PATTERN_WINDOW_MS = 45 * 24 * 3_600_000;

/**
 * Once a fortnight per reminder, at most. The cooldown is the difference
 * between an observation and a nag about the nagging: without it, every push
 * past the threshold re-asks the identical question, and the feature that was
 * supposed to notice he is being over-reminded becomes another reminder.
 */
const PATTERN_COOLDOWN_MS = 14 * 24 * 3_600_000;

/**
 * The one thing this reminder's own history says, or nothing at all.
 *
 * Silent on every failure path by design. This is decoration on top of a write
 * that already happened and already has its own true sentence; a throw here
 * must never cost him the confirmation of the thing he actually did.
 */
async function patternFor(
  env: Env,
  chatId: string,
  ctx: Context,
  reminderId: number,
  title: string,
): Promise<Effect[]> {
  try {
    const now = Date.now();
    if (await db.patternOfferedSince(env, chatId, reminderId, now - PATTERN_COOLDOWN_MS)) return [];

    const b = await db.behaviourOf(env, chatId, reminderId, ctx.settings.tz, now - PATTERN_WINDOW_MS);
    const p = detectPattern(b);
    if (!p) return [];

    if (p.kind === 'failing') {
      return [{ kind: 'pattern_failing', id: reminderId, title, failures: p.failures, fires: p.fires }];
    }
    // The suggested hour as an INSTANT — its next occurrence — so facts.ts
    // sweeps it through the existing `at` rule and validate.ts allows the
    // persona to repeat it. An hour carried as a bare number would be a clock
    // time the allow-list has never seen, and the whole rewrite would be
    // discarded for saying it.
    const at =
      p.hour === null
        ? undefined
        : (computeNext({ type: 'daily', time: `${String(p.hour).padStart(2, '0')}:00` }, ctx.settings.tz, now) ??
          undefined);
    return [
      { kind: 'pattern_pushed', id: reminderId, title, snoozes: p.snoozes, fires: p.fires, at },
    ];
  } catch (err) {
    console.error('patternFor', err);
    return [];
  }
}

/** Anything scheduled within this of the appointment counts as "already handled". */
const FOLLOWUP_QUIET_WINDOW_MS = 4 * 3_600_000;

/**
 * Every still-open item across the reminders he currently has firing.
 *
 * Scoped to OPEN INSTANCES rather than to every reminder he owns: "החזרתי את
 * הראוטר" is about the thing being chased right now, and matching it against a
 * reminder scheduled for next Thursday would tick off an errand he has not
 * reached yet.
 */
async function openItemsFor(env: Env, chatId: string, ctx: Context): Promise<ReminderItem[]> {
  const ids = [...new Set(ctx.open.map((i) => i.reminder_id))];
  if (!ids.length) return [];
  const byReminder = await db.itemsForReminders(env, ids);
  const out: ReminderItem[] = [];
  for (const list of byReminder.values()) {
    for (const item of list) if (item.done_at === null && item.chat_id === chatId) out.push(item);
  }
  return out;
}

/**
 * Which open item his words are about, or null when it is not obvious.
 *
 * Deliberately requires a real word in common — a shared "את" or "ל" is not
 * evidence of anything. Returning null when two items match equally well is
 * the whole point: the caller then ASKS, and asking is always truthful where
 * guessing is a claim about what he did.
 */
function matchItem(open: ReminderItem[], text: string): ReminderItem | null {
  const words = new Set(
    normalizeTitle(text)
      .split(' ')
      .filter((w) => w.length >= 3),
  );
  if (!words.size) return null;

  const scored = open
    .map((item) => {
      const itemWords = normalizeTitle(item.title)
        .split(' ')
        .filter((w) => w.length >= 3);
      return { item, hits: itemWords.filter((w) => words.has(w)).length };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (!scored.length) return null;
  // A tie means two errands fit his sentence equally well and nothing in it
  // separates them.
  if (scored.length > 1 && scored[0].hits === scored[1].hits) return null;
  return scored[0].item;
}

/**
 * Close the loop after an item is ticked: report it, and when it was the last
 * one, close the task itself.
 *
 * The instance close rides in the SAME effects array rather than being left to
 * the next turn, so "that was the last one" is one message with one streak,
 * not a tick followed by silence.
 */
async function finishItem(
  env: Env,
  chatId: string,
  ctx: Context,
  item: ReminderItem,
): Promise<Effect[]> {
  const remaining = await db.openItemCount(env, item.reminder_id);
  const effects: Effect[] = [
    {
      kind: 'item_done',
      id: item.id,
      title: item.title,
      reminderId: item.reminder_id,
      remaining,
    },
  ];
  if (remaining > 0) return effects;

  // Last errand. Close whichever open instance belongs to this reminder — by
  // reminder_id, never "the only open one", or a second task firing in the
  // same minute would be closed by the wrong tick.
  const inst = ctx.open.find((i) => i.reminder_id === item.reminder_id);
  if (inst && (await db.closeIfOpen(env, inst.id, 'done', 'כל הפריטים'))) {
    const fresh = await db.stats(env, chatId);
    effects.push({
      kind: 'instance_done',
      id: inst.id,
      title: inst.title,
      streak: fresh.currentStreak,
    });
  }
  return effects;
}

/**
 * A reminder for somebody else.
 *
 * Three refusals, and all three are the same refusal: this function writes
 * into an account its caller cannot see, so anything it is not certain of it
 * declines rather than approximates.
 *
 *  - A name that matches nobody, or two people, is `unknown_friend`. It is
 *    NOT downgraded to a reminder for himself: he asked for something to
 *    happen to another person, and a row in his own chat is a different thing
 *    he would then have to notice and delete.
 *  - No time is `no_time`, not an inbox capture. An inbox item belongs to
 *    whoever can schedule it, and the /inbox buttons are on HIS side — hers
 *    would be a line she never wrote, in a list she never asked for, with
 *    nothing able to give it an hour.
 *  - The consent check is db.friendsOf, which is accepted edges only. A
 *    pending request is a question.
 *
 * The hour is read in HER timezone, not his. "תזכיר לדנה ב-8" means eight
 * o'clock where Dana is, because she is the one it has to be useful to.
 */
async function friendReminder(
  env: Env,
  chatId: string,
  ctx: Context,
  intent: Intent,
  title: string,
  userText: string,
): Promise<Effect[]> {
  const friend = db.matchFriend(ctx.friends ?? [], intent.for_friend ?? '');
  if (!friend) {
    return [
      {
        kind: 'friend_unknown',
        asked: (intent.for_friend ?? '').slice(0, 40),
        known: (ctx.friends ?? []).map((f) => f.nickname),
      },
    ];
  }

  const theirs = await db.getSettings(env, friend.friend_chat_id);
  const schedule = scheduleFromIntent(intent, theirs.tz);
  if (!schedule) return [{ kind: 'nothing', why: 'no_time', userText }];

  let next: number | null;
  try {
    next = computeNext(schedule, theirs.tz, Date.now());
  } catch {
    return [{ kind: 'nothing', why: 'bad_time', userText }];
  }
  if (next === null) return [{ kind: 'nothing', why: 'past_time', userText }];

  const id = await db.addReminder(env, {
    chat_id: friend.friend_chat_id,
    title,
    notes: null,
    schedule: JSON.stringify(schedule),
    tz: theirs.tz,
    requires_proof: intent.requires_proof ? 1 : 0,
    proof_type: intent.proof_type ?? 'any',
    nag_interval_min: 20,
    max_nags: 3,
    next_fire_at: next,
    // Deliberately null, not forwarded from the intent. friendReminder refuses
    // everything it cannot be certain of, because it writes into an account its
    // caller cannot see — and an event hour is the kind of extra that would be
    // stated aloud in HER chat, through the heads-up path that has no validator
    // on it at all.
    event_at: null,
    // What makes her fired message able to say who this came from — see
    // migrations/013. Stored as the id, resolved to a name at fire time.
    from_chat_id: chatId,
  });

  // Errands split the same way they do for his own reminders, and under HER
  // chat_id: the ticks are hers to make, and db.completeItem checks the row
  // belongs to whoever tapped.
  const itemTitles = splitIntoItems(title);
  if (itemTitles.length) await db.addItems(env, id, friend.friend_chat_id, itemTitles);

  // No duplicate check, deliberately. The two that exist for his own
  // reminders both answer "did he already ask for this", by reading his own
  // rows — and the honest wording for a hit ("כבר יש לך את זה") is a sentence
  // about a list he cannot open. He sees a confirmation naming her and the
  // hour for every one of these, so a repeat is visible where it matters.
  return [
    {
      kind: 'friend_reminder_created',
      id,
      title,
      at: next,
      schedule,
      requiresProof: !!intent.requires_proof,
      friend: friend.nickname,
      to: friend.friend_chat_id,
    },
  ];
}

export async function applyIntent(
  env: Env,
  chatId: string,
  ctx: Context,
  intent: Intent,
  userText: string,
): Promise<Effect[]> {
  const tz = ctx.settings.tz;

  switch (intent.action) {
    case 'create_reminder': {
      const title = titleFromHisWords(intent.title?.trim() ?? '', userText) || UNTITLED_TITLE;

      // "תזכיר לדנה..." — a row in somebody else's account. Handled before
      // anything else in this branch, because almost nothing below it applies:
      // the duplicate check, the inbox capture and the item split are all
      // about HIS chat, and running them against hers would be answering a
      // question nobody asked.
      if (intent.for_friend) return friendReminder(env, chatId, ctx, intent, title, userText);

      // The same second look `reschedule` has taken since 14.08.2026
      // (see its branch below). The router returns a create with the time
      // field empty even when he said the hour in the same breath — which is
      // how "תזכיר לי לקבוע טיפול וטסט מחר ב-15:00" became an inbox capture
      // and a question about an hour sitting in the sentence being answered.
      //
      // This asymmetry is the shape CLAUDE.md records being burned by twice
      // with asksForNewReminder: one question, two implementations, and only
      // one of them fixed. findNamedTime refuses rather than guesses on a
      // repeat rule, two times in one sentence, and an hour already past, so
      // every refusal still falls through to the capture below.
      const named = findNamedTime(userText, Date.now(), tz);
      // Third look, and the last one: a pinned DAY plus a named part of it,
      // with no digits anywhere. "תזכיר לי מחר בערב להתכונן" parsed to nothing
      // at all before 17.08.2026 — not to the wrong hour, to no hour — so the
      // commonest vague phrasing in the language cost a model call and came
      // back as a capture and a question about a time he had already roughly
      // given.
      //
      // findFutureInstant + PERIOD_HOUR already did this for the
      // appointment-offer path; it was simply never asked on the path where he
      // requests the reminder himself.
      //
      // It is a convention, not a reading — ערב is 20:00 because it has to be
      // something. That is honest here for one reason: voice.ts ALWAYS states
      // the hour it set, so he reads "20:00" back and can move it. No hedge is
      // added, deliberately: a hedge would sit inside the rewrite, and speak()
      // is licensed to rephrase, so it could vanish without the validator
      // noticing — validate.ts checks for facts INVENTED, never for words
      // dropped. An hour that is always spoken cannot be quietly lost.
      //
      // Bounded by the day: findFutureInstant returns null without one, so a
      // bare "בערב" — tonight? tomorrow? — still falls through to the capture.
      const vague = named === null ? findFutureInstant(userText, Date.now(), tz) : null;
      const guessed = named ?? (vague !== null && vague > Date.now() ? vague : null);
      const schedule =
        scheduleFromIntent(intent, tz) ??
        (guessed === null ? null : ({ type: 'once', at: wallString(guessed, tz) } as Schedule));

      // No time is not a failure any more. Capture first, schedule later.
      if (!schedule) {
        const id = await db.addInboxItem(env, chatId, title, tz);
        return [{ kind: 'reminder_captured', id, title }];
      }

      let next: number | null;
      try {
        next = computeNext(schedule, tz, Date.now());
      } catch {
        return [{ kind: 'nothing', why: 'bad_time', userText }];
      }
      if (next === null) return [{ kind: 'nothing', why: 'past_time', userText }];

      // Deterministic duplicate check — no model call. Only reminders close
      // in time to this one are even candidates, so this never touches
      // anything the user scheduled for a genuinely different moment.
      const normTitle = normalizeTitle(title);
      const generic = isGenericTitle(normTitle);
      const nearby = await db.findNearbyReminders(env, chatId, next, DUPLICATE_WINDOW_MS);

      const exact = nearby.find((r) => normalizeTitle(r.title) === normTitle);
      if (exact) {
        // Identical title at (near enough) the same time really is a double-
        // send — even for the generic fallback title, where two unrelated
        // untitled captures landing in the same minute is implausible enough
        // that treating it as a duplicate is still the right call. Nothing is
        // inserted; the capture already exists.
        return [
          { kind: 'reminder_duplicate', id: exact.id, title: exact.title, at: exact.next_fire_at ?? next },
        ];
      }

      // Near-matching is skipped for generic titles on either side — "תזכורת"
      // says nothing about the subject, so similarity here is noise, not signal.
      const similar = (rows: Reminder[]) =>
        generic
          ? undefined
          : rows.find((r) => {
              const normExisting = normalizeTitle(r.title);
              return !isGenericTitle(normExisting) && isNearMatch(normTitle, normExisting);
            });

      const near = similar(nearby);

      // The appointment itself. Parsed through the same wall-clock->instant
      // path as any other time, then STORED AS AN INSTANT — a wall string
      // would be read back under whichever timezone the row lives in, and a
      // cross-chat reminder lives under hers.
      //
      // Refused rather than approximated when it is unparseable or already
      // gone: an event time is decoration on top of a working reminder, and a
      // wrong one is worse than none, since the bot would state it aloud.
      let eventAt: number | null = null;
      if (intent.event_at) {
        try {
          const t = computeNext({ type: 'once', at: intent.event_at }, tz, Date.now() - 60_000);
          eventAt = t;
        } catch {
          eventAt = null;
        }
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
        event_at: eventAt,
      });

      // Three errands in one sentence become three things to tick off, under
      // one reminder. The title is left exactly as he typed it — the items are
      // additional structure, not a replacement, so /list, the nag and every
      // existing test still see the sentence he wrote.
      const itemTitles = splitIntoItems(title);
      if (itemTitles.length) await db.addItems(env, id, chatId, itemTitles);

      // Nothing within a minute, so widen to the whole local day. He asked for
      // the same thing twice, hours apart, having forgotten the first — the
      // case the 60-second window was never going to catch. Only ever a
      // warning: at this width, refusing would break twice-daily reminders.
      let twin = near;
      if (!twin) {
        const { from, to } = localDayBounds(next, tz);
        twin = similar(await db.remindersSameDay(env, chatId, from, to, id));
      }

      return [
        {
          kind: 'reminder_created', id, title, at: next, eventAt, schedule,
          requiresProof: !!intent.requires_proof,
          ...(intent.ambiguous_hour === undefined ? {} : { altHour: intent.ambiguous_hour }),
          ...(twin
            ? { duplicateOf: { id: twin.id, title: twin.title, at: twin.next_fire_at ?? next } }
            : {}),
        },
        // Alongside the confirmation, never instead of it. He asked for a
        // reminder and he has one; how full his morning is, is an observation
        // he can act on or ignore. Suppressed when a duplicate warning is
        // already riding along — two unsolicited remarks on one confirmation
        // is a lecture.
        ...(twin ? [] : await crowdingFor(env, chatId, tz, next)),
      ];
    }

    case 'complete': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) {
        // More than one open task and no way to tell which: asking is
        // truthful, "no open task" (below) is not — those tasks are right
        // there. The genuinely-empty case keeps its existing message.
        if (ctx.open.length > 1) return [{ kind: 'needs_task_choice', action: 'complete', open: ctx.open }];
        return [{ kind: 'nothing', why: 'no_open_task', userText }];
      }
      await db.closeInstance(env, inst.id, 'done', userText.slice(0, 500) || 'דיווח');
      const fresh = await db.stats(env, chatId);
      return [
        { kind: 'instance_done', id: inst.id, title: inst.title, streak: fresh.currentStreak },
        ...(await suggestFollowup(env, chatId, ctx, inst.id, inst.title)),
      ];
    }

    /**
     * "החזרתי את הראוטר" — one errand out of three.
     *
     * The item is resolved by id when the router names one, and otherwise by
     * matching his words against the open items. That fallback matters: this
     * is the intent the model is newest at, and the deterministic path costs
     * nothing and cannot hallucinate an id.
     */
    case 'complete_item': {
      const open = await openItemsFor(env, chatId, ctx);
      const item =
        open.find((i) => i.id === intent.item_id) ??
        matchItem(open, intent.title ?? intent.note ?? userText);
      if (!item) {
        // Never silently falls back to closing the whole task. Getting this
        // wrong claims he did errands he did not do, which is the one thing
        // this pipeline exists to prevent.
        return open.length
          ? [{ kind: 'needs_item_choice', open }]
          : [{ kind: 'nothing', why: 'no_open_task', userText }];
      }
      if (!(await db.completeItem(env, item.id))) {
        return [{ kind: 'nothing', why: 'no_open_task', userText }];
      }
      return finishItem(env, chatId, ctx, item);
    }

    case 'annotate': {
      const rem = await resolveReminder(env, chatId, ctx, intent);
      const note = (intent.note ?? intent.title ?? userText).trim();
      if (!rem || !note) return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      if (!(await db.annotateReminder(env, rem.id, note))) {
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }
      return [
        {
          kind: 'reminder_annotated',
          id: rem.id,
          title: rem.title,
          note: note.slice(0, db.REMINDER_NOTE_MAX),
        },
      ];
    }

    case 'on_my_way': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) {
        if (ctx.open.length > 1) {
          return [{ kind: 'needs_task_choice', action: 'on_my_way', open: ctx.open }];
        }
        return [{ kind: 'nothing', why: 'no_open_task', userText }];
      }
      // Long enough to actually get there and do the thing, short enough that
      // "בדרך" cannot quietly become a way of never being asked again.
      const minutes = ON_MY_WAY_GRACE_MIN;
      if (!(await db.startInstance(env, inst.id, minutes))) {
        return [{ kind: 'nothing', why: 'no_open_task', userText }];
      }
      return [
        {
          kind: 'instance_started',
          id: inst.id,
          title: inst.title,
          until: Date.now() + minutes * 60_000,
        },
      ];
    }

    case 'snooze': {
      const inst =
        ctx.open.find((i) => i.id === intent.target_id) ??
        (ctx.open.length === 1 ? ctx.open[0] : null);
      if (!inst) {
        if (ctx.open.length > 1) return [{ kind: 'needs_task_choice', action: 'snooze', open: ctx.open }];
        return [{ kind: 'nothing', why: 'no_open_task', userText }];
      }
      // The router is asked for `snooze_minutes` but routinely omits it, and
      // the fallback below is then reported back to him as a number he chose
      // — "עוד שעה" came out as "הזזתי ב-30 דקות" on 10.08.2026. The write is
      // real either way, so validate.ts cannot see this: the lie is upstream
      // of the model. parseDuration reads the length off his own words before
      // the default gets to speak for him.
      const minutes = Math.min(
        720,
        Math.max(5, intent.snooze_minutes ?? parseDuration(userText) ?? 30),
      );
      await db.snoozeInstance(env, inst.id, minutes);
      const snoozed: Effect[] = [
        {
          kind: 'instance_snoozed',
          id: inst.id,
          title: inst.title,
          until: Date.now() + minutes * 60_000,
          minutes,
        },
      ];
      // Raised HERE, on the push itself, rather than as its own message later.
      // The moment he defers it for the sixth time is the moment the question
      // makes sense, and appending to a reply he was already getting costs no
      // extra notification. An unsolicited message about a reminder he was not
      // thinking about is exactly the noise this is meant to reduce.
      snoozed.push(...(await patternFor(env, chatId, ctx, inst.reminder_id, inst.title)));
      return snoozed;
    }

    case 'list':
      return [{ kind: 'listed_reminders', rows: ctx.reminders, openCount: ctx.open.length }];

    case 'list_goals':
      return [{ kind: 'listed_goals', rows: ctx.goals }];

    case 'delete': {
      if (!intent.target_id) return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      const rem = ctx.reminders.find((r) => r.id === intent.target_id);
      const ok = await db.deleteReminder(env, chatId, intent.target_id);
      if (!ok) return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      return [
        { kind: 'reminder_deleted', id: intent.target_id, title: rem?.title ?? String(intent.target_id) },
      ];
    }

    case 'reschedule': {
      const rem = await resolveReminder(env, chatId, ctx, intent);
      if (!rem) {
        if (ctx.reminders.length > 1) {
          return [{ kind: 'needs_reminder_choice', action: 'reschedule', rows: ctx.reminders }];
        }
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }

      // The router routinely returns a reschedule with the time field empty,
      // even when he said the hour out loud in the same breath. Reading it off
      // his own words is the same move parseDuration already makes for snooze,
      // and it is the difference between one exchange and two: on 14.08.2026
      // "בוא נזיז את התזכורת של הבשר ל15:00" was answered with "מתי?".
      //
      // findNamedTime refuses anything it cannot be sure of — a repeat rule, a
      // second time in the sentence, an hour already gone — so the question
      // below is still asked whenever asking is the honest answer.
      const named = findNamedTime(userText, Date.now(), tz);
      const schedule =
        scheduleFromIntent(intent, tz) ??
        (named === null ? null : ({ type: 'once', at: wallString(named, tz) } as Schedule));

      // Carries the reminder, unlike the `nothing: 'no_time'` this replaced.
      // The bot is about to ask "מתי?" and it has to still know what it asked
      // about when the answer arrives — see db.setAwaiting.
      if (!schedule) return [{ kind: 'needs_time', id: rem.id, title: rem.title }];

      let next: number | null;
      try {
        next = computeNext(schedule, tz, Date.now());
      } catch {
        return [{ kind: 'nothing', why: 'bad_time', userText }];
      }
      if (next === null) return [{ kind: 'nothing', why: 'past_time', userText }];

      // Captured BEFORE the write, which flips the row to 'scheduled'.
      const wasInbox = rem.status === 'inbox';

      if (!(await db.retimeReminder(env, rem.id, next, JSON.stringify(schedule)))) {
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }

      // Giving an inbox capture its FIRST hour is not a move, and saying
      // "שיניתי" about it (voice.ts, reminder_retimed) is a claim about a
      // previous time the row never had. reminder_scheduled is deliberately in
      // BOTH claim groups in validate.ts — giving an inbox item its first time
      // is as fairly described as a create as it is as a move — whereas
      // reminder_retimed is in `move` alone, which would let the persona
      // legally escalate it to "הזזתי".
      //
      // The `plan` button already takes this path via scheduleInboxItem. Two
      // routes to one user-visible action have to produce one sentence.
      if (wasInbox) {
        return [{ kind: 'reminder_scheduled', id: rem.id, title: rem.title, at: next }];
      }
      return [{ kind: 'reminder_retimed', id: rem.id, title: rem.title, at: next }];
    }

    case 'rename': {
      const rem = await resolveReminder(env, chatId, ctx, intent);
      if (!rem) {
        if (ctx.reminders.length > 1) {
          return [{ kind: 'needs_reminder_choice', action: 'rename', rows: ctx.reminders }];
        }
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }

      const to = intent.title?.trim().slice(0, 120);
      // Nothing to rename it to, and renaming it to what it already says would
      // report a change that did not happen.
      if (!to || to === rem.title) return [{ kind: 'nothing', why: 'unknown_reminder', userText }];

      if (!(await db.renameReminder(env, rem.id, to))) {
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }
      return [{ kind: 'reminder_renamed', id: rem.id, from: rem.title, to }];
    }

    case 'remember': {
      const note = (intent.note ?? intent.title ?? userText).trim();
      if (!note) return [{ kind: 'nothing', why: 'chat', userText }];
      const id = await db.addProfileNote(env, chatId, note);
      // Already on file. Nothing was written, so this must not be reported as
      // if something had been — hence a separate effect kind outside WROTE
      // rather than a `profile_noted` with a flag on it.
      if (id === null) return [{ kind: 'profile_known', note: note.slice(0, db.PROFILE_NOTE_MAX) }];
      return [{ kind: 'profile_noted', id, note: note.slice(0, db.PROFILE_NOTE_MAX) }];
    }

    case 'forget': {
      const notes = await db.listProfileNotes(env, chatId);
      const wanted = (intent.note ?? intent.title ?? '').trim();
      const hit =
        notes.find((n) => n.id === intent.target_id) ??
        (wanted
          ? notes.find(
              (n) => n.note.includes(wanted) || wanted.includes(n.note),
            )
          : undefined);
      if (!hit || !(await db.deleteProfileNote(env, chatId, hit.id))) {
        return [{ kind: 'nothing', why: 'unknown_note', userText }];
      }
      return [{ kind: 'profile_forgotten', note: hit.note }];
    }

    case 'create_goal': {
      if (!intent.title) return [{ kind: 'nothing', why: 'unknown_goal', userText }];
      // `note` now, because `why` was removed from the router schema — see the
      // long note there. `intent.why` is still read as a fallback so a response
      // already in flight during the deploy keeps its reason rather than
      // silently losing it; nothing new can produce one.
      const reason = intent.note?.trim() || intent.why?.trim() || null;
      const id = await db.addGoal(env, chatId, intent.title, reason);
      return [{ kind: 'goal_created', id, title: intent.title, why: reason }];
    }

    case 'goal_progress': {
      const goal = ctx.goals.find((g) => g.id === intent.goal_id);
      if (!goal) return [{ kind: 'nothing', why: 'unknown_goal', userText }];
      const note = (intent.reason ?? userText).slice(0, 400);
      await db.recordGoalProgress(env, goal.id, note);
      return [
        { kind: 'goal_progress', id: goal.id, title: goal.title, note, previous: goal.last_progress },
      ];
    }

    case 'complete_goal':
    case 'drop_goal': {
      const status = intent.action === 'complete_goal' ? 'done' : 'dropped';
      const goal = ctx.goals.find((g) => g.id === intent.goal_id);
      if (!goal || !(await db.setGoalStatus(env, chatId, goal.id, status))) {
        return [{ kind: 'nothing', why: 'unknown_goal', userText }];
      }
      return [{ kind: 'goal_closed', id: goal.id, title: goal.title, status }];
    }

    case 'set_checkins': {
      const enabled = intent.checkins_enabled ?? true;
      await db.setCheckins(env, chatId, enabled, intent.checkin_per_day);
      return [{ kind: 'checkins_set', enabled, perDay: intent.checkin_per_day ?? null }];
    }

    case 'chill': {
      const hours = Math.min(72, Math.max(1, intent.chill_hours ?? 4));
      const until = Date.now() + hours * 3_600_000;
      await db.setMuted(env, chatId, until);
      return [{ kind: 'muted', until, hours }];
    }

    case 'set_intensity': {
      const level = Math.min(3, Math.max(1, intent.intensity ?? 2));
      await db.setIntensity(env, chatId, level);
      return [{ kind: 'intensity_set', level }];
    }

    case 'chat':
    default:
      return [{ kind: 'nothing', why: 'chat', userText }];
  }
}
