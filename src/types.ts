export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  OWNER_CHAT_ID: string;
  GEMINI_MODEL?: string;
  GEMINI_MODEL_FALLBACK?: string;
  GEMINI_SOFT_LIMIT?: string;
  DEFAULT_TZ?: string;
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
    | 'snooze'
    | 'list'
    | 'delete'
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
  goal_id?: number;
  why?: string;
  snooze_minutes?: number;
  chill_hours?: number;
  intensity?: number;
  checkins_enabled?: boolean;
  checkin_per_day?: number;
  distress?: boolean;
  reason?: string;
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
  | { kind: 'reminder_created'; id: number; title: string; at: number; schedule: Schedule; requiresProof: boolean; altHour?: number }
  | { kind: 'reminder_captured'; id: number; title: string }
  | { kind: 'reminder_scheduled'; id: number; title: string; at: number }
  | { kind: 'reminder_retimed'; id: number; title: string; at: number }
  | { kind: 'reminder_deleted'; id: number; title: string }
  | { kind: 'instance_done'; id: number; title: string; streak: number }
  | { kind: 'instance_skipped'; id: number; title: string }
  | { kind: 'instance_snoozed'; id: number; title: string; until: number; minutes: number }
  | { kind: 'goal_created'; id: number; title: string; why: string | null }
  | { kind: 'goal_progress'; id: number; title: string; note: string; previous: string | null }
  | { kind: 'goal_closed'; id: number; title: string; status: 'done' | 'dropped' }
  | { kind: 'checkins_set'; enabled: boolean; perDay: number | null }
  | { kind: 'muted'; until: number; hours: number }
  | { kind: 'intensity_set'; level: number }
  | { kind: 'listed_reminders'; rows: Reminder[]; openCount: number }
  | { kind: 'listed_goals'; rows: Goal[] }
  | { kind: 'listed_inbox'; rows: Reminder[] }
  | { kind: 'reminder_fired'; id: number; title: string; instanceId: number; requiresProof: boolean }
  | { kind: 'nagged'; instanceId: number; title: string; since: number; round: number }
  | { kind: 'gave_up'; instanceId: number; title: string; rounds: number }
  | { kind: 'checkin_goal'; id: number; title: string; why: string | null; lastProgress: string | null; lastProgressAt: number | null; lastCheckinAt: number | null }
  | { kind: 'photo_accepted'; instanceId: number; title: string; reason: string; streak: number }
  | { kind: 'photo_rejected'; instanceId: number; title: string; reason: string }
  | { kind: 'distress'; text: string }
  /** Nothing was written. `why` selects the deterministic wording. */
  | { kind: 'nothing'; why: 'no_time' | 'past_time' | 'bad_time' | 'no_open_task' | 'unknown_reminder' | 'unknown_goal' | 'chat'; userText: string };

/** True when this effect wrote something the bot is allowed to confirm. */
export const WROTE: ReadonlySet<Effect['kind']> = new Set<Effect['kind']>([
  'reminder_created', 'reminder_captured', 'reminder_scheduled', 'reminder_retimed',
  'reminder_deleted', 'instance_done', 'instance_skipped', 'instance_snoozed',
  'goal_created', 'goal_progress', 'goal_closed', 'checkins_set', 'muted',
  'intensity_set', 'photo_accepted',
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
  /** Every task or goal title the model may quote. */
  titles: string[];
  /**
   * Human-readable prose the effects carry — reasons, progress notes, the user's
   * own words. The model may quote any of it truthfully, but unlike a title it is
   * never shortened or paraphrased, so it is matched in one direction only.
   */
  quotable: string[];
  /** True when at least one effect wrote to the database. */
  wrote: boolean;
}
