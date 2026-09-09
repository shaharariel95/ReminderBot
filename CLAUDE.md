# נו? — working notes

A Hebrew accountability bot. Telegram → Cloudflare Worker (webhook + 1-minute
cron) → D1 → Gemini. It does not just remind: it nags, asks for proof, keeps
streaks, and brings up goals on its own.

`README.md` is setup and the product story. `issues.md` is the architectural
audit and `REFACTOR.md` the decisions taken against it. **This file is the
rules** — what you must not break, and where the proof lives.

## How to read this file

Every rule below is one or two lines and ends in a pointer: `→ effects.titleFromHisWords`.
That symbol is where the reasoning lives, and the reasoning is a comment naming
the production message that bought the line — usually longer and always more
current than anything this file could restate.

**That split is deliberate and it is this codebase's own invariant applied to
its own documentation.** This file used to carry both, so a rule lived in two
places and only one got updated; `src/` is 40% comments and won that argument on
merit. If you change a rule, change it at the symbol. Update the line here only
when the *rule* changes, never to re-explain it.

Pointers are symbol names, never line numbers. `grep` finds a symbol; a line
number rots on the next edit and quietly becomes the second stale copy.

---

## The one rule

**The bot must never claim something it did not do.**

Every other rule here is downstream of that. A missed reminder is a bug; a
reminder the bot says it set and did not is the failure this whole codebase is
built to prevent. When a change forces a choice between saying less and
risking a false claim, say less.

Two corollaries that get lost, and each cost a production message:

- **A claim about what HE did is a claim too.** "סגרת את זה מוקדם" over a turn
  that wrote nothing is the same lie in the second person. → `validate.CLAIM`
- **A rejection costs prose; a miss costs the one rule.** A discarded rewrite
  ships the flat baseline, which is true. Never loosen a validator rule to
  recover good writing. → `validate.validate`

---

## The invariants, and what actually enforces each

The middle column is the part that matters — an invariant nothing enforces is
one the next change will break.

| Invariant | Enforced by | Where |
|---|---|---|
| Never claim a write that did not happen | six rules over output true by construction | `validate.validate`, `voice.renderBaseline` |
| A guarantee is a field's **absence**, never a constraint on it | the router schema is a union; an action reading no free text has no free-text property | `brain.TEXT_FIELDS`, `brain.NO_TEXT_ACTIONS` |
| The model classifies; **code computes** | one time resolver, one precedence order | `when.readWhen`, `effects.preferHisWords` |
| No model-emitted field may cause a write **outside his own chat** | his sentence fills the addressee the router dropped; `matchFriend` still decides whether it resolves | `effects.friendFromHisWords`, `db.matchFriend` |
| A bot-side close and a decline are different words at every layer | status / event / effect kind all split | `db.closeInstance`, `db.EVENT_OF` |
| A threshold can switch a feature off, silently and for months | `/diag` says when each feature last spoke | `slash.diag` |
| One question has **one implementation** | *nothing* | — |
| Every write the bot makes is visible in `events` | *nothing* — convention only | `index.sendOutcome` |

**The two rows that say *nothing* are the finding, not an omission.**

**And a row in this table is not an invariant until the code has been audited
against it.** The "code computes" row was written on 06.09.2026 naming
`when.readWhen` and `effects.preferHisWords`. It was already false: the
ADDRESSEE of a reminder was decided by a model field and nothing else, so on
07.09.2026 a reminder for אמנון was written into the owner's own chat with a
confirmation that was true about everything except who it was for. Writing the
row down did not check it. The audit that should have followed it takes ten
minutes and is worth redoing whenever a row is added — ask, for each field the
model emits, *what happens when it is absent or wrong, and what stops that.*
The answer for every field is now in code: times through `preferHisWords`,
titles through `titleFromHisWords`, the addressee through `friendFromHisWords`,
`goal_id` scoped to his own rows, and `chill_hours` / `intensity` /
`checkin_per_day` clamped where they are read.

**"One question, one implementation"** is violated whenever the same question
is answered in two places and only one gets fixed. It has cost, so far:
`asksForNewReminder` (two bare-noun regexes), `findNamedTime` (wired into
`reschedule`, not `create_reminder`), `namesSomeoneElse` / `addressesSomeoneElse`,
`DAY_OFFSET`'s second number parser beside `toNumber`, `snooze` nearly growing a
second question kind beside the awaiting slot, the model ladder left inverted in
`gemini.DEFAULT_LADDER` for nine versions after `wrangler.toml` was fixed, and
this file against the code comments. **When you fix a rule, grep for the second
place it lives.**

**"Every write is visible in `events`"** is enforced by nobody looking. The
known holes have been closed one at a time; the seam that would make it
structural — `applyIntent` pure, one `commit()` — is still open (`issues.md` §5,
deliberately). Until then: a write that does not go through `sendOutcome` is
invisible to the only record there is.

---

## The pipeline every outgoing message goes through

```
effects (what the database actually did)
  → voice.ts    deterministic Hebrew, true by construction
  → speak()     the model rewrites it with personality
  → validate.ts checks the rewrite against the facts
  → send        rejected rewrites ship the baseline instead
```

