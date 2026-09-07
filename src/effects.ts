import * as db from './db';
import type { Context } from './brain';
import type { Effect, Env, Intent, Reminder, ReminderItem, Schedule } from './types';
import type { Friend } from './db';
import { UNTITLED_TITLE } from './types';
import { computeNext, localDateKey, localDayBounds, wallParts, wallString, wallToUtc } from './time';
import { asksForNewReminder, findFutureInstant, isBareTimeWord, parseDuration } from './quickparse';
import { readWhen, type TimeRef } from './when';
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
  //
  // Except that ל also glues onto a day: "להיום" passes that test and is not
  // an errand. Production reminder 57, "לקבוע רעמוו נשק במאי, להיום", became
  // two tickable items and the nag went on to name the second one out loud.
  // The time phrase belongs to the SCHEDULE and the router left it in the
  // title; discounting it here means the part count drops to one and nothing
  // is split at all, which is the right outcome — over-splitting is the worse
  // error, and a title with a comma in it is just what he typed.
  //
  // Only the split is refused. The title still reads "…במאי, להיום", because
  // stripping time words out of a title the ROUTER wrote is a different and
  // far riskier job: "לתכנן את היום" is an errand whose subject is the day.
  const verbs = parts.filter((p) => /^ל[א-ת]/.test(p) && !isBareTimeWord(p)).length;
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
/**
 * Characters that structure a DOCUMENT rather than name an errand.
 *
 * A person writing a task in Hebrew does not reach for these; a model spilling
 * its own scratch work does. The set is deliberately small and contains no
 * ordinary punctuation — a comma, a period, a hyphen and a plus are all things
 * he really types ("ללכת לקניות - אדויל, נובימול", "טיפול + טסט") and cutting
 * a title at one of those would lose half an errand he wrote himself.
 */
const FILLER = /[_=~^*|\\/<>[\]{}]/;
/**
 * One underscore or one slash is already a tell; everything else needs a run
 * of two.
 *
 * The slash was added after reminder 71, written 02.09.2026 22:27, whose title
 * is stored as
 *
 *     "ללכת לישון / : ללכת לישון"
 *
 * — the errand, a separator he never typed, and the model's second go at the
 * same phrase. A run of two was required, so a single "/" carried the whole
 * spill straight through and it is now read out every time that reminder
 * fires.
 *
 * Safe to loosen to one because of the guard at the top of titleFromHisWords:
 * if HIS message contains any filler character at all, nothing is cut. A slash
 * he typed — "ב9/9", which readWhen now parses as a date — is his and stays.
 * This can only ever cut one he did not write.
 */
const FILLER_RUN = /[_/]|[=~^*|\\<>[\]{}]{2,}/;

/**
 * A title built from HIS OWN sentence, for when the router supplied none.
 *
 * `titleFromHisWords` below exists on the premise that his words are the safer
 * source — but it was only ever applied to a title the model HAD produced.
 * When the model produced nothing the premise was dropped and the generic
 * fallback went into the database instead. Production, chat B, 03.09.2026:
 * "תזכיר לי מחר לבדוק כמה אתה טיפש" was stored as `#77 "תזכורת"`, and the
 * reply then asked him what it was about.
 *
 * It reads from the first INFINITIVE ל to the end, and that choice is the
 * whole safety of it.
 *
 * The obvious implementation — strip the lead-in, strip a leading time word —
 * was tried and is wrong: "תזכיר לי עוד 5 דקות" becomes the title "עוד 5
 * דקות", a time phrase filed as an errand. Trimming harder does not fix it
 * either, because "עוד שעה לקנות חלב" has the errand AFTER the time and
 * "לתכנן את היום" has a time word inside the errand. There is no prefix rule
 * that separates those three.
 *
 * `splitIntoItems` already answers exactly this question — "is this an errand
 * or is it something else he typed" — with the infinitive ל, and it is the
 * test this codebase already trusts. Taking the sentence from that word
 * onwards drops every lead-in and every time phrase in front of it without
 * needing to recognise any of them, and keeps the ones inside the errand.
 *
 * Conservative by construction: a request with no infinitive at all
 * ("תזכיר לי מחר את הכביסה") returns null and the generic fallback stands,
 * which is exactly today's behaviour. A miss costs a question; a wrong title
 * is read back to him every time it fires.
 */
/**
 * ל-words that are PRONOUNS, not infinitives. "תזכיר לי" is the request itself.
 *
 * A closed list of whole words, for the same reason `isBareTimeWord` is one:
 * there is no shape that separates "לי" from "לימד" or "להם" from "להיכנס", so
 * a prefix rule would eat real errands. This is the same exclusion
 * `addressesSomeoneElse` makes and for the same word.
 */
const L_PRONOUN = /^(?:לי|לך|לו|לה|לנו|לכם|לכן|להם|להן)$/;

