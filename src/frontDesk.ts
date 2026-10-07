// Front-desk (home) rule, kept out of the Express route so it can be tested.
// The front desk exists only when it shows something useful (the customer's request);
// otherwise staff go straight to Openings.
import type { Opening } from "./types";

type OpeningState = Pick<Opening, "status" | "recordedInSquare">;

/** An opening that is still being worked on: being matched, held for someone, or with no one who fits. */
export function isActiveOpening(opening: OpeningState): boolean {
  return opening.status === "matching" || opening.status === "held" || opening.status === "unfilled";
}

/**
 * A booked opening surfaced as a Square reminder until staff mark it recorded (markRecordedInSquare).
 * Juniper can't see Square, so this reflects what staff have marked, not Square itself.
 */
export function isSquareReminder(opening: OpeningState): boolean {
  return opening.status === "booked" && !opening.recordedInSquare;
}

export function shouldShowFrontDesk(snapshot: { openings: OpeningState[] }): boolean {
  return snapshot.openings.some((o) => isActiveOpening(o) || isSquareReminder(o));
}
