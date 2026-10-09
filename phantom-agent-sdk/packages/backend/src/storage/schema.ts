// Drizzle mirror of migrations/*.sql. The SQL files are the source of truth
// (applied by Database.migrate); this file exists for typed queries. Every
// table here is the SDK's, in the SDK's schema (phantom_agent_sdk, 054); an
// app's tables live in the app's schema with the app's migrations.
import { getTableColumns, sql } from 'drizzle-orm';
import type { StoredSystemPrompt } from '@phantom-agent-sdk/client/systemPrompt';
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
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value,
});

export const phantomAgentSdk = pgSchema('phantom_agent_sdk');

// ONE store for settings and secrets — a row is (scope, namespace, key).
// `namespace` separates the declared settings world ('general' — every key
// declared in code; a credential is the same kind of row with its value in
// value_enc) from user-named secrets ('secret' — free names, token in
// value_enc, description in plain value). The CHECK constraints (in SQL, not
// here) make a general row hold exactly one of the two columns and a secret
// row both (migrations 010, 034).
export const settings = phantomAgentSdk.table('settings', {
  scope: text('scope').notNull().default('global'),  // global | organization:<id> | user:<id> | project:<id>
  namespace: text('namespace').notNull().default('general'),  // general | secret
  key: text('key').notNull(),
  value: json('value'),
  valueEnc: bytea('value_enc'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.scope, table.namespace, table.key] })]);