`voice.ts` output is always shippable on its own. The model only ever makes it
nicer.

**Adding an `Effect` kind is four edits, and two of them nothing will remind
you about:**

1. its wording in `voice.renderBaseline`
2. whether it belongs in `types.WROTE`
3. the sample list in `test/voice.test.ts`
4. the sample list in `test/validate.test.ts`

3 and 4 enumerate kinds by hand and will not tell you one is missing.

**If you add a fact the model is SHOWN, sweep it into `facts.ts` too**, or the
validator discards truthful rewrites for repeating what the prompt handed them.
That failure is silent — a rising rejection count in `/diag`, never an error.
→ `facts.buildFacts`

**If you write a question into `renderBaseline`, add its arm to
`voice.questionAsked` in the same edit** — otherwise the bot asks and records
nothing, and his answer becomes a new reminder. → `voice.questionAsked`

---

## Rules by area

### Time

- The model classifies; **code computes**. His own words beat an absolute the
  model calculated. → `effects.preferHisWords`
- One resolver, one union. `null` used to carry five different meanings.
  → `when.readWhen`
- `preferHisWords` **fills a gap, never overrides**; the `in_minutes` exclusion
  stays. → `effects.preferHisWords`
- The only guess allowed is a **pinned day plus a named part of it** ("מחר בערב"
  → 20:00). A bare day, or a bare part, refuses. → `when.findFutureInstant`,
  `when.PERIOD_HOUR`
- That guess is honest only because **voice.ts always states the hour it chose**.
  Never hedge inside the rewrite — `validate` checks for facts invented, never
  for words dropped, so a hedge can vanish with its blessing.
- A repeat rule must never be flattened into a single fire — that ENDS the
  recurrence. → `when.readWhen`
- `event_at` is when the THING is; `next_fire_at` is when to ring. Stored as an
  instant, required not optional, and swept into `facts.ts` because it is the
  one field crossing the safety chain. → `types.Reminder`, `facts.buildFacts`
- A day with no hour is **not** "no time at all". → `when.Ambiguity`

### Speech and the validator

- Seven rules. 1–4 ask "did the model INVENT this?"; 5–7 ask the opposite,
  because a rewrite that says LESS asserts nothing and passes all of 1–4.
  → `validate.validate`
- Rules 5, 6 and 7 are deliberately low floors, and deliberately scoped — 5 to
  moves, 6 to fires, 7 to the close-out's own closes. The persona's job is to
  reword. All three share `mentions`' one-word bar where they need a name.
- **A dropped word is invisible to all seven.** They check for facts invented,
  never for words missing, so "סגרת 1 **היום**" losing its day is a tense
  change nothing sees — which is how rule 7 came to exist.
- **Rule 3 over-fires and the record says by how much**: four false positives
  against two true ones, and both true ones caught a bug fixed at its root.
  Hebrew uses quotation marks for scare-quotes as often as for naming a thing.
  Two are left firing on purpose. → `validate.validate`, `buttons.FIXED_LABELS`
- `FIXED_LABELS` is a **closed list, matched one direction only**. Make it
  bidirectional and "הכל" starts admitting "להוציא את הכלב". An INTERPOLATED
  label must never go in it. → `buttons.FIXED_LABELS`
- **`CLAIM` is not read by `validate()`. `CLAIM_GROUPS` is**, and carries its own
  copy of every verb. Adding to one only is a fix that does nothing and reviews
  as though it did. → `validate.CLAIM_GROUPS`
- Writing something down is not scheduling it: `noted` and `scheduled` are
  separate groups and a capture is in the first only. → `validate.CLAIM_GROUPS`
- **The failed turn never reaches the model at all.** Handing failure wording to
  something licensed to rephrase invites the exact invention it was written to
  avoid. → `index.sendOutcome`
- **When nobody spoke, the synthetic turn must say so outright.** Any word he
  could plausibly have typed gets answered instead of the baseline.
  → `brain.speak`
- `נו?` is the bot's name and the opener of every fire and nag — **not available
  as a fallback**. A turn that threw says so; an unparseable router says
  something else again. → `voice.TURN_FAILED`
- Do **not** extend the lexicon to catch the next miss. `issues.md` §6 argues the
  approach out; the seam stays open until traffic justifies it.

### Writes, effects and events

- `sendOutcome` is the one point every path converges on. A write that skips it
  is invisible. → `index.sendOutcome`
- **Every unprompted message leaves a row**, filed under the right row. The three
  daily kinds are CHAT_LEVEL — both ids null, because a message naming several
  reminders belongs to none of them. → `db.recordEvents`
- `recordEvents`' default branch reads `e.id` as a REMINDER id. An effect whose
  `id` is an instance must be in `ID_IS_INSTANCE`. → `db.ID_IS_INSTANCE`
- **One word cannot mean "he declined" and "the bot tidied up".** Bot-side closes
  are `superseded`, never `skipped`. → `db.closeInstance`, `effects.applyIntent`
