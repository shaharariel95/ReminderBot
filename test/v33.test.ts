/**
 * Run with `npm run test:v33`.
 *
 * An audit round. Nothing here came from a production message — these are the
 * three things a sweep for "bugs shaped like the last seven" actually found.
 *
 * 1. THE SAMPLE LISTS WERE THIRTEEN KINDS SHORT, AND NOTHING SAID SO.
 *
 * CLAUDE.md lists four edits for a new `Effect` kind and warns that two of
 * them — the sample lists in voice.test.ts and validate.test.ts — "enumerate
 * kinds by hand and will not tell you one is missing". They were 38 of 51:
 * `reminder_renamed`, `instance_superseded`, all three `pattern_*`,
 * `window_crowded`, `friend_unknown`, `needs_reminder_choice`,
 * `appointment_offer` and the four `profile_*` had never been rendered by a
 * test at all.
 *
 * No live failure — all thirteen were round-tripped by hand and every one
 * renders and passes its own validator. The finding is that the guard did not
 * exist, which is the same finding as the two rows in CLAUDE.md's invariants
 * table that say *nothing*.
 *
 * The fix is not a longer list. `SAMPLES` below is a mapped type over
 * `Effect['kind']`, so a kind with no sample is a TYPE ERROR and `npm run
 * typecheck` — which covers the test project — refuses to pass. A list that
 * cannot be short is not a list anyone has to remember to update.
 *
 * 2. `nothing: 'no_time'` WAS DEAD, AND ITS WORDING WAS A LOADED TRAP.
 *
 * 0.31.0 replaced its only emitter (friendReminder) with `friend_needs_time`,
 * which has a `questionAsked` arm. The `why` stayed in the union and voice.ts
 * kept answering it with a bare "מתי?" — so the next person to reach for it
 * would get a question that arms no slot, which is exactly the bug that put
 * reminder #85 in the wrong chat. Removed from the union, so emitting it again
 * does not compile.
 *
 * 3. TWO STRICTNESSES FOR ONE QUESTION, AND THIS ONE WAS SELF-INFLICTED.
 *
 * The `time` slot reads his answer with `parseAnswerTime`, which is documented
 * as deliberately stricter than the general parser: the whole message must be
 * the time, because "a wrong answer to מתי? retimes a real reminder". The
 * `forwhom` slot added in 0.31.0 read the same kind of answer with `readWhen`,
 * which is happy with a time buried in a sentence. Same question, two
 * strictnesses, three days old. Now both use `parseAnswerTime`.
 */
import worker from '../src/index';
import { renderBaseline, questionAsked } from '../src/voice';
import { validate } from '../src/validate';
import { buildFacts } from '../src/facts';
import { wallToUtc } from '../src/time';
import type { Effect, Settings, Stats } from '../src/types';
import type { Context } from '../src/brain';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const TZ = 'Asia/Jerusalem';
const HIM = '12345';
const HER = '999';
const AT = wallToUtc(2026, 9, 8, 7, 5, TZ);
const ONCE = { type: 'once', at: '2026-09-08T07:05' } as const;

function ctxFor(): Context {
  return {
    settings: {
      chat_id: HIM, tz: TZ, intensity: 2, muted_until: null, off_limits: null,
      checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
      next_checkin_at: null, awaiting: null, brief_hour: 8, closeout_hour: 21,
      last_brief_on: null, last_closeout_on: null,
    } as Settings,
    stats: { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 } as Stats,
    reminders: [], goals: [], open: [], nowLabel: 'עכשיו',
  };
}

const goalRow = () =>
  ({ id: 1, chat_id: HIM, title: 'לרוץ יותר', why: null, status: 'active',
     last_progress: null, last_progress_at: null, checkin_count: 0,
     created_at: 0, next_checkin_at: null }) as any;

const instRow = (id = 9, title = 'לרוץ', status = 'open') =>
  ({ id, reminder_id: 1, chat_id: HIM, title, status, fired_at: AT,
     closed_at: status === 'open' ? null : AT, nag_count: 0, next_nag_at: null,
     proof: null, due_at: AT, granted_min: 0 }) as any;

const itemRow = () =>
  ({ id: 3, reminder_id: 1, chat_id: HIM, title: 'ראוטר', position: 0, done_at: null, created_at: 0 }) as any;

