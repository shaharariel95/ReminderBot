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

`validate.ts` has six rules, each with an allow-list built by `facts.ts`.
Rules 1–4 ask "did the model INVENT this?":

1. clock times — only times the turn actually knows
2. write-claim verbs — only when a write of THAT KIND happened (CLAIM_GROUPS).
   "a write happened" is not enough: it once let a create be reported as a move
3. quoted titles and prose — only real ones
4. elapsed-time claims — only spans the turn can back up

Rules 5–6 ask the opposite question, and they exist because the first four
have a blind side: **a rewrite that says LESS than the baseline asserts
nothing, so it passes all of them.**

5. a MOVE may not drop the hour it moved to
6. a reminder that FIRES must name the errand

Both are floors, deliberately low, because the persona's job is to reword and
a rule demanding fidelity would discard good writing. Rule 5 is scoped to
moves alone: on a create the operation is legible without the clock, on a
delete there is no clock. Rule 6 is scoped to fires alone — a NAG refers back
to a thread he is already in ("רק תרים את הפלסטיק של המזגן" against the title
"לנקות פילטרים למזגנים"), and substring matching cannot see through a Hebrew
prefix and a plural. The nag half of that failure is closed at its root
instead, in `brain.speak`.

If you add a fact the model is shown, sweep it into `facts.ts` too, or the
validator will discard truthful rewrites for repeating what the prompt handed
them. That failure mode is silent: it shows up as a rising rejection count in
`/diag`, not as an error. It is not hypothetical and not rare: `rejections` #9
binned a good rewrite because he had typed a stray apostrophe ("עוד 'שעה
בערך") and the quote was compared with a raw `includes`. Both quote tests now
fold quote marks, geresh/gershayim and whitespace first (`normQuote`).

**The failed turn never reaches the model at all.** `sendOutcome` skips
`speak()` when the effects carry `nothing: 'failed'`. The failure wording is
written to confirm and deny nothing; handing it to something whose licence is
to rephrase invites exactly what it was written to avoid, and that is
`rejections` #8 — "העברתי את #60 ללכת למוסך להיום ב-08:47" over a turn that
had thrown, caught only because 08:47 was an hour the turn did not know.

## The turn the model is handed when nobody spoke

The Gemini API requires the last entry in `contents` to be `role: 'user'`.
Every unprompted message — a fire, a nag, the brief, the close-out, a
check-in — ends on a bot turn, so `brain.speak` has to synthesise one.

**What that synthetic turn says is load-bearing.** It was the bare string
`(המשך)` for months, and the model read it as his word and answered IT instead
of rewriting the baseline. Production, chat B, 25.08.2026 22:00 — this is the
"לקחת תרופה" reminder FIRING:

```
המשך למה בדיוק? הכל נקי פה.
או שתביא משימה חדשה, או שתשחרר אותי לראות טלוויזיה.
```

and its nag: "מה המשך? הכל סגור. לך לישון." A reminder that goes off, never
names the errand, and asserts that nothing is open. `rejections` #2 and #3 are
the same phantom months earlier, caught only because the model happened to put
quotes round it — rule 3 sees a quoted invention and nothing saw an unquoted
one until rule 6.

The replacement is not a nicer filler word: any word he could plausibly have
typed has this failure mode. The turn now says outright that he said nothing
and that this is the bot opening. If you ever change it, change it to
something that cannot be read as speech.

## Saying nothing, and saying "נו?"

`נו?` is the bot's name, the opener of every fired reminder, and the opener of
every nag. It is therefore **not available as a fallback**. `nothing: 'chat'`
is small talk and only small talk; a turn that threw says so (`why: 'failed'`,
worded by `voice.TURN_FAILED`), and a router that came back unparseable says
that instead (`why: 'not_understood'`). `route()` returns an EMPTY list rather
than synthesising `chat`, which is what keeps those two apart.

The failure wording must never confirm or deny the write. `applyIntent` can
close an instance and then throw before producing an effect, so "לא קרה כלום"
would be as false as "נשמר". It says what is certain and points at `/list` and
`/errors`.

Silence is worse than either. Every Gemini call carries `AbortSignal.timeout`
and the whole ladder carries a budget (`gemini.ts`), because an unbounded
`fetch` that overruns the Worker's wall clock kills `ctx.waitUntil` **without
throwing** — no catch runs, nothing ships, and the user gets nothing at all.

A timeout then has to DEGRADE like everything else. 429/503/404 drop a tier,
RECITATION and MAX_TOKENS retry; when the timeout was first added it threw, and
one slow request ended the turn with the faster fallback model sitting unasked.
`/errors` is what surfaced that — five straight aborts against `route/apply`.
The budget must stay wide enough for the primary to burn its whole per-call
allowance AND the fallback to answer afterwards, or the second tier inherits a
scrap of time and is not worth calling.

## Observability

Three separate readers, on purpose:

- `events` — the life story of a reminder. Written from `sendOutcome`, the one
  point every path converges on. Read by `/why [id]` and, counted over a day,
  by `/diag`'s cron block.
- `errors` — where a throw went, tagged by stage. Read by `/errors`.
- `meta.last_tick` — stamped at the START of a tick, so "the scheduler is dead"
  and "the scheduler ran and something inside it threw" are distinguishable.

Keep them separate. They have different writers, readers and retention, and the
day errors arrive fastest must not be the day reminder history is pushed out of
the window. The event for a fired reminder is `צלצלה` (came due), never
`נשלחה` — a send that then failed must not leave a row claiming it arrived.

## The awaiting slot

One nullable JSON column on `settings`, holding the single question the bot is
waiting on: `{k:'time'}` after it asked "מתי?", `{k:'offer'}` after it offered a
reminder for something he only mentioned. Consumed before the router runs, so
an answer costs no model call.

It expires (`AWAITING_TTL_MS`) **and** is cleared by any turn that does not
re-ask. Both matter: a slot left open means a bare "15:00" typed later, about
something else, silently retimes whatever was last asked about.

It is the SECOND line of defence, not the first. A reschedule tries
`findNamedTime` on his own sentence before it asks anything — the router
routinely returns a reschedule with the time field empty even when he said the
hour in the same breath, and "בוא נזיז את התזכורת של הבשר ל15:00" was answered
with "מתי?" on 14.08.2026. Same move `parseDuration` already makes for snooze.

`findNamedTime` refuses rather than guesses in three cases, and the middle one
is the one to keep: a repeat rule ("כל יום ב-8") must never be flattened into a
single fire, because that ENDS the recurrence — the same trap the retime button
was fixed for. Two times in one sentence and an hour already past are the other
two. Every refusal falls through to the question, which is what the slot is for.

## Moving a reminder that is ringing

A `reschedule` on a reminder with an OPEN instance is two different requests
depending on how he phrased the time, and until 0.14.1 it was neither.

Reminder 61, "ללכת למוסך", 23.08.2026, straight out of `events`:

```
08:30:38  צלצלה   instance 39 opens
08:30:54  הוזזה   retimed to 09:00 — instance 39 left untouched
09:00:42  צלצלה   instance 41 opens, while 39 is STILL open
09:00:45  נדנוד   on instance 39, three seconds after the new fire
09:04     נסגרה   instance 39 — "רצף 27"
09:31     נסגרה   instance 41 — "רצף 28"
```

One trip to the garage, two streak points, four messages inside ten seconds.

- **A RELATIVE push on something that is ringing is a snooze**, whatever the
  router called it. `brain.ts` says so in prose and the model ignored it for
  "עוד חצי שעה"; `applyIntent` now decides it deterministically. This matters
  most on a REPEAT: `scheduleFromIntent` turns `in_minutes` into
  `{type:'once'}`, so taking it as a reschedule would end the recurrence — the
  same trap `findNamedTime` refuses to walk into when it sees a repeat rule.
- **An ABSOLUTE retime supersedes the ring.** "תעביר את זה ל-9" stays a
  reschedule and closes the open instance as `skipped`. Never `done` or
  `failed`: he did not do it and he did not flake, and `db.stats` counts only
  those two, so a superseded ring cannot pay him a streak point.

**One word cannot mean "he declined" and "the bot tidied up".** `instances.status`
had `skipped` written from four places with three meanings:

```
closeIfOpen(..., 'skipped', 'כפתור')       he tapped "לא היום"        — he declined
closeIfOpen(..., 'skipped', 'נדחה למחר')   he tapped "מחר"            — he deferred
closeInstance(ringing.id, 'skipped')       a retime superseded a ring — the BOT
deleteReminder                             the reminder is cancelled  — the BOT
```

`missStreak` counted all four, on the reasoning in its own comment that a
decline and a give-up are "the same fact from the outside: it isn't happening".
True of the first two. False of the last two, where he MOVED it or DELETED it —
both of which are engagement. Reminder #69 had exactly that shape: two rings
superseded by his own retimes plus one real decline, so `missStreak` returned 3
= `MISS_THRESHOLD`, and the next fire would have carried *"3 פעמים ברצף שזה לא
קורה. אולי השעה לא נכונה, אולי זה לא באמת חשוב לך"* — an accusation whose
evidence was two-thirds the bot's own housekeeping.

The bot-side closes are `superseded` now (migrations/019). The backfill is
exact rather than approximate because `closeIfOpen` stamps `proof` on every
genuine decline and both bot-side closes leave it NULL — verified against
production before it was written, and it moved exactly the two rows predicted.

**The supersede EMITS.** It ran as a bare `db.closeInstance` for five versions,
so it produced no `events` row and no `/why` line: instances 53 and 54 of #69
read from the history like rings that simply never closed. Effects are the write
log and `sendOutcome` is the one point every path converges on — a write that
does not go through it is invisible to the only record there is. The effect is
pushed **inside** the try, only when the write actually happened, because a
claim may not outrun its row.

**Its event word is `נדחק`, deliberately not `דילג`.** `behaviourOf` counts
`דילג` toward `failing` since 0.20.0, so sharing the word would have fed the
pattern detector evidence against him for engaging with a reminder. Two writes
that mean opposite things need two words at every layer they pass through —
status, event, effect kind — and the moment one layer collapses them, some
reader downstream draws the wrong conclusion silently.

Note what was NOT done: `dueReminders` still has no "skip if an instance is
open" guard, and must not get one. A daily reminder he never closed should
still ring tomorrow — that is a new day's dose, not a duplicate.

## Items

A reminder can hold several errands (`reminder_items`, migrations/011). Items
hang off the REMINDER, and `db.resetItems` clears the ticks each time it fires
— that line is what makes a daily three-errand reminder work on day two.

Splitting is deliberately narrow (`effects.splitIntoItems`): commas, plus at
least two parts starting with an infinitive ל. Over-splitting is the worse
error — a checklist he did not ask for turns one task into three ticks he has
to clear, whereas a title with commas in it is just what he typed.

**ל also glues onto a day.** "לקבוע רעמוו נשק במאי, להיום" was split into two
items, the second of them "להיום", and the nag then named it out loud: "עזוב
את 'להיום'. רק תעשה את החלק של…" — the bot naming an errand that does not
exist. `quickparse.isBareTimeWord` discounts those parts from the verb count,
which drops it to one and refuses the split entirely. Note what the fix is NOT:
it is not a rule about ל followed by ה, because "להיות", "להיכנס" and every
other nif'al infinitive has exactly that shape and every one of them is a real
errand. It matches whole words off the closed list of days and parts of a day.

The title still reads "…במאי, להיום". Stripping time words out of a title the
ROUTER wrote is a different and much riskier job — "לתכנן את היום" is an errand
whose subject is the day — and `CLOCK_RESIDUE` already covers the quickparse
side, where the parse is the thing that was incomplete.

`complete_item` NEVER falls back to closing the whole task, and `matchItem`
returns null on a tie. Marking the wrong errand is a claim that he did
something he did not, so asking is the only honest move.

Items are shown to the router only under OPEN instances, which is also the
scope `effects.openItemsFor` matches against. Keep those two together, or the
model will name an item the code then refuses.

## Things that look like bugs and are not

- **`quickparse.ts` bails a lot on purpose.** A partial parse is a confident
  wrong answer; falling through to the router costs one LLM call. Rule 2 at the
  top of that file is the whole design.
- **There is ONE gate, `asksForNewReminder`, and two callers.** quickparse
  uses it, and so does the router-failure capture in `respondToOwner`. They
  had separate bare-noun regexes and both had to be fixed for the same bug:
  after the first fix, a router timeout on "בוא נזיז את התזכורת..." still
  answered "תפסתי #30" and filed his MOVE request as a new inbox item.
- **The gate is grammar, not a verb list.** `asksForNewReminder` admits a
  request ("תזכיר לי", "שים לי תזכורת") and refuses a DEFINITE reference
  ("התזכורת" — *the* reminder, so it already exists). There was briefly a
  blocklist of move verbs instead, and it was wrong twice: it could never be
  complete, and "הזיז" is a substring of "להזיז", so adding the form he
  actually typed would have refused "תזכיר לי להזיז את הארון" — a real
  reminder whose SUBJECT is moving something. What he wants reminding OF is
  none of that file's business. Do not reintroduce a verb list.
- **Buttons never call the model.** The effect and its Hebrew are already
  known, so a tap costs no latency and no quota.
- **The deploy ping claims the version BEFORE sending.** A failed send loses
  one announcement; the reverse would re-announce every minute forever.
- **`greetStranger` is the only place the bot talks to someone unknown**, and
  it is bounded on purpose: two replies per chat ever, capped queue, denials
  remembered.

## What the model can SEE

Most "the bot is dumb" reports are the bot acting on a partial view, not a
comprehension failure. Before blaming the router, check what it was shown.

On 16.08.2026 he asked for a reminder with no hour, it was captured as #35, the
bot asked "מתי?" — and his answer produced #36 and #37. Three rows, one errand.
None of it was misunderstanding: `db.listReminders` filters
`status='scheduled'`, captures are `status='inbox'`, so **the router had never
been shown #35 at all.** Creating another row was the only move it had.

- `Context.inbox` and `inboxSummary` exist so that stops being true. The block
  says outright that naming an hour for one of these is a `reschedule`, not a
  new reminder. It is capped, and the remainder is COUNTED rather than dropped:
  inbox rows have no `next_fire_at` to age out on, so the list only ever grows,
  and a model that believes it has seen everything duplicates what was trimmed.
- **Promoting a capture emits `reminder_scheduled`, never `reminder_retimed`.**
  voice.ts words the latter "שיניתי" — a claim about a previous time the row
  never had — and it sits in the `move` CLAIM_GROUP alone, so the persona can
  legally escalate it to "הזזתי". `reminder_scheduled` is in BOTH groups on
  purpose. The `plan` button has always taken this path; the router path must
  produce the same sentence.
- **`create_reminder` re-reads his sentence with `findNamedTime`**, exactly as
  `reschedule` has since 14.08.2026. That asymmetry — one question, two
  implementations, one of them fixed — is the same shape as the
  `asksForNewReminder` bug below, and it cost a question about an hour that was
  sitting in the message being answered.

## Questions the bot asks

`voice.questionAsked` maps an effect to the slot that will answer it, and it
lives beside the wording ON PURPOSE. `index.ts` used to pattern-match
`needs_time` and `appointment_offer` by hand, while `voice.ts` had said
"תגיד לי מתי" for `reminder_captured` since inbox capture shipped. The bot asked
and wrote down nothing, so the answer became a new reminder. **If you write a
question into `renderBaseline`, add its arm in the same edit.**

`readAwaiting` is an exhaustive `switch` with a `never` default. It was a chain
of `if`s ending in `return null`, which meant a new `Awaiting` arm would
compile, be written by `setAwaiting`, and read back as null forever — the same
ask-and-forget bug one level down.

Note what is NOT here: a focus/"what we are talking about" hint in the router
prompt. It was designed and cut. The ask-on-ambiguity guards —
`needs_task_choice`, `matchItem`'s null-on-tie — fire only when the model
DECLINES to name a row. Hand it a focused id and it stops declining: two open
tasks, "עשיתי", and the wrong one closes with a streak he did not earn. The
chat-scoped checks do not catch that; they guard the wrong chat, never the
wrong row in the right chat. If focus is ever added it must be consumed by
deterministic code as a tiebreak, and it may resolve a reference he MADE
("על זה") but never supply one where he named nothing.


## When it happens vs when to ring

`reminders.event_at` (migration 015) is when the THING is; `next_fire_at` is
when to ring about it. "קבעתי טיפול ליום שלישי ב-8:30, תזכיר לי בשני בערב" says
both, and before this there was nowhere to put the first — `Intent` had
`once_at`, `in_minutes` and `time`, three ways to say when to ring and none for
when the appointment is. The hour was dropped every time, in every phrasing.

Stored as an **instant**, not a wall string like `schedule.once.at`. A reminder
can be written into somebody else's chat under HER timezone, and the heads-up
that announces it ships through plain `sendMessage` with no validator at all —
a wall string would state an hour shifted by the tz delta, outside the chain.

It is the only field here that crosses the safety chain, so it is threaded all
the way and each step is load-bearing:

- `voice.ts` states it on creation AND on firing. A reminder to PREPARE that
  does not say what it is preparing for has sent him to go and look it up.
- **`facts.ts` sweeps it.** `facts.times` is otherwise built from
  `next_fire_at`, `schedule.time`, `fired_at` and effect `at`/`until`/`since` —
  an event hour is none of those. Without the sweep, `validate.ts` rule 1 finds
  it outside the allow-list and discards the WHOLE rewrite for repeating
  something the baseline itself said. That failure is silent: a rejection count
  in `/diag`, never an error.
- `remindersSummary` renders it, and that block is shared with the persona. If
  it is absent the persona must never mention the hour; if present, the sweep
  above is mandatory.
- `friendReminder` passes `event_at: null` deliberately. It writes into an
  account its caller cannot see, and an event hour would be spoken in HER chat
  through the un-validated heads-up path.

`Reminder.event_at` is REQUIRED rather than optional on purpose: every insert
site has to decide, and three of them did (all `null`). An optional field would
have let a new caller drop it silently.

## Times the bot is allowed to guess

`findFutureInstant` + `PERIOD_HOUR` resolve a pinned day plus a named part of
it — "מחר בערב" is 20:00. Before 17.08.2026 that parsed to NOTHING (verified by
running it: "מחר בערב", "בשני בערב" and "מחר בבוקר" all returned null), so the
commonest vague phrasing in the language cost a model call and came back as a
capture and a question about a time he had already roughly given.

Two things make the guess honest, and neither is a hedge in the prose:

- **The day must be pinned.** `findFutureInstant` returns null without one, so
  a bare "בערב" — tonight? tomorrow? — still refuses and falls through to the
  capture.
- **`voice.ts` always states the hour it set.** He reads "20:00" back and can
  move it. A hedge would live inside the rewrite, and `speak` is licensed to
  rephrase — `validate.ts` checks for facts INVENTED, never for words DROPPED,
  so a hedge could vanish with the validator's blessing. An hour that is always
  spoken cannot be quietly lost.

The create path now takes three looks for a time, in order: the router's own
fields, `findNamedTime` on his sentence, then this. `reschedule` has taken the
middle one since 14.08.2026 and `create_reminder` did not — one question, two
implementations, and only one of them fixed. Same shape as `asksForNewReminder`.

## Chasing him vs answering him

`sendOutcome` and `speak` take a `stance`: `'chasing'` (the cron — nags, fired
reminders) or `'replying'` (he just said something, including a button tap).
It defaults to `'chasing'`, so every cron path behaves exactly as it always did
and only the reply paths opt out.

It changes exactly one thing, and the thing it does NOT change is the point:

- The elapsed-minutes block is still shown on a reply turn. Withholding it was
  tried on 17.08.2026 and is worse — `openSummary` carries `fired_at`, so the
  model can still do the subtraction, it just does it badly without a true
  span. That is the 10.08.2026 "שעה וחצי" bug, and every time rule 4 catches it
  the whole rewrite is discarded.
- What `'replying'` removes is permission to WEAPONISE the number. On
  16.08.2026 that block produced "למה לקח לך 69 דקות להבין מתי זה?" — aimed at
  a cooperative answer to the bot's own question.

**A summary is not a nag, and `stance` is where that is said.** There are three
stances now, and the third exists because of one message.

Production 04.09.2026 21:00, the evening close-out over #78, open since 14:59:

> נו? "להזמין אוכל ללילה" פתוח כבר 361 דקות. כמה זמן לוקח לבחור המבורגר?
> תזמין משהו עכשיו ותסגור את הפינה הזאת.

Every fact in it is true. 14:59:03 to 21:00:43 is 361 minutes, `facts.elapsed`
had it, and rule 4 rightly passed it. It is a NAG, sent from the summary slot,
and three things are wrong with that:

- a close-out REPORTS a day — a tally, what is still open, what is still ahead.
  This looked at one task and pushed.
- it bypasses the ladder. `NAG_BACKOFF_MIN` is `[30, 120, 360]`, so after the
  17:31 nag the next was due at 23:31 — inside quiet hours, where it would have
  been held. He got the pressure two and a half hours early through a path with
  no ladder, no `nag_count` and no ceiling.
- `nag_count` said 2. He had received three, and `/why` and `/diag` both agree
  with the counter rather than with his chat.

**The fix is permission, never suppression.** Withholding the number was tried
on 17.08.2026 for the reply stance and is worse: `openSummary` carries
`fired_at`, so the model does the subtraction anyway and does it badly, and
every catch costs the whole rewrite. `'summarising'` therefore says what
`'replying'` says — the span is background, not a charge — without the false
claim that he has just answered. Three stances, three sentences about the same
number; sharing one between any two of them puts an untrue line in the prompt,
which is exactly what "הוא ישן אז" did for granted minutes in 0.18.0.

Note what this does NOT do: the close-out still names what is open, because
that is its job. What it may not do is chase it.

**The number is the span he was AWAKE for.** `facts.addElapsed` subtracts the
quiet window (`time.quietMinutesBetween`). Instance 44 fired at 22:00 and was
nagged again at 08:03, so a flat subtraction handed the model 630 and he woke
up to "התרופה מאתמול גוררת חוב של 600 דקות" — nine of those hours being this
bot's own quiet hours. Accurate arithmetic in the service of a claim about
HIM, which is the more expensive of the two errors.

Three things hold it together. The raw span still rides in `facts.elapsedRaw`
and is folded into rule 4's allow-list only — it is equally true, the model can
derive it from `fired_at` in `openSummary`, and discarding a rewrite for saying
something true costs more than it protects. `facts.elapsedSpansQuiet` adds one
line to the prompt saying the night is already out of the number, because
otherwise the model "corrects" the smaller figure back up. And the discount is
OFF for `checkin_goal` (`addElapsed(ts, false)`): a goal last touched on Friday
morning is a span measured in days, and taking two nights out of it hands the
model a number that reads as a day and a half.

**The daily messages keep quiet hours too.** `briefDue`/`closeoutDue` are
guarded by `quiet`, exactly as check-ins always were — they were the one
unprompted path that was not, and the owner's row is `quiet_end_hour` 9 against
`brief_hour` 8, so the bot opened every morning inside the window he had asked
it to stay out of. It is a hold, not a cancellation: `markDailySent` runs inside
the senders, so the day stays unmarked and `dailyDue` picks it up on the first
tick after the window closes, still bounded by `DAILY_GRACE_HOURS`.

**The close-out says what is still AHEAD.** Everything else in it looks
backwards — a tally, what is still open, what was given up on — so at 21:00 it
had nothing to say about the evening and the persona filled the silence: "זהו,
אין יותר להיום", an hour before a 22:00 dose. `evening_closeout.ahead` carries
tonight's remaining rows, `voice.ts` states them WITH the hour, `facts.ts`
sweeps that hour, and "אין זנבות" is now reachable only when the evening is
empty as well.

**Time the bot GRANTED is not time he wasted.** `instances.granted_min`
(migrations/018) accumulates every snooze the bot said yes to, and
`facts.addElapsed` subtracts it exactly as it subtracts quiet hours. 18:03,
chat B: *"93 דקות ש… פתוחה"* — he had pushed it to 18:02 an hour earlier, at
the bot's own invitation. Sixty of those ninety-three minutes were the bot
agreeing.

The two discounts set **separate** flags (`elapsedSpansQuiet`,
`elapsedSpansGranted`) because each gets its own line in the prompt and each
line is a claim. While they shared one flag, an hour he had spent awake and
asked for was announced to the model as "הוא ישן אז". Both lines exist for the
same reason: the model can subtract `fired_at` from the clock itself and will
"correct" the smaller number back up unless told why it is smaller.

**A deferral with no length is a question, never a default.** `snooze` fell to
a hardcoded 30 when the router omitted `snooze_minutes` and his words held no
duration — and the router omits it routinely, so this was the common path.
*"לא יקרה היום, בוא ננסה שוב מחר"* came back as *"דחיתי … ב-30 דקות"*: a number
he never said, reported as his. It now returns `needs_time`, which reuses the
awaiting slot already wired to route his answer through `reschedule` — one
question, one implementation. `parseDuration` closed the "עוד שעה" case;
nothing can close the "מחר" case by guessing, because the guess IS the bug.

**"ירדה להיום" is a promise only a recurring reminder can keep.**
`instance_skipped` carries `recurs`, read off the schedule at the moment of the
skip — afterwards the row cannot answer it, because a fired one-off and a
finished daily both read `status='done'`. A one-off that is skipped is gone,
and saying so is the difference between a deferral and a deletion he did not
know he made. The fire keyboard also gained `מחר` (`buttons.deferRow`), which
is the answer he actually wanted twice in two days; the `tomorrow` callback had
been wired and working the whole time, reachable only from the evening
close-out.

**The daily messages also keep out of the way of an actual reminder.** Brief at
08:00:41, nag at 08:00:55, same tick, same two tasks. `briefDue`/`closeoutDue`
are now guarded by `!chasing` as well as `!quiet`, on identical terms — a hold,
not a cancellation, since `markDailySent` runs inside the senders.

**A bare relative push while something is ringing is a snooze — on EVERY path.**
CLAUDE.md has said this since 0.14.1 and `applyIntent` enforced it
deterministically, but only inside `reschedule`. The router does not always
route it there. 03.09.2026 17:07, with #69 fired at 16:30 and nagged at 17:00,
"תזכיר לי עוד שעה" came back as `create_reminder`, was captured with no time,
and the reply was "סגרנו על #75. אבל על מה להזכיר לך ובאיזו שעה בדיוק?" — a
second row, a question, and #69 still ringing underneath it.

The create path takes the same redirect now, under three conditions that are
the whole of its safety: he named NO errand (a titled push is a second errand,
and folding it in would lose it), EXACTLY one thing is ringing (two, and there
is no way to tell which — the same answer `matchItem` gives on a tie), and the
time is RELATIVE.

**`preferHisWords` FILLS a gap; it never overrides.** A `duration` from
`readWhen` is used only when `scheduleFromIntent` returned null. "עוד שעה" was
read correctly the whole time and then thrown away, so the bot asked "באיזו
שעה בדיוק?" about the only specific thing in the sentence. The `in_minutes`
exclusion is untouched and must stay: overriding it turned "ללכת למוסך ב8:20",
typed AT 08:20, into tomorrow.

**Writing something down is not scheduling it.** `validate.ts` had ONE create
group holding "רשמתי" and "קבעתי" as interchangeable, with `reminder_captured`
in it — which is what LICENSED "סגרנו על #75" over a row with no time and no
title. It is split into `noted` and `scheduled`, and a capture is in the first
only. The reply agreed an appointment in one sentence and asked what the errand
was in the next; nothing in the chain could see a contradiction.

**A claim about what HE did is a claim too.** `CLAIM` was first person only, so
every affirmation of the user sailed through: chat B, 30.08.2026 20:01, "יפה
שסגרת את זה מוקדם" over a `no_open_task` baseline, with #68 firing 24 minutes
later. "סגרת" and "סיימת" are policed now. "דחית", "ביטלת" and "קבעת"
deliberately are NOT: they describe standing state as readily as this turn, and
"דחית את X 6 מתוך 7 הפעמים האחרונות" is `pattern_pushed`'s own baseline — true,
over a turn that wrote nothing. Only a close is an event this turn can be sure
it owns.

**`CLAIM` is not read by `validate()`.** `CLAIM_GROUPS` is, and it carries its
own copy of every verb. Adding to one and not the other is a fix that does
nothing and reviews as though it did. Proven by deletion rather than assumed:
stripping the 0.19.0 additions from `CLAIM` alone left the suite green.

**Rule 4 was dormant for a month.** `ELAPSED_BEFORE` wanted the marker BEFORE
the quantity; Hebrew puts it after at least as often, so "93 דקות שהיא פתוחה"
— the very message that exposed the granted-minutes bug — was never checked at
all. Two frames added, both unambiguous ("X עברו", "X שזה פתוח"). Zero rule-4
rejections in a month was not a quiet month, and a safety rule that has
silently stopped running is worse than one never written, because it counts.

**A backoff with no probe and no expiry is a deletion.** `GOAL_QUIET_AFTER` was
`checkin_count < 8` in SQL with nothing that ever cleared it, so goal #1 (count
11, last check-in 17.08.2026) was switched off permanently and silently. Quiet
is now a month (`GOAL_PROBE_MS`) and then one ask. `gemini.blockFor` has had
this right for two versions: **the expiry IS the probe.**

