# נו? — a personal nagging bot

> The name is the product. Your phone buzzes, the sender says **נו?**, and you
> already know what it's about before you open it.

A private Telegram bot that reminds you, chases you, demands proof, and is a bit
of a dick about it. Runs entirely on free tiers.

**Stack:** Telegram Bot API → Cloudflare Worker (webhook + 1-minute cron) → D1 (SQLite) → Gemini, primary model with a cheaper fallback.

**Cost:** $0 at personal volume. ~1,440 cron invocations/day against a 100,000/day
free allowance, and a couple of Gemini calls per message against a free tier of
roughly 15 RPM / 1,500 RPD. Verify current limits before you scale it up. Past a
configurable daily call count, unprompted check-ins stop calling the model
entirely and ship deterministic text instead — see **Model configuration**
below.

---

## How it works

```
Telegram ──webhook──> Worker /tg
    ├─ message ────────> route() (Gemini, temp 0.2, JSON) → decides WHAT
    │                    applyIntent() (plain TS, effects.ts) → touches the DB → Effect[]
    └─ callback_query ─> buttons.ts decode() → touches the DB → Effect[]
                          (no model call — the effect and its Hebrew are already known)

Effect[]
  → buildFacts()      (facts.ts)     allow-lists of times/titles the reply may mention
  → renderBaseline()  (voice.ts)     correct, blunt Hebrew — shippable on its own, no model needed
  → speak()           (Gemini, temp 1.05) rewrites the baseline in character
  → validate()        (validate.ts) throws the rewrite away if it strays from the facts
  → send: the rewrite if it passed validation, the baseline otherwise

cron * * * * * ──> tick() ──> fire due reminders
                          ├─> nag open instances, escalating each round
                          ├─> give up after max_nags, mark failed
                          └─> occasionally start a check-in, only if a goal exists to ask about
```

Design decisions worth keeping:

**One cron, not one cron per reminder.** Scheduling lives in
`reminders.next_fire_at`; the tick just asks "what's due?". This is what makes
snoozing, escalation and arbitrary recurrence possible — and it never runs out
of cron triggers.

**The router and the personality are separate calls.** The personality never
gets write access to the database, and the scheduler never has to sound like a
form letter. `route()` returns structured JSON at temperature 0.2 (the lowest
that stays clear of Gemini's RECITATION filter on constrained decoding — see
`src/gemini.ts`); `applyIntent()`
is ordinary TypeScript that touches the database and returns a list of
`Effect`s — a typed record of what actually happened.

**The model never originates a fact, only rephrases one.** `voice.ts` renders
every `Effect` into correct, deterministic Hebrew before the model ever sees it
— that baseline is what actually gets sent if anything downstream fails. The
model's only job is making that text sound like נו?; `validate.ts` compares the
rewrite against the same allow-lists the baseline was built from — clock-format
times (`HH:MM`) and titles — and discards it if it invented one. That check is
narrower than "any fact": a hallucinated streak count or nag round isn't in an
allow-list at all, so it isn't caught this way. A button tap skips the model
entirely — the effect and its Hebrew are already fully known, so a tap is both
free of quota and the fastest path in the bot.

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
inbox - דברים שתפסתי בלי שעה
stats - המספרים שלך
chill - שתיקה זמנית
checkins - כמה אני יוזם שיחות
intensity - כמה עוקצני אני
quiet - שעות שקט
offlimits - נושאים אסורים
diag - בדיקת תקינות
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
migrations instead, in order, once each:

```bash
npx wrangler d1 execute nu-bot --remote --file=./migrations/001_goals.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/002_inbox_and_usage.sql
```

`002` adds `reminders.status` (the inbox) and the `usage` table. Re-running it
errors with "duplicate column name", which is safe to ignore.

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
  -d '{"url":"https://nu-bot.<subdomain>.workers.dev/tg","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
```

**On Windows PowerShell**, `curl` is an alias for `Invoke-WebRequest` and the
quoting will fight you. Use this instead — the single-quoted body is passed
through literally:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot<TOKEN>/setWebhook" `
  -ContentType "application/json" `
  -Body '{"url":"https://nu-bot.<subdomain>.workers.dev/tg","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
```