- Its event word is `נדחק`, deliberately not `דילג` — sharing the word would feed
  the pattern detector evidence against him for engaging. → `db.EVENT_OF`
- The supersede **emits**, inside the try, only when the write happened.
  → `effects.applyIntent`
- The event for a fired reminder is `צלצלה` (came due), never `נשלחה` — a send
  that then failed must not leave a row claiming it arrived.
- `events`, `errors` and `meta.last_tick` stay **separate**: different writers,
  readers and retention. → `slash.diag`
- `dueReminders` has **no** "skip if an instance is open" guard and must not get
  one — tomorrow's dose is not a duplicate. → `db.dueReminders`

### Nags, stances and the daily messages

- Three stances — `chasing`, `replying`, `summarising`. They differ in one thing:
  permission to WEAPONISE the elapsed number. → `brain.speak`
- **Permission, never suppression.** Withholding the number was tried and is
  worse: `openSummary` carries `fired_at`, so the model subtracts anyway and does
  it badly. Three stances need three sentences; sharing one puts an untrue line
  in the prompt. → `brain.speak`
- The number is the span he was **awake** for — quiet hours and granted minutes
  both come out, under **separate** flags because each is its own claim.
  → `facts.addElapsed`, `time.quietMinutesBetween`
- The discount is OFF for `checkin_goal`: a goal's span is measured in days.
- A summary is not a nag. A close-out reports a day and names what is open; it
  may not chase it, and it says what is still **ahead**. → `index.sendEveningCloseout`
- **It names what he CLOSED too, and `done` is rows for the same reason
  `missed` and `dropped` are.** It was a count, and a count has no identity in
  it: "אוקיי, המשימה נסגרה. יש לך 39 ברצף" went out eleven hours after his last
  message, true in every word and unanswerable. → `db.doneBetween`
- Capped at four named, **remainder counted**, never dropped. → `voice.CLOSEOUT_NAMED`
- **Rule 7 requires the identity, not a verb.** The message said "נסגרה",
  which is in no group in the lexicon — requiring the name needs no lexicon at
  all, and that is the whole reason it is shaped that way. → `validate.validate`
- The `done` titles are swept into `facts.ts` for the ones **past the cap
  only**: the named four ride in on validate's baseline fold, because voice.ts
  quotes them and the bullet lists do not. → `facts.buildFacts`
- `briefDue`/`closeoutDue` are guarded by `!quiet` **and** `!chasing`, on
  identical terms. A hold, not a cancellation — `markDailySent` runs inside the
  senders. → `index.tickChat`
- Nags hold off while he is talking, using **`deferNag`, never `bumpNag`**, and
  the defer is BOUNDED to the end of the window. → `index.tickChat`,
  `db.deferNag`
- **State the count, never the motive.** "דחית 6 מתוך 7" is checkable against
  rows; "אתה נמנע מזה" is a claim about him that he cannot open a list and check.
  → `patterns.behaviourOf`
- The bot may not invent a task's parts. It knows them only when he typed a comma
  list. → `persona.NAG_LADDER`, `persona.NAG_LADDER_ITEMS`
- A backoff with no probe and no expiry is a deletion. **The expiry IS the
  probe.** → `db.GOAL_PROBE_MS`, `gemini.blockFor`
- A deferral with no length is a **question**, never a default 30.
  → `effects.applyIntent`
- "ירדה להיום" is a promise only a recurring reminder can keep.
  → `types.Effect` (`instance_skipped.recurs`)

### Moving a reminder that is ringing

- **A RELATIVE push on something ringing is a snooze**, whatever the router
  called it — decided in code, and on every path, not just `reschedule`.
  → `effects.applyIntent`
- The create path takes the same redirect under three conditions that are the
  whole of its safety: **no errand named, exactly one thing ringing, time is
  relative**. → `effects.applyIntent`
- **An ABSOLUTE retime supersedes the ring**, closing it `superseded` so it
  cannot pay a streak point. → `effects.applyIntent`

### Closing something before it rings

- **`complete` resolving against `ctx.open` alone is a denial he can disprove.**
  Nothing ringing is not nothing open: the errand may still be on the schedule,
  and "אין לי משימה פתוחה כזאת לסגור" about a row `/list` prints the id of is
  the one rule in the second person. → `effects.completeEarly`
- It was reported TWICE, ten days apart, and 0.19.0 fixed only the lie —
  validate.ts learned "סגרת" so the persona would stop inverting the refusal
  into praise. **A validator that stops a false claim about something the bot
  cannot do is not a way of doing it.** → `validate.CLAIM_GROUPS`
- The write is a **real dose**, not a special case: an instance filed against
  the slot, closed `done`, and the schedule advanced past it in the same
  breath. Skip the advance and it rings anyway, which is half the incident.
  → `effects.completeEarly`
- The next fire is computed **after the DOSE, not after `now`** — he is
  reporting early, so `now` is before the slot and a daily reminder resolves to
  the very fire this close replaces. → `time.computeNext`
- Its instance gets **`next_nag_at` null**: nothing was sent, so there is
  nothing to chase. → `db.createInstance`
