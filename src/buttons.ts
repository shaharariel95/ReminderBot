/**
 * Telegram caps callback_data at 64 bytes, so the encoding is terse positional
 * text rather than JSON. Every decode is strict: an unparseable payload returns
 * null and the caller ignores it. Guessing at a malformed callback would mean
 * writing to the database on the strength of a corrupted string.
 */

import { UNTITLED_TITLE } from './types';
import { formatLocal, planSlotInstant } from './time';

export type PlanSlot = 'eve' | 'tm' | 'hr' | 'none';

export type Callback =
  | { t: 'done'; instance: number }
  | { t: 'snooze'; instance: number; minutes: number }
  | { t: 'skip'; instance: number }
  | { t: 'retime'; reminder: number; hour: number; minute: number }
  | { t: 'plan'; reminder: number; slot: PlanSlot }
  /** From the evening close-out: drop today's attempt and try again tomorrow. */
  | { t: 'tomorrow'; instance: number }
  /** Accept the follow-up reminder offered when a task that was ARRANGING
   *  something got closed. Carries only the instance: the appointment is
   *  re-derived from the same title by the same function that offered it, so
   *  the label and the write cannot disagree. */
  | { t: 'followup'; instance: number }
  /** From an unprompted goal check-in: close it, or stop being asked at all.
   *  It had no buttons, so the only way to end the loop was to keep ignoring
   *  it — which is exactly what produced five identical messages in four days. */
  | { t: 'gdone'; goal: number }
  | { t: 'gdrop'; goal: number }
  /** Accept the reminder offered for something he only MENTIONED. Carries no
   *  payload at all: callback_data has 64 bytes and a title does not fit, so
   *  the title and instant live in the chat's `awaiting` slot and the tap just
   *  says yes. One outstanding offer per chat, which is all there can be. */
  | { t: 'offer' };

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
    case 'followup':
      return `f:${c.instance}`;
    case 'gdone':
      return `gd:${c.goal}`;
    case 'gdrop':
      return `gx:${c.goal}`;
    case 'offer':
      return 'o';
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
    case 'f':
      return parts.length === 2 && isNat(parts[1]) ? { t: 'followup', instance: +parts[1] } : null;
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
    case 'o':
      return parts.length === 1 ? { t: 'offer' } : null;
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

/** "07:05" out of the formatted local label. */
function hhmm(ts: number, tz: string): string {
  const label = formatLocal(ts, tz);
  return /(\d{2}:\d{2})/.exec(label)?.[1] ?? label;
}

export function buttonsFor(
  effects: { kind: string; [k: string]: unknown }[],
  /** Only the inbox slots need these; every other keyboard is time-free. */
  tz = 'Asia/Jerusalem',
  now = Date.now(),
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

  // Checked before the fired/created keyboards below can claim the message: a
  // follow-up offer is a question, and a question with no way to say yes is
  // just noise.
  const followup = effects.find((e) => e.kind === 'followup_suggested');
  if (followup) {
    const instance = positiveId(followup.instanceId);
    const at = Number(followup.at);
    if (instance === null || !Number.isFinite(at)) return undefined;
    return [[{ text: `כן, ${hhmm(at, tz)}`, data: { t: 'followup', instance } }]];
  }

  // Same shape as followup_suggested above, and for the same reason: an offer
  // with no way to accept it is just the bot talking to itself.
  const offer = effects.find((e) => e.kind === 'appointment_offer');
  if (offer) {
    const at = Number(offer.at);
    if (!Number.isFinite(at)) return undefined;
    return [[{ text: `כן, ${hhmm(at, tz)}`, data: { t: 'offer' } }]];
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
    // Dropped tasks get a button too — they are the ones that most need one.
    // Something still open can be answered by talking; something the bot has
    // already given up on has no other way back.
    const missed = [
      ...(Array.isArray(closeout.missed) ? closeout.missed : []),
      ...(Array.isArray(closeout.dropped) ? closeout.dropped : []),
    ];
    const rows = missed.flatMap((m: { id?: unknown; title?: unknown }) => {
      const instance = positiveId(m?.id);
      if (instance === null) return [];
      return [[{ text: `מחר · ${shortLabel(m?.title)}`, data: { t: 'tomorrow', instance } }] as Button[]];
    });
    return rows.length ? rows : undefined;
  }

  // "איזו מהן? #22 "…" · #24 "…"" — a question that asked him to type an
  // instance id back. Every question this bot asks except reminder_captured
  // was a dead end like this one, which is how "15:00" ended up answered with
  // "נו?" on 13.08.2026: there was no affordance, so the answer had to survive
  // a round trip through the router, and it did not.
  //
  // Only the actions a single tap can actually FINISH are given buttons.
  // on_my_way has no callback of its own, and needs_reminder_choice needs a
  // time or a title after the choice — those are answered by the awaiting slot
  // (see db.setAwaiting) rather than by a button that would settle nothing.
  // An unprompted check-in about a goal, with a way to end it.
  //
  // This had no keyboard at all, and the consequence is the loudest thing in
  // the 0.7 transcript: "להגיד לאישתי משהו יפה" was raised five times across
  // four days, and the only way to stop it was to keep not answering — which
  // is precisely the input that made it keep asking.
  const checkin = effects.find((e) => e.kind === 'checkin_goal');
  if (checkin) {
    const goal = positiveId(checkin.id);
    if (goal !== null) {
      return [
        [
          { text: 'עשיתי', data: { t: 'gdone', goal } },
          { text: 'תוריד את זה', data: { t: 'gdrop', goal } },
        ],
      ];
    }
  }

  const choice = effects.find((e) => e.kind === 'needs_task_choice');
  if (choice) {
    const open = Array.isArray(choice.open) ? choice.open : [];
    const rows = open.flatMap((i: { id?: unknown; title?: unknown }) => {
      const instance = positiveId(i?.id);
      if (instance === null) return [];
      if (choice.action === 'complete') {
        return [[{ text: `✓ ${shortLabel(i?.title)}`, data: { t: 'done', instance } }] as Button[]];
      }
      if (choice.action === 'snooze') {
        return [
          [
            { text: `${shortLabel(i?.title)} · 10 דק׳`, data: { t: 'snooze', instance, minutes: 10 } },
          ] as Button[],
        ];
      }
      return [];
    });
    if (rows.length) return rows;
  }

  const captured = effects.find((e) => e.kind === 'reminder_captured');
  if (captured) {
    const reminder = positiveId(captured.id);
    if (reminder === null) return undefined;
    // Each label carries the hour it will actually produce, read from the same
    // function the tap writes with. "מחר בבוקר" silently meant 09:00 to one
    // side and nothing at all to the other, and an hour he had explicitly
    // asked for disappeared into the gap.
    const slotLabel = (name: string, slot: 'eve' | 'tm' | 'hr') =>
      `${name} ${hhmm(planSlotInstant(slot, tz, now), tz)}`;
    return [
      [
        { text: slotLabel('עוד שעה', 'hr'), data: { t: 'plan', reminder, slot: 'hr' } },
        { text: slotLabel('הערב', 'eve'), data: { t: 'plan', reminder, slot: 'eve' } },
      ],
      [
        { text: slotLabel('מחר', 'tm'), data: { t: 'plan', reminder, slot: 'tm' } },
        // The only slot with no hour to promise, so the only one without one.
        { text: 'בלי זמן', data: { t: 'plan', reminder, slot: 'none' } },
      ],
    ];
  }

  return undefined;
}
