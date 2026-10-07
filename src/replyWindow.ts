// Reply-window rules (I15, confirmed by Lena 2026-10-06). Pure and deterministic: no Temporal
// imports, no clock reads, and NO time-zone interpretation. It compares the offer's send time with
// the opening's recorded salon calendar (UTC instants resolved by the API, src/salonCalendar.ts),
// so replay always computes the same expiresAt.
//
// Confirmed [S]:
// - Same-day opening: the offer expires 15 minutes after it's sent.
// - Later-day opening: it expires at the salon's closing time on the day it's sent.
// - Sent too close to or after closing: it runs until the salon's opening time the next morning.
// - Never past the appointment start: expiresAt = min(deadline, start).
// Prototype assumptions [A], not confirmed by Lena:
// - A1: "too close to closing" = fewer than minLaterReplyMs (15 minutes) remain before closing.
// - A2: "next morning" = the next day the salon opens, when the following day is closed.
// - A4: if the appointment start has already passed, no offer is issued (null).
import type { OfferPolicy, Opening } from "./types";

export type ReplyPolicy = Pick<OfferPolicy, "sameDayReplyMs" | "minLaterReplyMs">;
export type DeadlineOpening = Pick<Opening, "start" | "local" | "calendar">;

/**
 * When an offer sent at `sentAt` (the Workflow's send time for that offer) expires; null if it
 * can't be offered (A4).
 */
export function offerExpiresAt(sentAt: string, opening: DeadlineOpening, policy: ReplyPolicy): string | null {
  const sent = Date.parse(sentAt);
  const start = Date.parse(opening.start);
  if (start <= sent) return null;

  const days = opening.calendar;
  const index = days.findIndex((d) => d.startsAt <= sent && sent < d.endsAt);
  const day = days[index];

  let deadline: number;
  if (!day || day.date === opening.local.date) {
    // Same-day rule. (`!day` can't happen for a validated calendar, which runs from before creation
    // through the opening's date; the conservative fallback keeps the Workflow deterministic anyway.)
    deadline = sent + policy.sameDayReplyMs;
  } else if (day.closesAt !== null && day.closesAt - sent >= policy.minLaterReplyMs) {
    deadline = day.closesAt;
  } else {
    // The next salon day that opens (A2). None before the opening's date means the start caps it.
    const nextOpen = days.slice(index + 1).find((d) => d.opensAt !== null);
    deadline = nextOpen?.opensAt ?? start;
  }
  return new Date(Math.min(deadline, start)).toISOString();
}

/** A reply at or after the deadline is late. The deadline decides, not whether a timer has fired. */
export function isLate(nowMs: number, expiresAt: string): boolean {
  return nowMs >= Date.parse(expiresAt);
}

/** Checks a recorded calendar before the Workflow accepts it (createOpening validator). */
export function calendarProblem(opening: DeadlineOpening): string | null {
  const days = opening.calendar;
  if (!Array.isArray(days) || days.length === 0) return "The opening needs its salon calendar.";
  for (const [i, d] of days.entries()) {
    if (!(d.startsAt < d.endsAt)) return "Salon calendar days must have positive length.";
    if (i > 0 && days[i - 1].endsAt !== d.startsAt) return "Salon calendar days must be contiguous.";
    if ((d.opensAt === null) !== (d.closesAt === null)) return "A salon day needs both opening and closing times.";
    if (d.opensAt !== null && !(d.opensAt < d.closesAt!)) return "A salon day must open before it closes.";
  }
  const last = days[days.length - 1];
  const start = Date.parse(opening.start);
  if (last.date !== opening.local.date || !(last.startsAt <= start && start < last.endsAt)) {
    return "The salon calendar must end on the opening's day.";
  }
  return null;
}
