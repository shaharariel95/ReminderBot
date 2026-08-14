export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  OWNER_CHAT_ID: string;
  GEMINI_MODEL?: string;
  GEMINI_MODEL_FALLBACK?: string;
  /** Calls per DAY before the bot stops consulting the model at all. */
  GEMINI_SOFT_LIMIT?: string;
  /**
   * Calls per MINUTE, per model. This is the axis the free tier actually
   * limits — /diag caught it returning `limit: 20` with "please retry in 56s"
   * while the daily budget still had hundreds left, so the daily guard above
   * had never once fired. Kept a little under the real ceiling so a burst
   * degrades to the deterministic baseline instead of to a 429.
   */
  GEMINI_RPM?: string;
  /** Milliseconds one Gemini request may take. See gemini.ts. */
  GEMINI_TIMEOUT_MS?: string;
  /** Milliseconds a whole generate() may take, across every retry and tier. */
  GEMINI_BUDGET_MS?: string;
  DEFAULT_TZ?: string;
  /**
   * Test-only override for sendBurst's inter-chunk sleep (see telegram.ts).
   * Real deployments get `Env` from Cloudflare's wrangler bindings, which
   * cannot produce a function value, so this is always `undefined` outside
   * the test harness — there is no path by which a real deployment could end
   * up with this set.
   */
  __burstSleep?: (ms: number) => Promise<void>;
}

/** Recurrence rule, stored as JSON in reminders.schedule. */
export type Schedule =
  | { type: 'once'; at: string }                      // local wall time "2026-08-03T07:30"
  | { type: 'daily'; time: string }                   // "07:30"
  | { type: 'weekly'; time: string; days: number[] }  // days: 0=Sunday .. 6=Saturday
  | { type: 'interval'; minutes: number };

/** `inbox` = captured with no time. Never fires, never nags, waits in /inbox. */
export type ReminderStatus = 'scheduled' | 'inbox' | 'done' | 'cancelled';

export interface Reminder {
  id: number;
  chat_id: string;
  title: string;
  notes: string | null;
  schedule: string;
  tz: string;
  requires_proof: number;
  proof_type: 'text' | 'photo' | 'any';
  nag_interval_min: number;
  max_nags: number;
  next_fire_at: number | null;
  status: ReminderStatus;
  active: number;
  created_at: number;
}

/**
 * One tickable thing inside a reminder. See migrations/011 for why these hang
 * off the reminder rather than off the instance.
 */
export interface ReminderItem {
  id: number;
  reminder_id: number;
  chat_id: string;
  title: string;
  position: number;
  /** NULL while it is still open. */
  done_at: number | null;
  created_at: number;
}

export interface Instance {
  id: number;
  reminder_id: number;
  chat_id: string;
  title: string;
  fired_at: number;
  next_nag_at: number | null;
  nag_count: number;
  status: 'open' | 'done' | 'failed' | 'skipped';
  proof: string | null;
  closed_at: number | null;
}

export interface Goal {
  id: number;
  chat_id: string;
  title: string;
  why: string | null;
  status: 'active' | 'done' | 'dropped';
  last_progress: string | null;
  last_progress_at: number | null;
  last_checkin_at: number | null;
  checkin_count: number;
  created_at: number;
}

export interface Settings {
  chat_id: string;
  tz: string;
  intensity: number;
  muted_until: number | null;
  off_limits: string | null;
  checkins_enabled: number;
  checkin_per_day: number;
  quiet_start_hour: number;
  quiet_end_hour: number;
  next_checkin_at: number | null;
  /** JSON for the one question the bot is waiting on — see db.readAwaiting. */
  awaiting: string | null;
  /** Local hour for the once-a-day messages; null switches one off. */
  brief_hour: number | null;
  closeout_hour: number | null;
  /** Local date (YYYY-MM-DD) each was last sent on — see migrations/003. */
  last_brief_on: string | null;
  last_closeout_on: string | null;
}

export interface Stats {
  done7: number;
  failed7: number;
  done30: number;
  failed30: number;
  currentStreak: number;
}

