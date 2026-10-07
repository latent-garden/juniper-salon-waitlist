import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isEligible, orderedEligible, type MatchableOpening } from "../src/matching";
import { fromSalonLocal, resolveOpening, toSalonLocal } from "../src/salonCalendar";
import type { Client } from "../src/types";
import { testPolicy } from "./fixtures";

const policy = testPolicy(); // salon time = UTC in these tests

// Tuesday, October 6, 2026 at 2:00 pm, salon time. Matching sees only the salon-local facts
// the API resolved and recorded with the opening (no time-zone conversion in matching).
const opening: MatchableOpening = {
  start: "2026-10-06T14:00:00.000Z",
  service: "haircut",
  stylist: "Maria",
  durationMin: 45,
  local: { date: "2026-10-06", weekday: 2, minutes: 14 * 60 },
};

const tuesdayAfternoon = [{ weekday: 2 as const, start: "12:00", end: "18:00" }];

function client(overrides: Partial<Client> & Pick<Client, "seq">): Client {
  return {
    clientId: `client-${overrides.seq}`,
    name: `Client ${overrides.seq}`,
    mobile: "555-0100",
    service: "haircut",
    stylistPreference: { kind: "any" },
    availability: tuesdayAfternoon,
    joinedAt: "2026-09-01T10:00:00.000Z",
    status: "waiting",
    ...overrides,
  };
}

describe("eligibility (I3)", () => {
  test("a waiting client who wants a service that fits, is free, and takes any stylist is eligible", () => {
    assert.equal(isEligible(client({ seq: 1 }), opening, policy), true);
  });

  test("a client who requires a different stylist is not eligible", () => {
    const c = client({ seq: 1, stylistPreference: { kind: "requires", stylist: "Jo" } });
    assert.equal(isEligible(c, opening, policy), false);
  });

  test("a client who requires this opening's stylist is eligible", () => {
    const c = client({ seq: 1, stylistPreference: { kind: "requires", stylist: "Maria" } });
    assert.equal(isEligible(c, opening, policy), true);
  });

  test("a client who only prefers a different stylist is not offered it automatically", () => {
    const c = client({ seq: 1, stylistPreference: { kind: "prefers", stylist: "Jo" } });
    assert.equal(isEligible(c, opening, policy), false);
  });

  test("a client who prefers this opening's stylist is eligible", () => {
    const c = client({ seq: 1, stylistPreference: { kind: "prefers", stylist: "Maria" } });
    assert.equal(isEligible(c, opening, policy), true);
  });

  test("a service longer than the opening is not eligible (color 120 min in a 45 min gap)", () => {
    assert.equal(isEligible(client({ seq: 1, service: "color" }), opening, policy), false);
  });

  test("a client who isn't free at that time is not eligible", () => {
    const mornings = [{ weekday: 2 as const, start: "09:00", end: "12:00" }];
    assert.equal(isEligible(client({ seq: 1, availability: mornings }), opening, policy), false);
  });

  test("a client free that day but not long enough for the service is not eligible", () => {
    const short = [{ weekday: 2 as const, start: "13:00", end: "14:30" }];
    assert.equal(isEligible(client({ seq: 1, availability: short }), opening, policy), false);
  });

  test("a client free on a different weekday is not eligible", () => {
    const wednesday = [{ weekday: 3 as const, start: "09:00", end: "18:00" }];
    assert.equal(isEligible(client({ seq: 1, availability: wednesday }), opening, policy), false);
  });

  test("a client who is already booked is not eligible", () => {
    assert.equal(isEligible(client({ seq: 1, status: "booked" }), opening, policy), false);
  });
});

describe("ordering (I4)", () => {
  test("eligible clients are ordered by join date, not by entry order", () => {
    const later = client({ seq: 1, joinedAt: "2026-09-10T10:00:00.000Z" });
    const earlier = client({ seq: 2, joinedAt: "2026-09-03T10:00:00.000Z" });
    const ineligibleEarliest = client({
      seq: 3,
      joinedAt: "2026-08-01T10:00:00.000Z",
      stylistPreference: { kind: "requires", stylist: "Jo" },
    });
    const ordered = orderedEligible([later, earlier, ineligibleEarliest], opening, policy);
    assert.deepEqual(
      ordered.map((c) => c.clientId),
      ["client-2", "client-1"],
    );
  });

  test("clients who declined this opening are skipped; the rest keep join order (I19)", () => {
    const first = client({ seq: 1, joinedAt: "2026-09-01T10:00:00.000Z" });
    const second = client({ seq: 2, joinedAt: "2026-09-02T10:00:00.000Z" });
    const third = client({ seq: 3, joinedAt: "2026-09-03T10:00:00.000Z" });
    assert.deepEqual(
      orderedEligible([third, first, second], opening, policy, new Set([first.clientId])).map((c) => c.seq),
      [2, 3],
    );
  });

  test("clients who joined at the same moment keep their entry order", () => {
    const first = client({ seq: 2 });
    const second = client({ seq: 10 });
    assert.deepEqual(
      orderedEligible([second, first], opening, policy).map((c) => c.seq),
      [2, 10],
    );
  });
});

