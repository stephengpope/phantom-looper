// Drizzle mirror of migrations/*.sql. The SQL files are the source of truth
// (applied by server/db/migrate.ts); this file exists for typed queries.
import { getTableColumns } from 'drizzle-orm';
import { pgSchema, text, jsonb, timestamp, integer, bigint, boolean, real, customType, primaryKey, unique } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

// jsonb as the DRIVER hands it over. pg already decodes jsonb (pg-types runs
// JSON.parse on it), and drizzle's own `jsonb` column decodes AGAIN whenever
// what arrives is a string — so a stored string that is itself valid JSON came
// back as that JSON: card_prefix "567" resolved to the number 567, the cli's
// session list put it in a label cell that only takes a string, and the app
// died on `label.length` (2026-09-03). Arrays and objects were never touched
// (drizzle only re-parses strings), which is why only a string-valued setting
// ever showed it. Writes stringify exactly as drizzle's jsonb did.
const json = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (v) => JSON.stringify(v),
  fromDriver: (v) => v,
});

export const phantomLooper = pgSchema('phantom_looper');

// ONE store for settings and secrets — a row is (scope, namespace, key).
// `namespace` separates the declared settings world ('general' — every key
// declared in code; a credential is the same kind of row with its value in
// value_enc) from user-named secrets ('secret' — free names, token in
// value_enc, description in plain value). The CHECK constraints (in SQL, not
// here) make a general row hold exactly one of the two columns and a secret
// row both (migrations 010, 034).
export const settings = phantomLooper.table('settings', {
  scope: text('scope').notNull().default('global'),  // global | workspace:<id>
  namespace: text('namespace').notNull().default('general'),  // general | secret
  key: text('key').notNull(),
  value: json('value'),
  valueEnc: bytea('value_enc'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.scope, t.namespace, t.key] })]);

// A registered GitHub repository. Its clone URL is derived from owner + name
// (git/remote.ts remoteUrl), not stored (032).
export const workspaces = phantomLooper.table('workspaces', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  displayName: text('display_name'),
  baseBranch: text('base_branch').notNull(),
  branchPrefix: text('branch_prefix').notNull().default('agent'),
  kanbanColumns: jsonb('kanban_columns').$type<string[]>(),
  // The next card number this workspace hands out. Numbers are never reused:
  // a deleted card's stays taken. (024; Workspaces.claimCardNumber moves it.)
  nextCardNumber: integer('next_card_number').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// The board (024: one table, every workspace). Status is a plain string
// matched against the workspace's column list (workspaces.kanban_columns,
// default in code) — columns are data, not DDL. `auto_plan`/`auto_build` are
// the per-card looper switches: null inherits the workspace setting of the
// same name. `requirements` is the ONE checklist — {key, text, done}, done
// meaning VERIFIED. Column keys are snake_case on purpose: a card row IS the
// API's card, sent as stored to the cli and the agents' kanban tools.
export const cards = phantomLooper.table('cards', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  workspace_id: text('workspace_id').notNull(),
  number: integer('number').notNull(),  // PHA-7 is card 7 — the permanent handle, never reused
  status: text('status').notNull().default('backlog'),
  pos: real('pos').notNull(),
  title: text('title').notNull(),
  details: text('details').notNull().default(''),
  requirements: jsonb('requirements').$type<{ key: string; text: string; done: boolean }[]>().notNull().default([]),
  blocked_reason: text('blocked_reason'),
  resolution: text('resolution'),
  auto_plan: boolean('auto_plan'),
  auto_build: boolean('auto_build'),
  pinned: boolean('pinned').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.workspace_id, t.number)]);