/** What the router LLM is allowed to decide. */
export interface Intent {
  action:
    | 'create_reminder'
    | 'complete'
    /**
     * Close ONE errand inside a multi-item reminder, leaving the rest open.
     *
     * Without this the only honest answer to "החזרתי את הראוטר" was silence:
     * `complete` closes the whole instance, which would have been a claim about
     * the two errands he had NOT done.
     */
    | 'complete_item'
    | 'snooze'
    /** "I'm on it / on my way." Neither done nor postponed: the task stays
     *  open and the nag ladder is held off for a grace window. Without this,
     *  a man reporting that he is driving to the thing gets nagged about it. */
    | 'on_my_way'
    | 'list'
    | 'delete'
    /** Move an existing reminder to a different time. Distinct from `snooze`,
     *  which pushes an instance that has ALREADY fired. */
    | 'reschedule'
    /** Fix the wording of an existing reminder without touching its schedule. */
    | 'rename'
    /** Attach the detail that makes a reminder land — what it is for, what to
     *  bring, who to ask. Usually his answer to a question the bot asked. */
    | 'annotate'
    /** Store a durable fact he stated about himself. Not a reminder, not a
     *  goal — nothing fires, nothing is chased. It only informs the tone. */
    | 'remember'
    | 'forget'
    | 'set_intensity'
    | 'chill'
    | 'create_goal'
    | 'goal_progress'
    | 'complete_goal'
    | 'drop_goal'
    | 'list_goals'
    | 'set_checkins'
    | 'chat';
  title?: string;
  schedule_type?: 'once' | 'daily' | 'weekly' | 'interval';
  time?: string;
  days?: number[];
  interval_minutes?: number;
  once_at?: string;
  /** "in N minutes/hours" — TypeScript does the arithmetic, not the model. */
  in_minutes?: number;
  requires_proof?: boolean;
  proof_type?: 'text' | 'photo' | 'any';
  target_id?: number;
  /** Which item of a multi-errand reminder — see the complete_item action. */
  item_id?: number;
  goal_id?: number;
  why?: string;
  snooze_minutes?: number;
  chill_hours?: number;
  intensity?: number;
  checkins_enabled?: boolean;
  checkin_per_day?: number;
  distress?: boolean;
  reason?: string;
  /** The durable fact for `remember`, in his own words. */
  note?: string;
  /**
   * Set when the hour was written without am/pm and we committed to the literal
   * reading. Value is the other reading's hour, offered as a one-tap correction.
   */
  ambiguous_hour?: number;
}

/**
 * What the database ACTUALLY did — not what the router asked for. Every
 * user-facing claim is derived from one of these, which is what makes
 * "I saved it" impossible to say when nothing was saved.
 */