You should get back `ok: True`. To check it later:
`Invoke-RestMethod "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` —
`last_error_message` is where a broken deploy shows up.

Inline buttons arrive as a different update type from a plain text message, so
the webhook must explicitly opt in — that's the `"callback_query"` in
`allowed_updates` above. **If you registered the webhook before this change**
(or ever registered it without that field), re-register with both:

```json
{"allowed_updates":["message","callback_query"]}
```

Without `callback_query` in that list, every button tap is silently dropped —
no error, no log entry, nothing. It is the single most likely cause of "I
deployed it and the buttons don't work."

### 6. Claim the bot

Message it anything. Because `OWNER_CHAT_ID` is still `0`, it replies with your
chat id. Set it for real and redeploy:

```bash
npx wrangler secret put OWNER_CHAT_ID   # paste the number it gave you
npm run deploy
```

From here on, every message from any other chat id is silently dropped.

---

## Model configuration

`wrangler.toml` sets these under `[vars]`:

```toml
GEMINI_MODEL = "gemini-3.5-flash"
GEMINI_MODEL_FALLBACK = "gemini-3.5-flash-lite"
GEMINI_MODELS = "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite"
GEMINI_SOFT_LIMIT = "200"
GEMINI_RPM = "18"
```

The free tier meters requests **per minute, per model**, against one key — so
a ladder of models is capacity, not just redundancy. `GEMINI_MODEL` and
`GEMINI_MODEL_FALLBACK` are the top two rungs; `GEMINI_MODELS` is everything
under them. A call walks down until one answers.

**None of these ids has been verified against any particular key** — they're
forward-looking pins. That is survivable by design: an id that doesn't exist
returns 404, and the bot treats 404, 429 (quota) and 503 (overloaded) the same
way — step down a rung, and *write the model off* so the next message skips it
without paying for a round trip:

| Answer | Rest | Why |
|---|---|---|
| 429 | whatever Google's `retryDelay` says, else 5 min | a per-minute limit clears in a minute; taking Google's number back means not sitting out four of them for nothing |
| 503 | 1 min | transient overload |
| 404 | 6 h | a retired or misspelled id isn't coming back before lunch |

Each *consecutive* block doubles the wait (capped at 30 minutes; a day for a
404). Nothing else clears a block: **the expiry is the probe.** The next
message after it lapses tries the model again, because whether a quota has
reset is not knowable without asking. One success deletes the record outright,
so a model that was out for an hour starts its next bad minute at one strike
rather than five.

If every model is blocked at once, the blocks are **ignored** and the ladder is
walked anyway. They are an optimisation, and an optimisation is never a good
enough reason for the bot to say nothing.

`/diag` prints the ladder and exactly which rungs are out, with the reason and
the time they come back — so "the bot feels dumb today" becomes a fact you can
read. Verify current model names and free-tier limits at
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models).

`GEMINI_SOFT_LIMIT` only throttles unprompted check-ins, and it counts a chat's
calls **across the whole ladder** for the local day (the `usage` table): past
the limit, a check-in skips the model and sends `voice.ts`'s deterministic
Hebrew directly instead of paying for a rewrite. Reminders, nags, and give-ups
are never throttled — the budget priority is check-ins first, because a blunt
check-in is no worse than none, but a blunt reminder would be a regression.

---

## Friends — reminders you set for someone else

Both people have to be allowed to use the bot (`/allow`), and then:

```
/id                       your chat_id — this is what you hand a friend
/friend 12345 דנה         ask 12345 to be a friend, called "דנה" on your side
/friends                  who's in, who hasn't answered, who's waiting on you
/unfriend דנה             end it, both directions
```

`/friend` **asks**. It writes a pending row and sends her a message with two
buttons; nothing can be written into her chat until she taps yes. Saying yes
makes it mutual — she can set reminders for you too, named after your Telegram
name, which she can change with `/friend` at any time. Saying no is remembered,
and asking again won't ask her again.

Once she's in, it's ordinary language:

