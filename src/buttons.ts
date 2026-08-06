/**
 * Telegram caps callback_data at 64 bytes, so the encoding is terse positional
 * text rather than JSON. Every decode is strict: an unparseable payload returns
 * null and the caller ignores it. Guessing at a malformed callback would mean
 * writing to the database on the strength of a corrupted string.
 */

import { UNTITLED_TITLE } from './types';

export type PlanSlot = 'eve' | 'tm' | 'hr' | 'none';

export type Callback =
  | { t: 'done'; instance: number }
  | { t: 'snooze'; instance: number; minutes: number }
  | { t: 'skip'; instance: number }
  | { t: 'retime'; reminder: number; hour: number; minute: number }
  | { t: 'plan'; reminder: number; slot: PlanSlot }
  /** From the evening close-out: drop today's attempt and try again tomorrow. */
  | { t: 'tomorrow'; instance: number };

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
    case 'tomorrow':
      return `m:${c.instance}`;
  }
}

export function decode(s: string): Callback | null {
  const parts = s.split(':');
  switch (parts[0]) {
    case 'd':
      return parts.length === 2 && isNat(parts[1]) ? { t: 'done', instance: +parts[1] } : null;
    case 'x':
      return parts.length === 2 && isNat(parts[1]) ? { t: 'skip', instance: +parts[1] } : null;
    case 'm':
      return parts.length === 2 && isNat(parts[1]) ? { t: 'tomorrow', instance: +parts[1] } : null;
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

/** A positive integer id, or null. Guards against a typo'd property name
 *  silently reading as NaN — NaN would still encode to callback_data (as the
 *  literal string "NaN"), producing a button that decode() rejects on tap,
 *  which is worse than no button at all. */
function positiveId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Which buttons belong on a message. Driven by effects rather than by the
 * caller so that every path producing the same effect gets the same affordance.
 */
/** Enough of a title to tell two buttons apart, short enough to fit on one. */
function shortLabel(title: unknown): string {
  const s = String(title ?? '').trim();
  if (!s || s === UNTITLED_TITLE) return 'בלי שם';
  return s.length > 14 ? `${s.slice(0, 13)}…` : s;
}

export function buttonsFor(
  effects: { kind: string; [k: string]: unknown }[],
): Button[][] | undefined {
  const fired = effects.filter((e) => e.kind === 'reminder_fired' || e.kind === 'nagged');

  if (fired.length === 1) {
    const instance = positiveId(fired[0].instanceId);
    if (instance === null) return undefined;
    return [
      [
        { text: 'עשיתי', data: { t: 'done', instance } },
        { text: 'עוד 10 דק׳', data: { t: 'snooze', instance, minutes: 10 } },
        { text: 'לא היום', data: { t: 'skip', instance } },
      ],
    ];
  }

  // Several fired at once. One row per task, each labelled — a single shared
  // "עשיתי" would be a lie about which one he closed, and this used to be a
  // `.find()`, which quietly gave buttons to the first task and none to the
  // rest. A task whose id is unusable is skipped rather than taking the whole
  // keyboard down with it: the others are still actionable.
  if (fired.length > 1) {
    const rows = fired.flatMap((f) => {
      const instance = positiveId(f.instanceId);
      if (instance === null) return [];
      return [
        [
          { text: `✓ ${shortLabel(f.title)}`, data: { t: 'done', instance } },
          { text: '10 דק׳', data: { t: 'snooze', instance, minutes: 10 } },
          { text: 'לא היום', data: { t: 'skip', instance } },
        ] as Button[],
      ];
    });
    return rows.length ? rows : undefined;
  }

  const created = effects.find((e) => e.kind === 'reminder_created' && e.altHour !== undefined);
  if (created) {
    const reminder = positiveId(created.id);
    const alt = Number(created.altHour);
    if (reminder === null || !Number.isInteger(alt) || alt < 0 || alt > 23) return undefined;
    return [
      [
        {
          text: `לא, ${String(alt).padStart(2, '0')}:00`,
          data: { t: 'retime', reminder, hour: alt, minute: 0 },
        },
      ],
    ];
  }

  // The close-out's whole point is that a miss costs one tap, not a re-typed
  // reminder. One row per item still open at the end of the day.
  const closeout = effects.find((e) => e.kind === 'evening_closeout');
  if (closeout) {
    const missed = Array.isArray(closeout.missed) ? closeout.missed : [];
    const rows = missed.flatMap((m: { id?: unknown; title?: unknown }) => {
      const instance = positiveId(m?.id);
      if (instance === null) return [];
      return [[{ text: `מחר · ${shortLabel(m?.title)}`, data: { t: 'tomorrow', instance } }] as Button[]];
    });
    return rows.length ? rows : undefined;
  }

  const captured = effects.find((e) => e.kind === 'reminder_captured');
  if (captured) {
    const reminder = positiveId(captured.id);
    if (reminder === null) return undefined;
    return [
      [
        { text: 'עוד שעה', data: { t: 'plan', reminder, slot: 'hr' } },
        { text: 'היום בערב', data: { t: 'plan', reminder, slot: 'eve' } },
      ],
      [
        { text: 'מחר בבוקר', data: { t: 'plan', reminder, slot: 'tm' } },
        { text: 'בלי זמן', data: { t: 'plan', reminder, slot: 'none' } },
      ],
    ];
  }

  return undefined;
}
