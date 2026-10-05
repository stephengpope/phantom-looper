// Identity — who a caller is. The one owner of Better Auth (docs/multi-user.md):
// its tables (storage/schema.ts, schema `identity`), its routes (mounted at
// /api/auth/*), and the answer every other route wants: `callerOf(request)`.
//
// Off (no config.identity): no route, no row written, `callerOf` knows only
// the operator. On: people sign in by magic link (invite-only — a stranger's
// email gets no mail and no account), every user has a personal organization
// from their first sign-in and an invitation adds membership in another; a
// cli carries the session token as a bearer, a program a long-lived API key.
// The operator's API key stays what it is and is a caller here too.
//
// Who may see which project, session or row is NOT decided here — user space
// gates its /app routes with `require` and writes its own rules.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fromNodeHeaders } from 'better-auth/node';
import { magicLink, organization, bearer, admin, openAPI } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Database } from '../storage/Database.js';
import type { Mailer } from '../mail/Mailer.js';
import type { Settings } from '../storage/Settings.js';
import { organizationScope, userScope } from '../lib/scopes.js';
import { user, session, account, verification, organization as organizationTable, member, invitation, apikey,
  type UserRow, type OrganizationRow } from '../storage/schema.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('identity');

/** Where Better Auth's routes live, under the API. */
export const IDENTITY_PATH = '/api/auth';

export interface IdentityOptions {
  /** Signs sessions and tokens. 32+ characters; rotating it signs everyone out. */
  secret: string;
  /** Browser apps on another origin that may call /api/auth and /app with
   *  credentials (CORS). The backend's own address is always trusted. */
  trustedOrigins?: string[];
  /** The page an invitation mail links to, given the invitation id — the
   *  app's own, where the invitee signs in and accepts. Unset: the mail
   *  carries the id and says to sign in. */
  invitationUrl?: (invitationId: string) => string;
}

export type OrganizationRole = 'owner' | 'admin' | 'member';

/** Who is calling: the operator (the API key) or a signed-in user, in the
 *  organization their session is active in (their first, when none is). */
export type Caller =
  | { kind: 'operator' }
  | { kind: 'user'; user: UserRow; organization: OrganizationRow; role: OrganizationRole };

export class IdentityError extends Error {
  constructor(readonly code: 'disabled' | 'unauthorized' | 'email_taken', message: string) { super(message); this.name = 'IdentityError'; }
}

/** How long a magic link may be clicked, seconds. */
const MAGIC_LINK_EXPIRES_IN = 15 * 60;

/** What the Better Auth instance is built from. */
interface AuthDeps {
  database: Database;
  mailer: Mailer;
  /** A deleted organization or user takes its settings layer with it. */
  settings: Settings;
  options: IdentityOptions;
  baseUrl: string;
  /** Magic links asked for by the operator (bootstrap, no mail): the
   *  request's id → the resolver `sendMagicLink` hands the url to. */
  captures: Map<string, (url: string) => void>;
}

/** The Better Auth instance: the adapter over our tables, the two hooks
 *  (a personal organization at creation, an active one at sign-in), the
 *  plugins. A function, so the instance's type — which carries every
 *  plugin's endpoints — can be named (`BetterAuth`). */