**Nags hold off while he is talking** (`CONVERSATION_WINDOW_MIN`). Five
messages stacked up on 16.08.2026 while he was actively answering, and a bot
that interrupts is not being persistent, it is being noise.

It uses `deferNag`, never `bumpNag` — the same "defer without burning a round"
the quiet-hours branch has always used. `nag_count` drives the ladder and
`gave_up`, so burning a round here would let one chatty hour exhaust his
patience budget without a single nag having been delivered.

And the defer is BOUNDED: to the end of the window, not by a fresh interval
each time. Pushing `next_nag_at` forward on every inbound message instead —
which is the obvious implementation and was the first design — leaves the
instance open forever, `nag_count` frozen and `gave_up` unreachable. That is a
reminder that has quietly stopped being one, which is worse than a rude one.

## Reading the behavioural record

`events` held every fire, snooze, close and give-up — timestamped, keyed by
reminder_id — and until v0.12 the only things that read it were `/why`
(printing one reminder's story) and `/diag` (counting a day). Nothing ever
asked whether a given reminder was actually WORKING, so the bot applied
identical pressure to one he closes every morning and one he has pushed eleven
times running. The nag ladder escalates within an instance and resets at the
next fire; there was no learning across instances at all.

`patterns.ts` is that question, and it is deliberately pure — no env, no
database, no clock. The thresholds ARE the feature and they should be readable
and testable in one place.

**The rule the whole file exists under: state the count, never the motive.**
`NAG_LADDER[2]` once ended "ותנקוב בשם דפוס ההימנעות שלו" and produced
"הימנעות קלאסית דרך שתיקה" after ninety minutes — he might have been driving.
Pattern detection is that same temptation with arithmetic behind it, which
makes it more persuasive and no more true. "דחית 6 מתוך 7" is checkable against
rows; "אתה נמנע מזה" is a claim about HIM that he cannot open a list and check,
and a wrong one costs more than a wrong claim about a reminder.

**A feature can be switched off by a threshold and nobody finds out.** This is
the second time in two versions, so it is written down as a class rather than
an incident. `GOAL_QUIET_AFTER` did it to goal check-ins; `patterns.ts` did it
to itself, and in a month of production it had produced **zero** rows:

```
55 instances across 46 reminders          1.2 fires per reminder
reminders that ever reached 3+ fires: 2   #63 (5, all done), #69 (3, all skipped)
'הצעתי שינוי' events, all time:       0
```

Three causes, all in the reading rather than the arithmetic:

- **`behaviourOf` did not count `דילג` at all.** Only `ויתרתי` counted as a
  failure, so #69 — three fires, never once closed, DECLINED every time — read
  as no evidence whatsoever. A give-up is the bot running out of patience; a
  skip is him saying no. Different events, same fact for this file.
- **`patternFor` was never CALLED on a skip.** It hung off `snooze` and the
  give-up, so the plainest "this reminder is not working" signal in the product
  never asked the question. It takes `pending: 'failed' | 'skipped'` now — the
  row for what is happening right now is written by `sendOutcome`, AFTER the
  decision, so without it FAILURE_FLOOR is silently one higher than it says.
- **`MIN_SAMPLE` gated `failing`, and it should not.** Four is the floor for a
  HABIT claim — "you always push this" is about HIM, and off three data points
  it is astrology. `failing` makes no such claim: it is `dones === 0` plus a
  count `FAILURE_FLOOR` already governs. Gating it as well meant abandoned 3
  out of 3 was invisible while abandoned 3 out of 4 was raised, and the first
  is the worse reminder.

The gate still guards the `pushed` arm and is NOT redundant with the `snoozes
>= MIN_SAMPLE` beside it: one fire can be snoozed four times, which satisfies
the snoozes floor at a ratio of 4.0 and would announce a habit off one morning.

**`/diag` now says when patterns.ts last spoke, or "מעולם לא".** Same argument
as naming blocked models: a threshold that has quietly switched a feature off
is invisible until something counts it out loud. A zero there is the finding.

**Errand identity is deliberately NOT merged.** #56 "לנקות פילטרים למזגנים" and
#69 "לנקות את הפילטרים של המזגנים" are one errand under two ids, and merging
them is the only way patterns.ts gets a sample out of 1.2 fires per reminder.
It is still refused. Every count this file produces is quoted back at him
("דחית את X 6 מתוך 7"), and the reason counts are safe where motives are not is
that a count is CHECKABLE against rows he can open. A merged history is a count
about a row that does not exist. The honest fix is fewer duplicate rows, not
fuzzier arithmetic over them.


Four things are load-bearing:

- **`MIN_SAMPLE` is 4, not 2.** A habit announced off two data points is
  astrology, and it costs trust in everything else the bot says.
- **`usualHour` is a MODE, never a mean.** The mean of 08:00 and 20:00 is
  14:00, an hour he has never once used — offering it invents a habit out of
  two real ones. No clear cluster means no suggested hour and the honest offer
  becomes "מתי כן?".
- **`failing` is checked before `pushed`.** Offering to retime a reminder he
  has never once completed treats a wrong reminder as a scheduling detail.
- **There is a COOLDOWN** (`pattern_offered`, recorded through the existing
  events table). Without it every push past the threshold re-asks the identical
  question, and the feature meant to notice he is over-reminded becomes another
  reminder.

The pattern effects are NOT in `WROTE`: an offer is a question, and nothing was
written. `pattern_pushed.at` carries the suggested hour as an INSTANT so the
existing `facts.ts` sweep of `at` allow-lists it — a bare hour number would be
a clock time the allow-list has never seen and the whole rewrite would be
discarded for saying it.

`buttons.ts` gained `keep` — a decline that writes nothing. The first version
reused `plan` with slot `'none'`, which does not mean "leave it", it means "no
time": it would have UNSCHEDULED the reminder he had just said was fine. A
decline button that changes something is worse than no decline button. It also
gained `rdrop`, which had to move off the `x:` prefix — that is `skip`, and the
collision silently round-tripped a DELETE into skipping an unrelated instance.

## Letters he never typed

`titleFromHisWords` (effects.ts) removes from a model-supplied title any SCRIPT
that is absent from his message. The router answered "תזכיר לאמנון לדבר עם שחר
עוד שתי דקות" with the title "לדבר עם שחרy", then "לדבר עם שחרyil" — hex
79 69 6C — stray Latin on otherwise correct Hebrew.

Nothing downstream could see it. `validate.ts` compares the REPLY against the
EFFECT, so a title corrupted before the effect exists is reported faithfully,
quoted back to him, and read out every time it fires.

It is narrow on purpose and is about honesty, not tidiness. Rewording is the
router's job — dropping "תזכיר לאמנון" from the front is exactly right and
survives. Only a script he never used is stripped, so "תזכיר לי לשלוח email"
keeps its email. A prompt line asking for this already exists and is not
trusted to hold; this is the deterministic half.

## What the bot may not invent about a task

`NAG_LADDER[1]` used to say "תציע חצי ממנה" for every task alike. But the bot
only knows a task's parts when he happened to type them as a comma list
(`splitIntoItems`); for everything else there is no substructure, so "offer
half" is either useless ("do half of לסדר את המוסך") or an invented claim about
what the task contains — the same class of error as naming a motive. The
generic rung now asks for the smallest VISIBLE next action and says outright
not to invent a breakdown; `NAG_LADDER_ITEMS` replaces it only when real items
exist, and then it names one.

`window_crowded` is an observation attached to a confirmation, never a refusal
and never advice. He is allowed a busy morning. The count INCLUDES the row just
written, because that is what he will see in `/list`, and being off by one
about something he can check in two taps reads as the bot being wrong.

## Multi-user

Everything user-facing is keyed by `chat_id`. Access is `db.allowedChats` —
the owner plus a `meta`-backed guest list — and **the owner is always in that
set whatever the database says**, so a broken row degrades to owner-only rather
than locking everyone out.

The cron reads due rows for allowed chats **in SQL**, not in JS afterwards:
both queries carry `LIMIT 25`, and a revoked chat's stale rows would otherwise
fill the page forever and starve everyone else. Each chat ticks inside its own
`.catch` — one user's failure must not swallow another's reminders.

Model calls are attributed per chat (`usage`, keyed day+model+chat_id since
migration 012). Two numbers, two questions: `usageTodayFor` is what /diag shows
him and what his check-in budget is measured against; `usageToday` is the SUM,
and it is what protects the shared API key. Getting this wrong is not
theoretical — /diag once reported a rejection the owner could not explain
because it was a guest's, and a guest burning the day's calls silently switched
off the owner's check-ins.

If you add a query that returns rows across users, ask what happens when a
second person exists. That exact question was worth asking: `dueReminders` and
`dueNags` read the whole table and everything was sent to `OWNER_CHAT_ID`.

## Friends

A reminder can be written into somebody ELSE's chat (`friends`,
migrations/013). Two facts hold the whole feature up:

