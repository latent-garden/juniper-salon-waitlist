import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { calendarProblem, isLate, offerExpiresAt } from "../src/replyWindow";
import { fromSalonLocal, resolveAppointment, resolveOpening } from "../src/salonCalendar";
import { policyDifferences, resolveSalon, STANDARD_SAME_DAY_REPLY_MIN, type SalonConfig } from "../src/salonConfig";
import type { SalonDay } from "../src/types";

// The prototype configuration itself: America/Los_Angeles; Tue–Fri 9:00 am–7:00 pm (Thu until 8:00 pm),
// Sat 9:00 am–5:00 pm, Sun and Mon closed (sample hours, A3).
const config = JSON.parse(readFileSync("config/salon.json", "utf8")) as SalonConfig;
const { policy, hours } = resolveSalon(config);
const la = (date: string, time: string) => fromSalonLocal(date, time, hours.timeZone);
/** As in production: the API resolves the opening's calendar when it's created (here, at `sent`). */
const expires = (sent: string, start: string) =>
  offerExpiresAt(sent, resolveOpening({ start, service: "haircut", stylist: "Maria", durationMin: 45 }, hours, Date.parse(sent)), policy);

// Week of Tuesday, October 6, 2026 (PDT).
const TUE = "2026-10-06", WED = "2026-10-07", THU = "2026-10-08", FRI = "2026-10-09", SAT = "2026-10-10";

describe("reply window: confirmed rules (I15)", () => {
  test("same-day opening: expires 15 minutes after the offer is sent", () => {
    assert.equal(expires(la(TUE, "14:00"), la(TUE, "17:30")), la(TUE, "14:15"));
  });

  test("same-day opening: never past the appointment start", () => {
    assert.equal(expires(la(TUE, "17:20"), la(TUE, "17:30")), la(TUE, "17:30"));
  });

  test("later-day opening: expires at closing time on the day the offer is sent", () => {
    assert.equal(expires(la(TUE, "14:00"), la(THU, "10:00")), la(TUE, "19:00"));
  });

  test("closing time varies by day and comes from configuration", () => {
    assert.equal(expires(la(THU, "14:00"), la(SAT, "10:00")), la(THU, "20:00"));
    assert.equal(expires(la(SAT, "10:00"), la("2026-10-13", "10:00")), la(SAT, "17:00"));
  });

  test("sent after closing: runs until opening time the next morning", () => {
    assert.equal(expires(la(TUE, "21:30"), la(THU, "10:00")), la(WED, "09:00"));
  });

  test("the next-morning deadline is capped at the appointment start", () => {
    assert.equal(expires(la(TUE, "21:30"), la(WED, "08:30")), la(WED, "08:30"));
  });
});

describe("reply window: prototype assumptions (A1, A2, A4)", () => {
  test("A1: fewer than 15 minutes before closing counts as too close; runs to the next morning", () => {
    assert.equal(expires(la(TUE, "18:50"), la(THU, "10:00")), la(WED, "09:00"));
  });

  test("A1: exactly 15 minutes before closing still expires at closing", () => {
    assert.equal(expires(la(TUE, "18:45"), la(THU, "10:00")), la(TUE, "19:00"));
  });

  test("before opening time on an open day, the offer runs until that day's closing", () => {
    assert.equal(expires(la(WED, "07:30"), la(FRI, "10:00")), la(WED, "19:00"));
  });

  test("A2: when the next day is closed, 'next morning' is the next day the salon opens", () => {
    // Saturday 4:50 pm (closes 5:00 pm); Sunday and Monday are closed.
    assert.equal(expires(la(SAT, "16:50"), la("2026-10-14", "10:00")), la("2026-10-13", "09:00"));
  });

  test("A2: sent on a closed day, the offer runs until the next opening", () => {
    assert.equal(expires(la("2026-10-11", "12:00"), la("2026-10-14", "10:00")), la("2026-10-13", "09:00"));
  });

  test("A4: no offer once the appointment start has passed", () => {
    assert.equal(expires(la(TUE, "14:00"), la(TUE, "13:00")), null);
    assert.equal(expires(la(TUE, "14:00"), la(TUE, "14:00")), null);
  });
});

describe("reply window: time zone and lateness", () => {
  test("deadlines across the daylight-saving change match the approved behavior", () => {
    // Saturday, October 31 after closing (PDT); next opening Tuesday, November 3, 9:00 am PST (UTC-8).
    assert.equal(expires(la("2026-10-31", "18:00"), la("2026-11-04", "10:00")), "2026-11-03T17:00:00.000Z");
    // Same-day and closing-time rules on the first PST weekday.
    assert.equal(expires(la("2026-11-03", "14:00"), la("2026-11-03", "17:30")), "2026-11-03T22:15:00.000Z");
    assert.equal(expires(la("2026-11-03", "14:00"), la("2026-11-05", "10:00")), "2026-11-04T03:00:00.000Z");
  });

  test("a reply exactly at expiresAt is late; one millisecond before is not", () => {
    const expiresAt = "2026-10-06T21:15:00.000Z";
    assert.equal(isLate(Date.parse(expiresAt), expiresAt), true);
    assert.equal(isLate(Date.parse(expiresAt) - 1, expiresAt), false);
  });
});

