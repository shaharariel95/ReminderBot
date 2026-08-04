export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  OWNER_CHAT_ID: string;
  GEMINI_MODEL?: string;
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
}
