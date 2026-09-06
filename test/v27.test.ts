/**
 * Run with `npm run test:v27`.
 *
 * issues.md §3: one flat bag of optional properties shared by 21 actions.
 *
 * The audit called the discriminated union "the tap" for the runaway `title`,
 * and that was half right in a way worth being precise about. Reading the five
 * spills out of `errors` rather than reasoning about them:
 *
 *   #13  create_reminder   "ללכת למוסךTrimmed to: …"                3022 chars
 *   #14  reschedule  #60   "ללכת למוסך24.08.2026, 07:30 — הבא: …"   4345
 *   #15  create_reminder   "להזמין רכב לאוסטריה Lights-out-…"       4800
 *   #16  reschedule  #69   "לנקות את הפילטרים של המזגנים_resche…"   6296
 *   #17  reschedule  #69   "לנקות את הפילטרים של המזגנים…"          3112
 *
 * THREE OF THE FIVE ARE RESCHEDULES, and `reschedule` does not read `title`.
 * `resolveReminder` matches on `target_id` and falls back to "he has exactly
 * one reminder" — the title is never consulted on that path, by any branch.
 * It is a field the model can only get wrong.
 *
 * So the union is not a bound on `title`. It is the removal of `title` from
 * the actions that were never going to read it, and on the record that is
 * three failures out of five. The other two are creates, where the title is
 * the point and no schema can help; those are titleFromHisWords' job.
 *
 * The line the union is drawn along is therefore the one the evidence draws:
 * actions that read free text, and actions that cannot. TWO branches, not
 * twenty-one — the `action` enums are disjoint, so the branch is determined by
 * the action alone, and a two-way choice is a far smaller ask of constrained
 * decoding than a twenty-one-way one.
 *
 * And `maxLength` is not the guarantee brain.ts claimed it was. It is absent
 * from the supported-field list in Google's structured-output documentation
 * (checked 06.09.2026), which is why #16 and #17 — both AFTER 0.14.1 added it
 * — ran to 6296 and 3112 characters over a field declared `maxLength: 120`.
 */
import worker from '../src/index';
import { ROUTER_SCHEMA, ROUTER_SCHEMA_FLAT } from '../src/brain';
import { handleSlash } from '../src/slash';
import { check, createRig, done, eq, section, withNow, type Rig } from './harness';

const CHAT = '12345';

const branches: any[] = (ROUTER_SCHEMA as any).properties.actions.items.anyOf ?? [];
const enumOf = (b: any): string[] => b?.properties?.action?.enum ?? [];
const flatEnum: string[] =
  (ROUTER_SCHEMA_FLAT as any).properties.actions.items.properties.action.enum;

async function say(rig: Rig, text: string, at: number): Promise<void> {
  await withNow(at, async () => {
    const pending: Promise<unknown>[] = [];
    const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
    await worker.fetch(
      new Request('https://x/tg', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': rig.env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify({ message: { chat: { id: Number(CHAT) }, text, message_id: 3 } }),
      }),
      rig.env, ctx,
    );
    await Promise.all(pending);
  });
}

// ===========================================================================
section('the router schema is a union, split on whether the action reads text');
{
  eq('two branches', branches.length, 2);

  const withText = branches.find((b: any) => 'title' in (b.properties ?? {}));
  const noText = branches.find((b: any) => !('title' in (b.properties ?? {})));
  check('one branch carries the free-text fields', !!withText);
  check('and the other carries none of them', !!noText);

  for (const f of ['title', 'note', 'reason']) {
    check(`${f} is absent from the no-text branch`, !(f in noText.properties),
      Object.keys(noText.properties).join(', '));
    check(`${f} is present on the text branch`, f in withText.properties,
      Object.keys(withText.properties).join(', '));
  }

  // The guarantee this whole change is for. A reschedule is decoded against a
  // schema in which `title` does not exist, so it cannot be emitted — which is
  // the difference between a rule and a request, exactly as removing `why`
  // was in 0.14.0.
  check('reschedule cannot emit a title', enumOf(noText).includes('reschedule'),
    enumOf(noText).join(', '));
  check('nor can snooze, complete, delete or chat',
    ['snooze', 'complete', 'delete', 'chat'].every((a) => enumOf(noText).includes(a)),
    enumOf(noText).join(', '));
  check('create_reminder still can', enumOf(withText).includes('create_reminder'),
    enumOf(withText).join(', '));
  check('and so can rename, annotate and create_goal',
    ['rename', 'annotate', 'create_goal'].every((a) => enumOf(withText).includes(a)),
    enumOf(withText).join(', '));
}

// ---------------------------------------------------------------------------
section('no action falls between the two branches');
//
// The failure this guards is silent and total: an action listed nowhere in the
// union CANNOT BE EMITTED AT ALL, so the feature simply stops existing and
// every message that wanted it routes to something else. Compared against the
// flat fallback schema, which is the one list of actions that already had to
// be complete.
{
  const union = [...enumOf(branches[0]), ...enumOf(branches[1])].sort();
  const flat = [...flatEnum].sort();
  eq('the two branches cover exactly the actions the flat schema has',
    union.join(','), flat.join(','));
  eq('and no action is in both', new Set(union).size, union.length);
}

