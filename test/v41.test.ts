/**
 * Run with `npm run test:v41`.
 *
 * **"An hour and twenty" was an hour, and the twenty became the errand.**
 *
 * Production #93, אמנון, 22.09.2026 11:18:
 *
 *   him  תזכיר לי עוד שעה ועשרים להעביר כביסה למייבש
 *   row  "ועשרים להעביר כביסה למייבש", once, 12:18
 *
 * It never reached the model. quickparse handled it, and `parseRelative` knew
 * exactly two things that may follow a unit — וחצי and ורבע. So `REL_BARE`
 * matched the shorter "עוד שעה", read 60, and left "ועשרים" at the head of the
 * title. `hasTimeResidue` is supposed to catch a time word left in a title and
 * did not know this one either: the parse was accepted as a confident wrong
 * answer, the one thing quickparse's rule 2 exists to refuse. It rang forty
 * minutes before the laundry was done, under a title that read it back to him.
 *
 * What must hold:
 *
 *   1. The colloquial compound — שעה ועשרים, שעתיים ועשר, שעה ו-20 דקות — is
 *      read whole, on every path that reads a length: create, readWhen,
 *      snooze, the answer to "מתי?", and validate's scan.
 *   2. A compound this file cannot read REFUSES. It is not read as its first
 *      half — that is #93 — and it is not guessed at.
 *   3. וחצי / ורבע still work, because they were the only thing that did.
 */
import worker from '../src/index';
import {
  parseAnswerTime,
  parseDuration,
  parseRelative,
  quickParse,
  scanDurations,
} from '../src/quickparse';
import { readWhen } from '../src/when';
import { wallToUtc } from '../src/time';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';
const TZ = 'Asia/Jerusalem';

/** 22.09.2026 11:18 — when #93 was written. */
const NOW = wallToUtc(2026, 9, 22, 11, 18, TZ);

const LAUNDRY = 'להעביר כביסה למייבש';