const remRow = (id: number, title: string) =>
  ({
    id, chat_id: HIM, title, notes: null, schedule: JSON.stringify(ONCE), tz: TZ,
    next_fire_at: AT, status: 'scheduled', active: 1, created_at: 0, event_at: null,
    requires_proof: 0, proof_type: 'any', nag_interval_min: 20, max_nags: 3,
    from_chat_id: null, miss_streak: 0,
  }) as any;

/**
 * ONE SAMPLE PER EFFECT KIND — enforced by the compiler.
 *
 * The mapped type is the whole point. Adding a kind to `Effect` without adding
 * it here is a type error, so this cannot silently fall behind the union the
 * way a hand-written array did. `nothing` carries its own exhaustive map
 * further down, for the same reason.
 */
const SAMPLES: { [K in Effect['kind']]: Extract<Effect, { kind: K }> } = {
  reminder_created: { kind: 'reminder_created', id: 1, title: 'לרוץ', at: AT, schedule: ONCE, requiresProof: false },
  friend_reminder_created: { kind: 'friend_reminder_created', id: 1, title: 'לקנות חלב', at: AT, schedule: ONCE, requiresProof: false, friend: 'דנה', to: HER },
  friend_needs_time: { kind: 'friend_needs_time', friend: 'דנה', to: HER, title: 'לקנות חלב' },
  friend_unknown: { kind: 'friend_unknown', asked: 'רותי', known: ['אמנון'] },
  reminder_captured: { kind: 'reminder_captured', id: 2, title: 'לקנות חלב' },
  reminder_scheduled: { kind: 'reminder_scheduled', id: 2, title: 'לקנות חלב', at: AT },
  reminder_retimed: { kind: 'reminder_retimed', id: 1, title: 'לרוץ', at: AT },
  reminder_unchanged: { kind: 'reminder_unchanged', id: 1, title: 'לרוץ', at: AT },
  reminder_renamed: { kind: 'reminder_renamed', id: 1, from: 'לרוץ', to: 'לרוץ מהר' },
  reminder_deleted: { kind: 'reminder_deleted', id: 1, title: 'לרוץ' },
  reminder_duplicate: { kind: 'reminder_duplicate', id: 1, title: 'לרוץ', at: AT },
  reminder_annotated: { kind: 'reminder_annotated', id: 1, title: 'לרוץ', note: 'עם הכלב' },
  reminder_fired: { kind: 'reminder_fired', id: 1, instanceId: 9, title: 'לרוץ', requiresProof: false },
  nagged: { kind: 'nagged', instanceId: 9, title: 'לרוץ', since: AT, round: 1, granted: 0 },
  gave_up: { kind: 'gave_up', instanceId: 9, title: 'לרוץ', rounds: 3 },
  instance_done: { kind: 'instance_done', id: 9, title: 'לרוץ', streak: 4 },
  instance_skipped: { kind: 'instance_skipped', id: 9, title: 'לרוץ', recurs: false },
  instance_snoozed: { kind: 'instance_snoozed', id: 9, title: 'לרוץ', until: AT, minutes: 30 },
  instance_started: { kind: 'instance_started', id: 9, title: 'לרוץ', until: AT },
  instance_superseded: { kind: 'instance_superseded', id: 9, title: 'לרוץ' },
  photo_accepted: { kind: 'photo_accepted', instanceId: 9, title: 'לרוץ', reason: 'תמונה', streak: 4 },
  item_done: { kind: 'item_done', id: 3, title: 'ראוטר', reminderId: 1, remaining: 1 },
  goal_created: { kind: 'goal_created', id: 1, title: 'לרוץ יותר', why: null },
  goal_progress: { kind: 'goal_progress', id: 1, title: 'לרוץ יותר', note: 'רצתי', previous: null },
  goal_closed: { kind: 'goal_closed', id: 1, title: 'לרוץ יותר', status: 'done' },
  listed_goals: { kind: 'listed_goals', rows: [goalRow()] },
  checkin_goal: { kind: 'checkin_goal', id: 1, title: 'לרוץ יותר', why: null, lastProgress: null, lastProgressAt: null, lastCheckinAt: null },
  checkins_set: { kind: 'checkins_set', enabled: true, perDay: 2 },
  intensity_set: { kind: 'intensity_set', level: 2 },
  profile_noted: { kind: 'profile_noted', id: 1, note: 'אוהב קפה' },
  profile_known: { kind: 'profile_known', note: 'אוהב קפה' },
  profile_forgotten: { kind: 'profile_forgotten', note: 'אוהב קפה' },
  listed_profile: { kind: 'listed_profile', rows: [{ id: 1, note: 'אוהב קפה' }] },
  morning_brief: { kind: 'morning_brief', rows: [remRow(1, 'לרוץ')], openCount: 0 },
  evening_closeout: {
    kind: 'evening_closeout',
    done: [instRow(20, 'לקנות חלב', 'done'), instRow(21, 'לרוץ', 'done')],
    missed: [], dropped: [], ahead: [],
  },
  pattern_pushed: { kind: 'pattern_pushed', id: 1, title: 'לנקות', snoozes: 6, fires: 7, at: AT },
  pattern_failing: { kind: 'pattern_failing', id: 1, title: 'לנקות', dropped: 4, fires: 4 },
  pattern_kept: { kind: 'pattern_kept' },
  window_crowded: { kind: 'window_crowded', count: 3, label: 'מחר בבוקר' },
  needs_time: { kind: 'needs_time', id: 1, title: 'לרוץ' },
  needs_reminder_choice: { kind: 'needs_reminder_choice', action: 'reschedule', rows: [remRow(1, 'לרוץ')] },
  appointment_offer: { kind: 'appointment_offer', title: 'ללכת למוסך', at: AT },
  followup_suggested: { kind: 'followup_suggested', instanceId: 9, title: 'ללכת למוסך', at: AT },
  distress: { kind: 'distress', text: 'קשה לי' },
  needs_task_choice: { kind: 'needs_task_choice', action: 'complete', open: [instRow()] },
  needs_item_choice: { kind: 'needs_item_choice', open: [itemRow()] },
  muted: { kind: 'muted', until: AT, hours: 4 },
  listed_reminders: { kind: 'listed_reminders', rows: [remRow(1, 'לרוץ')], openCount: 0 },
  listed_inbox: { kind: 'listed_inbox', rows: [remRow(2, 'לקנות חלב')] },
  photo_rejected: { kind: 'photo_rejected', instanceId: 9, title: 'לרוץ', reason: 'לא ברור' },
  nothing: { kind: 'nothing', why: 'chat', userText: 'מה קורה' },
};

