// Identity — who a caller is. The one owner of Better Auth (docs/multi-user.md):
// its tables (storage/schema.ts, schema `identity`), its routes (mounted at
// /api/auth/*), and the answer every other route wants: `callerOf(request)`.
//
// Off (no config.identity): no route, no row written, `callerOf` knows only
// the phantom admin. On: people sign in by magic link (invite-only — a stranger's
// email gets no mail and no account), every user has a personal organization
// from their first sign-in and an invitation adds membership in another; a
// cli carries the session token as a bearer, a program a long-lived API key.
// The phantom admin's API key stays what it is and is a caller here too.
//
// Who may see which project, session or row is NOT decided here — user space
// gates its /app routes with `require` and writes its own rules.
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fromNodeHeaders } from 'better-auth/node';
import { magicLink, organization, bearer, admin } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Database } from '../storage/Database.js';
import type { Mail, Mailer } from '../mail/Mailer.js';
import type { Settings } from '../storage/Settings.js';
import type { Projects } from '../storage/Projects.js';
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
  /** Ways in beside the magic link. Invite-only holds for each: nothing
   *  creates a user but the phantom admin and an invitation. */
  signIn?: {
    /** Email + password. An invited user sets theirs through the reset
     *  flow (`request-password-reset` → mail → `reset-password`); an
     *  unverified email cannot sign in until its link is clicked. */
    password?: boolean;
    /** OAuth apps, the app's own. A sign-in links to the user with that
     *  verified email; a stranger's is refused. */
    github?: OAuthApp;
    google?: OAuthApp;
  };
  /** The four mails' wording — user space's. Each a pure function of what
   *  the mail is about, answering what `Mailer.send` takes; one left out
   *  gets the SDK's plain default. The app builds its own links from the
   *  ids and urls given (the invitation has no url of its own: the page
   *  where the invitee signs in and accepts is the app's). */
  mail?: Partial<MailTemplates>;
}

export interface OAuthApp { clientId: string; clientSecret: string }

/** A template's answer: the mail without its recipient (the SDK adds that). */
export type MailBody = Omit<Mail, 'to'>;

/** What each mail is about. `url` is Better Auth's own link where one
 *  exists; the invitation's page is the app's to name. */
export interface MailTemplates {
  magicLink: (data: { email: string; url: string }) => MailBody;
  invitation: (data: { email: string; invitationId: string; organization: { id: string; name: string; slug: string };
    inviter: { name: string; email: string }; role: string }) => MailBody;
  passwordReset: (data: { user: { email: string; name: string }; url: string }) => MailBody;
  verification: (data: { user: { email: string; name: string }; url: string }) => MailBody;
}

/** How long a magic link may be clicked, seconds. */
const MAGIC_LINK_EXPIRES_IN = 15 * 60;

/** The SDK's wording, used where the app gave none. */
const DEFAULT_MAIL: MailTemplates = {
  magicLink: ({ url }) => ({ subject: 'Your sign-in link',
    text: `Sign in with this link (valid ${MAGIC_LINK_EXPIRES_IN / 60} minutes):\n\n${url}\n\nIf you did not ask for it, ignore this mail.` }),
  invitation: ({ organization, inviter, role, invitationId }) => ({ subject: `You're invited to ${organization.name}`,
    text: `${inviter.name} (${inviter.email}) invited you to ${organization.name} as ${role}.\n\nSign in with this address and accept invitation ${invitationId}.` }),
  passwordReset: ({ url }) => ({ subject: 'Set your password', text: `Set or reset your password here:\n\n${url}\n\nIf you did not ask for it, ignore this mail.` }),
  verification: ({ url }) => ({ subject: 'Verify your email', text: `Confirm this address:\n\n${url}` }),
};

export type OrganizationRole = 'owner' | 'admin' | 'member';

/** Who is calling: the phantom admin (the API key) or a signed-in user, in the
 *  organization their session is active in (their first, when none is). */
export type Caller =
  | { type: 'phantom_admin' }
  | { type: 'user'; user: UserRow; organization: OrganizationRow; role: OrganizationRole };

export class IdentityError extends Error {
  constructor(readonly code: 'disabled' | 'unauthorized' | 'email_taken', message: string) { super(message); this.name = 'IdentityError'; }
}