describe("salon calendar: resolved by the API, recorded with the opening", () => {
  test("an opening created across the daylight-saving change carries the correct local facts and instants", () => {
    // Created Saturday, October 31 (PDT) for Tuesday, November 3 at 10:00 am (PST).
    const input = resolveOpening({ start: la("2026-11-03", "10:00"), service: "haircut", stylist: "Maria", durationMin: 45 }, hours, Date.parse(la("2026-10-31", "12:00")));
    assert.deepEqual(input.local, { date: "2026-11-03", weekday: 2, minutes: 600 });
    assert.equal(input.start, "2026-11-03T18:00:00.000Z");

    const day = (date: string) => input.calendar.find((d) => d.date === date)!;
    assert.deepEqual(input.calendar.map((d) => d.date), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
    assert.equal(day("2026-11-01").endsAt - day("2026-11-01").startsAt, 25 * 3_600_000, "the change day has 25 hours");
    assert.equal(new Date(day("2026-10-31").closesAt!).toISOString(), "2026-11-01T00:00:00.000Z"); // 5:00 pm PDT
    assert.equal(new Date(day("2026-11-03").opensAt!).toISOString(), "2026-11-03T17:00:00.000Z"); // 9:00 am PST
    assert.equal(day("2026-11-01").opensAt, null, "Sunday is closed");
    assert.equal(calendarProblem(input), null);
  });

  test("a client's existing appointment is resolved the same way, with its service, for the slot it would free", () => {
    const appointment = resolveAppointment(
      { start: la("2026-11-05", "15:00"), service: "color", stylist: "Maria", durationMin: 120 },
      hours,
      Date.parse(la("2026-10-31", "12:00")),
    );
    assert.deepEqual(appointment.local, { date: "2026-11-05", weekday: 4, minutes: 900 });
    assert.equal(appointment.service, "color");
    assert.equal(appointment.durationMin, 120);
    assert.equal(appointment.calendar[0].date, "2026-10-30");
    assert.equal(appointment.calendar.at(-1)!.date, "2026-11-05");
    assert.equal(calendarProblem(appointment), null, "valid as a freed opening's calendar");
  });

  test("deadlines use only the recorded calendar: a hand-made calendar is followed exactly", () => {
    // Synthetic instants that match no real time zone. Each successive send time picks its own day.
    const H = 3_600_000, t0 = Date.parse("2030-01-01T00:00:00.000Z");
    const days: SalonDay[] = [
      { date: "day-a", startsAt: t0, endsAt: t0 + 20 * H, opensAt: t0 + 2 * H, closesAt: t0 + 10 * H },
      { date: "day-b", startsAt: t0 + 20 * H, endsAt: t0 + 30 * H, opensAt: null, closesAt: null },
      { date: "day-c", startsAt: t0 + 30 * H, endsAt: t0 + 50 * H, opensAt: t0 + 33 * H, closesAt: t0 + 40 * H },
    ];
    const opening = { start: new Date(t0 + 45 * H).toISOString(), local: { date: "day-c", weekday: 3 as const, minutes: 900 }, calendar: days };
    const at = (h: number) => new Date(t0 + h * H).toISOString();
    assert.equal(offerExpiresAt(at(5), opening, policy), at(10), "first send: that day's recorded closing");
    assert.equal(offerExpiresAt(at(10), opening, policy), at(33), "next send, after closing: next recorded opening");
    assert.equal(offerExpiresAt(at(34), opening, policy), at(34.25), "send on the opening's own day: same-day window");
  });

  test("the Workflow rejects calendars that don't cover the opening's day or aren't contiguous", () => {
    const input = resolveOpening({ start: la(THU, "10:00"), service: "haircut", stylist: "Maria", durationMin: 45 }, hours, Date.parse(la(TUE, "12:00")));
    assert.equal(calendarProblem(input), null);
    assert.match(calendarProblem({ ...input, calendar: input.calendar.slice(0, -1) })!, /opening's day/);
    assert.match(calendarProblem({ ...input, calendar: [input.calendar[0], input.calendar[2]] })!, /contiguous/);
    assert.match(calendarProblem({ ...input, calendar: [] })!, /calendar/);
  });
});

describe("salon configuration", () => {
  test("the standard (submitted) reply window is 15 minutes", () => {
    assert.equal(STANDARD_SAME_DAY_REPLY_MIN, 15);
    assert.equal(config.sameDayReplyMin, 15, "config/salon.json");
    assert.equal(policy.sameDayReplyMs, 15 * 60_000, "resolved with no override");
    assert.equal(policy.minLaterReplyMs, 15 * 60_000);
  });

  test("resolves the Workflow policy (no hours) and the API-side hours separately", () => {
    assert.equal(policy.timeZone, "America/Los_Angeles");
    assert.equal("weeklyHours" in policy, false, "hours never enter the Workflow policy");
    assert.equal(hours.weeklyHours[0], null);
    assert.deepEqual(hours.weeklyHours[4], { opens: "09:00", closes: "20:00" });
  });

  test("rejects an unknown time zone, inverted hours and a salon with no open days", () => {
    assert.throws(() => resolveSalon({ ...config, timeZone: "Mars/Olympus_Mons" }), /time zone/);
    assert.throws(() => resolveSalon({ ...config, weeklyHours: { ...config.weeklyHours, 2: { opens: "19:00", closes: "09:00" } } }), /before closing/);
    assert.throws(() => resolveSalon({ ...config, weeklyHours: {} }), /open day/);
  });

  test("policy comparison flags a demo reply window and any other difference", () => {
    const demo = resolveSalon(config, { sameDayReplyMin: 1 }).policy;
    assert.deepEqual(policyDifferences(policy, policy), []);
    assert.deepEqual(policyDifferences(demo, policy), ["sameDayReplyMs: running 60000, configured 900000"]);
    assert.equal(policyDifferences({ ...policy, timeZone: "UTC" }, policy).length, 1);
  });
});