// A card's history, written by a trigger on every update (024, 028, 033) so
// edits made over SQL are recorded too. `changed_from`: the keys that
// changed and the value each had before the write. Linked by the card's
// key; goes with the card (cascade).
export const cardRevisions = phantomLooper.table('card_revisions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  card_id: bigint('card_id', { mode: 'number' }).notNull(),
  changed_from: jsonb('changed_from').notNull(),
  changed_at: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

// A checkout: the files on disk, the branch, the container. The directory on
// disk is named by this id (which equals the owning session's id). The row is
// permanent — it is what remembers the branch; the FILES can be deleted and
// re-cloned from it. Goes with its workspace (cascade, 026). Every fact about
// the checkout lives here (036); a session reads them through its folder_id.
export const folders = phantomLooper.table('folders', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  branch: text('branch').notNull(),
  // HEAD right after the checkout: base's tip for a new session, the source
  // branch's tip for a duplicate. /git/status counts base's commits since it.
  cutFromSha: text('cut_from_sha').notNull(),
  // Whether the files exist on this server right now. Destroy removes them
  // and clears this; a restart re-clones the branch and sets it again.
  onDisk: boolean('on_disk').notNull().default(true),
  // When the checkout was last touched by ANY session on it — a tool call,
  // a saved turn. Container reaping, the idle backup and the pressure sweep
  // read it; the session list orders by it. Background jobs never move it.
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  // When its branch last reached origin.
  lastPushAt: timestamp('last_push_at', { withTimezone: true }),
  // Its git state: not_pushed, not_merged, merged. Written by the periodic
  // refresh for folders with a running container; null = never measured.
  work: text('work'),
  // The checkout lock (038): the one git sync writing this checkout right
  // now, and when its hold lapses. Fresh id per run, never re-entered.
  syncLockedBy: text('sync_locked_by'),
  syncLockExpiresAt: timestamp('sync_lock_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// A conversation. Its checkout facts — files present, last touched, last
// pushed, git state — are its FOLDER's (036); reads join them in.
export const sessions = phantomLooper.table('sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  // Who drove the last turn: 'coding'/'supervisor' for the loop's seats,
  // null = a person's. The loop stamps its coder seat at turn start; every
  // transcript save re-derives it from the writer's client id (sessions.ts
  // agentAfterSave) — so a person typing into a card's coding session takes
  // it over, and the loop takes it back when it next drives. A supervisor
  // record never changes hands.
  agent: text('agent'),
  // The model-written title — what the session is building, best-effort,
  // written AFTER a transcript save (sessionTitle.ts), never in it. turnCount
  // is the clock that paces it: +1 per transcript save; naming fires at turn
  // 1 while unnamed, then every 10th turn. A duplicate copies the name and
  // starts the clock at 0. (007) nameManual marks a /rename — a person's
  // name, which the titler never writes over; renaming to null clears both
  // and re-enables the titler. (008)
  name: text('name'),
  turnCount: integer('turn_count').notNull().default(0),
  nameManual: boolean('name_manual').notNull().default(false),
  // /plan: while on, the cli builds the coding agent's mutating kits with the
  // readonly preset. The row is the record so every window agrees; false =
  // code mode, every new session's start. (009) The looper never reads this —
  // its plan-column kickoff passes plan mode explicitly per turn.
  planMode: boolean('plan_mode').notNull().default(false),
  // /pin: pinned to the top of every session list, ahead of recency and of
  // sessions in motion. The row is the record so every client agrees. (018,
  // renamed from starred in 019)
  pinned: boolean('pinned').notNull().default(false),
  // WHICH FOLDER MY TOOLS OPEN. A coder points at its own id; a supervisor
  // at its coder's; the assistant at the on-screen session's. Null only for
  // an assistant with no session on screen yet (no files to read). Resolved
  // in ONE place (Sessions.folderOf) — nothing falls back to the session id.
  folderId: text('folder_id'),
  // THE CARD THIS SESSION WORKS ON — the card's key (cards.id), null when it
  // is on no card. A coder and its supervisor both carry it. The pairing is
  // derived: a card's coder is its newest coding session, its supervisor its
  // newest supervisor session (Sessions.coderOf / supervisorOf). Written by
  // the looper when it opens a round's sessions (Sessions.setCard). A
  // deleted card leaves its sessions unlinked (on delete set null). (027)
  cardId: bigint('card_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // The session lock: who holds the conversation, until when. A hold ends by
  // release; one that ends by the clock alone means the holder DIED mid-turn
  // (crashed window, killed process) — the row keeps who and when as the
  // evidence, the next taker logs it, and the digest reports it as a death,
  // not a finished turn (Sessions.expiredHold).
  lockedBy: text('locked_by'),
  lockedLabel: text('locked_label'),
  lockExpiresAt: timestamp('lock_expires_at', { withTimezone: true }),
  // The conversation, whole — ONE per session (one session, one transcript;
  // migrations 002 + 005). On the row since 005; reads go through
  // sessionColumns below so no list ever drags the blob.
  transcript: text('transcript'),
  lastUserMessage: text('last_user_message'),
  transcriptUpdatedAt: timestamp('transcript_updated_at', { withTimezone: true }),
  // When this session was last included in the idle digest notification.
  // Null = never notified. A session is eligible when transcriptUpdatedAt >
  // digestNotifiedAt AND it has been idle > the configured threshold. (021)
  digestNotifiedAt: timestamp('digest_notified_at', { withTimezone: true }),
  // THE model this session runs on. Written at birth from the settings (a
  // duplicate takes its source's), moved by a settings write only while
  // turn_count is 0, frozen after — so a conversation cannot change model
  // mid-life. Every runner — coding, supervisor, assistant — reads these
  // three; nothing computes a model. The endpoint rides along because the
  // three only mean anything together. (015, 016; Sessions.birthModel /
  // followModelSettings)
  provider: text('provider'),
  model: text('model'),
  baseUrl: text('base_url'),
  // THE system prompt this session runs on, in the two pieces the prompt
  // cache wants (core/llm/prompts/coding/wiring.ts CodingPrompt). Frozen at
  // birth from that moment's facts — skills, secrets, credentials — and never
  // rewritten, so a prompt edit reaches new sessions only and a running
  // session's cache never moves. A duplicate takes its source's. Null on a
  // conversation-only session (supervisor, assistant): those build fresh.
  // (025; Sessions.systemPrompt / freezeSystemPrompt)
  systemPrompt: jsonb('system_prompt').$type<{ base: string; workspace: string }>(),
});

// Every sessions read selects THESE (plus the folder's facts, joined —
// Sessions.view), never the bare table: the columns left out are the blobs —
// the conversation and the frozen prompt — so no list or lookup hauls them
// through Postgres by accident. The transcript routes and the one-session
// view name them explicitly.
const { transcript: _transcriptBlob, systemPrompt: _promptBlob, ...withoutBlob } = getTableColumns(sessions);
export const sessionColumns = withoutBlob;

// Telegram (migrations 012, 031). Three tables, three owners in
// phantom-backend/telegram/: TelegramBotState, TelegramSentMessages,
// TelegramHandledUpdates.

// The ONE row (id pinned 1): who answers a plain message, which session and
// workspace are active, and the webhook registration.
export const telegramBotState = phantomLooper.table('telegram_bot_state', {
  id: integer('id').primaryKey().default(1),
  // 'assistant' (home) | 'code' (messages run coding turns on activeSessionId).
  mode: text('mode').notNull().default('assistant'),
  // Keyed to sessions / workspaces, cleared when the row goes (031).
  activeSessionId: text('active_session_id'),
  activeWorkspaceId: text('active_workspace_id'),
  webhookSecretEnc: bytea('webhook_secret_enc'),
  webhookUrl: text('webhook_url'),
  botUsername: text('bot_username'),
});

// One row per message the bot sent — a reply or reaction to it carries only
// (chat, message id), and this says which conversation it belongs to.
export const telegramSentMessages = phantomLooper.table('telegram_sent_messages', {
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  messageId: bigint('message_id', { mode: 'number' }).notNull(),
  content: text('content').notNull(),
  // The session the bubble came from; null = the assistant's. Keyed, gone
  // with its session (031).
  sessionId: text('session_id'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.chatId, t.messageId] })]);

// One row per Telegram update_id already handled: Telegram re-delivers, the
// repeat loses the insert and is dropped.
export const telegramHandledUpdates = phantomLooper.table('telegram_handled_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
});

