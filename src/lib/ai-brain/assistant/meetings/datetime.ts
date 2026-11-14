/** Time zone arithmetic with the platform Intl data only (no date library). All instants are UTC milliseconds. */

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0); return true; } catch { return false; }
}

/**
 * The zone a question's dates and times are read in: the asker's own browser zone when it is a valid IANA name (a user in Toronto means
 * Toronto time), else the organisation default (BROKO_TIMEZONE), else undefined (the parser then uses UTC and the reply says so). The
 * browser value only changes how a date is read, never what is authorized; anything that is not a real zone name is ignored.
 * A zone typed in the question still wins over both.
 */
export function timeZoneFor(clientZone: unknown, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (typeof clientZone === "string" && clientZone.length <= 64 && /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(clientZone) && isValidTimeZone(clientZone)) return clientZone;
  const org = env.BROKO_TIMEZONE?.trim();
  return org && isValidTimeZone(org) ? org : undefined;
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

/** The calendar date and clock time `ms` shows in `tz`. `weekday`: 0 = Sunday. */
export function localParts(ms: number, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: WEEK.indexOf(get("weekday")) };
}

/** Offset (ms) of `tz` from UTC at the instant `ms`. */
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000;
}

/** The UTC instant at which the wall clock in `tz` shows this date and time. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

/** A calendar date exists (rejects 30 February). */
export function validDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** The calendar date `days` before the date shown by `ms` in `tz` (the clock time is ignored). */
export function dateMinusDays(ms: number, tz: string, days: number): { year: number; month: number; day: number } {
  const p = localParts(ms, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Time zone abbreviations that are unambiguous enough to accept. "IST" is read as India Standard Time and the answer says so. */
export const TZ_ABBREVIATIONS: Record<string, { zone: string; label: string }> = {
  UTC: { zone: "UTC", label: "UTC" }, GMT: { zone: "UTC", label: "GMT" },
  IST: { zone: "Asia/Kolkata", label: "India Standard Time (IST)" },
  EST: { zone: "America/New_York", label: "US Eastern" }, EDT: { zone: "America/New_York", label: "US Eastern" },
  PST: { zone: "America/Los_Angeles", label: "US Pacific" }, PDT: { zone: "America/Los_Angeles", label: "US Pacific" },
  CST: { zone: "America/Chicago", label: "US Central" }, CDT: { zone: "America/Chicago", label: "US Central" },
  MST: { zone: "America/Denver", label: "US Mountain" }, MDT: { zone: "America/Denver", label: "US Mountain" },
  CET: { zone: "Europe/Paris", label: "Central European" },
};

const pad = (n: number) => String(n).padStart(2, "0");
export const formatDate = (p: { year: number; month: number; day: number }) => `${p.day} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][p.month - 1]} ${p.year}`;
export const formatTime = (p: { hour: number; minute: number }) => `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${pad(p.minute)} ${p.hour < 12 ? "AM" : "PM"}`;
