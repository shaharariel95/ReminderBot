/**
 * In-memory test rig: a real SQLite behind a D1-shaped facade, plus fetch stubs
 * for Gemini and Telegram. Lets the tick and webhook paths run end to end so a
 * bug like "the reminder never arrived" can be reproduced instead of argued about.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ D1 shim

/**
 * `state.dbFailOn`, when set, matches against the SQL text of every D1
 * `.run()` call (INSERT/UPDATE/DELETE — never `.first`/`.all`, which are
 * reads). The first write whose SQL matches throws instead of executing,
 * simulating a transient D1 failure in the middle of a multi-write turn, and
 * the trap disarms itself so later writes (e.g. a fallback capture reusing
 * the same table) are unaffected. `null` (the default) never fails.
 *
 * Targeting by SQL text rather than by call position means a test stays valid
 * when an unrelated write is added anywhere else in the turn — a positional
 * countdown breaks the moment call order shifts for any reason.
 */
function shim(sqlite: DatabaseSync, state: { dbFailOn: RegExp | null }) {
  const norm = (v: unknown) =>
    typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v;
  const out = (row: any) => {
    if (!row) return null;
    const o: any = {};
    for (const k of Object.keys(row)) o[k] = typeof row[k] === 'bigint' ? Number(row[k]) : row[k];
    return o;
  };

  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      const bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound.length = 0;
          bound.push(...args.map(norm));
          return api;
        },
        async first<T>(): Promise<T | null> {
          return out(stmt.get(...(bound as any))) as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: (stmt.all(...(bound as any)) as any[]).map(out) as T[] };
        },
        async run() {
          if (state.dbFailOn && state.dbFailOn.test(sql)) {
            state.dbFailOn = null; // fires once, then disarms
            throw new Error('test rig: simulated D1 write failure');
          }
          const r = stmt.run(...(bound as any));
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
        },
      };
      return api;
    },
  };
}

// --------------------------------------------------------------- fetch stub

export interface Sent {
  method: string;
  chat_id?: string;
  text?: string;
  markup?: unknown;
}

export interface GeminiCall {
  kind: 'router' | 'speak';
  /** The systemInstruction text — this is where the model's ground truth lives. */
  system: string;
}

export interface Rig {
  env: any;
  db: DatabaseSync;
  /** Every Telegram sendMessage that actually went out. */
  sent: Sent[];
  /**
   * Every outbound call (Telegram methods as `tg:<method>`, Gemini calls as
   * `gemini:<kind>`) in the single order they actually happened, across both
   * kinds — `sent` and `geminiCalls` are separate arrays and can't answer
   * "did the reaction fire before the model was consulted?" on their own.
   */
  timeline: string[];
  /**
   * Every millisecond value sendBurst actually requested from its inter-chunk
   * sleep, in order. `env.__burstSleep` (installed below) records into this
   * and resolves immediately rather than discarding the value — a stub that
   * only made pacing fast would leave a regression in the BURST_BUDGET_MS
   * clamping arithmetic (or in pacingDelay's own bounds) unobservable by any
   * test; recording turns the seam into something that makes timing
   * assertable instead of invisible.
   */
  burstDelays: number[];
  /** Every Gemini call, so a test can assert what the model was actually told. */
  geminiCalls: GeminiCall[];
  /** Plain text of the messages the user would have seen, in order. */
  texts(): string[];
  /** Bot API methods called, for asserting answerCallbackQuery and edits fired. */
  methods(): string[];
  /** Router JSON responses, consumed in order. */
  routerQueue: unknown[];
  /** speak() text responses, consumed in order. Strings, or Error to throw. */
  speakQueue: (string | Error)[];
  /** Set true to make every Gemini call fail, simulating a rate limit. */
  geminiDown: boolean;
  /** Models that should return 429, by exact id. */
  downModels: Set<string>;
  /** Every model id that was called, in order. */
  modelsCalled: string[];
  /** Set true to make every Telegram sendMessage fail, simulating an outage. */
  telegramDown: boolean;
  /**
   * When set, the next D1 `.run()` (write) whose SQL matches this pattern
   * throws instead of executing, then disarms itself. `null` (default) never
   * fails. Lets a test force one specific write mid-turn to fail without
   * touching Gemini or Telegram, and without depending on the position of
   * unrelated writes elsewhere in the same turn.
   */
  dbFailOn: RegExp | null;
  restore(): void;
}

