// Salon configuration (config/salon.json) -> two resolved parts, both built in the API:
// - `policy`: the Workflow's input (recorded in history; the Workflow never reads configuration),
// - `hours`: time zone and weekly hours, used only by the API to resolve each opening's calendar
//   (src/salonCalendar.ts). Hours changes apply to openings created afterwards.
import { DateTime } from "luxon";
import { parseClock } from "./matching";
import type { SalonHours } from "./salonCalendar";
import { DEFAULT_SERVICE_MINUTES, type DayHours, type OfferPolicy, type WeeklyHours, type Weekday } from "./types";

export type SalonConfig = {
  timeZone: string;
  weeklyHours: Record<string, DayHours>;
  sameDayReplyMin: number;
  minLaterReplyMin: number;
};

/** Lena's confirmed same-day reply window. Anything else is a demo override. */
export const STANDARD_SAME_DAY_REPLY_MIN = 15;

const MINUTE = 60_000;

export function resolveSalon(
  config: SalonConfig,
  overrides: { sameDayReplyMin?: number } = {},
): { policy: OfferPolicy; hours: SalonHours } {
  if (!config.timeZone || !DateTime.now().setZone(config.timeZone).isValid) {
    throw new Error(`Unknown salon time zone: ${config.timeZone}`);
  }
  const weeklyHours = {} as WeeklyHours;
  for (let weekday = 0; weekday <= 6; weekday++) {
    const hours = config.weeklyHours?.[String(weekday)] ?? null;
    if (hours && !(parseClock(hours.opens) < parseClock(hours.closes))) {
      throw new Error(`Weekday ${weekday}: opening time must be before closing time.`);
    }
    weeklyHours[weekday as Weekday] = hours ? { opens: hours.opens, closes: hours.closes } : null;
  }
  if (Object.values(weeklyHours).every((h) => h === null)) throw new Error("The salon needs at least one open day.");

  const sameDayReplyMin = overrides.sameDayReplyMin ?? config.sameDayReplyMin;
  for (const [name, value] of [["sameDayReplyMin", sameDayReplyMin], ["minLaterReplyMin", config.minLaterReplyMin]] as const) {
    if (!(Number.isFinite(value) && value > 0)) throw new Error(`${name} must be a positive number of minutes.`);
  }
  return {
    policy: {
      timeZone: config.timeZone,
      sameDayReplyMs: sameDayReplyMin * MINUTE,
      minLaterReplyMs: config.minLaterReplyMin * MINUTE,
      serviceMinutes: DEFAULT_SERVICE_MINUTES,
    },
    hours: { timeZone: config.timeZone, weeklyHours },
  };
}

/** Fields where a running salon Workflow's policy differs from the one the API intends to use. */
export function policyDifferences(running: OfferPolicy, intended: OfferPolicy): string[] {
  const differences: string[] = [];
  const describe = (v: unknown) => JSON.stringify(v);
  for (const key of ["timeZone", "sameDayReplyMs", "minLaterReplyMs", "serviceMinutes"] as const) {
    if (describe(running?.[key]) !== describe(intended[key])) {
      differences.push(`${key}: running ${describe(running?.[key])}, configured ${describe(intended[key])}`);
    }
  }
  return differences;
}
