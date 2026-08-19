/**
 * Run with `npm run test:whoami`.
 *
 * Who the bot thinks it is talking to.
 *
 * Everything user-facing in this codebase is keyed by chat_id — reminders,
 * instances, goals, usage, friends. The persona prompt was the one place that
 * was not: it opened `אתה הבוט האישי של שחר`, hardcoded, for every chat.
 *
 * Production, 09.08.2026, chat B — a guest, not שחר:
 *
 *   שחר, לא צריך את כל האימון.
 *   רק שים נעליים וצא מהדלת.
 *
 * A nag, addressed to the wrong person by name. There are two guests on the
 * allow-list today and every one of them gets this.
 */
import worker from '../src/index';
import * as db from '../src/db';
import { buildSystemPrompt } from '../src/persona';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';
import type { Settings, Stats } from '../src/types';

const OWNER = '12345';
const GUEST = '67890';
const TZ = 'Asia/Jerusalem';
const NOW = Date.UTC(2026, 7, 20, 6, 0);

async function say(rig: Rig, chatId: string, text: string, firstName?: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
  await worker.fetch(
    new Request('https://x/tg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        message: {
          chat: { id: Number(chatId) },
          from: { id: Number(chatId), ...(firstName ? { first_name: firstName } : {}) },
          text,
          message_id: 999,
        },
      }),
    }),
    rig.env,
    ctx,
  );
  await Promise.all(pending);
}

const stats: Stats = { done7: 0, failed7: 0, done30: 0, failed30: 0, currentStreak: 0 };
function settingsFor(chatId: string, displayName: string | null): Settings {
  return {
    chat_id: chatId, tz: TZ, intensity: 2, muted_until: null, off_limits: null,
    checkins_enabled: 0, checkin_per_day: 2, quiet_start_hour: 23, quiet_end_hour: 8,
    next_checkin_at: null, awaiting: null, display_name: displayName,
    brief_hour: null, closeout_hour: null, last_brief_on: null, last_closeout_on: null,
  };
}

section('the prompt names whoever is actually in the chat');
{
  const named = buildSystemPrompt(settingsFor(GUEST, 'אמנון'), stats, 'עכשיו', '(אין)', '(אין)', '(אין)');
  check('a chat with a known name gets that name', named.includes('אמנון'), named.slice(0, 160));
  check('and never the owner\'s', !named.includes('שחר'), named.slice(0, 160));

  // The fallback matters as much as the name. A chat whose owner has never
  // sent a message from a named account (a friend's reminder landing in a
  // fresh chat, say) must simply not be addressed by name, rather than being
  // addressed by somebody else's.
  const anon = buildSystemPrompt(settingsFor(GUEST, null), stats, 'עכשיו', '(אין)', '(אין)', '(אין)');
  check('an unknown chat is addressed by no name at all', !anon.includes('שחר'), anon.slice(0, 160));
  check('and the prompt still opens coherently',
    anon.includes('נו?') && anon.length > 500, anon.slice(0, 160));
}

section('the name is captured from Telegram and survives into the cron path');
{
  const rig = createRig({ chatId: OWNER, tz: TZ });
  await withNow(NOW, async () => {
    // A guest, allowed in, talking for the first time.
    await db.setAllowedChats(rig.env, [GUEST]);
    rig.routerQueue.push({ actions: [{ action: 'chat' }] });
    rig.speakQueue.push('נו?');
    await say(rig, GUEST, 'מה קורה', 'אמנון');

    const s = await db.getSettings(rig.env, GUEST);
    eq('his Telegram name is stored on his own settings row', s.display_name, 'אמנון');

    // The prompt for HIS turn — the thing the model actually read.
    const spoke = rig.geminiCalls.filter((c) => c.kind === 'speak').pop();
    const persona = spoke?.system.split('## מה שקרה עכשיו')[0] ?? '';
    check('the guest\'s own turn is not addressed to the owner',
      !persona.includes('שחר'), persona.slice(0, 200));
    check('it is addressed to him', persona.includes('אמנון'), persona.slice(0, 200));

    // And the owner still gets his own name, from his own row.
    await db.setDisplayName(rig.env, OWNER, 'שחר');
    const ownerPrompt = buildSystemPrompt(
      await db.getSettings(rig.env, OWNER), stats, 'עכשיו', '(אין)', '(אין)', '(אין)');
    check('the owner is still addressed by his name', ownerPrompt.includes('שחר'), ownerPrompt.slice(0, 160));
  });
  rig.restore();
}

done();