export function createRig(opts: { tz?: string; chatId?: string } = {}): Rig {
  const chatId = opts.chatId ?? '12345';
  const sqlite = new DatabaseSync(':memory:');
  const schema = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');
  sqlite.exec(schema);
  const dbState: { dbFailOn: RegExp | null } = { dbFailOn: null };

  const rig: Rig = {
    env: {
      DB: shim(sqlite, dbState),
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_WEBHOOK_SECRET: 'test-secret',
      GEMINI_API_KEY: 'test-key',
      OWNER_CHAT_ID: chatId,
      GEMINI_MODEL: 'gemini-3.5-flash-lite',
      DEFAULT_TZ: opts.tz ?? 'Asia/Jerusalem',
      // Records what sendBurst actually requested instead of really sleeping
      // for it — see the `burstDelays` doc comment above. Referencing `rig`
      // here is safe: this closure only runs once a test calls sendBurst,
      // long after the `rig` binding below has been assigned.
      __burstSleep: async (ms: number) => {
        rig.burstDelays.push(ms);
      },
    },
    db: sqlite,
    sent: [],
    timeline: [],
    burstDelays: [],
    geminiCalls: [],
    texts: () => rig.sent.filter((s) => s.method === 'sendMessage').map((s) => s.text ?? ''),
    methods: () => rig.sent.map((s) => s.method),
    routerQueue: [],
    speakQueue: [],
    geminiDown: false,
    downModels: new Set<string>(),
    modelsCalled: [],
    get dbFailOn() {
      return dbState.dbFailOn;
    },
    set dbFailOn(v: RegExp | null) {
      dbState.dbFailOn = v;
    },
    telegramDown: false,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };

  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : {};

    if (url.includes('api.telegram.org')) {
      const method = url.split('/').pop()!;
      // Only sendMessage simulates the outage — sendChatAction already
      // swallows its own errors in telegram.ts, so failing it too would not
      // exercise anything new.
      if (rig.telegramDown && method === 'sendMessage') {
        return json({ ok: false, description: 'test rig: telegram down' });
      }
      rig.sent.push({ method, chat_id: body.chat_id, text: body.text, markup: body.reply_markup });
      rig.timeline.push(`tg:${method}`);
      return json({ ok: true, result: {} });
    }

    if (url.includes('generativelanguage.googleapis.com')) {
      const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
      rig.modelsCalled.push(model);
      if (rig.geminiDown || rig.downModels.has(model)) {
        return new Response('{"error":{"code":429,"message":"rate limit"}}', { status: 429 });
      }
      // The router is the call that pins a responseSchema; everything else is speak().
      const isRouter = !!body?.generationConfig?.responseSchema;
      rig.geminiCalls.push({
        kind: isRouter ? 'router' : 'speak',
        system: body?.systemInstruction?.parts?.[0]?.text ?? '',
      });
      rig.timeline.push(`gemini:${isRouter ? 'router' : 'speak'}`);
      const queue = isRouter ? rig.routerQueue : rig.speakQueue;
      if (!queue.length) {
        throw new Error(
          `test rig: unexpected ${isRouter ? 'router' : 'speak'} call, queue empty`,
        );
      }
      const next = queue.shift()!;
      if (next instanceof Error) throw next;
      const text = isRouter ? JSON.stringify(next) : String(next);
      return json({
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: {},
      });
    }

    throw new Error(`test rig: unexpected fetch to ${url}`);
  }) as any;

  return rig;
}

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ------------------------------------------------------------------ asserts

let failures = 0;
let currentSection = '';

export function section(name: string): void {
  currentSection = name;
  console.log(`\n--- ${name} ---`);
}

export function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
  } else {
    console.log(`PASS  ${label}`);
  }
}

export function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, `expected ${e}\n        actual   ${a}`);
}

export function done(): void {
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  if (failures > 0) (globalThis as any).process?.exit?.(1);
}

/** Run `fn` with the wall clock pinned to `ms`, so a tick can be tested at 07:05. */
export async function withNow<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/** A Telegram update carrying a text message from the owner. */
export function textUpdate(chatId: string, text: string): unknown {
  // A real message always has a message_id — handleUpdate's instant reaction
  // (Task 12) is keyed off it.
  return { message: { chat: { id: Number(chatId) }, text, message_id: 999 } };
}

/** A Telegram update for an inline button tap. */
export function callbackUpdate(chatId: string, data: string, fromId = chatId): unknown {
  return {
    callback_query: {
      id: 'cb1',
      from: { id: Number(fromId) },
      message: { message_id: 555, chat: { id: Number(chatId) } },
      data,
    },
  };
}