export function titleFromMessage(userText: string): string | null {
  /*
   * No `asksForNewReminder` gate here, and its absence is deliberate.
   *
   * It was in the first version, copied from the length guard in
   * titleFromHisWords — and the red-proof showed that deleting it changed
   * nothing, because the infinitive rule below already refuses everything it
   * refused. Worse than dead weight: this only ever runs when the ROUTER has
   * already decided the turn is a create, so the gate could only suppress a
   * good title on a request phrased outside the grammar ("אני צריך ללכת
   * למוסך"), handing back the generic instead of his own words.
   *
   * It would also have been a third caller of a gate CLAUDE.md keeps to two
   * on purpose.
   */
  const s = userText.replace(/\s+/g, ' ').trim();
  // The infinitive marker followed by a real letter — the same shape
  // splitIntoItems counts, and `isBareTimeWord` discounts "להיום" for the same
  // reason it does there: ל also glues onto a day.
  const words = s.split(' ');
  const start = words.findIndex(
    (w) => /^ל[א-ת]/.test(w) && !isBareTimeWord(w) && !L_PRONOUN.test(w),
  );
  if (start < 0) return null;
  const out = words.slice(start).join(' ').trim();
  return out.length >= 3 ? out.slice(0, 120) : null;
}

/**
 * A title the model returned, with anything he never typed taken back out.
 *
 * Two rules, both learned in production, both about the same thing: the router
 * may re-word him but may not put characters in his mouth.
 *
 * **Script.** On 17.08.2026 "תזכיר לאמנון לדבר עם שחר עוד שתי דקות" came back
 * titled "לדבר עם שחרy", then "לדבר עם שחרyil" — hex 79 69 6C, stray Latin on
 * otherwise correct Hebrew, from a message with no Latin in it at all.
 *
 * **Filler.** On 18.08.2026 "...תבדוק מה המצב היום בערב" came back as
 *
 *   תבדוק מה המצב היום בערב//______________18____19_00_____פורש____2026_08_1820_00___
 *
 * — the real title, then a separator, then the model's own scratch: once_at
 * and event_at fragments written as prose. That is the failure mode that
 * killed the `why` field (see brain.ts), relocated into `title` now that `why`
 * is gone from the schema. The script rule could not see it, because
 * underscores and digits are not `[A-Za-z]`.
 *
 * So the spill is CUT rather than filtered: everything from the first filler
 * run onwards goes. Filtering would have left "תבדוק מה המצב היום בערב 18 19
 * 00 פורש 2026 08 1820 00", which is no better a claim about what he asked
 * for. The real title is always in front of the separator, because that is
 * what a separator is.
 *
 * Nothing downstream can do this job. validate.ts compares the REPLY against
 * the EFFECT, so a title corrupted before the effect exists is reported
 * faithfully, quoted back to him, and read out every time it fires. And it can
 * hide for hours: every message that quoted #53 went through speak(), and the
 * persona dropped the junk each time. It surfaced exactly once, on the BUTTON
 * close — the one path that never calls the model.
 *
 * Both rules are narrow in the same direction and for the same reason. Only
 * what is ABSENT from his message is removed, so "תזכיר לי לשלוח email" keeps
 * its email and "לשלם ביט // מזומן" keeps its slashes. Rewording is the
 * router's job and survives untouched; dropping "תזכיר לאמנון" from the front
 * is exactly right. Deliberately NOT a length bound: "כן" confirming an offer
 * is a real production shape, and a two-character message is not licence to
 * cut the title it confirms.
 */
/**
 * A title that says the errand, and then says it again.
 *
 * Three production spills, three different punctuation shapes, one identical
 * structure:
 *
 *   #13  "ללכת למוסךTrimmed to: ללכת למוסך והוא לא אמר משהו אחר. ללכת למוסך…"
 *   #71  "ללכת לישון / : ללכת לישון"
 *   #72  "לבדוק משימות חדשות - (, : 'לבדוק משימות חדשות') -> "לבדוק משימות…"
 *
 * Each was answered by adding another character to FILLER_RUN, and each time
 * the next one arrived wearing different punctuation. issues.md §3 says why
 * that can never converge: the model needs somewhere to deliberate, `title` is
 * the field within reach, and the separator it happens to use is not the
 * pattern. **Repeating the errand is.**
 *
 * So this looks for structure instead of characters: the leading run of real
 * words, appearing again later in the same string. No errand says its own
 * opening clause twice.
 *
 * Two guards keep it off real titles. The prefix must be substantial (a short
 * one like "לקנות" recurs innocently in "לקנות חלב, לקנות לחם"), and if HIS
 * message contains the repetition too then the repetition is his and stays.
 *
 * This is still a mop. The fix is the discriminated union in Stage 4, which
 * removes the field the deliberation lands in.
 */
const REPEAT_MIN_CHARS = 10;

