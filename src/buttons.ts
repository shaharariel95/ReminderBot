/**
 * Telegram caps callback_data at 64 bytes, so the encoding is terse positional
 * text rather than JSON. Every decode is strict: an unparseable payload returns
 * null and the caller ignores it. Guessing at a malformed callback would mean
 * writing to the database on the strength of a corrupted string.
 */

export type PlanSlot = 'eve' | 'tm' | 'hr' | 'none';

export type Callback =
  | { t: 'done'; instance: number }
  | { t: 'snooze'; instance: number; minutes: number }
  | { t: 'skip'; instance: number }
  | { t: 'retime'; reminder: number; hour: number; minute: number }
  | { t: 'plan'; reminder: number; slot: PlanSlot };

const SLOTS: PlanSlot[] = ['eve', 'tm', 'hr', 'none'];

const isNat = (s: string) => /^\d{1,9}$/.test(s);

export function encode(c: Callback): string {
  switch (c.t) {
    case 'done':
      return `d:${c.instance}`;
    case 'snooze':
      return `s:${c.instance}:${c.minutes}`;
    case 'skip':
      return `x:${c.instance}`;
    case 'retime':
      return `r:${c.reminder}:${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
    case 'plan':
      return `p:${c.reminder}:${c.slot}`;
  }
}

export function decode(s: string): Callback | null {
  const parts = s.split(':');
  switch (parts[0]) {
    case 'd':
      return parts.length === 2 && isNat(parts[1]) ? { t: 'done', instance: +parts[1] } : null;
    case 'x':
      return parts.length === 2 && isNat(parts[1]) ? { t: 'skip', instance: +parts[1] } : null;
    case 's':
      return parts.length === 3 && isNat(parts[1]) && isNat(parts[2])
        ? { t: 'snooze', instance: +parts[1], minutes: +parts[2] }
        : null;
    case 'r': {
      if (parts.length !== 4 || !isNat(parts[1]) || !isNat(parts[2]) || !isNat(parts[3])) return null;
      const hour = +parts[2];
      const minute = +parts[3];
      if (hour > 23 || minute > 59) return null;
      return { t: 'retime', reminder: +parts[1], hour, minute };
    }
    case 'p':
      return parts.length === 3 && isNat(parts[1]) && SLOTS.includes(parts[2] as PlanSlot)
        ? { t: 'plan', reminder: +parts[1], slot: parts[2] as PlanSlot }
        : null;
    default:
      return null;
  }
}

export interface Button {
  text: string;
  data: Callback;
}

/** The `reply_markup` value Telegram expects. */
export function keyboard(rows: Button[][]): unknown {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) => ({ text: b.text, callback_data: encode(b.data) })),
    ),
  };
}
