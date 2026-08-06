# נו? — a personal nagging bot

> The name is the product. Your phone buzzes, the sender says **נו?**, and you
> already know what it's about before you open it.

A private Telegram bot that reminds you, chases you, demands proof, and is a bit
of a dick about it. Runs entirely on free tiers.

**Stack:** Telegram Bot API → Cloudflare Worker (webhook + 1-minute cron) → D1 (SQLite) → Gemini Flash-Lite.

**Cost:** $0 at personal volume. ~1,440 cron invocations/day against a 100,000/day
free allowance, and a couple of Gemini calls per message against a free tier of
roughly 15 RPM / 1,500 RPD. Verify current limits before you scale it up.

---

## How it works

```
Telegram ──webhook──> Worker /tg ──> route()  (Gemini, temp 0, JSON)  → decides WHAT
                                 └─> applyIntent()  (plain TS)        → touches the DB
                                 └─> speak()   (Gemini, temp 1.05)    → decides HOW it sounds

cron * * * * * ──> tick() ──> fire due reminders
                          ├─> nag open instances, escalating each round
                          └─> give up after max_nags, mark failed
```

Two design decisions worth keeping:

**One cron, not one cron per reminder.** Scheduling lives in
`reminders.next_fire_at`; the tick just asks "what's due?". This is what makes
snoozing, escalation and arbitrary recurrence possible — and it never runs out
of cron triggers.

**The router and the personality are separate calls.** The personality never
gets write access to the database, and the scheduler never has to sound like a
form letter. `route()` returns structured JSON at temperature 0; `speak()` takes
a factual note produced by ordinary TypeScript and dresses it in character.

---

## Setup

### 1. Create the bot

