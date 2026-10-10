// The settings store's scope names — the one vocabulary every layer speaks:
// `global`, `organization:<id>`, `user:<id>`, `project:<id>`. The table
// itself is owned by the Settings object (storage/Settings.ts); nothing
// else touches it.
//
// THE chain, in order: a read walks it and the last row found wins. An
// organization's row is what its members share; a user's is their own; a
// project's is a fact about that repo and wins over both (VS Code's rule:
// user settings, then the workspace's). Adding a layer later is one more
// word here.
export const LAYERS = ['global', 'organization', 'user', 'project'] as const;
export type Layer = (typeof LAYERS)[number];
/** The layers below global — where a definition may allow an override. */
export type OverridableLayer = Exclude<Layer, 'global'>;

import { acting } from './acting.js';

export const GLOBAL = 'global';
/** The service role's own organization (migrations 059, 063): what it owns
 *  when it makes something without naming anyone. A real row, never null. */
export const SERVICE_ROLE_ORGANIZATION = 'service_role';
export const organizationScope = (id: string) => `organization:${id}`;
export const userScope = (id: string) => `user:${id}`;
export const projectScope = (id: string) => `project:${id}`;

/** What resolution is relative to: nothing (global only), or any of an
 *  organization, a user, a project. Build one from a project ROW
 *  (`scopeOf`), never by hand from an id — the row carries the project's
 *  organization, and a scope without it skips the organization's layer. */
export interface SettingScope { organizationId?: string; userId?: string; projectId?: string }

/** The scope for work in a project: its id, its organization's, and the
 *  user the work is for when there is one (lib/acting.ts) — so a user's own
 *  keys win over their organization's in everything they run. */
export const scopeOf = (project: { id: string; organizationId: string }): SettingScope => {
  const userId = acting()?.userId;
  return { projectId: project.id, organizationId: project.organizationId, ...(userId ? { userId } : {}) };
};

/** The scope for work in no particular project: the acting organization
 *  and user (lib/acting.ts); global only for the service role's own. */
export const actingScope = (): SettingScope => {
  const who = acting();
  return who ? { organizationId: who.organizationId, ...(who.userId ? { userId: who.userId } : {}) } : {};
};

/** The scope names a SettingScope reads, by layer, in chain order. */
export function scopeNames(scope: SettingScope): Partial<Record<Layer, string>> {
  return {
    global: GLOBAL,
    ...(scope.organizationId ? { organization: organizationScope(scope.organizationId) } : {}),
    ...(scope.userId ? { user: userScope(scope.userId) } : {}),
    ...(scope.projectId ? { project: projectScope(scope.projectId) } : {}),
  };
}

/** The layer a scope name belongs to. */
export const layerOf = (scopeName: string): Layer =>
  scopeName === GLOBAL ? 'global' : (scopeName.split(':', 1)[0] as Layer);
