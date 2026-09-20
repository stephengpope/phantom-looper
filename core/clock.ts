// The builder's clock: every place that turns a moment into a human date or
// time — "today", "9am", "Current date: …" — goes through one of these, so
// they all agree on the zone. Timestamps (when a row was saved) are not
// dates and do not come here; they stay plain `new Date()`.
//
// The server runs in a container whose OS clock is UTC, so anything that
// reads the OS zone (`setHours(0)`, `toLocaleDateString()` with no zone) is
// wrong for a builder anywhere else. The zone is the `timezone` setting —
// global with a workspace override — and Settings.clock() builds the Clock.
//
// Built on Intl alone (the same zone table croner reads); no date library.

/** Every IANA zone this Node knows — the one list the setting is checked
 *  against and the cli offers. */
export const TIMEZONES: readonly string[] = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];

/** Wall-clock fields of `at` as read in `timeZone`. */
function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour'), minute: n('minute'), second: n('second') };
}

/** The zone's offset from UTC at `at`, in ms (positive east of Greenwich). */
function offsetMs(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export class Clock {
  constructor(readonly timezone: string) {}

  now(): Date { return new Date(); }

  /** Midnight at the start of `at`'s day in the zone — the instant the
   *  builder's "today" began. Two passes so a DST change between UTC
   *  midnight and local midnight lands on the right side (the same
   *  approach as date-fns-tz's fromZonedTime). */
  startOfDay(at: Date = this.now()): Date {
    const w = wallClock(at, this.timezone);
    const local = Date.UTC(w.year, w.month - 1, w.day);
    const guess = local - offsetMs(new Date(local), this.timezone);
    return new Date(local - offsetMs(new Date(guess), this.timezone));
  }

  /** `at` as a date the builder reads, in the zone — "September 19, 2026"
   *  by default, or any Intl date options. */
  date(at: Date = this.now(), options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: '2-digit' }): string {
    return at.toLocaleDateString('en-US', { ...options, timeZone: this.timezone });
  }
}