function buildAuth({ database, mailer, settings, options, baseUrl, captures }: AuthDeps) {
  // The hooks and the invitation mail need the instance's own context, and
  // the instance does not exist while they are declared: a promise the
  // instance fills once built. (A hook called from an endpoint has `ctx`;
  // one called from `internalAdapter` does not.)
  // Only the two members the hooks use are typed: the instance's own context
  // type is generic over its options and cannot be named before it exists.
  type Context = { adapter: { create: <T>(args: { model: string; data: Record<string, unknown> }) => Promise<T>;
    findOne: <T>(args: { model: string; where: { field: string; value: string }[] }) => Promise<T | null> };
    internalAdapter: { findUserByEmail: (email: string) => Promise<unknown>;
      createUser: (fields: { email: string; name: string }, source: { method: string }) => Promise<unknown> } };
  let ready!: (context: Context) => void;
  const context = new Promise<Context>((resolve) => { ready = resolve; });
  const adapter = async () => (await context).adapter;
  const auth = betterAuth({
    database: drizzleAdapter(database.drizzle, { provider: 'pg',
      schema: { user, session, account, verification, organization: organizationTable, member, invitation, apikey } }),
    secret: options.secret,
    baseURL: baseUrl,
    basePath: IDENTITY_PATH,
    trustedOrigins: options.trustedOrigins,
    emailAndPassword: { enabled: false },
    databaseHooks: {
      // A personal organization, owned, from the first moment there is a user.
      user: { create: { after: async (created) => {
        const db = await adapter();
        const personal = await db.create<{ id: string }>({ model: 'organization',
          data: { name: created.name || created.email, slug: `personal-${created.id.toLowerCase()}`, createdAt: new Date() } });
        await db.create({ model: 'member', data: { organizationId: personal.id, userId: created.id, role: 'owner', createdAt: new Date() } });
      } }, delete: { after: async (gone) => { await settings.deleteScope(userScope(gone.id)); } } },
      // A sign-in opens in an organization: the first membership when the
      // session says none.
      session: { create: { before: async (opening) => {
        if (opening.activeOrganizationId) return { data: opening };
        const first = await (await adapter()).findOne<{ organizationId: string }>({ model: 'member', where: [{ field: 'userId', value: opening.userId }] });
        return { data: { ...opening, activeOrganizationId: first?.organizationId } };
      } } },
    },
    plugins: [
      magicLink({
        disableSignUp: true,
        expiresIn: MAGIC_LINK_EXPIRES_IN,
        sendMagicLink: async ({ email, url, metadata }, ctx) => {
          const capture = typeof metadata?.capture === 'string' ? captures.get(metadata.capture) : undefined;
          if (capture) { capture(url); return; }
          // Invite-only: a stranger's email gets nothing (the endpoint still
          // answers 200, so nothing is learned from it).
          if (!ctx || !(await ctx.context.internalAdapter.findUserByEmail(email))) return;
          await mailer.send({ to: email, subject: 'Your sign-in link',
            text: `Sign in with this link (valid ${MAGIC_LINK_EXPIRES_IN / 60} minutes):\n\n${url}\n\nIf you did not ask for it, ignore this mail.` });
        },
      }),
      organization({
        organizationHooks: { afterDeleteOrganization: async ({ organization: gone }) => { await settings.deleteScope(organizationScope(gone.id)); } },
        sendInvitationEmail: async (data) => {
          // An invitee without an account gets one — invite-only sign-in needs
          // the user to exist before the link works.
          const { internalAdapter } = await context;
          if (!(await internalAdapter.findUserByEmail(data.email))) {
            await internalAdapter.createUser({ email: data.email, name: data.email }, { method: 'magic-link' });
            log.info({ email: data.email }, 'user created by invitation');
          }
          const where = options.invitationUrl ? `Accept it here: ${options.invitationUrl(data.id)}` : `Sign in with this address at ${baseUrl} and accept invitation ${data.id}.`;
          await mailer.send({ to: data.email, subject: `You're invited to ${data.organization.name}`,
            text: `${data.inviter.user.name} (${data.inviter.user.email}) invited you to ${data.organization.name} as ${data.role}.\n\n${where}` });
        },
      }),
      bearer(),
      admin(),
      apiKey({ enableSessionForAPIKeys: true }),
      openAPI(),
    ],
  });
  void auth.$context.then(ready);
  return auth;
}
type BetterAuth = ReturnType<typeof buildAuth>;

export class Identity {
  readonly enabled: boolean;
  /** Browser origins that may call /api/auth and /app with credentials. */
  readonly trustedOrigins: readonly string[];
  readonly #auth: BetterAuth | undefined;
  readonly #captures = new Map<string, (url: string) => void>();

  constructor(
    private readonly database: Database,
    mailer: Mailer,
    settings: Settings,
    options: IdentityOptions | undefined,
    /** The backend's public address (`https://host`): where the links point. */
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.enabled = options !== undefined;
    this.trustedOrigins = options?.trustedOrigins ?? [];
    if (!options) return;
    if (options.secret.length < 32) throw new Error('identity.secret must be at least 32 characters (openssl rand -hex 24)');
    this.#auth = buildAuth({ database, mailer, settings, options, baseUrl, captures: this.#captures });
  }