- **A pending row is not consent.** `/friend` writes `status='pending'` and
  sends a question with two buttons. `db.friendsOf` returns accepted edges
  only, and it is the list every cross-chat write is checked against.
- **A friendship is two rows.** Acceptance writes the reverse edge in the same
  call, named after the requester's Telegram name (captured at request time —
  the accept is a tap in HER chat and carries her name, not his). Without it,
  her reminder lands in his chat from a chat_id he has no name for.

The model never sees a chat_id. It is shown NICKNAMES (`friendsSummary`) and
returns one in `for_friend`; `db.matchFriend` resolves it and returns null on a
tie, exactly like `matchItem`. Marking the wrong errand is a claim he did
something he did not; sending to the wrong friend is a message in a stranger's
chat, which he cannot even see to correct.

`friendReminder` (effects.ts) refuses three ways and they are all one refusal —
it writes into an account its caller cannot see, so anything uncertain is
declined rather than approximated. Note the two that look like they could be
softened and must not be: an unresolvable name does NOT fall back to a reminder
for himself, and a missing time does NOT fall back to an inbox capture (the
/inbox buttons are on his side; hers could never be scheduled).

**Two gates, and they ask different questions.** `namesSomeoneElse` asks the
ADDRESS BOOK; `addressesSomeoneElse` asks the GRAMMAR. The second exists
because the first was the wrong question on 17.08.2026: the book held the
friend under his Telegram profile name ("amnon") while the message said
"לאמנון", nothing matched, and "תזכיר לאמנון לדבר עם שחר עוד שתי דקות" was
filed as HIS reminder — his chat, his hour, the other person's errand as the
title, and no model call, so the router never saw it.

