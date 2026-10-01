// The settings store's scope names — the one vocabulary every layer speaks:
// `global`, `project:<id>`. The table itself is owned by the Settings
// object (settings.ts); nothing else touches it.
export const GLOBAL = 'global';
export const projectScope = (id: string) => `project:${id}`;
