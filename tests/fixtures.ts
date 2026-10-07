// Shared test policy and salon hours.
import { resolveOpening, type SalonHours } from "../src/salonCalendar";
import { DEFAULT_SERVICE_MINUTES, type NewOpeningInput, type OfferPolicy, type ServiceId, type WeeklyHours } from "../src/types";

const ALL_DAY = { opens: "00:00", closes: "23:59" };
export const OPEN_EVERY_DAY: WeeklyHours = { 0: ALL_DAY, 1: ALL_DAY, 2: ALL_DAY, 3: ALL_DAY, 4: ALL_DAY, 5: ALL_DAY, 6: ALL_DAY };

export function testPolicy(overrides: Partial<OfferPolicy> = {}): OfferPolicy {
  return {
    timeZone: "UTC",
    sameDayReplyMs: 15 * 60_000,
    minLaterReplyMs: 15 * 60_000,
    serviceMinutes: DEFAULT_SERVICE_MINUTES,
    ...overrides,
  };
}

/** Open every day, so tests that aren't about hours aren't affected by them. */
export const testHours = (timeZone = "UTC"): SalonHours => ({ timeZone, weeklyHours: OPEN_EVERY_DAY });

/** createOpening input as the API builds it: salon-local facts and calendar resolved outside the Workflow. */
export function openingInput(
  opening: { start: string; stylist: string; durationMin: number; service?: ServiceId },
  hours: SalonHours = testHours(),
): NewOpeningInput {
  return resolveOpening({ service: "haircut", ...opening }, hours, Date.now()); // haircut unless the test says otherwise
}