`addressesSomeoneElse` does NOT reintroduce a name list, and it does not claim
to tell "לדנה" from "לקנות". It matches a stronger shape: **two** ל-phrases
after "תזכיר" — an addressee and an errand ("תזכיר לאמנון לדבר"). One ל-phrase
is just an errand and is left alone. "לי" is excluded, anchored, because
"לילדים" starts with the same letters and IS a third party.

It over-refuses on purpose ("תזכיר לבדוק לפני שאתה יוצא" bails). A bail costs
one model call and the router is shown the friends list; a wrong pass costs a
row filed under somebody else's errand in his name. Known gap: an addressee
with words in between ("תזכיר לאמנון בשעה 8 לדבר") is not matched, because
widening the pattern trades that miss for real over-refusal.

**A prompt rule loses to the rules around it.** The friends rule was fixed once
by APPENDING "report the name even if it is not in the list" — and it kept
failing, because it landed between "for_friend must be the exact name **from
the list**" and "a reminder written to the wrong chat cannot be undone". The
model obeyed the sandwich, omitted for_friend, and the reminder fell on him.
The rule now replaces both neighbours and, more importantly, says WHY reporting
an unknown name is safe: the model does not choose a recipient, `matchFriend`
does, and an unmatched name writes nothing. Without that sentence the warning
beats the instruction every time. When editing a prompt rule, read its
neighbours — an addition that contradicts them is worse than no addition.

