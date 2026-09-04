// Rendering a setting's VALUE — 30d rather than 2592000000, yes rather than
// true. Presentation only.
//
// What a setting is called and what it does are NOT here. They live in
// server/settings.ts (`META[key].label`, `META[key].choiceLabels`, `DESCRIPTIONS`)
// and reach this client over the wire, in `meta` and `description` on every
// entry of GET /settings and GET /workspaces/:id `settings`. There was briefly a
// friendlier copy of all of it in this file; that made two places to write down
// what a setting means, so every new setting needed both and the two would
// drift. If a description reads badly here, fix it at the source.

/** The shape every settings screen gets back from the API. */
export interface WireMeta {
  type: 'string' | 'number' | 'boolean';
  label?: string;
  /** The heading the server files this under; rows sharing one sit together. */
  group?: string;
  choices?: string[];
  choiceLabels?: Record<string, string>;
  nullable?: boolean;
  unit?: string;
}

/** A setting's name for a person. Falls back to a readable form of the key,
 *  which is all an older server that does not send one leaves us. */
export const labelFor = (key: string, meta?: WireMeta) =>
  meta?.label ?? key.replace(/_/g, ' ');

const MS = [
  [86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm'], [1_000, 's'],
] as const;

/** A value as a person would say it. The stored value is untouched — this is
 *  the reading, not the writing. */
export function human(value: unknown, meta?: WireMeta): string {
  if (value === null || value === undefined || value === '') return 'not set';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' && meta?.choiceLabels?.[value]) return meta.choiceLabels[value];
  if (typeof value === 'number' && meta?.unit === 'ms') {
    for (const [size, suffix] of MS) {
      if (value >= size && value % size === 0) return `${value / size}${suffix}`;
      if (value >= size) return `${(value / size).toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
    return `${value}ms`;
  }
  if (typeof value === 'number' && meta?.unit === 'bytes') {
    if (value >= 1_048_576) return `${Math.round(value / 1_048_576)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} bytes`;
  }
  return String(value);
}

/** Fit a rendered value into the list's value column. */
export const fit = (s: string, width = 26) => s.length > width ? `${s.slice(0, width - 1)}…` : s;