function cutSelfRepeat(title: string, userText: string): string {
  // The errand as stated up to the first structural punctuation — that is the
  // part a spill copies.
  const head = /^[^,;.:()[\]{}'"<>|/\\_=~^*-]+/.exec(title)?.[0].trim() ?? '';
  if (head.length < REPEAT_MIN_CHARS) return title;

  const rest = title.slice(title.indexOf(head) + head.length);
  if (!rest.includes(head)) return title;

  // He said it twice himself. Then it is his phrasing, not a spill.
  const his = userText.split(head).length - 1;
  if (his >= 2) return title;

  return head;
}

/**
 * Anything that is not Hebrew, Latin, a digit, punctuation or whitespace.
 *
 * Not `/u` on a per-character test by accident: the flag is what makes
 * `\p{...}` mean anything at all, and without it this is a character class of
 * literal letters p, L, S and braces. Deliberately NOT global — a `/g` regex
 * carries `lastIndex` across `.test()` calls and would skip every other
 * character, which is the trap CLAUDE.md already records for CLOCK and QUOTED.
 */
const FOREIGN_SCRIPT = /[^\p{Script=Hebrew}\p{Script=Latin}\p{N}\p{P}\p{Z}\s]/u;

/**
 * The addressee, read from HIS sentence — but only when the router named none.
 *
 * This is `preferHisWords` for people instead of for clocks, and it exists for
 * the same reason: code computed the right answer and the model's answer won
 * anyway.
 *
 * Production, 07.09.2026 19:21, with the address book CORRECT and every earlier
 * friends fix in place:
 *
 *   him  תזכיר לאמנון עוד שתי דקות "לשלוח לשחר שעבד"
 *   bot  קבעתי #83: "לשלוח לשחר שעבדೊ" — פעם אחת ב-07.09 בשעה 19:23.
 *
 * `reminders` #83 landed with `chat_id` = HIS and `from_chat_id` = NULL. The
 * router simply did not emit `for_friend`, `applyIntent` read that field and
 * nothing else, and the row went to him — with a confirmation that was true
 * about everything except who it was for.
 *
 * The router prompt spends five lines on that field and includes the sentence
 * "אסור לך להשמיט for_friend... זה הכי גרוע". The prompt names this exact
 * failure as the worst one available, and there was no code behind it. A rule
 * that matters lives in code; this is that rule finally living here.
 *
 * **It FILLS a gap and never overrides.** Same exclusion discipline as
 * `preferHisWords`: if the router named somebody, that is classification and
 * it wins, even when this disagrees.
 *
 * Three deliberate narrownesses, each of which cost something to learn:
 *
 * - **Anchored to the addressee position**, not to the message. The obvious
 *   implementation reuses `namesSomeoneElse`, which is right there and already
 *   returns true for the production text. It also returns true for
 *   "תזכיר לי לקנות מתנה לדנה", because it matches the name ANYWHERE and is
 *   documented as over-refusing on purpose. Wiring that to a write would file
 *   his own errand in her chat — the same failure this area exists to prevent,
 *   reached from the other side. So the name has to sit immediately after the
 *   verb.
 * - **Anchored to the ADDRESS BOOK**, which is what makes the bare form safe.
 *   "תזכיר אמנון לשלוח הודעה" (no ל — how he typed the second one, which
 *   neither existing gate sees) can only match because "אמנון" is an accepted
 *   nickname; "תזכיר לקנות חלב" cannot match anything, because "לקנות" is not
 *   a person he has agreed to write reminders for.
 * - **It returns the BOOK's spelling, and decides nothing.** The name goes to
 *   `matchFriend`, which is exact and returns null on a tie, because sending to
 *   the wrong friend is a message in a stranger's chat he cannot see to
 *   correct. This function widens who gets ASKED about; it does not widen who
 *   can be written to.
 *
 * The residual gap, named rather than papered over: a nickname that is also an
 * ordinary vocative ("אחי") makes "תזכיר אחי לקנות חלב" ambiguous between an
 * addressee and "remind me, mate". The ל form is unambiguous; the bare form is
 * a judgement, and it is made in favour of the addressee because that is the
 * reading that matches the words in the order he typed them.
 */
export function friendFromHisWords(userText: string, friends: Friend[]): string | null {
  for (const f of friends) {
    const n = (f.nickname ?? '').trim();
    if (n.length < 2) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Built by concatenation, not as a template literal — an unrecognised
    // escape in a template literal loses its backslash and `\s` reads as a
    // plain "s", which is how namesSomeoneElse once compiled to a regex that
    // matched nothing at all.
    const re = new RegExp(
      '(?:^|\\s)(?:תזכיר|תזכירי|תזכירו|הזכר|הזכירי)\\s+ל?' + esc + '(?![א-ת])',
    );
    if (re.test(userText)) return n;
  }
  return null;
}

/**
 * Drop the addressing from a title once we know who it was addressed to.
 *
 * #84, the same evening: "תזכיר אמנון לשלוח הודעה ב19:25" was stored with the
 * whole command as its title, so the errand she would have been shown at 19:25
 * was an instruction aimed at somebody else. The router produces this — it is
 * echoing his sentence, which `titleFromHisWords` correctly allows, since the
 * title never grows and every letter is his.
 *
 * Only a LEADING match is cut, and only the addressing itself. "תזכיר לדנה
 * לקנות מתנה לדנה" keeps the second one, because that is the errand.
 */
export function stripAddressee(title: string, nickname: string): string {
  const esc = nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '^\\s*(?:תזכיר|תזכירי|תזכירו|הזכר|הזכירי)?\\s*ל?' + esc + '(?![א-ת])[\\s,:-]*',
  );
  const out = title.replace(re, '').trim();
  // Never returns empty: a title that was ONLY the addressing tells her
  // nothing, but so does an empty one, and the caller's UNTITLED_TITLE path
  // is wired to ask HIM rather than to guess.
  return out || title;
}