describe("service eligibility (R1/I3: the client must want the opening's service)", () => {
  const colorOpening: MatchableOpening = { ...opening, service: "color", durationMin: 120 };

  test("a haircut client is not eligible for a color opening, even though a haircut fits the length", () => {
    assert.equal(isEligible(client({ seq: 1 }), colorOpening, policy), false);
  });

  test("a color client is eligible for a color opening when every other rule fits", () => {
    const color = client({ seq: 1, service: "color", availability: [{ weekday: 2, start: "12:00", end: "18:00" }] });
    assert.equal(isEligible(color, colorOpening, policy), true);
    assert.equal(isEligible(color, opening, policy), false, "and not for a haircut opening");
  });

  test("blowout to blowout only", () => {
    const blowout = client({ seq: 1, service: "blowout" });
    assert.equal(isEligible(blowout, { ...opening, service: "blowout" }, policy), true);
    assert.equal(isEligible(blowout, opening, policy), false);
  });

  test("only when replaying a pre-rule history (no patch marker) is the old length-only check used", () => {
    assert.equal(isEligible(client({ seq: 1 }), colorOpening, policy, { serviceMustMatch: false }), true);
    const legacy = { ...opening, service: undefined }; // recorded before openings had a service
    assert.equal(isEligible(client({ seq: 1 }), legacy, policy), true);
  });
});

describe("staff inclusion of a 'Prefers' client: relaxes only the preferred-stylist mismatch", () => {
  const joOpening: MatchableOpening = { ...opening, stylist: "Jo" };
  const prefersMaria = (extra: Partial<Client> = {}) => client({ seq: 1, stylistPreference: { kind: "prefers", stylist: "Maria" }, ...extra });
  const including = (o: MatchableOpening, ...clientIds: string[]) => ({ ...o, inclusions: clientIds.map((clientId) => ({ clientId, at: "" })) });

  test("a 'Prefers Maria' client is normally excluded from a Jo opening", () => {
    assert.equal(isEligible(prefersMaria(), joOpening, policy), false);
  });

  test("including them makes them eligible for that Jo opening only", () => {
    assert.equal(isEligible(prefersMaria(), including(joOpening, "client-1"), policy), true);
    const anotherJoOpening = { ...joOpening, start: "2026-10-06T15:00:00.000Z", local: { ...joOpening.local, minutes: 15 * 60 } };
    assert.equal(isEligible(prefersMaria(), anotherJoOpening, policy), false, "not included there");
  });

  test("'Only with Maria' can never be included for Jo", () => {
    const onlyMaria = client({ seq: 1, stylistPreference: { kind: "requires", stylist: "Maria" } });
    assert.equal(isEligible(onlyMaria, including(joOpening, "client-1"), policy), false);
  });

  test("inclusion can't bypass service, length, availability or the earlier-than-appointment rule", () => {
    const included = including(joOpening, "client-1");
    assert.equal(isEligible(prefersMaria({ service: "color" }), included, policy), false, "service");
    assert.equal(isEligible(prefersMaria({ service: "color" }), { ...included, service: "color" }, policy), false, "color doesn't fit 45 minutes");
    assert.equal(isEligible(prefersMaria({ availability: [{ weekday: 2, start: "09:00", end: "12:00" }] }), included, policy), false, "availability");
    const earlierAppointment = { start: "2026-10-06T10:00:00.000Z", service: "haircut" as const, stylist: "Maria", durationMin: 45, local: opening.local, calendar: [] };
    assert.equal(isEligible(prefersMaria({ currentAppointment: earlierAppointment }), included, policy), false, "only earlier openings");
    assert.equal(isEligible(prefersMaria({ status: "booked" }), included, policy), false, "booked");
  });

  test("an included client keeps normal join-date order (no priority for being included)", () => {
    const zoe = client({ seq: 2, joinedAt: "2026-09-01T10:00:00.000Z", stylistPreference: { kind: "requires", stylist: "Jo" } });
    const ben = prefersMaria({ seq: 3, clientId: "client-3", joinedAt: "2026-09-08T10:00:00.000Z" });
    assert.deepEqual(orderedEligible([ben, zoe], including(joOpening, "client-3"), policy).map((c) => c.clientId), ["client-2", "client-3"]);
    const earlyBen = { ...ben, joinedAt: "2026-08-01T10:00:00.000Z" };
    assert.deepEqual(orderedEligible([zoe, earlyBen], including(joOpening, "client-3"), policy).map((c) => c.clientId), ["client-3", "client-2"]);
  });
});

