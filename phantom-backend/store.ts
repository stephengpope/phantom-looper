// The settings store's scope names — the one vocabulary every layer speaks:
// `global`, `workspace:<id>`, `session:<id>`. The table itself is owned by
// the Settings object (settings.ts); nothing else touches it.
export const GLOBAL = 'global';
export const workspaceScope = (id: string) => `workspace:${id}`;
export const sessionScope = (id: string) => `session:${id}`;