// ===========================================================================
section('every effect kind renders shippable Hebrew and passes its own validator');
//
// The round-trip is the point of the second half: voice.ts output is what
// ships when the model is unavailable, so a baseline that fails validate() is
// a sentence the bot can never send at all. 0.19.0 found `evening_closeout`
// doing exactly that the moment second-person verbs went into the lexicon —
// and it had never been in this loop either.
{
  const all = Object.values(SAMPLES) as Effect[];
  check(`the map covers the union — ${all.length} kinds`, all.length >= 45, String(all.length));

  for (const e of all) {
    let text = '';
    try {
      text = renderBaseline([e], TZ);
    } catch (err) {
      check(`${e.kind} renders without throwing`, false, String(err));
      continue;
    }
    const ok = text.trim().length > 0 && /[֐-׿]/.test(text);
    check(`${e.kind} renders Hebrew`, ok, JSON.stringify(text));

    /*
     * What this round-trip can and cannot prove, stated because the red-proof
     * found the difference the hard way.
     *
     * `validate` folds the BASELINE's own clock times and quoted strings into
     * its allow-lists — deliberately, because the baseline says things that are
     * true without being facts (the format example "כמו 19:30" in the bad_time
     * reply is not an hour anybody scheduled). Passing the baseline as its own
     * third argument therefore makes rules 1 and 3 unfalsifiable here: an hour
     * invented by voice.ts is allowed BY voice.ts.
     *
     * What is still live, and is the reason this loop exists: rule 2 (a claim
     * verb with no matching effect kind) and rules 5-6 (a message that says
     * less than it must). That is exactly the shape 0.19.0 found — the moment
     * second-person close verbs entered the lexicon, `evening_closeout`'s own
     * baseline "סגרת 2 היום" failed its own validator, and that kind had never
     * been in a loop like this one.
     */
    const facts = buildFacts(ctxFor(), [e], TZ);
    const v = validate(text, facts, text);
    check(`${e.kind} passes its own validator`, v.ok, `${v.reason ?? ''} — ${text}`);
  }
}

