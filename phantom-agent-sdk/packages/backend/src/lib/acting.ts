// Who the current work is for — the one context every database read and
// write runs under.
//
// A request from a user (sign-in token or user API key), or from the server
// key acting for one, runs inside `actAs`: every query on the shared
// database handle then runs as Postgres's `authenticated` role with this
// organization and user, and the row-level policies decide what it sees and
// writes. Outside `actAs` — the service role alone, the SDK's own background
// work — queries run as `backend`, as they always have.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Acting {
  organizationId: string;
  /** Null: the organization itself, no particular user. */
  userId: string | null;
}

const store = new AsyncLocalStorage<Acting>();

/** Run `work` (and everything it awaits) as this organization and user. */
export function actAs<T>(acting: Acting, work: () => T): T {
  return store.run(acting, work);
}

/** Who the current work is for; undefined = the service role's own. */
export function acting(): Acting | undefined {
  return store.getStore();
}
