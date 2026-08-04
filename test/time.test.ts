/**
 * Recurrence sanity checks. No framework — run with `npm run test:time`.
 * The DST cases are the ones that actually matter: Israel springs forward on
 * the Friday before the last Sunday of March and falls back on the last
 * Sunday of October, and a 07:30 reminder must stay 07:30 through both.
 */
import {
  afterQuietHours,
  computeNext,
  formatLocal,
  isQuietHour,
  nextCheckinTime,
  wallParts,
  wallString,
  wallToUtc,
} from '../src/time';
import type { Schedule } from '../src/types';

const TZ = 'Asia/Jerusalem';
let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${expected}\n        actual   ${actual}`);
}

/** Local wall-clock string of an instant, for readable assertions. */
function local(ts: number | null): string {
  if (ts === null) return 'null';
  const p = wallParts(ts, TZ);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (dow ${p.dow})`;
}

// --- daily -----------------------------------------------------------------
{
  const s: Schedule = { type: 'daily', time: '07:30' };
  const from = wallToUtc(2026, 8, 2, 6, 0, TZ); // Sun 02 Aug 2026, 06:00 local
  check('daily before the time fires today', local(computeNext(s, TZ, from)), '2026-08-02 07:30 (dow 0)');

  const after = wallToUtc(2026, 8, 2, 9, 0, TZ);
  check('daily after the time rolls to tomorrow', local(computeNext(s, TZ, after)), '2026-08-03 07:30 (dow 1)');

  const exact = wallToUtc(2026, 8, 2, 7, 30, TZ);
  check('daily at the exact minute moves on', local(computeNext(s, TZ, exact)), '2026-08-03 07:30 (dow 1)');
}

// --- weekly ----------------------------------------------------------------
{
  const s: Schedule = { type: 'weekly', time: '18:00', days: [0, 2, 4] }; // Sun/Tue/Thu
  const from = wallToUtc(2026, 8, 2, 20, 0, TZ); // Sunday evening, past 18:00
  const first = computeNext(s, TZ, from);
  check('weekly skips to the next listed day', local(first), '2026-08-04 18:00 (dow 2)');
  check('weekly chains correctly', local(computeNext(s, TZ, first!)), '2026-08-06 18:00 (dow 4)');
}

// --- DST: spring forward ---------------------------------------------------
{
  // Israel 2026: clocks jump 02:00 -> 03:00 on Fri 27 Mar (the Friday before
  // the last Sunday of March). A 07:30 reminder must stay 07:30 across it,
  // which means the real gap that morning is 23 hours, not 24.
  const s: Schedule = { type: 'daily', time: '07:30' };
  const before = wallToUtc(2026, 3, 25, 9, 0, TZ);
  const a = computeNext(s, TZ, before);
  check('DST spring: day before the shift', local(a), '2026-03-26 07:30 (dow 4)');
  const b = computeNext(s, TZ, a!);
  check('DST spring: still 07:30 after the shift', local(b), '2026-03-27 07:30 (dow 5)');
  check('DST spring: real gap is 23h', (b! - a!) / 3_600_000, 23);
}

// --- DST: fall back --------------------------------------------------------
{
  // Clocks go back on Sun 25 Oct 2026, so that morning is 25 hours long.
  const s: Schedule = { type: 'daily', time: '07:30' };
  const before = wallToUtc(2026, 10, 23, 9, 0, TZ);
  const a = computeNext(s, TZ, before);
  check('DST autumn: day before the shift', local(a), '2026-10-24 07:30 (dow 6)');
  const b = computeNext(s, TZ, a!);
  check('DST autumn: still 07:30 after the shift', local(b), '2026-10-25 07:30 (dow 0)');
  check('DST autumn: real gap is 25h', (b! - a!) / 3_600_000, 25);
}

// --- once ------------------------------------------------------------------
{
  const s: Schedule = { type: 'once', at: '2026-08-05T14:00' };
  const from = wallToUtc(2026, 8, 2, 0, 0, TZ);
  const t = computeNext(s, TZ, from);
  check('once fires at the stated local time', local(t), '2026-08-05 14:00 (dow 3)');
  check('once does not repeat', computeNext(s, TZ, t!), null);
}

// --- interval --------------------------------------------------------------
{
  const s: Schedule = { type: 'interval', minutes: 90 };
  const from = Date.UTC(2026, 7, 2, 12, 0, 0);
  check('interval adds the minutes', (computeNext(s, TZ, from)! - from) / 60000, 90);
}

