// Pure matching rules. No Temporal imports: this module is shared by the
// Workflow, the API and the unit tests.
import type { Client, OfferPolicy, Opening, OpeningLocal, WeeklyWindow } from "./types";

export function parseClock(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function windowCovers(window: WeeklyWindow, local: OpeningLocal, lengthMin: number): boolean {
  return (
    window.weekday === local.weekday &&
    parseClock(window.start) <= local.minutes &&
    local.minutes + lengthMin <= parseClock(window.end)
  );
}

/**
 * Lena's confirmed eligibility rules (I3):
 * - the client wants the opening's service,
 * - the service fits the opening's length,
 * - their availability covers the appointment,
 * - stylist: "any" always fits; "requires" and "prefers" only match that
 *   stylist automatically ("prefers" + another stylist is a staff decision).
 * Only waiting clients are considered.
 *
 * "One pending offer per client" (I17, a prototype assumption) is enforced by the allocation pass
 * (src/allocation.ts), not here: a busy client is temporarily unavailable, not ineligible.
 */
export type MatchableOpening = Pick<Opening, "start" | "stylist" | "durationMin" | "local"> &
  Partial<Pick<Opening, "service" | "inclusions">>;

export type MatchOptions = {
  /**
   * R1/I3(a): the client must want the opening's service. Always true for new executions; false only
   * when replaying a history recorded before this rule was enforced (the Workflow's
   * patched("service-eligibility") marker), so old histories replay as they ran.
   */
  serviceMustMatch: boolean;
};

export function isEligible(
  client: Client,
  opening: MatchableOpening,
  policy: OfferPolicy,
  options: MatchOptions = { serviceMustMatch: true },
): boolean {
  if (client.status !== "waiting") return false;

  // Haircut to haircut, color to color, blowout to blowout: a longer opening isn't interchangeable.
  // (Openings recorded before services existed have none and keep the length-only check.)
  if (options.serviceMustMatch && opening.service && opening.service !== client.service) return false;

  // I20 (Lena): with a current appointment, only a strictly earlier opening helps.
  // A UTC instant comparison of recorded values: no time-zone work.
  if (client.currentAppointment && !(Date.parse(opening.start) < Date.parse(client.currentAppointment.start))) return false;

  const lengthMin = policy.serviceMinutes[client.service];
  if (lengthMin > opening.durationMin) return false;

  const pref = client.stylistPreference;
  if (pref.kind === "requires" && pref.stylist !== opening.stylist) return false; // never includable
  // "Prefers" another stylist: automatically excluded, unless staff included this client for this
  // opening. Inclusion relaxes this one check only.
  const included = opening.inclusions?.some((i) => i.clientId === client.clientId) ?? false;
  if (pref.kind === "prefers" && pref.stylist !== opening.stylist && !included) return false;

  // Salon-local weekday and time were resolved by the API and recorded with the opening:
  // no time-zone conversion happens here (this module runs inside the Workflow).
  return client.availability.some((window) => windowCovers(window, opening.local, lengthMin));
}

/**
 * Eligible clients, first come first served (I4): join date, then entry order.
 * `skip` holds clients who already declined this opening (I19): never re-offered it.
 */
export function orderedEligible(
  clients: Iterable<Client>,
  opening: MatchableOpening,
  policy: OfferPolicy,
  skip: ReadonlySet<string> = new Set(),
  options: MatchOptions = { serviceMustMatch: true },
): Client[] {
  return [...clients]
    .filter((client) => !skip.has(client.clientId) && isEligible(client, opening, policy, options))
    .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.seq - b.seq);
}
