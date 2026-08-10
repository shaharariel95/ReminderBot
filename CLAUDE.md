# נו? — working notes

A Hebrew accountability bot. Telegram → Cloudflare Worker (webhook + 1-minute
cron) → D1 → Gemini. It does not just remind: it nags, asks for proof, keeps
streaks, and brings up goals on its own.

Read `README.md` for setup and the product story. This file is about how to
change the code without breaking the thing that makes it worth having.

## The one rule

**The bot must never claim something it did not do.**

Every other rule here is downstream of that. A missed reminder is a bug; a
reminder the bot says it set and did not is the failure this whole codebase is
built to prevent. When a change forces a choice between saying less and
risking a false claim, say less.

## The pipeline every outgoing message goes through

```
effects (what the database actually did)
  → voice.ts    deterministic Hebrew, true by construction
  → speak()     the model rewrites it with personality
  → validate.ts checks the rewrite against the facts
  → send        rejected rewrites ship the baseline instead
```

`voice.ts` output is always shippable on its own. The model only ever makes it
nicer. If you add an `Effect` kind you must add its `voice.ts` wording, decide
whether it belongs in `WROTE` (types.ts), and add it to the sample lists in
`test/voice.test.ts` and `test/validate.test.ts` — they enumerate kinds by
hand and will not tell you it is missing.

`validate.ts` has four rules, each with an allow-list built by `facts.ts`:

1. clock times — only times the turn actually knows
2. write-claim verbs — only when something was written (`facts.wrote`)
3. quoted titles and prose — only real ones
4. elapsed-time claims — only spans the turn can back up

If you add a fact the model is shown, sweep it into `facts.ts` too, or the
validator will discard truthful rewrites for repeating what the prompt handed
them. That failure mode is silent: it shows up as a rising rejection count in
`/diag`, not as an error.

## Things that look like bugs and are not

- **`quickparse.ts` bails a lot on purpose.** A partial parse is a confident
  wrong answer; falling through to the router costs one LLM call. Rule 2 at the
  top of that file is the whole design.
- **Buttons never call the model.** The effect and its Hebrew are already
  known, so a tap costs no latency and no quota.
- **The deploy ping claims the version BEFORE sending.** A failed send loses
  one announcement; the reverse would re-announce every minute forever.
- **`greetStranger` is the only place the bot talks to someone unknown**, and
  it is bounded on purpose: two replies per chat ever, capped queue, denials
  remembered.

## Multi-user

Everything user-facing is keyed by `chat_id`. Access is `db.allowedChats` —
the owner plus a `meta`-backed guest list — and **the owner is always in that
set whatever the database says**, so a broken row degrades to owner-only rather
than locking everyone out.

The cron reads due rows for allowed chats **in SQL**, not in JS afterwards:
both queries carry `LIMIT 25`, and a revoked chat's stale rows would otherwise
fill the page forever and starve everyone else. Each chat ticks inside its own
`.catch` — one user's failure must not swallow another's reminders.

If you add a query that returns rows across users, ask what happens when a
second person exists. That exact question was worth asking: `dueReminders` and
`dueNags` read the whole table and everything was sent to `OWNER_CHAT_ID`.

## Testing

`npm test` runs eight files with a real in-memory SQLite behind a D1-shaped
facade (`test/harness.ts`). The webhook and cron paths run end to end, so
"the reminder never arrived" is reproducible rather than arguable.

**Write the test first, watch it fail, then implement.** And then do the thing
that actually matters here:

> **Prove each new test goes red when you delete the line it guards.**

This has repeatedly caught tests that asserted on something incidentally
true — a title that already contained the word being checked, an assertion
that only proved "a message was sent" when any message would do. A test that
stays green with its guard removed is worse than no test, because it is
counted as coverage.

Where two guards independently prevent the same bug, removing either alone
proves nothing. Remove both.

Useful rig facts: `rig.speakQueue.push(new Error(...))` fails only the
persona call (`geminiDown` kills the router too, which usually is not what you
want); `rig.dbFailOn` traps one write by SQL pattern; `deployed(rig)` simulates
a deploy; a fresh rig is a bot that is already running the current version.

## Deploying

```bash
npx wrangler d1 execute nu-bot --remote --file=./migrations/00N_x.sql   # if any
npm run deploy
```

- **Bump `src/version.ts` first.** It is what tells the running Worker it is
  new, and it is what `/diag` reports. Deploying without bumping is silent.
- **Never run `npm run db:init`** against production — `schema.sql` starts with
  `DROP TABLE`. Migrations only.
- Deploys propagate with a lag of minutes. `wrangler deploy` reporting success
  means "accepted", not "live" — `/diag` is the only thing that tells you what
  is actually executing.
- Wrangler's Cloudflare API calls fail under the agent sandbox with a
  misleading `7403 not authorized`. Rerun with the sandbox disabled.

## Style

Comments explain **why**, and especially why the obvious alternative is wrong.
Most of the comments in this codebase are load-bearing history: they name the
bug that produced the line. Match that. A comment that only restates the code
is noise; a comment that says "this used to be X and here is the message the
user got" is the reason the next person does not undo it.