/** What the Better Auth instance is built from. */
interface AuthDeps {
  database: Database;
  mailer: Mailer;
  /** A deleted organization or user takes its settings layer with it. */
  settings: Settings;
  /** An organization that owns projects is not deleted. */
  projects: Projects;
  options: IdentityOptions;
  baseUrl: string;
  /** Magic links asked for by the phantom admin (bootstrap, no mail): the
   *  request's id → the resolver `sendMagicLink` hands the url to. */
  captures: Map<string, (url: string) => void>;
}

/** The Better Auth instance: the adapter over our tables, the two hooks
 *  (a personal organization at creation, an active one at sign-in), the
 *  plugins. A function, so the instance's type — which carries every
 *  plugin's endpoints — can be named (`BetterAuth`). */
function buildAuth({ database, mailer, settings, projects, options, baseUrl, captures }: AuthDeps) {
  const mail: MailTemplates = { ...DEFAULT_MAIL, ...options.mail };
  const send = (to: string, body: MailBody) => mailer.send({ to, ...body });
  const signIn = options.signIn ?? {};
  // The hooks and the invitation mail need the instance's own context, and
  // the instance does not exist while they are declared: a promise the
  // instance fills once built. (A hook called from an endpoint has `ctx`;
  // one called from `internalAdapter` does not.)
  // Only the members the hooks use are typed: the instance's own context
  // type is generic over its options and cannot be named before it exists.
  type Context = { adapter: { create: <T>(args: { model: string; data: Record<string, unknown> }) => Promise<T>;
    findOne: <T>(args: { model: string; where: { field: string; value: string }[] }) => Promise<T | null> };
    internalAdapter: { findUserByEmail: (email: string) => Promise<unknown>;
      createUser: (fields: { email: string; name: string }, source: { method: string }) => Promise<unknown>;
      updateUser: (id: string, fields: { emailVerified: boolean }) => Promise<unknown> } };
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
    emailAndPassword: {
      enabled: signIn.password === true,
      disableSignUp: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user: who, url }) => { await send(who.email, mail.passwordReset({ user: who, url })); },
      // The reset link went to this address and was followed: the address is
      // proven, as a clicked magic link proves it. An invited user's first
      // password comes this way, so without it they could never sign in.
      onPasswordReset: async ({ user: who }) => {
        if (!who.emailVerified) await (await context).internalAdapter.updateUser(who.id, { emailVerified: true });
      },
    },
    emailVerification: {
      // An unverified address signing in with a password gets the link again.
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user: who, url }) => { await send(who.email, mail.verification({ user: who, url })); },
    },
    socialProviders: {
      ...(signIn.github ? { github: { ...signIn.github, disableSignUp: true } } : {}),
      ...(signIn.google ? { google: { ...signIn.google, disableSignUp: true } } : {}),
    },
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
          await send(email, mail.magicLink({ email, url }));
        },
      }),
      organization({
        organizationHooks: {
          // Its projects are not the organization's to take with it: they are
          // deleted or moved first (056 restricts it too).
          beforeDeleteOrganization: async ({ organization: going }) => {
            const owned = await projects.ofOrganization(going.id);
            if (owned.length) throw APIError.from('CONFLICT', { code: 'ORGANIZATION_HAS_PROJECTS',
              message: `${going.name} still owns ${owned.map((project) => `${project.owner}/${project.name}`).join(', ')}: delete or move them first` });
          },
          afterDeleteOrganization: async ({ organization: gone }) => { await settings.deleteScope(organizationScope(gone.id)); },
        },
        sendInvitationEmail: async (data) => {
          // An invitee without an account gets one — invite-only sign-in needs
          // the user to exist before the link works.
          const { internalAdapter } = await context;
          if (!(await internalAdapter.findUserByEmail(data.email))) {
            await internalAdapter.createUser({ email: data.email, name: data.email }, { method: 'magic-link' });
            log.info({ email: data.email }, 'user created by invitation');
          }
          await send(data.email, mail.invitation({ email: data.email, invitationId: data.id, role: data.role,
            organization: { id: data.organization.id, name: data.organization.name, slug: data.organization.slug },
            inviter: { name: data.inviter.user.name, email: data.inviter.user.email } }));
        },
      }),
      bearer(),
      admin(),
      // A key remembers the organization it was made for (metadata.organizationId): callerOf reads it.
      apiKey({ enableSessionForAPIKeys: true, enableMetadata: true }),
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
    projects: Projects,
    options: IdentityOptions | undefined,
    /** The backend's public address (`https://host`): where the links point. */
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.enabled = options !== undefined;
    this.trustedOrigins = options?.trustedOrigins ?? [];
    if (!options) return;
    if (options.secret.length < 32) throw new Error('identity.secret must be at least 32 characters (openssl rand -hex 24)');
    this.#auth = buildAuth({ database, mailer, settings, projects, options, baseUrl, captures: this.#captures });
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

  /** Who is calling: the phantom admin's key, or a Better Auth session (cookie,
   *  bearer or API key) and the organization it is active in. Null: nobody. */
  async callerOf(request: FastifyRequest): Promise<Caller | null> {
    const authorization = String(request.headers.authorization ?? '');
    if (timingSafeEqualStr(authorization, `Bearer ${this.apiKey}`)) return { type: 'phantom_admin' };
    if (!this.#auth) return null;
    const signedIn = await this.#auth.api.getSession({ headers: fromNodeHeaders(request.headers) }).catch((error: unknown) => {
      log.warn({ err: errStr(error) }, 'session lookup failed'); return null;
    });
    if (!signedIn) return null;
    // A sign-in carries the organization it is active in. An API key's
    // session does not — the key's own metadata.organizationId says, when
    // it was made for one. Neither: the user's first.
    const session = signedIn.session as { activeOrganizationId?: string | null; id: string };
    const activeId = session.activeOrganizationId ?? (request.headers['x-api-key'] ? await this.#organizationOfKey(session.id) : null);
    const memberships = await this.database.drizzle.select({ organization: organizationTable, role: member.role, user })
      .from(member).innerJoin(organizationTable, eq(member.organizationId, organizationTable.id)).innerJoin(user, eq(user.id, member.userId))
      .where(activeId ? and(eq(member.userId, signedIn.user.id), eq(member.organizationId, activeId)) : eq(member.userId, signedIn.user.id))
      .limit(1);
    const membership = memberships[0];
    if (!membership) return null;
    return { type: 'user', user: membership.user, organization: membership.organization, role: membership.role as OrganizationRole };
  }

  /** The organization an API key was made for: the key's
   *  metadata.organizationId. The session an API key stands up carries the
   *  key's id as its own (the plugin's doing), so one read — not a second
   *  verify, which would count against the key's rate limit twice. */
  async #organizationOfKey(keyId: string): Promise<string | null> {
    const [row] = await this.database.drizzle.select({ metadata: apikey.metadata }).from(apikey).where(eq(apikey.id, keyId));
    if (!row?.metadata) return null;
    try {
      const metadata = JSON.parse(row.metadata) as { organizationId?: unknown };
      return typeof metadata.organizationId === 'string' ? metadata.organizationId : null;
    } catch { return null; }
  }

  /** The caller, or `unauthorized` (a 401 once HttpApi's error handler sees
   *  it). `users: true` refuses the phantom admin's key too. */
  async require(request: FastifyRequest, options: { users?: boolean } = {}): Promise<Caller> {
    const caller = await this.callerOf(request);
    if (!caller || (options.users && caller.type !== 'user')) throw new IdentityError('unauthorized', 'sign in first');
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

  /** Bootstrap, the phantom admin's: a user with no mail involved. `email_taken`
   *  when one has that address. */
  async createUser(fields: { email: string; name?: string }): Promise<UserRow> {
    const context = await this.#on.$context;
    if (await context.internalAdapter.findUserByEmail(fields.email)) throw new IdentityError('email_taken', `a user with email ${fields.email} exists`);
    const created = await context.internalAdapter.createUser({ email: fields.email, name: fields.name ?? fields.email }, { method: 'admin' });
    log.info({ email: fields.email }, 'user created by the phantom admin');
    return (await this.database.drizzle.select().from(user).where(eq(user.id, created.id)))[0];
  }

  /** Bootstrap, the phantom admin's: the magic link for `email`, handed back
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