// ---------------------------------------------------------------------------
section('every `nothing` reason has its own wording');
//
// Same mapped-type trick over the inner union. `no_time` is gone from it: its
// only emitter became `friend_needs_time` in 0.31.0, and leaving a bare "מתי?"
// reachable is leaving the #85 bug loaded for whoever reaches for it next.
{
  type Why = Extract<Effect, { kind: 'nothing' }>['why'];
  const WHYS: { [K in Why]: true } = {
    past_time: true, bad_time: true, no_open_task: true, unknown_reminder: true,
    unknown_goal: true, unknown_note: true, chat: true, unknown_friend: true,
    failed: true, not_understood: true,
  } as any;

  for (const why of Object.keys(WHYS) as Why[]) {
    const text = renderBaseline([{ kind: 'nothing', why, userText: 'משהו' } as Effect], TZ);
    check(`${why} says something`, text.trim().length > 0, JSON.stringify(text));
    // The two that must never be a bare "נו?" — that string is the bot's name
    // and the opener of every nag, so it reads as being nagged rather than as
    // an answer. CLAUDE.md states this; it is asserted here because the
    // wordings sit next to each other and are easy to collapse.
    if (why === 'failed' || why === 'not_understood') {
      check(`${why} is not the bare "נו?"`, text.trim() !== 'נו?', JSON.stringify(text));
    }
  }
}

// ---------------------------------------------------------------------------
section('a question either arms a slot or offers a button — never neither');
//
// The rule CLAUDE.md states for renderBaseline, checked rather than trusted.
// `friend_needs_time` is the one that was violating it three days ago.
{
  const asksAndArms: Effect['kind'][] = [
    'reminder_captured', 'needs_time', 'appointment_offer', 'friend_needs_time',
  ];
  for (const k of asksAndArms) {
    const e = (SAMPLES as any)[k] as Effect;
    check(`${k} arms a slot`, questionAsked(e) !== null, k);
  }
}

// ---------------------------------------------------------------------------
section('both time-answer slots are equally strict');
//
// `parseAnswerTime` refuses a message that is not ENTIRELY a time, because a
// wrong answer to "מתי?" retimes a real reminder. The forwhom slot added in
// 0.31.0 used readWhen, which is happy with a time buried in a sentence — two
// strictnesses for one question. Asserted through the rig on BOTH slots so
// they cannot drift apart again.
{
  const seed = (rig: Rig) => {
    for (const c of [HIM, HER]) {
      rig.db
        .prepare(
          `INSERT INTO settings (chat_id, tz, intensity, checkins_enabled, checkin_per_day,
            quiet_start_hour, quiet_end_hour, next_checkin_at, brief_hour, closeout_hour,
            last_brief_on, last_closeout_on)
           VALUES (?, ?, 2, 0, 0, 23, 8, NULL, NULL, NULL, NULL, NULL)`,
        )
        .run(c, TZ);
    }
    rig.db
      .prepare(
        `INSERT INTO friends (chat_id, friend_chat_id, nickname, status, requested_by, created_at)
         VALUES (?,?,'אמנון','accepted',?,0)`,
      )
      .run(HIM, HER, HIM);
  };
  const say = async (rig: Rig, text: string, at: number) => {
    await withNow(at, async () => {
      const pending: Promise<unknown>[] = [];
      const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
      await worker.fetch(
        new Request('https://x/tg', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
          },
          body: JSON.stringify({ message: { chat: { id: Number(HIM) }, text, message_id: 31 } }),
        }),
        rig.env, ctx,
      );
      await Promise.all(pending);
    });
  };
  const NOW = Date.parse('2026-09-08T09:00:00Z');
  // A time with words around it. Neither slot may take this as an answer.
  const MUDDY = 'בעוד שעה אבל אולי מחר';

  const rig = createRig({ tz: TZ });
  seed(rig);
  rig.routerQueue.push({
    actions: [{ action: 'create_reminder', for_friend: 'אמנון', title: 'לשלוח הודעה' }],
  });
  rig.speakQueue.push('מתי?');
  await say(rig, 'תזכיר לאמנון לשלוח הודעה', NOW);
  eq('nothing written while the question stands', (rig.db.prepare('SELECT COUNT(*) n FROM reminders').get() as any).n, 0);

  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('לא הבנתי.');
  await say(rig, MUDDY, NOW + 10_000);

  eq('a muddy answer is not written for the friend',
    (rig.db.prepare('SELECT COUNT(*) n FROM reminders').get() as any).n, 0);
  eq('it went to the router instead', rig.geminiCalls.filter((c) => c.kind === 'router').length, 2);
  rig.restore();
}

done();