// --- quiet hours -----------------------------------------------------------
{
  const at = (h: number, m = 0) => wallToUtc(2026, 8, 2, h, m, TZ);
  check('quiet at 03:00', isQuietHour(at(3), TZ, 23, 8), true);
  check('quiet at 23:30', isQuietHour(at(23, 30), TZ, 23, 8), true);
  check('awake at 08:00 exactly', isQuietHour(at(8), TZ, 23, 8), false);
  check('awake at 14:00', isQuietHour(at(14), TZ, 23, 8), false);
  check('window disabled when start == end', isQuietHour(at(3), TZ, 0, 0), false);

  // A non-wrapping window (e.g. a siesta) must work too.
  check('non-wrapping window inside', isQuietHour(at(14), TZ, 13, 16), true);
  check('non-wrapping window outside', isQuietHour(at(17), TZ, 13, 16), false);
}

// --- pushing out of quiet hours --------------------------------------------
{
  const noJitter = () => 0;
  // 03:00 is the morning half of the window: wake is later the SAME day.
  const early = afterQuietHours(wallToUtc(2026, 8, 2, 3, 0, TZ), TZ, 23, 8, noJitter);
  check('3am defers to 08:00 same day', local(early), '2026-08-02 08:00 (dow 0)');

  // 23:30 is the evening half: wake is the NEXT day, across a month boundary.
  const late = afterQuietHours(wallToUtc(2026, 8, 31, 23, 30, TZ), TZ, 23, 8, noJitter);
  check('11:30pm on the 31st defers to the 1st', local(late), '2026-09-01 08:00 (dow 2)');

  const awake = wallToUtc(2026, 8, 2, 14, 0, TZ);
  check('awake hours are left alone', afterQuietHours(awake, TZ, 23, 8, noJitter), awake);
}

// --- check-in scheduling ---------------------------------------------------
{
  // 2/day across 15 waking hours = a 7.5h average gap, jittered 0.6x..1.4x.
  const from = wallToUtc(2026, 8, 2, 9, 0, TZ);
  const minGap = (nextCheckinTime(from, TZ, 2, 23, 8, () => 0) - from) / 3_600_000;
  const maxGap = (nextCheckinTime(from, TZ, 2, 23, 8, () => 0.999) - from) / 3_600_000;
  check('shortest gap is 0.6x the average', Math.round(minGap * 10) / 10, 4.5);
  check('longest gap stays under a full day', maxGap < 24, true);

  // Never schedules into the small hours, however the jitter falls.
  let landedInQuiet = 0;
  for (let i = 0; i < 500; i++) {
    const base = wallToUtc(2026, 8, 2, 6 + (i % 18), (i * 7) % 60, TZ);
    const t = nextCheckinTime(base, TZ, 4, 23, 8);
    if (isQuietHour(t, TZ, 23, 8)) landedInQuiet++;
  }
  check('500 random check-ins, none inside quiet hours', landedInQuiet, 0);
}

// --- relative times ("in N minutes") ---------------------------------------
// The router hands back in_minutes and TypeScript builds the wall string; this
// is the round trip that was silently producing no reminder at all.
{
  const now = wallToUtc(2026, 8, 2, 22, 34, TZ);
  const at = wallString(now + 5 * 60_000, TZ);
  check('5 minutes later', at, '2026-08-02T22:39');
  check('round-trips through computeNext', local(computeNext({ type: 'once', at }, TZ, now)), '2026-08-02 22:39 (dow 0)');

  // Crossing midnight, month end and year end without the model doing maths.
  check('crosses midnight', wallString(wallToUtc(2026, 8, 2, 23, 58, TZ) + 5 * 60_000, TZ), '2026-08-03T00:03');
  check('crosses month end', wallString(wallToUtc(2026, 8, 31, 23, 50, TZ) + 20 * 60_000, TZ), '2026-09-01T00:10');
  check('crosses year end', wallString(wallToUtc(2026, 12, 31, 23, 45, TZ) + 30 * 60_000, TZ), '2027-01-01T00:15');
}

// --- formatting ------------------------------------------------------------
console.log(`\nformatLocal sample: ${formatLocal(wallToUtc(2026, 8, 2, 7, 30, TZ), TZ)}`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
if (failures > 0) (globalThis as any).process?.exit?.(1);