export function titleFromHisWords(title: string, userText: string): string {
  // Nothing to compare against: button and cron paths have no message.
  if (!userText.trim()) return title;


  let out = cutSelfRepeat(title, userText);
  // Filler first. It cuts a TAIL, so running it before the script filter keeps
  // the two independent — otherwise stripping Latin out of the spill could
  // erase the very run this needs to find.
  if (!FILLER.test(userText)) {
    const spill = FILLER_RUN.exec(out);
    if (spill) out = out.slice(0, spill.index);
  }
  /*
   * A script he never wrote in is not a rewording of what he said.
   *
   * Latin is CONDITIONAL, because he uses it: reminder #81 is
   * "לסיים את התרגומים ולפתוח pr" and the "pr" is his. So it is cut only when
   * his message has none.
   *
   * Everything else is an ALLOW-list, and that is the fix. This used to be the
   * Latin test alone, while CLAUDE.md claimed "any SCRIPT absent from his
   * message is stripped" — a guarantee the code did not provide. Reminder #83,
   * 07.09.2026: the stored title is "לשלוח לשחר שעבדೊ", ending in U+0CCA,
   * KANNADA VOWEL SIGN OO. It has no Latin, so the old test could not see it;
   * it does not repeat, so cutSelfRepeat could not; it is shorter than his
   * message, so "extraction cannot grow" could not. He was then read it back
   * twice, once when it was set and once when it fired.
   *
   * An allow-list rather than a longer block-list of scripts, deliberately.
   * A block-list here has exactly the shape of FILLER_RUN's character classes,
   * and issues.md §3 already argued that class of guard out: four shapes in
   * four days, four mops, none of them the fix. There are ~160 scripts and the
   * model can reach all of them; there are two this bot writes in.
   *
   * Anything he LITERALLY typed passes regardless — an emoji in his own
   * message is his, and stripping it would be the over-correction.
   */
  if (!/[A-Za-z]/.test(userText)) out = out.replace(/[A-Za-z]+/g, '');
  if (FOREIGN_SCRIPT.test(out)) {
    const his = new Set([...userText]);
    out = [...out].filter((c) => !FOREIGN_SCRIPT.test(c) || his.has(c)).join('');
  }
  /*
   * Extraction cannot grow.
   *
   * The router's job is to lift the errand OUT of his sentence — CLAUDE.md is
   * explicit that dropping "תזכיר לאמנון" from the front is exactly right and
   * that adding letters is not. So a title longer than the message it came
   * from did not come from it, whatever it is made of.
   *
   * This is the guard that does not care about characters, and it exists
   * because three that did could not keep up. Reminder #75, 03.09.2026 17:07:
   * he typed sixteen characters, "תזכיר לי עוד שעה", and the stored title is
   * 187 — the model thinking aloud about what the title should be, in fluent
   * Hebrew with no punctuation and no repetition. It walked past the script
   * filter, the filler cut and cutSelfRepeat in one go. It was the fourth
   * distinct shape in four days; issues.md §3 predicted that adding a fourth
   * character class would not converge either.
   *
   * Emptied rather than truncated, deliberately: half a deliberation is still
   * not an errand. The caller's fallback is UNTITLED_TITLE, and voice.ts words
   * that case properly — "קבעתי לך משהו ל-09:12. על מה להזכיר?" — with
   * questionAsked arming the slot, so the bot asks him instead of storing
   * something he never said and reading it back when it fires.
   *
   * Gated on `asksForNewReminder`, which is the whole reason this is safe. The
   * rule only holds when the errand is IN the message being read, and there is
   * one common shape where it is not: a bare confirmation. The router prompt
   * tells the model that "כן" means "repeat the action you just offered,
   * with all of its details" — so a two-character message legitimately yields
   * a twenty-character title, pulled from the previous turn rather than from
   * this one. Length says nothing there, and this must not judge it.
   *
   * Reusing that gate rather than inventing a length floor is the point.
   * CLAUDE.md records asksForNewReminder having to be fixed twice because two
   * places asked the same question two ways; a third implementation of "did he
   * ask for a reminder here" would be the same mistake again.
   */
  if (asksForNewReminder(userText) && out.trim().length > userText.trim().length) return '';

  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * His own words beat the model's arithmetic.
 *
 * This is the precedence flip Stage 1 exists for, and it is the whole of
 * "code computes, the model classifies" expressed in four lines.
 *
 * `scheduleFromIntent` already refuses to let the model add five minutes to a
 * wall clock — "asking an LLM to cross midnight/month/year boundaries
 * correctly is a coin flip; Date does it for free" — and then hands it
 * `once_at` and asks for exactly that arithmetic anyway. On 01.09.2026 it took
 * the flip and lost: "תזכיר לי עוד יומיים ב16:30", typed at 00:07, became a
 * reminder for **01.09** — the same day — and cost four more messages, two
 * route/apply crashes and a full day of nagging about a task that was not due.
 *
 * Reading it off his sentence first is not a heuristic beating a model. It is
 * the deterministic path being allowed to answer the question it can actually
 * answer, and `readWhen` refuses rather than guesses on everything else, so
 * every doubt still falls through to the router exactly as before.
 *
 * The scope is narrow, and every exclusion below is a real message that broke
 * when it was not. What gets overridden is exactly one thing: **an absolute
 * date the model calculated.** That is the only place it is doing arithmetic.
 *
 *   - `in_minutes` is NEVER overridden. The model is not computing there — it
 *     reports a number of minutes and `scheduleFromIntent` resolves it with
 *     Date, which is the bargain this whole function generalises. Overriding
 *     it turned "ללכת למוסך ב8:20", typed AT 08:20, into a reminder for
 *     tomorrow: the router correctly said `in_minutes: 1`, and readWhen read
 *     the "ב8:20" literally, found it was not in the future, and rolled it a
 *     day. Both readings are defensible; the router's is right.
 *
 *   - `event_at` present means the model has told us there are TWO times here
 *     and which is which — "קבעתי טיפול ליום שלישי ב-8:30, תזכיר לי בשני
 *     בערב". That is classification, not arithmetic, and it is precisely the
 *     work we want it doing. readWhen sees one clock and cannot know it is the
 *     appointment rather than the ring.
 *
 *   - a RECURRING schedule is never overridden. readWhen refuses anything
 *     RECURRING matches, so this should be unreachable — but flattening a
 *     repeat rule into one date ENDS the recurrence, which is the trap the
 *     retime button was fixed for, and a guard that costs nothing belongs in
 *     front of it.
 *
 *   - a `duration` from readWhen never OVERRIDES anything, for the same reason
 *     as the first exclusion: nobody is doing arithmetic.
 *
 *     But when the router produced no time at all there is nothing to
 *     override, and refusing to read one is not caution — it is throwing away
 *     an hour he said out loud. Production, 03.09.2026 17:07: "תזכיר לי עוד
 *     שעה" became an inbox capture and the reply asked "באיזו שעה בדיוק?"
 *     about the only thing in the sentence that WAS specific. readWhen had
 *     returned {kind:'duration',minutes:60} the whole time; this line is the
 *     only thing that was missing.
 */
function preferHisWords(heard: TimeRef, intent: Intent, tz: string): Schedule | null {
  const routed = scheduleFromIntent(intent, tz);
  // FILLING a gap, never overriding: `routed` wins whenever it exists, which
  // keeps the in_minutes exclusion above exactly as strict as it was.
  if (heard.kind === 'duration') {
    return routed ?? { type: 'once', at: wallString(Date.now() + heard.minutes * 60_000, tz) };
  }
  if (heard.kind !== 'instant') return routed;
  // The model calculated a wall-clock date, which is the one thing it should
  // never have been asked to do. Anything else it produced, it produced
  // honestly, and his sentence is not a better source than the router for it.
  const modelDidArithmetic = !intent.in_minutes && !!intent.once_at;
  const mayOverride = !intent.event_at && (routed === null || modelDidArithmetic);
  if (!mayOverride) return routed;
  return { type: 'once', at: wallString(heard.at, tz) };
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

const WEEKDAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * "הבוקר" · "מחר בבוקר" · "ביום חמישי בבוקר".
 *
 * This used to be a two-way choice — today, or the literal word "מחר" for
 * everything else — so four things on a Thursday morning next week were
 * announced as "מחר בבוקר". A wrong claim about WHEN, inside the one message
 * whose entire value is that he can go and check it in two taps. Being off by
 * a day about something checkable reads as the bot being broken, which is
 * exactly what CROWDED_AT's own comment says about being off by one.
 *
 * The label carries its own preposition rather than having "ב" glued on by the
 * caller. "הבוקר" needs none ("זה 4 דברים הבוקר"), and the other two bring
 * their own — the old version produced "בהבוקר", which is not Hebrew.
 */
function dayPartLabel(at: number, part: string, tz: string): string {
  const today = localDateKey(Date.now(), tz);
  if (localDateKey(at, tz) === today) return `ה${part}`;
  if (localDateKey(at, tz) === localDateKey(Date.now() + 86_400_000, tz)) return `מחר ב${part}`;
  return `ביום ${WEEKDAY_NAMES[wallParts(at, tz).dow]} ב${part}`;
}

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
    return [{ kind: 'window_crowded', count: rows.length, label: dayPartLabel(at, part[2], tz) }];
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
export async function patternFor(
  env: Env,
  chatId: string,
  ctx: Context,
  reminderId: number,
  title: string,
  /**
   * An abandonment that is committing in this very turn.
   *
   * `behaviourOf` counts rows in `events`, and the row for what is happening
   * right now is written by `sendOutcome` — which runs AFTER this decision is
   * made. Without this the in-flight event is invisible and FAILURE_FLOOR
   * silently becomes one higher than patterns.ts says it is. The instance is
   * already closed by the time this is called, so counting it is a statement
   * about a write that has happened, not a prediction.
   *
   * Was a bare `alsoFailed` boolean until 0.20.0, when the skip path started
   * asking too and needed the same thing for a different row. A second boolean
   * would have been two flags that must never both be true; naming the event
   * makes that unrepresentable.
   */
  pending?: 'failed' | 'skipped',
): Promise<Effect[]> {
  try {
    const now = Date.now();
    if (await db.patternOfferedSince(env, chatId, reminderId, now - PATTERN_COOLDOWN_MS)) return [];

    const counted = await db.behaviourOf(env, chatId, reminderId, ctx.settings.tz, now - PATTERN_WINDOW_MS);
    const b =
      pending === 'failed'
        ? { ...counted, fires: counted.fires + 1, failures: counted.failures + 1 }
        : pending === 'skipped'
          // Only the skip. Unlike the give-up above, a skip's `צלצלה` row is
          // already in the table — it was written when the thing rang, and the
          // tap is a separate, later event.
          ? { ...counted, skips: counted.skips + 1 }
          : counted;
    const p = detectPattern(b);
    if (!p) return [];

    if (p.kind === 'failing') {
      return [{ kind: 'pattern_failing', id: reminderId, title, dropped: p.dropped, fires: p.fires }];
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
      // His own sentence sits between the model's title and the generic
      // fallback: the router returning nothing is not a reason to throw away
      // the errand he typed. See titleFromMessage.
      const title =
        titleFromHisWords(intent.title?.trim() ?? '', userText) ||
        titleFromMessage(userText) ||
        UNTITLED_TITLE;

      // "תזכיר לדנה..." — a row in somebody else's account. Handled before
      // anything else in this branch, because almost nothing below it applies:
      // the duplicate check, the inbox capture and the item split are all
      // about HIS chat, and running them against hers would be answering a
      // question nobody asked.
      //
      // The `??` is the whole of 0.30.0. Until then this read `intent.for_friend`
      // and nothing else, so a router that omitted the field wrote the row to
      // HIM — see friendFromHisWords for the production turn and why a prompt
      // rule was never going to hold this.
      const addressee =
        intent.for_friend?.trim() || friendFromHisWords(userText, ctx.friends ?? []);
      if (addressee) {
        return friendReminder(
          env,
          chatId,
          ctx,
          { ...intent, for_friend: addressee },
          stripAddressee(title, addressee),
          userText,
        );
      }

      /*
       * A bare relative push while something is RINGING is a snooze.
       *
       * CLAUDE.md states this as a rule and `applyIntent` enforces it
       * deterministically rather than trusting the prompt — but only on the
       * `reschedule` path, and the router does not always route it there.
       * Production, 03.09.2026 17:07, with #69 fired at 16:30 and nagged at
       * 17:00: "תזכיר לי עוד שעה" came back as `create_reminder`, was captured
       * without a time, and the bot answered "סגרנו על #75. אבל על מה להזכיר
       * לך ובאיזו שעה בדיוק?" — a second row, a question, and #69 still
       * ringing underneath the whole exchange.
       *
       * Three conditions, and each one is what keeps this from over-reaching:
       *
       *  - he named NO errand. "תזכיר לי עוד שעה לקנות חלב" is a second
       *    errand, and folding it into a snooze would lose it outright. This
       *    is the same discriminator the ringing branch of `reschedule` does
       *    not need, because a reschedule already names its target.
       *  - EXACTLY one thing is ringing. Two, and there is no way to tell
       *    which he meant — same answer as matchItem's null-on-tie: pushing
       *    the wrong ring leaves the other one nagging and reports it handled.
       *  - the time is RELATIVE. An absolute hour on an untitled message is
       *    not a deferral of anything in particular.
       */
      const pushed =
        intent.in_minutes && intent.in_minutes > 0
          ? intent.in_minutes
          : (() => {
              const d = readWhen(userText, Date.now(), tz);
              return d.kind === 'duration' ? d.minutes : null;
            })();
      if (title === UNTITLED_TITLE && ctx.open.length === 1 && pushed !== null && pushed > 0) {
        const inst = ctx.open[0];
        const minutes = Math.min(720, Math.max(5, pushed));
        await db.snoozeInstance(env, inst.id, minutes);
        const snoozed: Effect[] = [
          {
            kind: 'instance_snoozed', id: inst.id, title: inst.title,
            until: Date.now() + minutes * 60_000, minutes,
          },
        ];
        // Same as every other push: the moment he defers it again is the
        // moment the question about the hour makes sense.
        snoozed.push(...(await patternFor(env, chatId, ctx, inst.reminder_id, inst.title)));
        return snoozed;
      }

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
      // One resolver now, and it absorbs the "third look" this used to make
      // separately: a pinned DAY plus a named part of it ("מחר בערב" is 20:00)
      // lives inside readWhen alongside every other reading, so the create and
      // reschedule paths cannot disagree about it again.
      const heard = readWhen(userText, Date.now(), tz);
      const schedule = preferHisWords(heard, intent, tz);

      // No time is not a failure any more. Capture first, schedule later.
      if (!schedule) {
        const id = await db.addInboxItem(env, chatId, title, tz);
        // He named a day and no hour: say so, and ask only for the half that
        // is actually missing. See readWhen's 'no-hour' arm.
        const dayHint =
          heard.kind === 'ambiguous' && heard.why === 'no-hour' ? heard.seen[0] : undefined;
        return [{ kind: 'reminder_captured', id, title, ...(dayHint ? { dayHint } : {}) }];
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
      /*
       * The router is asked for `snooze_minutes` but routinely omits it, and
       * the fallback was then reported back to him as a number he chose —
       * "עוד שעה" came out as "הזזתי ב-30 דקות" on 10.08.2026. The write is
       * real either way, so validate.ts cannot see this: the lie is upstream
       * of the model. parseDuration reads the length off his own words before
       * anything gets to speak for him.
       *
       * And when neither of them has a length, the bot ASKS. The hardcoded 30
       * that used to sit here is the same failure one step further along:
       * "לא יקרה היום, בוא ננסה שוב מחר" produced "דחיתי … ב-30 דקות" — a
       * deferral to tomorrow answered with half an hour, stated as though he
       * had asked for it. parseDuration closed the "עוד שעה" case; nothing can
       * close the "מחר" case by guessing, because the guess IS the bug.
       *
       * needs_time rather than a snooze-shaped question: the awaiting slot it
       * opens is already wired to route his answer back through `reschedule`,
       * which supersedes the ring correctly (CLAUDE.md, "Moving a reminder
       * that is ringing"). A second question kind would be a second
       * implementation of one question — §13's invariant.
       */
      const said = intent.snooze_minutes ?? parseDuration(userText);
      if (said === null || said === undefined) {
        return [{ kind: 'needs_time', id: inst.reminder_id, title: inst.title }];
      }
      const minutes = Math.min(720, Math.max(5, said));
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

      /*
       * Is this reminder RINGING right now?
       *
       * brain.ts tells the router that a task which has already rung takes
       * `snooze` and one still waiting takes `reschedule`. On 23.08.2026 it
       * returned `reschedule` for "עוד חצי שעה", said thirty seconds after
       * "נו? ללכת למוסך" went out, and the two branches below are what that
       * cost. A prompt rule is a request; this is the deterministic half.
       */
      const ringing = ctx.open.find((i) => i.reminder_id === rem.id) ?? null;

      /*
       * A RELATIVE push on something that is ringing is a snooze, whatever the
       * router called it.
       *
       * "עוד חצי שעה" means "not now, later" — it is about this ring, not
       * about the rule. Taking it as a reschedule flattens the rule into the
       * offset: scheduleFromIntent turns in_minutes into `{type:'once'}`, so
       * pushing a DAILY reminder half an hour would end the recurrence
       * outright. That is the same trap findNamedTime refuses to walk into
       * when it sees a repeat rule, and it has to be refused here too.
       *
       * Only the relative form is redirected. "תעביר את זה ל-9" while it rings
       * is an absolute retime and stays one — it falls through to the branch
       * below, which closes the ring it supersedes.
       */
      if (ringing) {
        const pushed = intent.in_minutes && intent.in_minutes > 0
          ? intent.in_minutes
          : scheduleFromIntent(intent, tz) === null ? parseDuration(userText) : null;
        if (pushed !== null && pushed > 0) {
          const minutes = Math.min(720, Math.max(5, pushed));
          await db.snoozeInstance(env, ringing.id, minutes);
          const snoozed: Effect[] = [
            {
              kind: 'instance_snoozed',
              id: ringing.id,
              title: ringing.title,
              until: Date.now() + minutes * 60_000,
              minutes,
            },
          ];
          // Same as the `snooze` branch: the moment he pushes it for the sixth
          // time is the moment the question about the hour makes sense.
          snoozed.push(...(await patternFor(env, chatId, ctx, ringing.reminder_id, ringing.title)));
          return snoozed;
        }
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
      const schedule = preferHisWords(readWhen(userText, Date.now(), tz), intent, tz);

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

      /*
       * He asked for the hour it already has.
       *
       * `rename` has guarded `to === rem.title` since it shipped and this had
       * no equivalent, so retimeReminder's UPDATE matched the row, changed
       * nothing, and still returned true (`changes` counts rows MATCHED, not
       * rows altered) — and the turn reported "שיניתי" and wrote a `הוזזה`
       * line into events for a move that did not happen. `events` is the life
       * story of a reminder and the thing /why prints; a false line in it is
       * not cosmetic.
       *
       * Both halves have to match. `next` alone is not enough: turning a daily
       * into a one-off at the same instant IS a change, and the next day is
       * when he would find out.
       */
      if (next === rem.next_fire_at && JSON.stringify(schedule) === rem.schedule) {
        return [{ kind: 'reminder_unchanged', id: rem.id, title: rem.title, at: next }];
      }

      // Captured BEFORE the write, which flips the row to 'scheduled'.
      const wasInbox = rem.status === 'inbox';

      if (!(await db.retimeReminder(env, rem.id, next, JSON.stringify(schedule)))) {
        return [{ kind: 'nothing', why: 'unknown_reminder', userText }];
      }

      /*
       * Moving a reminder that is ringing SUPERSEDES the ring.
       *
       * Without this the instance is orphaned: retimeReminder puts the row
       * back to `scheduled`, the cron fires it again at the new time, and a
       * second instance opens alongside the first. Production, 23.08.2026 —
       * reminder 61 rang at 08:30, was moved to 09:00, and at 09:00:42 opened
       * instance 41 while instance 39 was still open and still on its nag
       * ladder. He got a fresh fire and a nag for the old ring three seconds
       * apart, then closed both: "רצף 27" and "רצף 28" for one trip.
       *
       * `skipped`, never `done` or `failed`. He did not do it and he did not
       * flake — he moved it, and db.stats counts only done/failed, so this
       * cannot pay him a streak point for an errand he has not run yet.
       *
       * Best-effort: the reminder really has been retimed either way, and a
       * failure to tidy the old ring must not turn a successful move into a
       * reported failure.
       */
      /*
       * `superseded`, not `skipped`, since 0.21.0 — and it EMITS.
       *
       * The status was the same word he gets for tapping "לא היום", and
       * `missStreak` counts every skipped row as a miss on the reasoning that
       * a decline and a give-up are the same fact from outside. Moving it is
       * not: #69's two superseded rings plus one real decline put that counter
       * at MISS_THRESHOLD, so the next fire would have told him "3 פעמים
       * ברצף שזה לא קורה… אולי זה לא באמת חשוב לך" over two retimes he made
       * himself. See migrations/019.
       *
       * And the close is reported, because effects are the write log: this ran
       * as a bare db call for five versions, so it produced no `events` row and
       * no `/why` line, and instances 53 and 54 of #69 read from the history
       * like rings that simply never closed.
       */
      const superseded: Effect[] = [];
      if (ringing) {
        // Best-effort still: the reminder really has been retimed either way,
        // and failing to tidy the old ring must not turn a successful move
        // into a reported failure. The effect is pushed only if the write
        // actually happened — a claim is not allowed to outrun its row.
        try {
          await db.closeInstance(env, ringing.id, 'superseded');
          superseded.push({
            kind: 'instance_superseded', id: ringing.id, title: ringing.title,
          });
        } catch (e) {
          console.error('closing the ring a retime superseded', e);
        }
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
        // The errands, at the moment the row becomes a real reminder.
        //
        // splitIntoItems ran in create_reminder and nowhere else, so the same
        // sentence got three tickable errands when he named an hour and none
        // at all when he did not — because without an hour it is captured, and
        // the hour arrives later through here. Whether he happened to say the
        // time in the same breath decided whether he could tick them off one
        // at a time.
        //
        // Only on the inbox→scheduled transition, never on an ordinary retime:
        // a reminder that already exists may have had its items ticked, and
        // re-splitting would silently un-tick them. Best-effort for the same
        // reason it is in create_reminder — the reminder is real either way,
        // and the checklist is additional structure on top of it.
        const itemTitles = splitIntoItems(rem.title);
        if (itemTitles.length) {
          await db.addItems(env, rem.id, chatId, itemTitles).catch((e) =>
            console.error('addItems on promotion', e),
          );
        }
        // An inbox capture has no ringing instance by construction — it has
        // never fired — so `superseded` is empty here. Spread anyway rather
        // than relying on that: the day it stops being true, this arm should
        // report the close like the other one does.
        return [...superseded, { kind: 'reminder_scheduled', id: rem.id, title: rem.title, at: next }];
      }
      // The move first, the tidy-up after: he asked for the move, and the
      // closed ring is a consequence of it.
      return [
        { kind: 'reminder_retimed', id: rem.id, title: rem.title, at: next },
        ...superseded,
      ];
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
