import type { Schedule } from './types';

/**
 * Timezone maths without a library. Workers ship full ICU, so Intl is reliable.
 * Everything stored in the DB is epoch-ms UTC; only display and recurrence
 * calculations happen in the user's wall-clock timezone.
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  dow: number; // 0=Sunday
}

/** Wall-clock fields of an instant, as seen in `tz`. */
export function wallParts(ts: number, tz: string): WallParts {
  const map: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  // hourCycle h23 can emit "24" for midnight in some ICU versions.
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  const second = Number(map.second);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, second, dow };
}

/** Offset of `tz` from UTC at instant `ts`, in ms (positive = ahead of UTC). */
export function tzOffsetMs(ts: number, tz: string): number {
  const p = wallParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `tz` to a UTC instant.
 * Two passes so DST transitions resolve correctly (the first guess uses the
 * offset at the wrong instant; the second uses the offset at the right one).
 */
export function wallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = target - tzOffsetMs(target, tz);
  ts = target - tzOffsetMs(ts, tz);
  return ts;
}

function parseHm(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`bad time "${time}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`bad time "${time}"`);
  return [h, min];
}

const DAY_MS = 86_400_000;

/**
 * Next firing instant strictly after `afterMs`, or null if there is none.
 * Day arithmetic walks the local calendar (not fixed 24h hops) so a DST
 * shift never drags a 07:30 reminder to 06:30 or 08:30.
 */
export function computeNext(schedule: Schedule, tz: string, afterMs: number): number | null {
  switch (schedule.type) {
    case 'once': {
      const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(schedule.at.trim());
      if (!m) throw new Error(`bad once.at "${schedule.at}"`);
      const ts = wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
      return ts > afterMs ? ts : null;
    }

    case 'interval': {
      const mins = Math.max(1, Math.floor(schedule.minutes));
      return afterMs + mins * 60_000;
    }

    case 'daily':
    case 'weekly': {
      const [h, min] = parseHm(schedule.time);
      const days = schedule.type === 'weekly' ? schedule.days : null;
      if (days && days.length === 0) return null;

      // Probe today and the next 8 local days.
      for (let i = 0; i <= 8; i++) {
        const probe = wallParts(afterMs + i * DAY_MS, tz);
        const candidate = wallToUtc(probe.year, probe.month, probe.day, h, min, tz);
        if (candidate <= afterMs) continue;
        if (days) {
          const dow = wallParts(candidate, tz).dow;
          if (!days.includes(dow)) continue;
        }
        return candidate;
      }
      return null;
    }
  }
}

// ------------------------------------------------------- quiet hours

/**
 * Is `ts` inside the quiet window? The window normally wraps midnight
 * (23:00 → 08:00), so the comparison flips depending on direction.
 */
export function isQuietHour(ts: number, tz: string, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  const h = wallParts(ts, tz).hour;
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

/** Push an instant forward to the end of the quiet window, plus a little jitter. */
export function afterQuietHours(
  ts: number,
  tz: string,
  startHour: number,
  endHour: number,
  rand: () => number = Math.random,
): number {
  if (!isQuietHour(ts, tz, startHour, endHour)) return ts;
  const p = wallParts(ts, tz);
  // If we're in the evening half of a wrapping window, the end is tomorrow.
  const rollDay = startHour > endHour && p.hour >= startHour ? 1 : 0;
  // Date.UTC normalises day overflow, so day+1 past month end is fine.
  const wake = wallToUtc(p.year, p.month, p.day + rollDay, endHour, 0, tz);
  return wake + Math.floor(rand() * 45) * 60_000;
}

/**
 * When should the next unprompted check-in happen?
 * Spreads `perDay` messages across waking hours with heavy jitter, so it never
 * feels like a cron job. Clockwork check-ins read as spam; irregular ones read
 * as someone remembering you exist.
 */
export function nextCheckinTime(
  fromMs: number,
  tz: string,
  perDay: number,
  quietStart: number,
  quietEnd: number,
  rand: () => number = Math.random,
): number {
  const quietLen = ((quietEnd - quietStart) + 24) % 24;
  const wakingHours = Math.max(1, 24 - quietLen);
  const avgGapMin = (wakingHours * 60) / Math.max(1, perDay);
  const jitter = 0.6 + rand() * 0.8; // 0.6x .. 1.4x of the average gap
  const ts = fromMs + Math.round(avgGapMin * jitter) * 60_000;
  return afterQuietHours(ts, tz, quietStart, quietEnd, rand);
}

/** "יום ג׳, 02.08.2026, 07:30" — the year matters, see wallString below. */
export function formatLocal(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

/**
 * "2026-08-02T22:34" in local wall time — the exact shape the router has to
 * emit for `once_at`. Giving the model this format as its clock, rather than a
 * prose date, removes the guesswork that had it inventing years.
 */
export function wallString(ts: number, tz: string): string {
  const p = wallParts(ts, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * "2026-08-07" — the local calendar day an instant falls on.
 *
 * The once-a-day messages key off this rather than off a timestamp, because
 * "has today's brief been sent" is a question about the user's calendar, not
 * about elapsed hours: a 24-hour comparison sends it twice on the day the
 * clocks go back and skips it on the day they go forward.
 */
export function localDateKey(ts: number, tz: string): string {
  const p = wallParts(ts, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Start of the local day containing `ts`, and the start of the next one. */
export function localDayBounds(ts: number, tz: string): { from: number; to: number } {
  const p = wallParts(ts, tz);
  return {
    from: wallToUtc(p.year, p.month, p.day, 0, 0, tz),
    to: wallToUtc(p.year, p.month, p.day + 1, 0, 0, tz),
  };
}

export function describeSchedule(schedule: Schedule): string {
  const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  switch (schedule.type) {
    case 'once':
      return `פעם אחת ב-${schedule.at}`;
    case 'daily':
      return `כל יום ב-${schedule.time}`;
    case 'weekly':
      return `כל ${schedule.days.map((d) => names[d] ?? d).join(', ')} ב-${schedule.time}`;
    case 'interval':
      return `כל ${schedule.minutes} דקות`;
  }
}

/**
 * When an inbox quick-schedule slot actually lands, in the reminder's own
 * timezone.
 *
 * Lives here, rather than beside its one caller, because it has two: the
 * handler that writes the reminder AND the button that offers it. On
 * 09.08.2026 only the handler knew that "מחר בבוקר" meant 09:00 — the button
 * said "מחר בבוקר" and nothing else, he tapped it having asked for 10:00, and
 * there was nothing on screen for him to disagree with. One source means the
 * label and the write cannot drift apart.
 */
export function planSlotInstant(
  slot: 'eve' | 'tm' | 'hr',
  tz: string,
  now = Date.now(),
): number {
  if (slot === 'hr') return now + 3_600_000;
  const p = wallParts(now, tz);
  if (slot === 'eve') {
    const at = wallToUtc(p.year, p.month, p.day, 20, 0, tz);
    return at > now ? at : at + 86_400_000;
  }
  return wallToUtc(p.year, p.month, p.day + 1, 9, 0, tz);
}