- There is deliberately **no "he only has one reminder" fallback**. A ringing
  instance is a live question the bot just asked; a row for Friday is not, and
  a bare "סיימתי" closing it is the bot picking which of his days he meant.
- **A ringing instance is still resolved first**, and the order is load-bearing
  precisely where a daily reminder is in `ctx.open` and `ctx.reminders` at
  once — try the new path first and his report closes TOMORROW while tonight
  goes on nagging. Two tests were vacuous before one could show that.

### Items

- Items hang off the REMINDER, and `resetItems` on each fire is what makes a
  daily three-errand reminder work on day two. → `db.resetItems`
- Splitting is deliberately narrow — commas plus two infinitive ל parts.
  Over-splitting is the worse error. → `effects.splitIntoItems`
- ל glues onto a day too; bare time words are discounted from the verb count.
  → `quickparse.isBareTimeWord`
- `complete_item` **never** falls back to closing the whole task, and
  `matchByTitle` returns null on a tie. → `effects.matchByTitle`
- That matcher is shared with `completeEarly` and was renamed when the second
  caller arrived. It compares **whole words**, and Hebrew inflects every one of
  them — "זרקתי את הזבל" hits nothing in "לזרוק זבל". → `effects.matchByTitle`
- Items are shown to the router only under OPEN instances — the same scope
  `openItemsFor` matches against. Keep those two together.
  → `effects.openItemsFor`

### The router and its schema

- **The only guarantee the schema offers is ABSENCE.** `maxLength` is not
  enforced and production said so twice in nine days. The numbers stay because
  they document what `effects.ts` slices to. → `brain.TEXT_FIELDS`
- An unbounded free-text field **will** become a scratchpad — five runaway titles
  on record, each running until the response truncated and `JSON.parse` threw.
  → `brain.TEXT_FIELDS`
- The schema is a union of **two** branches, not twenty-one, split on "does this
  action read free text". → `brain.NO_TEXT_ACTIONS`
- The `anyOf` fallback is **mandatory, not belt-and-braces** — without it a
  refusing endpoint is a 400 on the first rung for every user until someone
  redeploys. Two guards stop it looping, and removing either alone leaves the
  suite green. → `gemini.callOnce`, `gemini.generate`
- `/diag` says whether the union is in force, because the fallback works and a
  refused schema otherwise has **no symptom at all**. → `db.schemaRefusal`
- **A prompt rule loses to the rules around it.** Read a rule's neighbours before
  adding to it; an addition that contradicts them is worse than none.
  → `brain.route`
- The model never sees a chat_id, only nicknames. → `brain.friendsSummary`
- A rule that matters goes in code, not in the prompt.

### What the model can SEE

Most "the bot is dumb" reports are a partial view, not a comprehension failure.
Check what it was shown before blaming the router.

- Captures are `status='inbox'` and were once invisible to the router entirely.
  `Context.inbox` is capped and the remainder **counted**, never dropped — inbox
  rows have no `next_fire_at` to age out on. → `brain.inboxSummary`
- **A ringing reminder is not "already finished".** `recentlyDone` excludes rows
  with an OPEN instance — an open one, not "has an instance", because a `failed`
  one genuinely belongs in that block. A contradiction the model has to resolve
  is the failure this whole area is about. → `db.recentlyDone`
- Promoting a capture emits `reminder_scheduled`, never `reminder_retimed`.
  → `effects.applyIntent`
- **No focus hint.** It was designed and cut: the ask-on-ambiguity guards fire
  only when the model declines to name a row, and a focused id stops it
  declining. If ever added it must be a deterministic tiebreak only.

### The awaiting slot

- One nullable JSON column holding the single question the bot is waiting on.
  Consumed before the router runs, so an answer costs no model call.
  → `db.readAwaiting`
- It expires **and** is cleared by any turn that does not re-ask. Both matter.
  → `db.AWAITING_TTL_MS`
- It is the SECOND line of defence. Both `reschedule` and `create_reminder` read
  his own sentence for a time first. → `effects.applyIntent`
- `readAwaiting` is an exhaustive switch with a `never` default — as an `if`
  chain, a new arm would compile, be written, and read back null forever.

### Friends

- **A pending row is not consent.** `friendsOf` returns accepted edges only.
  → `db.friendsOf`
- **A friendship is two rows**, the reverse edge named at request time.
  → `db.acceptFriend`
- `matchFriend` returns null on a tie. Sending to the wrong friend is a message
  in a stranger's chat, which he cannot even see to correct. → `db.matchFriend`
- **The accepter names his own edge.** `acceptFriend` writes it from the
  requester's Telegram profile — a name its owner never chose and often cannot
  type — so the accept now ASKS, through the awaiting slot, and `/rename`
  repairs the edges written before that. → `db.Awaiting` (`fname`), `slash.ts`
  (`/rename`)
- That was **one** of the reasons "friends does not work" — 0.29.0 called it the
  whole of it and was wrong within a day. The requester's side resolved and the
  accepter's side did not; `matchFriend` is exact, so a book holding "Shahar"
  against an owner who types "שחר" returned null every time and `friend_unknown`
  reported it as a polite refusal. Fixing the address book left the routing
  broken underneath it.
