// The date a prompt states: today, in the builder's time zone (the
// `timezone` setting). Written once, when the session's prompt is built.
// A missing or unknown zone falls back to UTC.
export function todayFor(settings: Record<string, { value: unknown }>): string {
  const tz = typeof settings.timezone?.value === 'string' ? settings.timezone.value : 'UTC';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