```
תזכיר לדנה מחר ב-8 לקחת את הרכב לטסט
```

The reminder is written **into her account**, at her timezone's 08:00, and she
gets told immediately that it exists and how to cancel it. When it fires, it
says who it's from — using her name for you, read at fire time, so renaming
works retroactively.

Guessing is refused rather than approximated throughout. A name that matches
nobody — or two people — gets a question, not a message in the wrong person's
chat. A reminder for a friend with no time in it is refused too: an inbox item
belongs to whoever can schedule it, and those buttons are on your side.

One limitation worth knowing: a reminder you set for her is **hers**. It shows
in her `/list` with her id, and only she can cancel it.

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
| `/inbox` | Things captured without a time — see below |
| `/stats` | Streak, done, failed |
| `/chill [hours]` | Total silence, default 4h. Any message from you cancels it. |
| `/checkins on\|off\|1-8` | How often it starts conversations |
| `/intensity 1\|2\|3` | Snark dial |
| `/quiet [start] [end]` | Quiet hours, e.g. `/quiet 23 8` |
| `/offlimits [text]` | Topics it must never touch. No argument shows current; `clear` wipes. |
| `/diag` | Health check: which model actually answered today and how many times (primary + fallback), rejected-rewrite count, whether the key is set, live Gemini + D1 probe |

## The inbox

If something that looks like a reminder request fails to parse into one — the
router errored, or the message was ambiguous — it doesn't just vanish. It's
captured verbatim into the inbox (`reminders.status = 'inbox'`) instead, and
the reply comes with buttons: *in an hour*, *this evening*, *tomorrow morning*,
or *no time* (stays in the inbox as a plain note). `/inbox` lists what's
waiting. This is the fallback for "the model choked but the user clearly asked
for something" — before it existed, that case was a silently dropped reminder.

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
npm run typecheck     # two projects: tsc --noEmit, then -p tsconfig.test.json
npm test              # all seven suites below, in order, no framework
npm run test:time     # recurrence + DST checks
npm run test:parse    # the deterministic phrase parser
npm run test:voice    # renderBaseline() — the deterministic Hebrew per Effect
npm run test:validate # the rewrite-vs-baseline validator
npm run test:buttons  # callback_data encode/decode + buttonsFor()
npm run test:bot      # end-to-end: webhook + cron against real SQLite
npm run test:facts    # buildFacts() allow-lists
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

`test/facts.test.ts` exists for a subtler reason: `facts.ts` builds the
allow-lists `validate.ts` enforces, so a gap there causes a *false rejection*
— the model rewrite told the truth and got discarded for it anyway. That
failure mode is invisible in production (the baseline still ships, so nothing
looks broken) which is exactly why it needs its own test rather than relying
on `validate.test.ts` to catch it indirectly.

## Files

| File | Job |
|---|---|
| `src/index.ts` | Webhook handler (messages + button callbacks) + cron tick + nag loop + check-ins |
| `src/brain.ts` | `route()`, `speak()`, `judgePhoto()` |
| `src/quickparse.ts` | Deterministic fast path for "remind me to X in N minutes" — skips the router (and its failure modes) for the single most common phrasing |
| `src/effects.ts` | `applyIntent()` — intent → database, returns the `Effect[]` that happened |
| `src/facts.ts` | `buildFacts()` — the allow-lists (times, titles) the validator enforces |
| `src/voice.ts` | `renderBaseline()` — deterministic, correct Hebrew for every `Effect` |
| `src/validate.ts` | Rejects a model rewrite that strays from the facts |
| `src/buttons.ts` | Inline-keyboard `callback_data` encode/decode + which buttons go on which message |
| `src/persona.ts` | The entire personality |
| `src/slash.ts` | Slash commands (`/list`, `/diag`, `/inbox`, ...), handled without an LLM call |
| `src/time.ts` | Timezone, recurrence, quiet hours, check-in jitter |
| `src/db.ts` | D1 queries |
| `src/gemini.ts` | Gemini REST wrapper: the model ladder, per-model blocking and probing, thinking-config fallback, usage tracking |
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