- **The addressee is read from HIS sentence when the router names none.** With
  the book CORRECT, 07.09.2026: "תזכיר לאמנון עוד שתי דקות …" was written to the
  OWNER, `from_chat_id` null, because `applyIntent` read the routed `for_friend` field and
  nothing else and the model had simply not set it. The prompt spends five lines
  on that field, including "אסור לך להשמיט for_friend … זה הכי גרוע" — a rule
  that matters, living in the prompt. → `effects.friendFromHisWords`
- It **fills a gap and never overrides**, exactly like `preferHisWords`: a name
  the router DID return wins, because that is the more conservative answer — an
  unknown one refuses, while his words resolving would write.
  → `effects.friendFromHisWords`
- It is anchored to the **addressee position** and to the **address book**, and
  both anchors are load-bearing. `namesSomeoneElse` is right there and returns
  true for the same message — and also for "תזכיר לי לקנות מתנה לדנה", because
  it matches the name anywhere and over-refuses on purpose. Wiring that to a
  write files his own errand in her chat. → `quickparse.namesSomeoneElse`
- The addressing is cut from the title she is SHOWN. #84 stored "תזכיר אמנון
  לשלוח הודעה" as the errand, which is an instruction aimed at somebody else.
  → `effects.stripAddressee`
- **`/rename` must not resolve through `matchFriend` alone.** `/friend <name>
  <new>` does, which meant repairing a name he could not type required typing
  it. With one friend `/rename <new>` renames and a bare `/rename` asks; with
  several it LISTS rather than guessing. 0.29.0 wired the one-friend shortcut to
  the bare form only, so `/rename אחי` still answered "אין לי אחי ברשימה" — the
  same bug, one branch to the left. → `slash.ts` (`/rename`)
- The nickname is still a **guess when nobody answers**, and usually in the
  wrong script. Nothing bridges Latin and Hebrew and nothing may try — the
  provisional name is a fallback, not a resolution. → `db.matchFriend`
- The model reports the name he USED, verbatim, even when it recognises nothing;
  `friendReminder` decides whether it resolves. The inversion is the fix — the
  old "omit it if unknown" rule silently wrote the reminder to HIM.
  → `effects.friendReminder`
- **`friendReminder` is a SECOND create path, and that is the whole story of
  this feature.** It re-implemented time resolution and missed 0.16.0's
  precedence flip, so "תזכיר לאמנון עוד שתי דקות" was answered "מתי?" with the
  time four words in. Both paths now use `readWhen` + `preferHisWords`, and
  `test/v31.test.ts` runs one sentence down BOTH and asserts they agree on the
  hour — the guard is against the next divergence, not this one.
  → `effects.friendReminder`
- The hour is read in HER timezone on that path, so the tz is threaded into
  `readWhen` too, and the answer to "באיזו שעה?" is resolved there rather than
  pre-resolved against his clock. → `effects.friendReminder`