async function runWebhook(rig: Rig, text: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException() {},
  };
  const req = new Request('https://x/tg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text, message_id: 999 } }),
  });
  await worker.fetch(req, rig.env, ctx);
  await Promise.all(pending);
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section('#93 exactly: the compound is read whole, and the title is his errand');
  {
    const q = quickParse(`תזכיר לי עוד שעה ועשרים ${LAUNDRY}`, NOW, TZ);
    eq('eighty minutes, not sixty', q?.in_minutes, 80);
    eq('the errand, without the twenty', q?.title, LAUNDRY);
  }

  // -------------------------------------------------------------------------
  section('the shapes he reaches for');
  {
    // [sentence, minutes]. Each is asserted against its own number, so a
    // regression to the first half — 60, 120 — fails per case rather than
    // hiding behind a neighbour that happens to work.
    const cases: [string, number][] = [
      [`עוד שעה ועשרים ${LAUNDRY}`, 80],
      [`עוד שעה ועשר ${LAUNDRY}`, 70],
      [`עוד שעה וחמש ${LAUNDRY}`, 65],
      [`עוד שעה וארבעים ${LAUNDRY}`, 100],
      [`עוד שעה ו-20 ${LAUNDRY}`, 80],
      [`עוד שעה ו20 דקות ${LAUNDRY}`, 80],
      [`עוד שעה ועשרים דקות ${LAUNDRY}`, 80],
      [`עוד שעה ושתי דקות ${LAUNDRY}`, 62],
      [`בעוד שעתיים ועשר ${LAUNDRY}`, 130],
      [`עוד 3 שעות ו-15 דקות ${LAUNDRY}`, 195],
      // The two that always worked must still work.
      [`עוד שעה וחצי ${LAUNDRY}`, 90],
      [`עוד שעתיים ורבע ${LAUNDRY}`, 135],
    ];
    for (const [text, minutes] of cases) {
      const q = quickParse(`תזכיר לי ${text}`, NOW, TZ);
      eq(`quickParse: ${text}`, q?.in_minutes, minutes);
      eq(`  title: ${text}`, q?.title, LAUNDRY);
    }
  }

  // -------------------------------------------------------------------------
  section('a compound this file cannot read refuses, rather than reading half');
  {
    // [sentence, the half-reading that must NOT come back]. Enumerated per
    // case: "not 60" is the #93 answer, and each of these has its own.
    const cases: [string, number][] = [
      // Minutes tacked onto days mean nothing anybody says.
      [`עוד יומיים ועשרים ${LAUNDRY}`, 2880],
      [`עוד יום ועשר ${LAUNDRY}`, 1440],
      // A small bare number after ו is a count of something, not minutes.
      [`עוד שעה ושני דברים ${LAUNDRY}`, 60],
      // Not a minute count at all.
      [`עוד שעה ו-75 ${LAUNDRY}`, 60],
      // Two number words — the second half would be left in the title.
      [`עוד שעה ועשרים וחמש ${LAUNDRY}`, 80],
      // The fraction path takes no tail at all, so anything after it is unread.
      [`עוד חצי שעה ועשר ${LAUNDRY}`, 30],
    ];
    for (const [text, half] of cases) {
      const rel = parseRelative(text);
      check(`parseRelative refuses: ${text}`, rel === null, `got ${JSON.stringify(rel)}`);
      const q = quickParse(`תזכיר לי ${text}`, NOW, TZ);
      check(
        `quickParse does not write ${half}m: ${text}`,
        q === null || (q.in_minutes !== half && !/^ו/.test(q.title ?? '')),
        `got ${JSON.stringify(q)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  section('the clock half of the same bug: "בשמונה ועשרים" is not 08:00');
  {
    // Found by probing the fix, not reported — matchClock had its own copy of
    // the וחצי/ורבע-only tail, so "בשמונה ועשרים" was written for 08:00 under
    // the title "ועשרים ...", exactly #93 one function over.
    // An unsettled hour at 11:18 is the next 08:20, with the evening offered
    // as a one-tap correction — the existing design, not this bug.
    const read: [string, string][] = [
      [`בשמונה ועשרים ${LAUNDRY}`, '2026-09-23T08:20'],
      [`ב-8 ועשרים בערב ${LAUNDRY}`, '2026-09-22T20:20'],
      [`בשעה תשע וחמש בערב ${LAUNDRY}`, '2026-09-22T21:05'],
      [`ב-8 ו-20 דקות בערב ${LAUNDRY}`, '2026-09-22T20:20'],
      [`בשמונה ורבע בערב ${LAUNDRY}`, '2026-09-22T20:15'],
    ];
    for (const [text, at] of read) {
      const q = quickParse(`תזכיר לי ${text}`, NOW, TZ);
      eq(`clock: ${text}`, q?.once_at, at);
      eq(`  title: ${text}`, q?.title, LAUNDRY);
    }

    // "ב-8 ו-9" is two times as often as it is 08:09. Neither reading, and
    // never 08:00 with "ו-9" in the title.
    for (const text of [`ב-8 ו-9 ${LAUNDRY}`, `בשמונה ועשרים וחמש ${LAUNDRY}`]) {
      const q = quickParse(`תזכיר לי ${text}`, NOW, TZ);
      check(`clock refuses: ${text}`, q === null, `got ${JSON.stringify(q)}`);
    }
  }

  // -------------------------------------------------------------------------
  section('every path that reads a length reads the same one');
  {
    // readWhen is the router path's reader (via preferHisWords). Had quickparse
    // bailed on #93, this is where the 60 would have come from instead.
    const w = readWhen(`עוד שעה ועשרים ${LAUNDRY}`, NOW, TZ);
    eq('readWhen', JSON.stringify(w), JSON.stringify({ kind: 'duration', minutes: 80 }));

    // Snooze. "תדחה לי בשעה ועשרים" on a ringing reminder.
    eq('parseDuration, עוד', parseDuration('עוד שעה ועשרים'), 80);
    eq('parseDuration, ב', parseDuration('תדחה בשעתיים ועשר'), 130);

    // The answer to "מתי?" — a wrong one retimes a real reminder.
    eq('parseAnswerTime', parseAnswerTime('עוד שעה ועשרים', NOW, TZ), NOW + 80 * 60_000);

    // validate's scan answers the same question with its own regex. A rewrite
    // saying "כבר שעה ועשרים" about an 80-minute wait must scan as 80, or a
    // true sentence is rejected as an invented 60.
    const hits = scanDurations('כבר שעה ועשרים שזה מחכה');
    eq('scanDurations', JSON.stringify(hits.map((h) => h.minutes)), '[80]');
  }

  // -------------------------------------------------------------------------
  section('end to end: the row rings at 12:38, under his title');
  {
    const rig = createRig();
    rig.speakQueue.push('קבעתי.');
    await withNow(NOW, () => runWebhook(rig, `תזכיר לי עוד שעה ועשרים ${LAUNDRY}`));
    const row = rig.db
      .prepare('SELECT title, next_fire_at FROM reminders WHERE chat_id = ?')
      .get(CHAT) as { title: string; next_fire_at: number } | undefined;
    check('a row was written', row !== undefined, 'no reminder row');
    eq('it rings eighty minutes out', row?.next_fire_at, NOW + 80 * 60_000);
    eq('under his title', row?.title, LAUNDRY);
    rig.restore();
  }

  done();
}

main();
