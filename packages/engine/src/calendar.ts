// Calendar days and wall-clock times in a time zone, with Node's built-in Intl only: its time-zone
// and locale data are fixed by the Node version the run manifest records, so no date library is
// needed and the same inputs always give the same dates. Days are counted with Date.UTC as plain
// calendar arithmetic, so 31 January plus one day is 1 February whatever the time zone.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import type { DateAnchor, DateFormat, Locale, RelativeDay, TimeZone } from '@revisum/contracts';

// A day on the calendar. month is 1 to 12.
export type CalendarDay = { readonly year: number; readonly month: number; readonly day: number };
type WallTime = CalendarDay & { readonly hour: number; readonly minute: number; readonly second: number };

const MILLISECONDS_PER_SECOND = 1000;
const NOON = 12;

// Formatters are costly to build and pure to use, so each is built once per time zone.
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timezone: TimeZone): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    wallClockFormatters.set(timezone, formatter);
  }
  return formatter;
}

// What a clock on the wall in `timezone` shows at `instant`.
function wallTimeAt(instant: number, timezone: TimeZone): WallTime {
  const parts = wallClockFormatter(timezone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') };
}

// How far the zone's wall clock is ahead of UTC at `instant`, in milliseconds.
function zoneOffset(instant: number, timezone: TimeZone): number {
  const wall = wallTimeAt(instant, timezone);
  const wholeSeconds = Math.floor(instant / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND;
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - wholeSeconds;
}

// The instant a wall clock in `timezone` shows this day and time. The offset is read twice, the
// second time at the first guess, so a daylight-saving change between the guess and the answer
// is accounted for.
export function instantOf(day: CalendarDay, hour: number, minute: number, timezone: TimeZone): number {
  const asIfUtc = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const firstGuess = asIfUtc - zoneOffset(asIfUtc, timezone);
  return asIfUtc - zoneOffset(firstGuess, timezone);
}

export function calendarDayAt(instant: number, timezone: TimeZone): CalendarDay {
  const { year, month, day } = wallTimeAt(instant, timezone);
  return { year, month, day };
}

// The calendar day `days` after `day` (before, when negative).
export function addDays(day: CalendarDay, days: number): CalendarDay {
  const moved = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

const DAYS_PER_WEEK = 7;
const MONDAY = 1;

// The anchor day of a relative day, on the calendar of `timezone` at `clockStart`.
function anchorDay(anchor: DateAnchor, clockStart: number, timezone: TimeZone): CalendarDay {
  const today = calendarDayAt(clockStart, timezone);
  switch (anchor) {
    case 'today': return today;
    case 'startOfWeek': {
      // Weeks start on Monday: getUTCDay counts from Sunday as 0.
      const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
      return addDays(today, -((weekday - MONDAY + DAYS_PER_WEEK) % DAYS_PER_WEEK));
    }
    case 'startOfMonth': return { ...today, day: 1 };
    case 'startOfNextMonth': return addDays({ year: today.year, month: today.month + 1, day: 1 }, 0);
  }
}

// The calendar day a relative day names, counted from the run's clock start in `timezone`.
export function relativeCalendarDay(relative: RelativeDay, clockStart: number, timezone: TimeZone): CalendarDay {
  return addDays(anchorDay(relative.from, clockStart, timezone), relative.addDays);
}

const twoDigits = (value: number): string => String(value).padStart(2, '0');

// Noon UTC on `day`: formatted in UTC it is that day in every locale, far from any midnight.
const noonOf = (day: CalendarDay): Date => new Date(Date.UTC(day.year, day.month - 1, day.day, NOON));

const LOCALE_FORMATS: { readonly [Format in 'monthAndYear' | 'longDate' | 'weekday']: Intl.DateTimeFormatOptions } = {
  monthAndYear: { month: 'long', year: 'numeric' },
  longDate: { day: 'numeric', month: 'long', year: 'numeric' },
  weekday: { weekday: 'long' },
};

// A calendar day written in `format`. Timestamps name midnight at the start of the day in
// `timezone`; the locale formats use the target's locale through Intl.
export function formatCalendarDay(day: CalendarDay, format: DateFormat, locale: Locale, timezone: TimeZone): string {
  switch (format) {
    case 'yearMonthDay': return `${String(day.year).padStart(4, '0')}-${twoDigits(day.month)}-${twoDigits(day.day)}`;
    case 'dayOfMonth': return String(day.day);
    case 'timestamp': return new Date(instantOf(day, 0, 0, timezone)).toISOString();
    case 'epochMilliseconds': return String(instantOf(day, 0, 0, timezone));
    case 'monthAndYear': case 'longDate': case 'weekday':
      return new Intl.DateTimeFormat(locale, { ...LOCALE_FORMATS[format], timeZone: 'UTC' }).format(noonOf(day));
  }
}
