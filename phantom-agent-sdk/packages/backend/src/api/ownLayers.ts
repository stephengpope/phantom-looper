// A user's settings and secrets are always relative to their own
// organization and themself: they read that chain, and may name only their
// own organization and user (a project they name is loaded as them, so the
// policies decide it). The service role names any. Which layer a write lands
// on is still the deepest named; one naming none is the global layer, which
// the policies refuse a user.
import type { Caller } from '../identity/Identity.js';
import type { SettingScope } from '../lib/scopes.js';

export function ownLayers(caller: Caller | null, query: { organization?: string; user?: string }): SettingScope | 'denied' {
  if (caller?.type !== 'user') return {};
  if (query.organization && query.organization !== caller.organization.id) return 'denied';
  if (query.user && query.user !== caller.user.id) return 'denied';
  return { organizationId: caller.organization.id, userId: caller.user.id };
}