Talk to [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → keep the token.

Usernames must be Latin and end in `bot`, so pick something like `NuNudnikBot`.
The **display name** is separate and does support Hebrew — set it with
`/setname` → `נו?`. That display name is what appears on notifications, which is
the whole point.

Optionally `/setprivacy` → Disable, and `/setcommands`:

```
help - כל הפקודות
list - התזכורות שלך
goals - המטרות שלך
stats - המספרים שלך
chill - שתיקה זמנית
checkins - כמה אני יוזם שיחות
intensity - כמה עוקצני אני
quiet - שעות שקט
offlimits - נושאים אסורים
```

### 2. Get a Gemini API key

[aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free tier, no card.

### 3. Install and create the database

```bash
npm install
npx wrangler login
npx wrangler d1 create nu-bot
```

Copy the printed `database_id` into `wrangler.toml`, then:

```bash
npm run db:init
```

**Already deployed an earlier version?** `db:init` drops your data. Run the
migration instead:

```bash
npx wrangler d1 execute nu-bot --remote --file=./migrations/001_goals.sql
```

### 4. Secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN      # from BotFather
npx wrangler secret put GEMINI_API_KEY          # from AI Studio
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET # any random string you invent
npx wrangler secret put OWNER_CHAT_ID           # put 0 for now
```

### 5. Deploy and wire up the webhook

```bash
npm run deploy
```

Note the deployed URL, then register it (substitute your token, secret and URL):

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://nu-bot.<subdomain>.workers.dev/tg","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message"]}'
```

**On Windows PowerShell**, `curl` is an alias for `Invoke-WebRequest` and the
quoting will fight you. Use this instead — the single-quoted body is passed
through literally:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot<TOKEN>/setWebhook" `
  -ContentType "application/json" `
  -Body '{"url":"https://nu-bot.<subdomain>.workers.dev/tg","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message"]}'
```

You should get back `ok: True`. To check it later:
`Invoke-RestMethod "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` —
`last_error_message` is where a broken deploy shows up.

### 6. Claim the bot

Message it anything. Because `OWNER_CHAT_ID` is still `0`, it replies with your
chat id. Set it for real and redeploy:

```bash
npx wrangler secret put OWNER_CHAT_ID   # paste the number it gave you
npm run deploy
```

From here on, every message from any other chat id is silently dropped.

---

## Reminders vs goals

Two different things, and the distinction is the whole point:

- A **reminder** has a clock. "Run at 07:00 daily." It fires, then nags.
- A **goal** has no clock. "Open a trading account." "Learn Bava Batra." It just
  sits there, and the bot brings it up *on its own* when it's gone quiet.

Goals are what make it feel like something that remembers you rather than
something that fires events. The router decides which one you meant: describe an
ambition without a time and you get a goal, not an invented 9am alarm.

Every check-in references what you last said about that goal, so the second
conversation isn't a repeat of the first. It picks whichever active goal it has
asked about least recently.

## Using it

Talk normally, in Hebrew or English:

- `תזכיר לי כל יום ב-7:00 לרוץ, ותדרוש תמונה` → reminder
- `כל שני ורביעי ב-20:00 להתקשר לסבתא` → reminder
- `אני רוצה סוף סוף לפתוח תיק מסחר` → goal, and it'll chase you about it
- `התקדמתי קצת עם התיק, מילאתי טפסים` → logged as progress on that goal
- `סיימתי` / send a photo → it judges the photo against the task
Full command list (`/help` prints it in the chat):

| Command | Does |
|---|---|
| `/list` | Reminders, with next fire time |
| `/goals` | Ongoing goals + last progress on each |
| `/stats` | Streak, done, failed |
| `/chill [hours]` | Total silence, default 4h. Any message from you cancels it. |
| `/checkins on\|off\|1-8` | How often it starts conversations |
| `/intensity 1\|2\|3` | Snark dial |
| `/quiet [start] [end]` | Quiet hours, e.g. `/quiet 23 8` |
| `/offlimits [text]` | Topics it must never touch. No argument shows current; `clear` wipes. |
| `/diag` | Health check: model name, whether the key is set, live Gemini + D1 probe |

## Unprompted check-ins

Off by default until you have goals; twice a day once you do, spread across
waking hours with heavy jitter (0.6×–1.4× the average gap) so it never reads as
a cron job. It stays quiet when:

- you're inside quiet hours (23:00–08:00 by default)
- there's already an open task it's nagging you about — piling a check-in on top
  of a nag is how a bot goes from useful to noise
- there's nothing real to ask about; it won't manufacture a topic

Quiet hours also defer *nags* rather than spending them, so an ignored 3am
message never counts as a strike against you. Explicit reminders still fire at
whatever time you set — if you asked for 05:30, you get 05:30.

## The nag ladder — it shrinks, it doesn't shout

The single most important design decision, and the one taken straight from
watching real Botivatzia transcripts: **when you resist, the ask gets smaller,
not louder.**

| Round | What it does |
|---|---|
| 1 | Reminder + one concrete small action |
| 2 | No reply → offers half the task, or only its first step |
| 3 | Still nothing → cuts it to something almost insultingly small, and names the avoidance pattern |
| 4 | Offers a dignified out: do the tiny thing now, or say out loud it isn't happening today |
| — | Gives up, logs a failure, offers to reschedule |

"Forget tidying, just fill one bag." "Close one function today and we'll talk."
"Open the account by yourself now, do the transfer together tomorrow."

Rising volume is what gets these bots muted in week two. A shrinking ask is what
makes them work, because the blocker is almost never motivation — it's that the
task feels large. `nag_interval_min` (default 20) and `max_nags` (default 3) are
per-reminder columns.

## Tuning the personality

Everything lives in `src/persona.ts`. Edit, `npm run deploy`, done.
`INTENSITY` is the 1–3 snark dial, `NAG_LADDER` is the shrinking ladder above.

It replies in **bursts of short messages** rather than paragraphs (`sendBurst` in
`src/telegram.ts` splits on blank lines), paced at roughly 22 characters per
second with jitter. The rhythm carries a surprising amount of the character.

The persona no longer decides *what* to say. `src/voice.ts` produces a correct,
blunt Hebrew message from what the database actually did; the model rewrites it
in character; `src/validate.ts` throws the rewrite away if it invented a time, a
task, or a confirmation. `/diag` reports how often that happens.

Two guardrails in there are load-bearing, and I'd leave them:

- **Behaviour, not person.** It mocks the procrastination, never your worth,
  body, or intelligence. LLMs drift meaner over a long context, especially with
  a snark instruction and a growing log of your failures to draw on. Without an
  explicit ceiling this gets genuinely unpleasant around week three.
- **The distress override.** If you sound actually burnt out or unwell, it drops
  the act entirely. A bot that keeps nagging someone having a bad week is worse
  than no bot.

You can also set `settings.off_limits` (free text) to name topics it must never
touch. Worth doing.

## Local development

```bash
npm run typecheck
npm test              # all three suites, no framework
npm run test:time     # recurrence + DST checks
npm run test:parse    # the deterministic phrase parser
npm run test:bot      # end-to-end: webhook + cron against real SQLite
npx wrangler dev      # local Worker; use `npx wrangler tail` for live logs
```

`test/time.test.ts` covers the part most likely to break silently: daily and
weekly recurrence across Israel's DST transitions, where a naive
`+24h` implementation drags a 07:30 reminder to 06:30 twice a year.

`test/bot.test.ts` runs the real `fetch` and `scheduled` handlers against an
in-memory SQLite standing in for D1, with Gemini and Telegram stubbed
(`test/harness.ts`). It exists because the failures that actually hurt are the
ones no unit test sees: a reminder that is marked as fired but never sent, or a
recurring reminder that quietly becomes a one-off. Every case in it is a bug
that reached production.

## Files

| File | Job |
|---|---|
| `src/index.ts` | Webhook handler + cron tick + nag loop + check-ins |
| `src/brain.ts` | `route()`, `speak()`, `judgePhoto()` |
| `src/persona.ts` | The entire personality |
| `src/commands.ts` | Intent → database, plus slash commands |
| `src/time.ts` | Timezone, recurrence, quiet hours, check-in jitter |
| `src/db.ts` | D1 queries |
| `src/gemini.ts` | Gemini REST wrapper |
| `src/telegram.ts` | Bot API + message bursting |
| `schema.sql` | Tables |
| `migrations/` | Incremental changes for a live database |

## Notes

- Cloudflare does not retry a failed `scheduled()` run. A crashed tick means a
  missed minute, but nothing is lost — the next tick re-reads `next_fire_at` and
  fires whatever is still due.
- The free plan's 10ms CPU limit sounds alarming but only counts CPU, not time
  spent awaiting `fetch()`, so waiting on Gemini is free.
- `messages` is pruned to the last 200 rows per chat automatically.