**quickparse must bail on these.** Every parse in that file assumes the
reminder is his own — `cleanTitle` strips "תזכיר לי" and nothing else — so
"תזכיר לדנה" would be filed as HIS, at his hour, with her name in the title.
The gate is the address book, not grammar: there is no way to tell "לדנה" from
"לקנות" by shape. `namesSomeoneElse` over-refuses on purpose (a friend's name
anywhere after a ל bails), because bailing costs one model call and the router
is told outright that "תזכיר לי" is always his.

The reminder's `from_chat_id` holds the SENDER'S ID, never their name: she may
rename him before it fires, and the name is resolved out of her own book at
fire time (`reminder_fired.from`). A friendship ended in between leaves the
reminder firing unattributed — it is her row, and deleting it behind her back
would be the bigger surprise.

**The nickname is a GUESS, and it is usually in the wrong script.** The reverse
edge created at acceptance is named after the requester's Telegram profile —
"amnon" — while the owner types Hebrew, "אמנון". `matchFriend` lowercases and
compares, and nothing bridges Latin and Hebrew. It must not try: guessing puts
a message in a stranger's chat.

That mismatch made the whole feature look broken, and what made it SILENT was
the router prompt. It used to say "if the name is not in the list, do not set
for_friend at all" — a safety rule with a wrong outcome. The friend intent
vanished, the reminder was written for HIM, and the bot confirmed it. True
about the write, not what he asked for, and no error row anywhere. Production
on 17.08.2026: 47 reminders, **0 cross-chat**.