- **A missing hour ASKS, and the question carries the request.** `no_time`
  armed no slot, so his answer reached the router as a fresh sentence with no
  name in it and became a reminder for HIM (#85). → `db.Awaiting` (`forwhom`)
- `friendReminder` refuses three ways and they are one refusal. An unresolvable
  name does **not** fall back to a reminder for himself; a missing time does
  **not** fall back to an inbox capture. → `effects.friendReminder`
- **Two gates, two questions.** `namesSomeoneElse` asks the address book;
  `addressesSomeoneElse` asks the grammar. Both over-refuse on purpose, and
  neither may become a verb list. → `index.addressesSomeoneElse`,
  `quickparse.namesSomeoneElse`
- quickparse must bail on these — every parse there assumes the reminder is his.
- `from_chat_id` holds the sender's ID, never their name.
- Not supported, deliberately: he cannot cancel or move a reminder he set for her.

### Multi-user

- Everything user-facing is keyed by `chat_id`, and **the owner is always in the
  allowed set whatever the database says** — a broken row degrades to owner-only,
  never to locked out. → `db.allowedChats`
- The cron reads due rows for allowed chats **in SQL**, not in JS afterwards:
  both queries carry `LIMIT 25` and a revoked chat would starve everyone else.
  → `db.dueReminders`
- Each chat ticks inside its own `.catch`. → `index.tick`
- Two usage numbers, two questions: `usageTodayFor` is his budget, `usageToday`
  is the SUM that protects the shared key. → `db.usageTodayFor`
- **If you add a query returning rows across users, ask what happens when a
  second person exists.**

### The model ladder

- More models is more **capacity**, not just redundancy — the free tier meters
  per minute per model. → `gemini.modelLadder`
- **Defined in TWO places that must agree rung for rung**: `wrangler.toml` and
  `gemini.DEFAULT_LADDER`. → `test/v26.test.ts`
- Blocks are remembered; **the expiry is the probe**, a success deletes the row,
  and every model blocked is not the same as no models. → `gemini.blockFor`
- **A previous 404 is evidence where a docs page is only a claim.** A stale id is
  cheap because `/diag` names it — that is not decoration, it is the only thing
  that makes it visible.
- Every call carries `AbortSignal.timeout` and the ladder a budget: an unbounded
  fetch overrunning the wall clock kills `ctx.waitUntil` **without throwing**.
  → `gemini.generate`
- A timeout must DEGRADE like everything else, and the budget must leave the
  second tier enough time to be worth calling. → `index.turnDeadline`
- Anything measured against "the model's usage" must be a SUM.
  → `db.usageTodayAll`

### Patterns

- `patterns.ts` is deliberately pure — no env, no database, no clock. The
  thresholds ARE the feature. → `patterns.behaviourOf`
- `MIN_SAMPLE` is 4, not 2, and gates the `pushed` arm only — `failing` makes no
  habit claim, and gating it hid abandoned-3-of-3 while raising 3-of-4.
  → `patterns.MIN_SAMPLE`
- It is **not** redundant with the `snoozes >= MIN_SAMPLE` beside it: one fire
  snoozed four times satisfies that at a ratio of 4.0.
- `usualHour` is a MODE, never a mean — the mean of 08:00 and 20:00 is an hour he
  has never used. → `patterns.usualHour`
- `failing` is checked before `pushed`. → `effects.patternFor`
- There is a COOLDOWN, or the feature meant to notice he is over-reminded becomes
  another reminder. → `db.patternOfferedSince`
- Pattern effects are NOT in `WROTE` — an offer is a question.
- **Errand identity is deliberately NOT merged.** Merging two ids for one errand
  is the only way to get a sample out of 1.2 fires per reminder, and it is still
  refused: a count is safe because it is checkable against rows he can open, and
  a merged history is a count about a row that does not exist. The honest fix is
  fewer duplicate rows, not fuzzier arithmetic over them.

### Titles

- His own words beat the generic, including when the model supplies **no** title.
  → `effects.titleFromHisWords`
- `titleFromMessage` reads from the first INFINITIVE ל to the end. The obvious
  implementation — strip lead-in, strip leading time word — was tried and turns
  "תזכיר לי עוד 5 דקות" into a title. → `effects.titleFromMessage`
- Two exclusions, both **closed lists of whole words**: ל-pronouns and bare day
  words. There is no shape separating "לי" from "לימד".
- **Any SCRIPT absent from his message is stripped** from a model-supplied title.
  This line was aspirational until 0.30.0 — the code tested `[A-Za-z]` and
  nothing else, so #83 stored "לשלוח לשחר שעבדೊ", ending in U+0CCA, and read it
  back to him twice. It is an ALLOW-list (Hebrew, Latin, digits, punctuation)
  plus anything he literally typed, never a longer list of scripts to block:
  there are ~160 scripts the model can reach and two this bot writes in.
  → `effects.FOREIGN_SCRIPT`
- Nothing downstream can see that corruption: `validate` compares the reply
  against the effect, so a title corrupted before the effect exists is reported
  faithfully. → `effects.titleFromHisWords`
- Rewording is the router's job and survives. Extraction may not GROW.

### Saying a time once

- **`describeSchedule` on a `once` schedule IS the instant**, so appending a
  formatted `next_fire_at` prints the same moment twice — "פעם אחת ב-07.09
  בשעה 20:58. הראשונה ב-יום ב׳, 07.09.2026, 20:58". "הראשונה"/"הבא" mean
  something only when there is a second one. → `time.scheduleWithNext`
- That sentence shape was written out by hand at FOUR sites (voice ×2,
  slash ×2), which is how one bug was wrong in four places at once. One helper
  now answers "does this repeat"; do not inline the conditional again.
- The router prompt (`brain.remindersSummary`) keeps the redundancy on
  purpose: "פעם אחת" is what tells the model the row is NOT recurring, and
  flattening a repeat rule is the more expensive error. A deliberate
  difference, not a missed site.

### Things that look like bugs and are not

- **`quickparse.ts` bails a lot on purpose.** A partial parse is a confident wrong
  answer; falling through costs one LLM call. → `quickparse.quickParse`
- **There is ONE gate, `asksForNewReminder`, and two callers** — quickparse and
  the router-failure capture. Both had to be fixed for the same bug.
  → `quickparse.asksForNewReminder`
- **The gate is grammar, not a verb list.** It admits a request and refuses a
  DEFINITE reference. A blocklist of move verbs was tried and was wrong twice:
  it could never be complete, and "הזיז" is a substring of "להזיז", so it would
  have refused "תזכיר לי להזיז את הארון". Do not reintroduce one.
- **Buttons never call the model** — the effect and its Hebrew are already known.
  → `buttons.buttonsFor`
- A decline button that changes something is worse than no decline button.
  → `buttons.keep`
- Callback prefixes must not collide — `rdrop` had to move off `x:` because that
  is `skip`, and the collision round-tripped a DELETE into skipping an unrelated
  instance.
- **The deploy ping claims the version BEFORE sending.** A failed send loses one
  announcement; the reverse re-announces every minute forever.
- **`greetStranger` is the only place the bot talks to someone unknown**, and it
  is bounded: two replies per chat ever, capped queue, denials remembered.
- `window_crowded` is an observation attached to a confirmation, never a refusal
  and never advice. The count INCLUDES the row just written, because that is what
  `/list` will show him.

---



### /models — measuring the ladder

- **"Promote by measuring" had no instrument until 0.34.0.** `usage` only ever
  reports the rungs that were REACHED, so the lower six stay unmeasured however
  long you wait — which is how two dead ids sat on the ladder from 19.08 to
  06.09. `/models` asks each rung directly. → `slash.ts` (`/models`)
- Owner-only: it spends one call of real quota per rung. Stated as a rate
  because "eight calls" went stale in three comments the day 0.35.0 left the
  ladder at six.
- **It does not walk the ladder, and must not.** `generate()` drops tiers,
  retries and honours blocks — each of which is the thing being measured.
  → `gemini.probeModel`
- **It neither writes nor reads `model_health`.** Writing would rest the ladder
  it was run to inspect; reading would report a model resting from a 429 as
  broken. The block is printed SEPARATELY, from the table, and the two are
  allowed to disagree — that disagreement is the useful part.
- **Parallel with a 200ms stagger, not sequential with a pause**, and this
  looks backwards until you check the meter. The free tier bills per minute PER
  MODEL, so one request each cannot approach any model's limit; meanwhile two
  rungs measured at 12s apiece run a sequential probe past the invocation's
  lifetime, and an invocation killed on the wall clock does not throw. The
  stagger is the only concession, against a project-wide concurrency limit.
  → `gemini.probeLadder`
- A 200 with no text is **not** a working model — a safety block returns
- **The probe sends production's numbers, not cheap ones.** It shipped with
  `maxOutputTokens: 16` and no thinkingConfig, and its first real run scored
  3.7, 3.6 and 3.8 as empty: sixteen tokens went entirely on reasoning and the
  answer never began. `buildBody` states the rule three lines above itself. A
  probe measuring a different configuration measures a different thing.
- The finishReason rides along with an empty result. ריק alone was not
  diagnosable — the cause was the probe, and a MAX_TOKENS would have said so.
- **A bounded run in an error regex fails on exactly the errors worth reading.**
  `[^"]{0,120}` must find the closing quote inside the bound, so a long message
  matched nothing and the report printed the raw pretty-printed JSON instead.
  → `gemini.errorMessage`
  exactly that. Same rule as `finishReason`, one level out.
- Usage IS recorded. The probe really does spend quota, and a `/diag` number
  that quietly excluded it would be wrong.
- **A measured span renders through one helper, and its unit is Latin.** `ש׳`
  is the abbreviation for שעה, and this bot writes hours in that vocabulary
  everywhere else — so the report called 4.1 seconds four hours, and the
  timeout line, which had its own arithmetic, called twelve seconds twelve.
  → `time.formatDuration`
- A slice with no mark on it claims the sentence ended there. The 140-character
  cut landed mid-URL. → `gemini.errorMessage`
- `rig.emptyModels` is how the empty-200 path is testable at all, and the hang
  path is RACED against a timer: a probe that lost its timeout makes the suite
  hang rather than go red, and the red-proof scored that GREEN until the race
  was added.

### Adding an Effect kind

The four edits are now **three plus a compile error**. `test/v33.test.ts`
holds `SAMPLES`, a mapped type over `Effect['kind']` — one sample per kind,
missing keys and wrong shapes are both type errors, and `npm run typecheck`
covers the test project. It renders every kind and round-trips it through its
own validator.

- The two hand-written sample lists in `test/voice.test.ts` and
  `test/validate.test.ts` are no longer the completeness check. They keep their
  targeted assertions about particular wordings; going stale no longer matters.
- When it was written they were **nineteen kinds short of fifty**, and a
  regex sweep found only thirteen of the nineteen. The compiler found the rest.
  Grep is not an inventory of a union.
- What the round-trip proves, and does not: `validate` folds the BASELINE into
  its own allow-lists, so rules 1 and 3 are unfalsifiable there — an hour
  invented by voice.ts is allowed by voice.ts. Rule 2 and rules 5-6 are live,
  and rule 2 is the one that caught `evening_closeout` in 0.19.0.

### Questions, and the slots behind them

- **A question in `renderBaseline` needs its `questionAsked` arm, or a button.**
  Neither means the bot asks and records nothing, and his answer becomes a new
  reminder. → `voice.questionAsked`
- `nothing` has no arm and never will — it is the refusal kind. So **a `why`
  that asks a question does not belong in it.** `'no_time'` did, worded "מתי?",
  and that is production #85: an hour for a friend's reminder written into the
  owner's chat. Removed from the union in 0.33.0 so reaching for it again does
  not compile. → `types.Effect` (the `nothing` reason list)
- **Both time-answer slots use `parseAnswerTime`**, which is stricter than
  `readWhen` on purpose: the whole message must be the time, because a wrong
  answer to "מתי?" retimes a real reminder. `forwhom` shipped with `readWhen`
  in 0.31.0 and had two strictnesses for one question for three days.
  → `quickparse.parseAnswerTime`

## Testing

`npm test` runs thirty-one files against a real in-memory SQLite behind a
D1-shaped facade (`test/harness.ts`). The webhook and cron paths run end to end,
so "the reminder never arrived" is reproducible rather than arguable.

**The pointers in this file are tested** (`test/docs.test.ts`). A renamed export
would otherwise leave a rule here aiming at a symbol that no longer exists, and
nothing else in the suite reads this file — the drift would be silent, which is
the failure mode half the rules above exist to prevent. Four pointers were
already wrong the first time it ran.

`npm run typecheck` is part of the deal and was red for a while without anyone
noticing. A permanently red typecheck is how a real type error hides.

**Write the test first, watch it fail, then implement.** And then the thing that
actually matters here:

> **Prove each new test goes red when you delete the line it guards.**

A test that stays green with its guard removed is worse than no test, because it
is counted as coverage. **Eight distinct ways one has been vacuous here**, each
found by the red-proof rather than by review:

1. **It matched the wrong block.** `system.includes(title)` passed against the
   exact bug it guarded, because the same title renders again further down the
   same prompt. Scope assertions to block boundaries.
2. **Two guards, one bug.** Removing either alone proves nothing. Remove both.
3. **Two lists, only one of which bites.** `CLAIM` is not read by `validate()`;
   the additions were stripped from it alone and the suite stayed green.
4. **A guard hiding behind a redundant-looking neighbour.** Every case had enough
   fires, so `snoozes >= MIN_SAMPLE` masked the rest.
5. **Colliding ids in the fixture.** A fresh rig numbers the first reminder 1 and
   the first instance 1, so `WHERE reminder_id = 1` is true whichever was
   written. Burn rows first so the ids differ.
6. **The assertion ran outside the pinned clock.** Awaiting the `ctx.waitUntil`
   queue outside `withNow` put `Date.now()` on the real wall clock and made a
   FAILING check pass.
7. **A refactor left it reading nothing.** `items.properties` became `undefined`,
   so `!('why' in {})` was true whatever the schema said. **If an assertion
   navigates into a structure, assert first that it found one.**

8. **The branch could not execute.** The duration regex accepted milliseconds
   OR seconds and looked thorough; `withNow` pins `Date.now`, so every probe in
   every test measured 0ms and only the first branch ever ran. The second
   shipped saying `4.1ש׳` — 4.1 HOURS. **An assertion offering alternatives is
   passed by the easiest one.** `rig.slowModels` exists to make the other
   reachable.

3 and 7 are the same failure at different times: an assertion that survives a
change by ceasing to look at anything. 8 is its opposite and just as quiet — an
assertion that looks at a thing the suite cannot produce.

Useful rig facts:

| | |
|---|---|
| `rig.speakQueue.push(new Error(...))` | fails only the persona call — `geminiDown` kills the router too |
| `rig.dbFailOn` | traps one write by SQL pattern |
| `rig.geminiHang` | never answers unless aborted — race it against a timer, or a regression hangs the suite instead of failing it |
| `rig.downModels` / `rig.notFoundModels` / `rig.retryDelaySeconds` | shape what a named model answers; the only way the ladder is testable |
| `rig.rejectAnyOf` | the 400 a real endpoint gives for a schema construct it refuses |
| `rig.emptyModels` | HTTP 200 with no candidates — what a safety block looks like |
| `rig.slowModels` | fakes elapsed ms by ADVANCING the pinned clock, not by sleeping |
| `deployed(rig)` | simulates a deploy |
| a fresh rig | a bot already running the current version |

One trap the friends tests hit and you will too: the router PROMPT contains
worked examples, so `system.includes('דנה')` passes with the whole context block
deleted. Assert on the rendered shape (`'"דנה"'`), not on the name.

The rig captures `schema` as well as `system` on purpose: "the model was asked
not to" and "the model cannot" are different facts, indistinguishable from the
prompt text alone.

---

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

- **Bump `src/version.ts` first.** It is what tells the running Worker it is new
  and what `/diag` reports. Deploying without bumping is silent.
- **Never run `npm run db:init`** against production — `schema.sql` starts with
  `DROP TABLE`. Migrations only.
- Deploys propagate with a lag of minutes. `wrangler deploy` reporting success
  means "accepted", not "live" — `/diag` is the only thing that tells you what is
  actually executing.
- Wrangler's Cloudflare API calls fail under the agent sandbox with a misleading
  `7403 not authorized`. Rerun with the sandbox disabled.

---

## Style

Comments explain **why**, and especially why the obvious alternative is wrong.

**Most of the comments in this codebase are load-bearing history: they name the
bug that produced the line, and they are the primary record — this file only
indexes them.** A comment that restates the code is noise; a comment that says
"this used to be X and here is the message the user got" is the reason the next
person does not undo it. When you fix something, the incident goes in the comment
at the line, and a one-line rule comes here only if it is one this file is
missing.