  get #on(): BetterAuth {
    if (!this.#auth) throw new IdentityError('disabled', 'identity is off on this backend (PhantomBackendConfig.identity)');
    return this.#auth;
  }

  /** Better Auth's routes. Mounted at /api/auth/* by HttpApi. */
  async handler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const url = new URL(request.url, this.baseUrl);
    const body = request.body === undefined || request.body === null ? undefined : JSON.stringify(request.body);
    const response = await this.#on.handler(new Request(url, { method: request.method, headers: fromNodeHeaders(request.headers), body }));
    reply.status(response.status);
    response.headers.forEach((value: string, key: string) => { reply.header(key, value); });
    reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
  }

  /** Who is calling: the operator's key, or a Better Auth session (cookie,
   *  bearer or API key) and the organization it is active in. Null: nobody. */
  async callerOf(request: FastifyRequest): Promise<Caller | null> {
    const authorization = String(request.headers.authorization ?? '');
    if (timingSafeEqualStr(authorization, `Bearer ${this.apiKey}`)) return { kind: 'operator' };
    if (!this.#auth) return null;
    const signedIn = await this.#auth.api.getSession({ headers: fromNodeHeaders(request.headers) }).catch((error: unknown) => {
      log.warn({ err: errStr(error) }, 'session lookup failed'); return null;
    });
    if (!signedIn) return null;
    const activeId = (signedIn.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
    const memberships = await this.database.drizzle.select({ organization: organizationTable, role: member.role, user })
      .from(member).innerJoin(organizationTable, eq(member.organizationId, organizationTable.id)).innerJoin(user, eq(user.id, member.userId))
      .where(activeId ? and(eq(member.userId, signedIn.user.id), eq(member.organizationId, activeId)) : eq(member.userId, signedIn.user.id))
      .limit(1);
    const membership = memberships[0];
    if (!membership) return null;
    return { kind: 'user', user: membership.user, organization: membership.organization, role: membership.role as OrganizationRole };
  }

  /** The caller, or `unauthorized` (a 401 once HttpApi's error handler sees
   *  it). `users: true` refuses the operator's key too. */
  async require(request: FastifyRequest, options: { users?: boolean } = {}): Promise<Caller> {
    const caller = await this.callerOf(request);
    if (!caller || (options.users && caller.kind !== 'user')) throw new IdentityError('unauthorized', 'sign in first');
    return caller;
  }

  /** An organization by id — what a settings route checks before writing
   *  its layer. Undefined when there is none, or identity is off. */
  async organization(id: string): Promise<OrganizationRow | undefined> {
    if (!this.#auth) return undefined;
    return (await this.database.drizzle.select().from(organizationTable).where(eq(organizationTable.id, id)))[0];
  }

  /** A user by id. Undefined when there is none, or identity is off. */
  async user(id: string): Promise<UserRow | undefined> {
    if (!this.#auth) return undefined;
    return (await this.database.drizzle.select().from(user).where(eq(user.id, id)))[0];
  }

  /** Bootstrap, the operator's: a user with no mail involved. `email_taken`
   *  when one has that address. */
  async createUser(fields: { email: string; name?: string }): Promise<UserRow> {
    const context = await this.#on.$context;
    if (await context.internalAdapter.findUserByEmail(fields.email)) throw new IdentityError('email_taken', `a user with email ${fields.email} exists`);
    const created = await context.internalAdapter.createUser({ email: fields.email, name: fields.name ?? fields.email }, { method: 'admin' });
    log.info({ email: fields.email }, 'user created by the operator');
    return (await this.database.drizzle.select().from(user).where(eq(user.id, created.id)))[0]!;
  }

  /** Bootstrap, the operator's: the magic link for `email`, handed back
   *  instead of mailed (no SMTP yet, or a link to paste). The link signs
   *  the user in on a click or on `GET` without a callbackURL. */
  async magicLink(email: string): Promise<string> {
    const auth = this.#on;
    const capture = randomUUID();
    let url: string | undefined;
    this.#captures.set(capture, (captured) => { url = captured; });
    try {
      await auth.api.signInMagicLink({ body: { email, metadata: { capture } }, headers: new Headers({ origin: this.baseUrl }) });
    } finally {
      this.#captures.delete(capture);
    }
    if (!url) throw new Error('no magic link was made');
    return url;
  }
}