// ---------------------------------------------------------------------------
section('an API that refuses the union still answers the message');
//
// `anyOf` is documented as supported (ai.google.dev structured-output, checked
// 06.09.2026) and cannot be verified from here against the real endpoint. So
// it degrades like everything else in gemini.ts: a 400 retries the SAME model
// with the flat schema, which is exactly the schema shipped up to 0.26.0.
//
// Without this, a schema the API will not accept is not a degraded turn — it
// is `if (!res.ok) throw` on the first rung of the ladder, on every call, for
// every user, until somebody redeploys.
{
  const rig = createRig();
  rig.rejectAnyOf = 'once';
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('אוקיי.');

  await say(rig, 'מה קורה', Date.parse('2026-09-06T09:00:00Z'));

  const texts = rig.texts();
  check(`he got an answer — ${JSON.stringify(texts)}`, texts.length > 0, texts.join(' | '));
  const routers = rig.geminiCalls.filter((c) => c.kind === 'router');
  const isUnion = (c: any) => !!c?.schema?.properties?.actions?.items?.anyOf;
  const isFlat = (c: any) => !!c?.schema?.properties?.actions?.items?.properties?.action;

  check(`the union was tried first — ${routers.length} router call(s)`,
    isUnion(routers[0]), JSON.stringify(routers[0]?.schema).slice(0, 120));
  // Not an index: callOnce's own thinkingConfig retry sits in between, and
  // pinning the position would make this test a description of that retry
  // rather than of the schema fallback.
  check('and the call that answered went out flat',
    isFlat(routers[routers.length - 1]),
    JSON.stringify(routers[routers.length - 1]?.schema).slice(0, 120));
  check('the flat schema was never sent before the union was refused',
    routers.findIndex(isFlat) > routers.findIndex(isUnion),
    routers.map((c) => (isUnion(c) ? 'union' : 'flat')).join(' → '));
  check('on the same model, not a tier down',
    new Set(rig.modelsCalled).size === 1, rig.modelsCalled.join(', '));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('the fallback fires once, and does not become a blanket retry');
//
// A 400 on the FLAT schema is a real error — there is nothing left to degrade
// to — and it has to surface rather than loop. Same shape as the model ladder:
// dropping a tier is not a licence to keep asking.
{
  const rig = createRig();
  rig.rejectAnyOf = 'always';
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('לא הצלחתי.');

  await say(rig, 'מה קורה', Date.parse('2026-09-06T09:00:00Z'));

  const routers = rig.geminiCalls.filter((c) => c.kind === 'router');
  // Four: the union and its thinkingConfig retry, then the flat schema and
  // its thinkingConfig retry. What must not happen is a fifth — the fallback
  // fires once, and a schema with nothing left to degrade to is an error.
  check(`the flat retry was not itself retried — ${routers.length} call(s)`,
    routers.length <= 4, String(routers.length));
  check('and it did try the flat schema before giving up',
    routers.some((c: any) => !!c?.schema?.properties?.actions?.items?.properties?.action),
    String(routers.length));
  const errs = rig.db.prepare('SELECT COUNT(*) AS n FROM errors').get() as any;
  check('and the failure is on the record', errs.n > 0, JSON.stringify(errs));
  rig.restore();
}

// ---------------------------------------------------------------------------
section('a refused schema is visible, because otherwise nothing about it is');
//
// The fallback works. That is the problem: a refused union produces a good
// reply, no error row, and no symptom at all — the guarantee would simply not
// be in force, silently, for as long as nobody looked. Which is `patterns.ts`
// (zero rows in a month) and `GOAL_QUIET_AFTER` (check-ins off since 17.08)
// for the third time in this sequence, so it gets counted out loud.
{
  const clean = createRig();
  const before = (await withNow(Date.parse('2026-09-06T09:00:00Z'), () =>
    handleSlash(clean.env, CHAT, '/diag'))) ?? '';
  check('a healthy deploy says so', /סכימת הראוטר: תקינה/.test(before), before);
  // The healthy line reads "תקינה (לא נדחתה מעולם)", so a bare /נדחתה/ matches
  // it and would pass on the wording rather than on the state.
  check('and does not claim a refusal that never happened',
    !/סכימת הראוטר נדחתה/.test(before), before);
  clean.restore();

  const rig = createRig();
  rig.rejectAnyOf = 'once';
  rig.routerQueue.push({ actions: [{ action: 'chat' }] });
  rig.speakQueue.push('אוקיי.');
  await say(rig, 'מה קורה', Date.parse('2026-09-06T09:00:00Z'));

  const out = (await withNow(Date.parse('2026-09-06T09:01:00Z'), () =>
    handleSlash(rig.env, CHAT, '/diag'))) ?? '';
  check('after a refusal /diag names it', /סכימת הראוטר נדחתה/.test(out), out);
  check('with the model that refused it', out.includes(rig.modelsCalled[0]), out);
  rig.restore();
}

done();
