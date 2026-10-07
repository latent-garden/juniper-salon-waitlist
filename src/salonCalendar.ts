// Salon calendar resolution: the ONLY place time-zone rules are interpreted (Luxon, backed by
// Intl's IANA data). Runs in the API, never inside the Workflow. Its results enter the Workflow
// as createOpening Update input, so they are recorded in history and replay can't recompute them.
import { DateTime } from "luxon";
import type { Appointment, NewOpeningInput, OpeningLocal, SalonDay, ServiceId, WeeklyHours, Weekday } from "./types";

export type SalonHours = { timeZone: string; weeklyHours: WeeklyHours };

const weekdayOf = (local: DateTime) => (local.weekday % 7) as Weekday; // Luxon: Monday = 1 … Sunday = 7

/** An ISO instant in salon-local terms. */
export function toSalonLocal(iso: string, timeZone: string): OpeningLocal {
  const local = DateTime.fromISO(iso, { zone: timeZone });
  if (!local.isValid) throw new Error(`Invalid instant or time zone: ${iso} ${timeZone}`);
  return { date: local.toISODate()!, weekday: weekdayOf(local), minutes: local.hour * 60 + local.minute };
}

/** A salon-local date ("2026-10-06") and time ("14:00") as an ISO instant. */
export function fromSalonLocal(date: string, time: string, timeZone: string): string {
  const local = DateTime.fromISO(`${date}T${time}`, { zone: timeZone });
  if (!local.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`Invalid date or time: ${date} ${time}`);
  }
  return new Date(local.toMillis()).toISOString();
}

function atClock(day: DateTime, clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 }).toMillis();
}

/** Contiguous salon days, as UTC instants, from the day containing `fromMs` through `throughDate` (inclusive). */
export function salonDays(fromMs: number, throughDate: string, hours: SalonHours): SalonDay[] {
  const days: SalonDay[] = [];
  let day = DateTime.fromMillis(fromMs, { zone: hours.timeZone }).startOf("day");
  const last = DateTime.fromISO(throughDate, { zone: hours.timeZone }).startOf("day");
  while (day <= last) {
    const next = day.plus({ days: 1 });
    const open = hours.weeklyHours[weekdayOf(day)];
    days.push({
      date: day.toISODate()!,
      startsAt: day.toMillis(),
      endsAt: next.toMillis(),
      opensAt: open ? atClock(day, open.opens) : null,
      closesAt: open ? atClock(day, open.closes) : null,
    });
    day = next;
  }
  return days;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The createOpening input for an opening: its salon-local facts plus the salon calendar from the
 * day before `nowMs` (margin for clock skew between the API and the Workflow) through the opening's
 * date. Offers are always sent before the start, so later days are never needed.
 */
export function resolveOpening(
  opening: { start: string; service: ServiceId; stylist: string; durationMin: number },
  hours: SalonHours,
  nowMs: number,
): NewOpeningInput {
  const local = toSalonLocal(opening.start, hours.timeZone);
  const from = Math.min(nowMs, Date.parse(opening.start)) - DAY_MS;
  return { ...opening, local, calendar: salonDays(from, local.date, hours) };
}

/**
 * A client's existing appointment, resolved like an opening: its salon-local facts and the salon
 * calendar from the day before `nowMs` through its date. If accepting an earlier opening frees it,
 * the freed opening is built from exactly these recorded values (A3, A5).
 */
export function resolveAppointment(
  appointment: { start: string; service: ServiceId; stylist: string; durationMin: number },
  hours: SalonHours,
  nowMs: number,
): Appointment {
  const { local, calendar } = resolveOpening(appointment, hours, nowMs);
  return { ...appointment, local, calendar };
}