The rule is now the inversion used everywhere else: the model reports the name
he USED, verbatim, even when it recognises nothing; `friendReminder` decides
whether it resolves and refuses if not. `friend_unknown` carries both his
spelling and the names on file, so the reply shows them side by side and hands
him the one command that fixes it. "I do not know that name" alone was a dead
end — he had no way to discover the book held Latin.

**`why` is gone from the router schema, and that is the fix.** It was read by
exactly one action (`create_goal`) and offered to all twenty, unbounded. EVERY
route/apply failure between 15 and 17.08.2026 carried a long one — including
two plain reschedules with no friend in them, so this was never a friends bug.
The worst had the model writing "for_friend=אמנון. in_minutes=2.
schedule_type=once. for_friend=אמנון." as PROSE inside it, repeating until the
response truncated mid-string and JSON.parse threw. The turn died and the
catch-block filed the raw message as an inbox item — which is what those
"תזכיר לאמנון..." titles in the reminders table are.

It was first "fixed" by asking the model in the prompt to leave it alone. That
is a request; `responseSchema` drives constrained decoding, so a property that
is absent CANNOT be emitted, which is a guarantee. Take the guarantee. A goal's
reason now rides in `note`, already in the schema and unused by goals.

The rig captures `schema` as well as `system` (test/harness.ts) precisely so
this is assertable: "the model was asked not to" and "the model cannot" are
different facts and are indistinguishable from the prompt text alone.