export type Effect =
  | {
      kind: 'reminder_created'; id: number; title: string; at: number; schedule: Schedule;
      requiresProof: boolean; altHour?: number;
      /**
       * A similar reminder that already exists — either within seconds of this
       * one, or elsewhere on the same day. The reminder was still created;
       * this only warns, because "the pill at 09:00 and again at 21:00" is an
       * ordinary pair and refusing it would be worse than mentioning it.
       *
       * `at` is carried so the warning can state WHEN the other one is, which
       * is the whole difference between a useful nudge and a vague one. Note
       * that neither this title nor this time sits at the top level of the
       * effect, so facts.ts must sweep both explicitly (see the comment there)
       * or a truthful mention gets discarded by validate.ts.
       */
      duplicateOf?: { id: number; title: string; at: number };
    }
  | { kind: 'reminder_captured'; id: number; title: string }
  | { kind: 'reminder_scheduled'; id: number; title: string; at: number }
  | { kind: 'reminder_retimed'; id: number; title: string; at: number }
  /**
   * Both titles are carried because the reply has to name the one that is
   * gone as well as the one that replaced it. Neither sits at the top level
   * under the key `title`, so facts.ts must sweep them explicitly — same trap
   * as `duplicateOf` above.
   */
  | { kind: 'reminder_renamed'; id: number; from: string; to: string }
  | { kind: 'reminder_deleted'; id: number; title: string }
  /**
   * An EXACT duplicate (same normalised title, within the dedup window) was
   * found — nothing was inserted. Carries the EXISTING row's identity so the
   * reply can point at it truthfully instead of claiming a new one was made.
   */
  | { kind: 'reminder_duplicate'; id: number; title: string; at: number }
  | { kind: 'instance_done'; id: number; title: string; streak: number }
  | { kind: 'instance_skipped'; id: number; title: string }
  | { kind: 'instance_snoozed'; id: number; title: string; until: number; minutes: number }
  /**
   * complete/snooze couldn't resolve which open instance the user meant AND
   * there was more than one candidate — asking is correct here; claiming
   * "no open task" (the `nothing/no_open_task` case, kept for the genuinely
   * empty case) would be false.
   */
  | { kind: 'reminder_annotated'; id: number; title: string; note: string }
  /**
   * A task he just closed named a future appointment that has no reminder of
   * its own — "לדבר על המוסך לוודא שאני מגיע ביום חמישי" closed on the Monday,
   * with nothing set for the Thursday it was arranging. Nothing is written:
   * this is an offer, and the button is what commits it. Deliberately outside
   * WROTE for exactly that reason.
   */
  | { kind: 'followup_suggested'; instanceId: number; title: string; at: number }
  | { kind: 'instance_started'; id: number; title: string; until: number }
  | { kind: 'needs_task_choice'; action: 'complete' | 'snooze' | 'on_my_way'; open: Instance[] }
  /**
   * The reminder-side twin of the above: reschedule/rename knew what to do but
   * not to which reminder, and there was more than one candidate.
   */
  | { kind: 'needs_reminder_choice'; action: 'reschedule' | 'rename'; rows: Reminder[] }
  /** He reported doing something, and more than one open errand fits. Asking
   *  is the only truthful move: guessing marks an errand he did not do. */
  | { kind: 'needs_item_choice'; open: ReminderItem[] }
  /**
   * "מתי?" — WHICH reminder is known, the hour is not.
   *
   * Distinct from `nothing: 'no_time'`, which this replaced, and the
   * difference is the whole point: `nothing` carried no id, so the answer he
   * typed a second later had nothing to attach itself to. On 13.08.2026 the
   * bot asked for an hour, he gave one, and it was applied to nothing at all.
   * Carrying the id is what lets db.setAwaiting remember the question.
   */
  /**
   * One errand out of several is done; the task itself is still open.
   *
   * `remaining` is what makes the wording true without a second query — it is
   * read after the write, so it is the count he actually has left. When it
   * reaches zero the caller closes the instance too and an `instance_done`
   * rides alongside this one.
   */
  | { kind: 'item_done'; id: number; title: string; reminderId: number; remaining: number }
  | { kind: 'needs_time'; id: number; title: string }
  /**
   * He MENTIONED something with a time in it — "יש לי מחר ב-9 אימון" — and was
   * offered a reminder for it. Nothing is written.
   *
   * The bot only ever reacted to "תזכיר לי X בשעה Y", which is not how anyone
   * actually says it. The fix is deliberately an offer rather than a capture:
   * rule 1 in quickparse.ts exists because "אני הולך עוד 20 דקות" once became a
   * reminder titled "אני הולך", and a wrong guess here must cost one ignorable
   * question, never a row he did not ask for. Sits outside WROTE for the same
   * reason `followup_suggested` does.
   */
  | { kind: 'appointment_offer'; title: string; at: number }
  | { kind: 'goal_created'; id: number; title: string; why: string | null }
  | { kind: 'goal_progress'; id: number; title: string; note: string; previous: string | null }
  | { kind: 'goal_closed'; id: number; title: string; status: 'done' | 'dropped' }
  /**
   * A durable fact about him was stored, or removed. `already` distinguishes
   * "I've noted that" from "I already knew that" — nothing was written in the
   * second case, so it is deliberately NOT in WROTE.
   */
  | { kind: 'profile_noted'; id: number; note: string }
  | { kind: 'profile_known'; note: string }
  | { kind: 'profile_forgotten'; note: string }
  | { kind: 'listed_profile'; rows: { id: number; note: string }[] }
  | { kind: 'checkins_set'; enabled: boolean; perDay: number | null }
  | { kind: 'muted'; until: number; hours: number }
  | { kind: 'intensity_set'; level: number }
  | { kind: 'listed_reminders'; rows: Reminder[]; openCount: number }
  | { kind: 'listed_goals'; rows: Goal[] }
  | { kind: 'listed_inbox'; rows: Reminder[] }
  /**
   * `misses` is how many times in a row this same reminder has already fired
   * without being done. Carried so the wording can name the pattern instead of
   * repeating the identical ping for the fifth time as though it were the first.
   */
  | { kind: 'reminder_fired'; id: number; title: string; instanceId: number; requiresProof: boolean; misses?: number; items?: ReminderItem[] }
  | { kind: 'nagged'; instanceId: number; title: string; since: number; round: number }
  | { kind: 'gave_up'; instanceId: number; title: string; rounds: number }
  | { kind: 'checkin_goal'; id: number; title: string; why: string | null; lastProgress: string | null; lastProgressAt: number | null; lastCheckinAt: number | null }
  | { kind: 'photo_accepted'; instanceId: number; title: string; reason: string; streak: number }
  | { kind: 'photo_rejected'; instanceId: number; title: string; reason: string }
  /** The once-a-day messages. Neither writes anything the user could be told
   *  about, so neither belongs in WROTE — they only describe existing rows. */
  | { kind: 'morning_brief'; rows: Reminder[]; openCount: number }
  /**
   * `missed` is still open; `dropped` was nagged the full ladder and closed as
   * failed today. Both are carried as rows rather than counts so the reply can
   * NAME them — a close-out that can only say "2 נפלו" is how an ignored task
   * quietly stops existing.
   */
  | { kind: 'evening_closeout'; done: number; missed: Instance[]; dropped: Instance[] }
  | { kind: 'distress'; text: string }
  /** Nothing was written. `why` selects the deterministic wording. */
  /**
   * Nothing was written, and here is why.
   *
   * `chat` used to carry two unrelated meanings: "he was making conversation"
   * AND "the router or applyIntent threw". Both rendered as a bare "נו?" —
   * which is also the bot's name, also the opener of every fired reminder, and
   * also the opener of every nag. On 13.08.2026 he answered a question the bot
   * had just asked and got "נו?" back, with no way to tell whether he had been
   * misunderstood, crashed on, or simply nagged again.
   *
   * `failed` and `not_understood` are therefore separate, and neither may ever
   * word itself as a bare "נו?". See voice.ts.
   */
  | {
      kind: 'nothing';
      why:
        | 'no_time' | 'past_time' | 'bad_time' | 'no_open_task' | 'unknown_reminder'
        | 'unknown_goal' | 'unknown_note' | 'chat'
        /** Something threw mid-turn. Must neither confirm nor deny the write. */
        | 'failed'
        /** The router came back with nothing usable — not the same as small talk. */
        | 'not_understood';
      userText: string;
    };

