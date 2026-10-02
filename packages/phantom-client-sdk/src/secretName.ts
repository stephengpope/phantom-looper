// A secret's name: the env-var shape — UPPER_SNAKE, starting with a letter.
// People type it however they like (`my_api_key`, `My-Api-Key`, `MY API KEY`);
// this is the ONE place that turns typed text into the stored name, so the
// cli editor and the /secrets routes cannot drift. Returns undefined when
// nothing valid is left.
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export const SECRET_NAME_RULE = 'letters, digits, underscores — starting with a letter (saved as UPPER_CASE)';

export function secretName(raw: string): string | undefined {
  const name = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return NAME.test(name) ? name : undefined;
}
