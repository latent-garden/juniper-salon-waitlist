import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allocateOffers, type AllocationDecision } from "../src/allocation";
import type { Client, Offer, Opening } from "../src/types";
import { openingInput, testPolicy } from "./fixtures";

// Allocation pass (pure): A-I17 one pending offer per client (derived from pending offers),
// A-ORDER openings by creation seq then clients by join order, A-WAIT busy-but-fitting means wait.

const policy = testPolicy();
const NOW = "2030-09-30T09:00:00.000Z"; // a Monday; openings are later that week (later-day offers)
const anytime = ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => ({ weekday, start: "00:00", end: "23:59" }));

function opening(seq: number, start: string, extra: Partial<Opening> = {}): Opening {
  const input = openingInput({ start, stylist: "Maria", durationMin: 45 });
  return {
    ...input, openingId: `opening-${seq}`, seq, status: "matching", offerIds: [], recordedInSquare: false,
    source: { kind: "added-by-staff" }, createdAt: NOW, ...extra,
  };
}
function client(seq: number, name: string, joinedAt: string, extra: Partial<Client> = {}): Client {
  return {
    clientId: `client-${seq}`, seq, name, mobile: "555-0100", service: "haircut", stylistPreference: { kind: "any" },
    availability: anytime, joinedAt, status: "waiting", ...extra,
  };
}
function offer(id: string, openingId: string, clientId: string, outcome: Offer["outcome"]): Offer {
  return { offerId: id, openingId, clientId, offeredAt: NOW, expiresAt: "2030-09-30T23:59:00.000Z", outcome };
}
const run = (openings: Opening[], clients: Client[], offers: Offer[] = []) =>
  allocateOffers({ openings, clients, offers, policy, now: NOW, matchOptions: { serviceMustMatch: true } });
const by = (decisions: AllocationDecision[]) => Object.fromEntries(decisions.map((d) => [d.openingId, d]));

const A = () => opening(7, "2030-10-01T14:00:00.000Z");
const B = () => opening(9, "2030-10-02T14:00:00.000Z");
const ava = client(1, "Ava Chen", "2026-09-02T10:00:00.000Z");
const ben = client(2, "Ben Ortiz", "2026-09-08T10:00:00.000Z");

describe("allocation pass (prototype assumptions A-I17, A-ORDER, A-WAIT)", () => {
  test("one client who fits two openings gets only the earlier-created one; the other waits", () => {
    const d = by(run([A(), B()], [ava]));
    assert.deepEqual(d["opening-7"], { openingId: "opening-7", kind: "offer", clientId: ava.clientId, expiresAt: d["opening-7"].kind === "offer" ? d["opening-7"].expiresAt : "" });
    assert.deepEqual(d["opening-9"], { openingId: "opening-9", kind: "wait" });
  });

  test("another eligible client receives the second opening", () => {
    const d = by(run([A(), B()], [ava, ben]));
    assert.equal(d["opening-7"].kind === "offer" && d["opening-7"].clientId, ava.clientId);
    assert.equal(d["opening-9"].kind === "offer" && d["opening-9"].clientId, ben.clientId);
  });

  test("the result doesn't depend on the order of the collections passed in", () => {
    const forward = run([A(), B()], [ava, ben]);
    const reversed = run([B(), A()], [ben, ava]);
    assert.deepEqual(reversed, forward);
    assert.deepEqual(forward.map((d) => d.openingId), ["opening-7", "opening-9"], "decided in creation order");
  });

  test("a client holding a pending offer elsewhere is busy; one whose offers have ended is free", () => {
    const elsewhere = opening(3, "2030-10-03T14:00:00.000Z", { status: "held" });
    assert.equal(by(run([B()], [ava], [offer("o1", elsewhere.openingId, ava.clientId, "pending")]))["opening-9"].kind, "wait");
    for (const ended of ["declined", "expired", "accepted"] as const) {
      const free = ended === "accepted" ? [] : [ava]; // an accepted client is booked, not waiting
      const d = by(run([B()], free, [offer("o1", elsewhere.openingId, ava.clientId, ended)]))["opening-9"];
      assert.equal(d.kind, ended === "accepted" ? "close" : "offer", ended);
    }
  });

  test("waiting is not unfilled: nobody fits closes no-one-fits, ended offers give the existing reasons", () => {
    assert.deepEqual(by(run([B()], []))["opening-9"], { openingId: "opening-9", kind: "close", reason: "no-one-fits" });
    const declined = B(); declined.offerIds = ["o1"];
    assert.deepEqual(by(run([declined], [ava], [offer("o1", "opening-9", ava.clientId, "declined")]))["opening-9"],
      { openingId: "opening-9", kind: "close", reason: "everyone-passed" });
    const timedOut = B(); timedOut.offerIds = ["o1"];
    assert.deepEqual(by(run([timedOut], [ava], [offer("o1", "opening-9", ava.clientId, "expired")]))["opening-9"],
      { openingId: "opening-9", kind: "close", reason: "no-one-accepted" });
  });

  test("per-opening skips are unchanged: a client who declined this opening isn't offered it, even when free", () => {
    const b = B(); b.offerIds = ["o1"];
    const d = by(run([b], [ava, ben], [offer("o1", "opening-9", ava.clientId, "declined")]))["opening-9"];
    assert.equal(d.kind === "offer" && d.clientId, ben.clientId);
    const freed = opening(11, "2030-10-02T14:00:00.000Z", { source: { kind: "freed", fromClientId: ava.clientId, movedToOpeningId: "opening-7" } });
    assert.equal(by(run([freed], [ava]))["opening-11"].kind, "close", "the mover is never offered their freed slot");
  });

  test("an opening whose start has passed closes too-late", () => {
    assert.deepEqual(by(run([opening(5, "2030-09-30T08:00:00.000Z")], [ava]))["opening-5"], { openingId: "opening-5", kind: "close", reason: "too-late" });
  });

  test("a freed opening (created later, higher seq) waits behind an older opening for the same client", () => {
    const freed = opening(12, "2030-10-01T10:00:00.000Z", { source: { kind: "freed", fromClientId: "client-9", movedToOpeningId: "opening-7" } });
    const d = by(run([freed, B()], [ava]));
    assert.equal(d["opening-9"].kind === "offer" && d["opening-9"].clientId, ava.clientId, "older opening first");
    assert.equal(d["opening-12"].kind, "wait");
  });
});