**Removing the field did not end this. It relocated it.** Every route/apply
failure since — `errors` #13, #14 and #15, all after 0.14.0 shipped — is the
same runaway in `title`, which was the next unbounded STRING within reach:

```
#13  "ללכת למוסךTrimmed to: ללכת למוסך והוא לא אמר משהו אחר. ללכת למוסך…"  3022
#14  "ללכת למוסך24.08.2026, 07:30 — הבא: יום ב׳, 24.08.2026, 07:30\n\n…"   4345
#15  "להזמין רכב לאוסטריה Lights-out-time-limit-reached-or-similar-…"      4800
```

The first is the model reciting `titleFromHisWords`' own prompt rule back into
the field it governs; the second is the rendered context block. Each ran until
the response truncated mid-string, so `JSON.parse` threw and the catch-block
filed his raw sentence as a reminder — reminder #62's title is one of his
messages, word for word.

`titleFromHisWords` cannot catch this: it runs on the PARSED intent, and there
is no parse. Every free-text field in `ACTION_SCHEMA` now carries a
`maxLength` (title 120, note 200, reason 400 — matching what the code slices
them to anyway). The lesson is the one `why` taught, one level up: **an
unbounded free-text field WILL become a scratchpad, and the bound belongs in
the schema, where decoding enforces it.** If you add a STRING here, bound it.