/**
 * The title a reminder gets when he asked to be reminded but never said of
 * what ("תזכיר לי עוד 5 דקות"). Capture must never block on a question, so the
 * reminder is created anyway — but every layer that WORDS one of these needs to
 * recognise it, because "נו? תזכורת." at 07:00 tells him nothing at all.
 * Defined here so quickparse, effects and voice cannot drift apart on it.
 */
export const UNTITLED_TITLE = 'תזכורת';

/** True when this effect wrote something the bot is allowed to confirm. */
export const WROTE: ReadonlySet<Effect['kind']> = new Set<Effect['kind']>([
  'reminder_created', 'reminder_captured', 'reminder_scheduled', 'reminder_retimed',
  'reminder_renamed', 'reminder_deleted', 'instance_done', 'instance_skipped', 'instance_snoozed',
  'instance_started', 'reminder_annotated',
  'goal_created', 'goal_progress', 'goal_closed', 'checkins_set', 'muted',
  'intensity_set', 'photo_accepted', 'profile_noted', 'profile_forgotten', 'item_done',
]);

/**
 * Everything the model is permitted to assert this turn. `times` and `titles`
 * are the allow-lists the validator checks output against.
 */
export interface Facts {
  effects: Effect[];
  reminders: Reminder[];
  open: Instance[];
  goals: Goal[];
  settings: Settings;
  stats: Stats;
  nowLabel: string;
  /** Every clock time the model may say, as "HH:MM". */
  times: string[];
  /**
   * How long, in minutes, each thing in play has actually been open. This is
   * the allow-list behind elapsed-time claims ("שעה וחצי אתה גורר את
   * הטלפון..." when it had been thirty minutes) — a class of invented fact
   * `times` cannot see, because it is written in words and never as a clock.
   */
  elapsed: number[];
  /** Every task or goal title the model may quote. */
  titles: string[];
  /**
   * Human-readable prose the effects carry — reasons, progress notes, the user's
   * own words. The model may quote any of it truthfully, but unlike a title it is
   * never shortened or paraphrased, so it is matched in one direction only.
   */
  quotable: string[];
  /**
   * Durable facts he has stated about himself. Read lazily — only when a turn
   * is actually going to consult the model — so the button path, which never
   * speaks, does not pay for them. buildFacts therefore leaves this empty and
   * sendOutcome fills it in before speak()/validate().
   */
  profile: string[];
  /** True when at least one effect wrote to the database. */
  wrote: boolean;
}