describe("existing appointments: only earlier openings (I20, Lena)", () => {
  // The opening is Tuesday 2:00 pm (UTC instants; no time zone involved in this rule).
  const withAppointment = (start: string, extra: Partial<Client> = {}) =>
    client({ seq: 1, currentAppointment: { start, service: "color", stylist: "Maria", durationMin: 120, local: opening.local, calendar: [] }, ...extra });

  test("an opening earlier than the client's current appointment is offered", () => {
    assert.equal(isEligible(withAppointment("2026-10-08T15:00:00.000Z"), opening, policy), true);
  });

  test("an opening later than the current appointment is not offered", () => {
    assert.equal(isEligible(withAppointment("2026-10-06T10:00:00.000Z"), opening, policy), false);
  });

  test("an opening at exactly the current appointment time is not offered", () => {
    assert.equal(isEligible(withAppointment(opening.start), opening, policy), false);
  });

  test("every other rule still applies, including 'Prefers' (only that stylist automatically)", () => {
    const later = "2026-10-08T15:00:00.000Z";
    assert.equal(isEligible(withAppointment(later, { stylistPreference: { kind: "prefers", stylist: "Jo" } }), opening, policy), false);
    assert.equal(isEligible(withAppointment(later, { service: "color" }), opening, policy), false, "color doesn't fit 45 minutes");
    assert.equal(isEligible(withAppointment(later, { status: "booked" }), opening, policy), false);
  });
});

describe("eligibility after moving time-zone resolution to the API", () => {
  const LA = "America/Los_Angeles";
  const allWeekHours = { timeZone: LA, weeklyHours: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null } };
  const resolved = (date: string, time: string) =>
    resolveOpening({ start: fromSalonLocal(date, time, LA), service: "haircut", stylist: "Maria", durationMin: 45 }, allWeekHours, Date.parse(`${date}T00:00:00Z`));

  test("the API resolves the same salon-local facts matching used to compute itself", () => {
    assert.deepEqual(resolved("2026-10-06", "14:00").local, opening.local);
  });

  test("eligibility is unchanged on both sides of the daylight-saving change", () => {
    const tuesday = client({ seq: 1 }); // Tuesday 12:00 to 18:00, salon time
    for (const date of ["2026-10-27", "2026-11-03"]) { // PDT, then PST
      assert.equal(isEligible(tuesday, resolved(date, "14:00"), policy), true, `${date} 2:00 pm fits`);
      assert.equal(isEligible(tuesday, resolved(date, "17:30"), policy), false, `${date} 5:30 pm ends after 6:00 pm`);
      assert.equal(isEligible(tuesday, resolved(date, "11:30"), policy), false, `${date} 11:30 am starts before noon`);
    }
  });

  test("'Prefers' behavior is unchanged: only that stylist is matched automatically", () => {
    const prefersJo = client({ seq: 1, stylistPreference: { kind: "prefers", stylist: "Jo" } });
    assert.equal(isEligible(prefersJo, resolved("2026-11-03", "14:00"), policy), false);
    assert.equal(isEligible(prefersJo, { ...resolved("2026-11-03", "14:00"), stylist: "Jo" }, policy), true);
  });
});

describe("salon time (API side)", () => {
  test("converts between salon-local time and ISO using the salon's named time zone", () => {
    const iso = fromSalonLocal("2026-10-06", "14:00", "America/Los_Angeles"); // PDT, UTC-7
    assert.equal(iso, "2026-10-06T21:00:00.000Z");
    assert.deepEqual(toSalonLocal(iso, "America/Los_Angeles"), { weekday: 2, minutes: 14 * 60, date: "2026-10-06" });
  });

  test("follows daylight saving: the same clock time is a different UTC instant after the change", () => {
    // US daylight saving ends 2026-11-01; 2:00 pm on Tuesday, November 3 is PST, UTC-8.
    const iso = fromSalonLocal("2026-11-03", "14:00", "America/Los_Angeles");
    assert.equal(iso, "2026-11-03T22:00:00.000Z");
    assert.deepEqual(toSalonLocal(iso, "America/Los_Angeles"), { weekday: 2, minutes: 14 * 60, date: "2026-11-03" });
  });
});