Not supported, and deliberately: he cannot cancel or move a reminder he set for
her. Every mutation path resolves through a chat-scoped read, and it is her row
now.

## The model ladder

Free-tier quota is metered per minute PER MODEL against one key, so more models
is more capacity, not just more redundancy. `gemini.modelLadder` builds the
list; `GEMINI_MODEL`/`GEMINI_MODEL_FALLBACK` still lead it, because they are
what /diag calls "the model" and what somebody debugging at 02:00 will change.

429/503/404 already dropped a tier. What is new is that the refusal is
REMEMBERED (`model_health`, migrations/014), so the next message skips that
model without paying a round trip for a limit already discovered. With a ladder
six deep that is the difference between a bad minute costing a moment and a bad
minute costing the whole budget.

Three things about the blocking are load-bearing:

- **The expiry IS the probe.** Nothing else clears a block, because whether a
  quota has reset cannot be known without asking. A 429 rests for whatever
  Google's `retryDelay` said (usually ~a minute), a 404 for six hours, and each
  CONSECUTIVE block doubles it — which is what separates "over the per-minute
  limit" from "the day's quota is gone" without having to tell them apart.
- **A success deletes the row.** The backoff has to recover in one step, or a
  model that was out for an hour spends the rest of the day at five strikes.
- **Every model blocked is not the same as no models.** When the health table
  rules out everything, it is ignored and the ladder is walked anyway. Blocks
  are an optimisation, and an optimisation is never a reason for silence.

An unknown model id is therefore self-pruning rather than fatal: it 404s once
every six hours and `/diag` names it. That is the trade the default ladder is
chosen under — /diag showing what is blocked is not decoration, it is the only
thing that makes a stale model id visible at all.

Because a day's calls now spread across the ladder, anything measured against
"the model's usage" has to be a SUM (`db.usageTodayAll`). `GEMINI_SOFT_LIMIT`
was per-model and would simply have stopped binding.

## Testing

`npm test` runs fifteen files with a real in-memory SQLite behind a D1-shaped
facade (`test/harness.ts`). The webhook and cron paths run end to end, so
"the reminder never arrived" is reproducible rather than arguable.

`npm run typecheck` is part of the deal and was red for a while without anyone
noticing — migration 016 added a required `Settings` field and four hand-built
fixtures never got it. A permanently red typecheck is how a real type error
hides, so keep it clean.

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
want); `rig.dbFailOn` traps one write by SQL pattern; `rig.geminiHang` makes the model
never answer unless the caller aborts it (race it against a timer, or a
regression hangs the suite instead of failing it); `rig.downModels` /
`rig.notFoundModels` / `rig.retryDelaySeconds` shape what a named model
answers, which is how the ladder is testable at all; `deployed(rig)` simulates
a deploy; a fresh rig is a bot that is already running the current version.

One trap the friends tests hit and you will too: the router PROMPT contains
worked examples, so `system.includes('דנה')` passes with the whole context
block deleted. Assert on the rendered shape (`'"דנה"'`), not on the name.

## Deploying

```bash
npx wrangler d1 execute nu-bot --remote --file=./migrations/009_events_and_errors.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/010_awaiting.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/011_reminder_items.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/012_usage_by_chat.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/013_friends.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/014_model_health.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/015_event_at.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/016_display_name.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/017_instance_due_slot.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/018_granted_minutes.sql
npx wrangler d1 execute nu-bot --remote --file=./migrations/019_superseded_instances.sql
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
