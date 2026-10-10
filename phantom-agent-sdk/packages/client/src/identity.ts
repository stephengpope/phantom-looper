// The client's door to sign-in: who am I, and Better Auth's own client for
// everything else (sign in by magic link, password or GitHub; organizations,
// invitations, API keys, admin). Better Auth's client is typed against its
// server plugins and maintained with them — this file only points it at
// the backend and carries the credential.
import { createAuthClient } from 'better-auth/client';
import { magicLinkClient, organizationClient, adminClient } from 'better-auth/client/plugins';
import { apiKeyClient } from '@better-auth/api-key/client';
import type { Credential } from './backend.js';

/** Where Better Auth's routes live under the API. */
export const IDENTITY_PATH = '/api/auth';

/** Who is calling, as GET /api/identity/me answers it. */
export type Caller =
  | { type: 'service_role' }
  | { type: 'user'; user: { id: string; email: string; name: string; role: string | null }
      organization: { id: string; name: string; slug: string }; role: 'owner' | 'admin' | 'member' };

/** Every key says what it is by its prefix: the service role key
 *  (`SERVICE_ROLE_KEY`, the server's own — it bypasses every fence) and a
 *  user's API key (made at /api/auth/api-key, theirs alone). A key with
 *  neither is refused on sight: nothing guesses. */
export const SERVICE_ROLE_KEY_PREFIX = 'ph_service_role_';
export const USER_ROLE_KEY_PREFIX = 'ph_user_role_';

/** The credential a key is, by its prefix; null for a key with neither. */
export function credentialOf(key: string): Credential | null {
  if (key.startsWith(SERVICE_ROLE_KEY_PREFIX)) return { serviceRoleKey: key };
  if (key.startsWith(USER_ROLE_KEY_PREFIX)) return { userRoleKey: key };
  return null;
}

/** The headers a credential rides in: the service role key and a session
 *  token as a bearer, a user role key as x-api-key. */
export function credentialHeaders(credential: Credential): Record<string, string> {
  if ('serviceRoleKey' in credential) return { authorization: `Bearer ${credential.serviceRoleKey}` };
  if ('sessionToken' in credential) return { authorization: `Bearer ${credential.sessionToken}` };
  return { 'x-api-key': credential.userRoleKey };
}

export interface IdentityDeps {
  /** The backend's origin (`https://host`). */
  origin: string;
  credential: () => Credential;
  /** A sign-in or verify handed a session token: keep it for every call from now on. */
  onSessionToken: (token: string) => void;
  fetch: typeof fetch;
  /** GET /api/identity/me through the API client (its envelope). */
  me: () => Promise<Caller>;
}

/** Better Auth's client, pointed at the backend, the credential on every
 *  call, the session token a sign-in answers kept for the next. */
export function makeAuthClient(deps: IdentityDeps) {
  return createAuthClient({
    baseURL: deps.origin,
    basePath: IDENTITY_PATH,
    plugins: [magicLinkClient(), organizationClient(), adminClient(), apiKeyClient()],
    fetchOptions: {
      customFetchImpl: deps.fetch,
      // Per request, so a session token kept by a sign-in rides the next call.
      // The origin is the backend's own, always trusted: Node's fetch marks
      // every request `sec-fetch-mode: cors` and sends no Origin, which Better
      // Auth refuses on a sign-in (MISSING_OR_NULL_ORIGIN). A browser ignores
      // this header and sends its real one.
      onRequest: (context: { headers: Headers }) => {
        for (const [name, value] of Object.entries({ origin: deps.origin, ...credentialHeaders(deps.credential()) })) context.headers.set(name, value);
      },
      onSuccess: (context: { response: Response }) => {
        const token = context.response.headers.get('set-auth-token');
        if (token) deps.onSessionToken(token);
      },
    },
  });
}

export class Identity {
  /** Better Auth's client: `signIn.magicLink`, `magicLink.verify`,
   *  `signIn.email`, `signIn.social`, `signOut`, `organization.*`,
   *  `apiKey.*`, `admin.*`. */
  readonly auth: ReturnType<typeof makeAuthClient>;

  constructor(private readonly deps: IdentityDeps) { this.auth = makeAuthClient(deps); }

  /** Who this client is to the backend: the service role, or a user in their
   *  organization. Throws the backend's `unauthorized` for nobody. */
  me(): Promise<Caller> { return this.deps.me(); }

  /** A magic link's token (the link's `token=`): signs in, keeps the
   *  session token on this client, answers who signed in. */
  async verify(token: string): Promise<Caller> {
    const result = await this.auth.magicLink.verify({ query: { token } });
    if (result.error) throw new Error(result.error.message ?? 'the link was refused');
    return this.me();
  }
}