// Background tasks (migration 029, was `commands`): one row per detached
// bash command a session's agent runs — the /tasks screen and the task_*
// tools read it. BackgroundTasks (backgroundTasks.ts) is its one writer.
export const backgroundTasks = phantomLooper.table('background_tasks', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  argv: jsonb('argv').notNull(),
  status: text('status').notNull(),
  exitCode: integer('exit_code'),
  // Container-namespace session id of the task's process tree (pid == sid;
  // runc setsids every exec) — captured at spawn, null until it lands.
  sid: text('sid'),
  logPath: text('log_path').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

// Provider presets: named snapshots of the model settings (provider/model/
// base_url for each agent, reasoning, max_steps). Migration 014.
export const presets = phantomLooper.table('presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  values: jsonb('values').notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PresetRow = typeof presets.$inferSelect;

// Token log (migrations 022, 023, 030): one entry per model call — agent
// steps and one-shot helper calls alike. The one store for all spend;
// LogTokens (logTokens.ts) is its one writer. `session_id` is deliberately
// not a foreign key: the spend report is by date and outlives the session.
// Null for a helper call that serves no one session (the digest).
export const logTokens = phantomLooper.table('log_tokens', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'),
  kind: text('kind').notNull(),
  provider: text('provider'),
  model: text('model'),
  responseId: text('response_id'),
  tokensInput: bigint('tokens_input', { mode: 'number' }).notNull().default(0),
  tokensOutput: bigint('tokens_output', { mode: 'number' }).notNull().default(0),
  tokensCacheRead: bigint('tokens_cache_read', { mode: 'number' }).notNull().default(0),
  tokensCacheWrite: bigint('tokens_cache_write', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Crons (migration 037): a workspace's scheduled prompts. The scheduler
// (crons/engine.ts) holds one croner job per enabled row, re-read every
// minute; at its time a job opens a NEW coding session in the workspace and
// runs the prompt as one turn — the session is the run's record. A slot
// that passed while the server was down never fires. RECURRING: `schedule` is a 5-field cron expression, the row lives
// until removed. ONE-TIME (`once`): `schedule` is an ISO datetime, the row
// fires and is deleted. Read in the workspace's `timezone`. Crons
// (crons.ts) is its one owner. Column keys are snake_case like cards': a row
// IS the API's cron.
export const crons = phantomLooper.table('crons', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  workspace_id: text('workspace_id').notNull(),
  name: text('name').notNull(),   // the handle — unique per workspace, case-insensitively
  schedule: text('schedule').notNull(),
  once: boolean('once').notNull(),
  prompt: text('prompt').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  last_run_at: timestamp('last_run_at', { withTimezone: true }),   // when it last fired; null = never
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type CardRow = typeof cards.$inferSelect;
export type CronRow = typeof crons.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
/** The checkout's facts as a session carries them: joined from its folder
 *  on every read. `status` says whether the files exist ('active' /
 *  'destroyed' — the wire's words); a session with no folder reads as
 *  active with nothing to measure. */
export interface CheckoutFacts {
  branch: string | null;
  status: 'active' | 'destroyed';
  lastUsedAt: Date;
  lastPushAt: Date | null;
  work: string | null;
}
/** A session as reads return it — sessionColumns' shape, blobs excluded,
 *  its folder's facts joined in (Sessions.view). */
export type SessionRow = Omit<typeof sessions.$inferSelect, 'transcript' | 'systemPrompt'> & CheckoutFacts;