// A registered GitHub repository. Its clone URL is derived from owner + name
// (git/remote.ts remoteUrl), not stored (032).
export const projects = phantomAgentSdk.table('projects', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  displayName: text('display_name'),
  baseBranch: text('base_branch').notNull(),
  branchPrefix: text('branch_prefix').notNull().default('agent'),
  kanbanColumns: jsonb('kanban_columns').$type<string[]>(),
  // The next card number this project hands out. Numbers are never reused:
  // a deleted card's stays taken. (024; Projects.claimCardNumber moves it.)
  nextCardNumber: integer('next_card_number').notNull().default(1),
  // The organization this project belongs to (056, 059): the caller's, or
  // 'service_role' — the service role's own. Everything under the project takes
  // it (059's triggers). Its settings layer rides in the project's chain
  // (scopes.ts scopeOf).
  organizationId: text('organization_id').notNull().default(sql`coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.service_role_organization())`),
  // Who made it (059); null = the service role, or a user since deleted.
  userId: text('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// The board (024: one table, every project). Status is a plain string
// matched against the project's column list (projects.kanban_columns,
// default in code) — columns are data, not DDL. What an app knows about a
// card beyond these columns is the app's table, keyed by `id`
// (CardFieldsExtension). `requirements` is the ONE checklist — {key, text,
// done}, done meaning VERIFIED. Column keys are snake_case on purpose: a card row IS the
// API's card, sent as stored to the cli and the agents' kanban tools.
export const cards = phantomAgentSdk.table('cards', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  project_id: text('project_id').notNull(),
  number: integer('number').notNull(),  // PHA-7 is card 7 — the permanent handle, never reused
  status: text('status').notNull().default('backlog'),
  pos: real('pos').notNull(),
  title: text('title').notNull(),
  details: text('details').notNull().default(''),
  requirements: jsonb('requirements').$type<{ key: string; text: string; done: boolean }[]>().notNull().default([]),
  blocked_reason: text('blocked_reason'),
  resolution: text('resolution'),
  pinned: boolean('pinned').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Whose it is (059): its project's organization, set by a trigger; the
  // user who made it (null = the service role). A card run acts for them.
  organization_id: text('organization_id').notNull().default(sql`coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.service_role_organization())`),
  user_id: text('user_id').default(sql`phantom_agent_sdk.caller_user()`),
}, (table) => [unique().on(table.project_id, table.number)]);

// A card's history, written by a trigger on every update (024, 028, 033) so
// edits made over SQL are recorded too. `changed_from`: the keys that
// changed and the value each had before the write. Linked by the card's
// key; goes with the card (cascade).
export const cardRevisions = phantomAgentSdk.table('card_revisions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  card_id: bigint('card_id', { mode: 'number' }).notNull(),
  changed_from: jsonb('changed_from').notNull(),
  changed_at: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

// A checkout: the files on disk, the branch, the container. The directory on
// disk is named by this id (which equals the owning session's id). The row is
// permanent — it is what remembers the branch; the FILES can be deleted and
// re-cloned from it. Goes with its project (cascade, 026). Every fact about
// the checkout lives here (036); a session reads them through its workspace_id.
export const workspaces = phantomAgentSdk.table('workspaces', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
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
  // refresh for workspaces with a running container; null = never measured.
  workState: text('work_state'),
  // The checkout lock (038): the one git sync writing this checkout right
  // now, and when its hold lapses. Fresh id per run, never re-entered.
  syncLockedBy: text('sync_locked_by'),
  syncLockExpiresAt: timestamp('sync_lock_expires_at', { withTimezone: true }),
  // WHERE THE FILES AND THE CONTAINER ARE (062): the session runner this
  // workspace was placed on, null for the backend itself (this server).
  // Decided once at creation (host/SessionRunners.ts place), rewritten only
  // by a move. Every file, git and container call routes by it.
  sessionRunnerId: text('session_runner_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// A SESSION RUNNER (062): a box running Docker and a workspace volume that
// connects OUT to this server and runs workspaces for it. Shared (owner
// null: registered with the service role key, any workspace may land there) or
// a user runner (a user's: only their workspaces). `boot` is the host process's
// id — a reconnect carries the same one, a restart a new one. `facts` is
// what the box reported at hello (host/protocol.ts HostFacts).
export const sessionRunners = phantomAgentSdk.table('session_runners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerUserId: text('owner_user_id'),
  boot: text('boot'),
  facts: json('facts').notNull().$type<{ dockerVersion?: string; arch?: string; diskSupport: string | null; sdkVersion: string; version?: string }>(),
  connectedAt: timestamp('connected_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// A conversation. Its checkout facts — files present, last touched, last
// pushed, git state — are its WORKSPACE's (036); reads join them in.
export const sessions = phantomAgentSdk.table('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  // The agent TYPE this session runs — a registered type's name (050).
  agent: text('agent').notNull(),
  // Who opened the session — the opener's declared actor, `person` when
  // unsaid. A fact, set once (050).
  startedBy: text('started_by').notNull(),
  // Who drove the last turn — the turn's declared actor (052). Null until a
  // turn ends. The list's background rule reads this before started_by.
  lastTurnBy: text('last_turn_by'),
  // WHICH user: who started it (059, the database stamps it) and who drove
  // the last turn (060). started_by / last_turn_by say what KIND of driver.
  userId: text('user_id'),
  lastTurnUserId: text('last_turn_user_id'),
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
  // WHICH WORKSPACE MY TOOLS OPEN. A coder points at its own id; a supervisor
  // at its coder's; the assistant at the on-screen session's. Null only for
  // an assistant with no session on screen yet (no files to read). Resolved
  // in ONE place (Sessions.workspaceOf) — nothing falls back to the session id.
  workspaceId: text('workspace_id'),
  // THE CARD THIS SESSION WORKS ON — the card's key (cards.id), null when it
  // is on no card: how a card is tied to the agents working it. Every
  // session on the card carries it; which one OWNS the card is derived — its
  // newest session with a workspace of its own (Sessions.ownerOnCard), the
  // newest of a type by newestOnCard. Written by an app when it opens a
  // card's sessions (Sessions.setCard). A deleted card leaves its sessions
  // unlinked (on delete set null). (027)
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
  // The append protocol's two facts (043): how many lines the record holds,
  // and the id of the last append that landed — Sessions.appendTranscript.
  transcriptLines: integer('transcript_lines').notNull().default(0),
  transcriptDelivery: text('transcript_delivery'),
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
  // The pin's reasoning level, when the opener named one (a cron's). Null = the settings' (051).
  reasoning: text('reasoning'),
  // THE system prompt this session runs on, in its three sections — stable,
  // context, volatile (@phantom-agent-sdk/client/systemPrompt; one system block and
  // one cache mark each). Assembled ONCE at birth from the agent's layout
  // and that moment's facts — skills, secrets, SOUL.md, the date — and never
  // rewritten, so a prompt edit reaches new sessions only and a running
  // session's cache never moves. A duplicate takes its source's. Every
  // session has one, whatever agent runs it. (025, 046;
  // Sessions.systemPrompt / freezeSystemPrompt)
  systemPrompt: jsonb('system_prompt').$type<StoredSystemPrompt>(),
});

// Every sessions read selects THESE (plus the workspace's facts, joined —
// Sessions.view), never the bare table: the columns left out are the blobs —
// the conversation and the frozen prompt — so no list or lookup hauls them
// through Postgres by accident. The transcript routes and the one-session
// view name them explicitly.
const { transcript: _transcriptBlob, systemPrompt: _promptBlob, ...withoutBlob } = getTableColumns(sessions);
export const sessionColumns = withoutBlob;

// Telegram (migrations 012, 031). Three tables, three owners in
// telegram/: TelegramBotState, TelegramSentMessages, TelegramHandledUpdates.

// The ONE row (id pinned 1): the link — the webhook registration and the
// bot's name. What the bot DOES with a message (which agent answers, which
// session it points at) is the app's, in the app's own table.
export const telegramBotState = phantomAgentSdk.table('telegram_bot_state', {
  id: integer('id').primaryKey().default(1),
  webhookSecretEnc: bytea('webhook_secret_enc'),
  webhookUrl: text('webhook_url'),
  botUsername: text('bot_username'),
});

// Linked Telegram chats (061): a user's private chat with the bot, or a
// group linked to one project. Everything said there runs as its user.
// telegram/chats.ts is the one owner.
export const telegramChats = phantomAgentSdk.table('telegram_chats', {
  id: text('id').primaryKey(),
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
  organizationId: text('organization_id').notNull().default(sql`coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.service_role_organization())`),
  userId: text('user_id'),
  projectId: text('project_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type TelegramChatRow = typeof telegramChats.$inferSelect;

// A link in waiting (061): a one-time code, ten minutes.
export const telegramLinkCodes = phantomAgentSdk.table('telegram_link_codes', {
  code: text('code').primaryKey(),
  organizationId: text('organization_id').notNull().default(sql`coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.service_role_organization())`),
  userId: text('user_id'),
  projectId: text('project_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// One row per message the bot sent — a reply or reaction to it carries only
// (chat, message id), and this says which conversation it belongs to.
export const telegramSentMessages = phantomAgentSdk.table('telegram_sent_messages', {
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  messageId: bigint('message_id', { mode: 'number' }).notNull(),
  content: text('content').notNull(),
  // The session the bubble came from; null = the assistant's. Keyed, gone
  // with its session (031).
  sessionId: text('session_id'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.chatId, table.messageId] })]);

// One row per Telegram update_id already handled: Telegram re-delivers, the
// repeat loses the insert and is dropped.
export const telegramHandledUpdates = phantomAgentSdk.table('telegram_handled_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
});

// Background tasks (migration 029, was `commands`): one row per detached
// bash command a session's agent runs — the /tasks screen and the task_*
// tools read it. BackgroundTasks (backgroundTasks.ts) is its one writer.
export const backgroundTasks = phantomAgentSdk.table('background_tasks', {
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
export const presets = phantomAgentSdk.table('presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  values: jsonb('values').notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PresetRow = typeof presets.$inferSelect;

// Media (058): tracked files on S3-compatible storage. The row is the file;
// the bucket holds its bytes at `key`. Owner is the organization
// ('service_role' = the service role's own); `userId` is who uploaded it.
// media/Media.ts is the one owner.
export const media = phantomAgentSdk.table('media', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().default(sql`coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.service_role_organization())`),
  userId: text('user_id'),
  projectId: text('project_id'),
  sessionId: text('session_id'),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('uploading').$type<'uploading' | 'ready'>(),
  endpoint: text('endpoint').notNull(),
  bucket: text('bucket').notNull(),
  key: text('key').notNull(),
  uploadId: text('upload_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MediaRow = typeof media.$inferSelect;

// Token usage (migrations 022, 023, 030, 059 — was log_tokens): one entry
// per model call — agent steps and one-shot helper calls alike. The one
// store for all spend; TokenLog (TokenLog.ts) is its one writer. `session_id` is deliberately
// not a foreign key: the spend report is by date and outlives the session.
// Null for a helper call that serves no one session (the digest).
export const tokenUsage = phantomAgentSdk.table('token_usage', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'),
  // Whose spend (059): the session's organization and project when it names
  // one (a trigger fills them), else the caller's; the user whose turn it was.
  organizationId: text('organization_id').notNull().default(sql`coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.service_role_organization())`),
  projectId: text('project_id'),
  userId: text('user_id'),
  type: text('type').notNull(),
  provider: text('provider'),
  model: text('model'),
  responseId: text('response_id'),
  tokensInput: bigint('tokens_input', { mode: 'number' }).notNull().default(0),
  tokensOutput: bigint('tokens_output', { mode: 'number' }).notNull().default(0),
  tokensCacheRead: bigint('tokens_cache_read', { mode: 'number' }).notNull().default(0),
  tokensCacheWrite: bigint('tokens_cache_write', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Crons (migration 037, 040): a project's scheduled prompts. The scheduler
// (crons/engine.ts) holds one croner job per enabled row, re-read every
// minute; at its time a job opens a NEW coding session in the project and
// runs the prompt as one turn — or, for a `script` cron, runs `sh <path>`
// in the session's container with no model — the session is the run's
// record. Exactly one of `prompt` / `script` is set (migration 040). A slot
// that passed while the server was down never fires. RECURRING: `schedule` is a 5-field cron expression, the row lives
// until removed. ONE-TIME (`once`): `schedule` is an ISO datetime, the row
// fires and is deleted. Read in the project's `timezone`. Crons
// (crons.ts) is its one owner. Column keys are snake_case like cards': a row
// IS the API's cron.
export const crons = phantomAgentSdk.table('crons', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  project_id: text('project_id').notNull(),
  // Who made it (059): a run is theirs — the scheduler acts for them, so
  // their keys come first. Null = the service role, or a user since deleted.
  user_id: text('user_id'),
  name: text('name').notNull(),   // the handle — unique per project, case-insensitively
  schedule: text('schedule').notNull(),
  once: boolean('once').notNull(),
  prompt: text('prompt'),   // what an agent run is asked to do
  script: text('script'),   // a path in the checkout, run with sh — no model
  // The model a run pins to; null = the project's settings at fire time.
  // provider+model together or not at all (migration 042).
  provider: text('provider'),
  model: text('model'),
  reasoning: text('reasoning'),
  enabled: boolean('enabled').notNull().default(true),
  last_run_at: timestamp('last_run_at', { withTimezone: true }),   // when it last fired; null = never
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type CardRow = typeof cards.$inferSelect;
export type CronRow = typeof crons.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type SessionRunnerRow = typeof sessionRunners.$inferSelect;
/** The checkout's facts as a session carries them: joined from its workspace
 *  on every read. `status` says whether the files exist ('active' /
 *  'destroyed' — the wire's words); a session with no workspace reads as
 *  active with nothing to measure. */
export interface CheckoutFacts {
  branch: string | null;
  status: 'active' | 'destroyed';
  lastUsedAt: Date;
  lastPushAt: Date | null;
  workState: string | null;
  /** The session runner the checkout is on; null = this server (062). */
  sessionRunnerId: string | null;
}
/** A session as reads return it — sessionColumns' shape, blobs excluded,
 *  its workspace's facts joined in (Sessions.view). */
export type SessionRow = Omit<typeof sessions.$inferSelect, 'transcript' | 'systemPrompt'> & CheckoutFacts;

// ── identity (055) ──────────────────────────────────────────────────────
// Better Auth's tables, in their own schema; its Drizzle adapter takes
// these objects (Identity). Property names are Better Auth's field names
// (its adapter finds a column by them); the column names are ours. Every
// table is read and written by Better Auth alone, except the reads Identity
// makes to answer who a caller is.
export const identity = pgSchema('identity');

export const user = identity.table('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  role: text('role'),                     // admin plugin: 'admin' | 'user'
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
});

export const session = identity.table('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  activeOrganizationId: text('active_organization_id'),
  impersonatedBy: text('impersonated_by'),
});

export const account = identity.table('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const verification = identity.table('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organization = identity.table('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  metadata: text('metadata'),
});

export const member = identity.table('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),   // owner | admin | member
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const invitation = identity.table('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  inviterId: text('inviter_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
});

export const apikey = identity.table('apikey', {
  id: text('id').primaryKey(),
  configId: text('config_id').notNull().default('default'),
  name: text('name'),
  start: text('start'),
  referenceId: text('reference_id').notNull(),
  prefix: text('prefix'),
  key: text('key').notNull(),
  refillInterval: integer('refill_interval'),
  refillAmount: integer('refill_amount'),
  lastRefillAt: timestamp('last_refill_at', { withTimezone: true }),
  enabled: boolean('enabled').default(true),
  rateLimitEnabled: boolean('rate_limit_enabled').default(true),
  rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
  rateLimitMax: integer('rate_limit_max').default(10),
  requestCount: integer('request_count').default(0),
  remaining: integer('remaining'),
  lastRequest: timestamp('last_request', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  permissions: text('permissions'),
  metadata: text('metadata'),
});

export type UserRow = typeof user.$inferSelect;
export type OrganizationRow = typeof organization.$inferSelect;
export type MemberRow = typeof member.$inferSelect;
export type InvitationRow = typeof invitation.$inferSelect;
export type ApiKeyRow = typeof apikey.$inferSelect;
