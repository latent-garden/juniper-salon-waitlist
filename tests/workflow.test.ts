import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { SalonDay } from "../src/types";
import { offerExpiresAt } from "../src/replyWindow";
import { IncompatibleSalonError, startOrAttachSalon } from "../src/salonGuard";
import {
  addClient,
  createOpening,
  getOffer,
  getSnapshot,
  includePreferredClient,
  markRecordedInSquare,
  respondToOffer,
  salonWaitlistWorkflow,
} from "../src/workflows";
import { openingInput, testHours, testPolicy } from "./fixtures";
import { resolveAppointment } from "../src/salonCalendar";
import {
  type NewClientInput,
  type OfferPolicy,
  type OpeningView,
  type RespondResult,
  type SalonSnapshot,
} from "../src/types";

// Integration tests run on TestWorkflowEnvironment.createLocal(): our chosen
// environment, the same dev server the app uses.
const TASK_QUEUE = "juniper-waitlist-test";
// Core and decline tests use openings on a future day: later-day offers, held until today's closing,
// so they never time out during a test.
const policy = testPolicy();

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;

before(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("../src/workflows"),
  });
  workerRun = worker.run();
});

after(async () => {
  worker?.shutdown();
  await workerRun;
  await env?.teardown();
});

/** 2:00 pm (UTC salon time) on a Tuesday 1–7 days ahead, plus `weeks` more: always a later-day opening. */
function tuesday2pm(weeks = 0): string {
  const d = new Date();
  d.setUTCHours(14, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + (((2 - d.getUTCDay() + 7) % 7) || 7) + 7 * weeks);
  return d.toISOString();
}

// A Tuesday at 2:00 pm with Maria, a 45-minute gap (in the future, so offers are issued: A4).
const MARIA_TUESDAY_2PM = { start: tuesday2pm(), stylist: "Maria", durationMin: 45 };
const tuesdayAfternoon = [{ weekday: 2 as const, start: "12:00", end: "18:00" }];

function waitlister(name: string, joinedAt: string, extra: Partial<NewClientInput> = {}): NewClientInput {
  return {
    name,
    mobile: "555-0100",
    service: "haircut",
    stylistPreference: { kind: "any" },
    availability: tuesdayAfternoon,
    joinedAt,
    ...extra,
  };
}

async function startSalon(
  salonPolicy: OfferPolicy = policy,
  taskQueue = TASK_QUEUE,
): Promise<WorkflowHandle<typeof salonWaitlistWorkflow>> {
  return env.client.workflow.start(salonWaitlistWorkflow, {
    workflowId: `salon-test-${randomUUID()}`,
    taskQueue,
    args: [{ policy: salonPolicy }],
  });
}

async function add(handle: WorkflowHandle, input: NewClientInput) {
  return handle.executeUpdate(addClient, { args: [input] });
}

async function openingSettled(handle: WorkflowHandle, openingId: string): Promise<OpeningView> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = await handle.query(getSnapshot);
    const opening = snapshot.openings.find((o) => o.openingId === openingId)!;
    // Settled: held, booked, unfilled, or waiting for a busy fitting client.
    if (opening.status !== "matching" || opening.waitingForAvailableClient) return opening;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Opening ${openingId} never left "matching".`);
}

/** Starts a salon with Ava and Ben waiting and one opening held for Ava. */
async function salonWithHeldOpening() {
  const handle = await startSalon();
  const ava = await add(handle, waitlister("Ava Chen", "2026-09-02T10:00:00.000Z"));
  const ben = await add(handle, waitlister("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
  const created = await handle.executeUpdate(createOpening, { args: [openingInput(MARIA_TUESDAY_2PM)] });
  const held = await openingSettled(handle, created.openingId);
  assert.equal(held.status, "held");
  assert.equal(held.heldBy?.clientId, ava.clientId);
  return { handle, ava, ben, openingId: created.openingId, offerId: held.currentOfferId! };
}

function bookedClients(snapshot: SalonSnapshot) {
  return snapshot.clients.filter((c) => c.status === "booked");
}

describe("salon waitlist: core invariant", () => {
  test("the earliest eligible client receives the offer; ineligible earlier joiners are skipped", async () => {
    const handle = await startSalon();
    // Entered out of join order on purpose.
    await add(handle, waitlister("Ava Chen", "2026-09-10T10:00:00.000Z"));
    const ben = await add(
      handle,
      waitlister("Ben Ortiz", "2026-09-05T10:00:00.000Z", {
        stylistPreference: { kind: "prefers", stylist: "Maria" },
      }),
    );
    await add(
      handle,
      waitlister("Zoe Walsh", "2026-09-01T10:00:00.000Z", {
        stylistPreference: { kind: "requires", stylist: "Jo" },
      }),
    );
    await add(handle, waitlister("Chloe Park", "2026-08-20T10:00:00.000Z", { service: "color" }));

    const created = await handle.executeUpdate(createOpening, { args: [openingInput(MARIA_TUESDAY_2PM)] });
    const opening = await openingSettled(handle, created.openingId);

    assert.equal(opening.status, "held");
    assert.equal(opening.heldBy?.name, "Ben Ortiz");
    assert.equal(opening.heldBy?.clientId, ben.clientId);
    assert.equal(opening.offers.length, 1, "only one client is offered the opening");
  });

  test("an opening nobody fits is marked unfilled and no offer is made", async () => {
    const handle = await startSalon();
    await add(
      handle,
      waitlister("Zoe Walsh", "2026-09-01T10:00:00.000Z", {
        stylistPreference: { kind: "requires", stylist: "Jo" },
      }),
    );
    const created = await handle.executeUpdate(createOpening, { args: [openingInput(MARIA_TUESDAY_2PM)] });
    const opening = await openingSettled(handle, created.openingId);
    assert.equal(opening.status, "unfilled");
    assert.equal(opening.unfilledReason, "no-one-fits");
    assert.equal(opening.offers.length, 0);
  });

  test("accepting books the opening for that client, and the Query agrees with the Update result", async () => {
    const { handle, ava, openingId, offerId } = await salonWithHeldOpening();

    const result = await handle.executeUpdate(respondToOffer, { args: [{ offerId, answer: "accept" }] });
    assert.equal(result.outcome, "booked");
    assert.equal(result.opening.status, "booked");
    assert.equal(result.opening.bookedClientId, ava.clientId);

    const snapshot = await handle.query(getSnapshot);
    const opening = snapshot.openings.find((o) => o.openingId === openingId)!;
    assert.equal(opening.status, result.opening.status);
    assert.equal(opening.bookedClientId, result.opening.bookedClientId);
    assert.equal(opening.bookedOfferId, offerId);
    assert.deepEqual(bookedClients(snapshot).map((c) => c.clientId), [ava.clientId]);
  });

  test("a second acceptance cannot claim an already-booked opening and changes nothing", async () => {
    const { handle, ava, offerId } = await salonWithHeldOpening();
    await handle.executeUpdate(respondToOffer, { args: [{ offerId, answer: "accept" }] });
    const before = await handle.query(getSnapshot);

    const again = await handle.executeUpdate(respondToOffer, { args: [{ offerId, answer: "accept" }] });
    assert.equal(again.outcome, "already-booked");
    assert.equal(again.opening.bookedClientId, ava.clientId);

    assert.deepEqual(await handle.query(getSnapshot), before);
  });

  test("an unknown offer ID is rejected and cannot change Workflow state", async () => {
    const { handle } = await salonWithHeldOpening();
    const before = await handle.query(getSnapshot);

    await assert.rejects(
      handle.executeUpdate(respondToOffer, { args: [{ offerId: randomUUID(), answer: "accept" }] }),
      WorkflowUpdateFailedError,
    );
    assert.deepEqual(await handle.query(getSnapshot), before);
  });

  test("simultaneous acceptances produce exactly one booking transition", async () => {
    const { handle, ava, ben, openingId, offerId } = await salonWithHeldOpening();

    const settled = await Promise.allSettled([
      handle.executeUpdate(respondToOffer, { args: [{ offerId, answer: "accept" }] }),
      handle.executeUpdate(respondToOffer, { args: [{ offerId, answer: "accept" }] }),
      handle.executeUpdate(respondToOffer, { args: [{ offerId: randomUUID(), answer: "accept" }] }),
    ]);

    const outcomes = settled
      .filter((s): s is PromiseFulfilledResult<RespondResult> => s.status === "fulfilled")
      .map((s) => s.value.outcome);
    // Assert the invariant, not which request won.
    assert.equal(outcomes.filter((o) => o === "booked").length, 1, "exactly one request books it");
    assert.ok(outcomes.every((o) => o === "booked" || o === "already-booked"));
    assert.equal(settled.filter((s) => s.status === "rejected").length, 1, "the unknown offer is rejected");

    const snapshot = await handle.query(getSnapshot);
    const opening = snapshot.openings.find((o) => o.openingId === openingId)!;
    assert.equal(opening.status, "booked");
    assert.equal(opening.bookedClientId, ava.clientId);
    assert.deepEqual(bookedClients(snapshot).map((c) => c.clientId), [ava.clientId]);
    assert.equal(snapshot.clients.find((c) => c.clientId === ben.clientId)!.status, "waiting");
  });
});

// ---- Decline and advancement ----

/** Waits until the opening is held by someone other than `previousOfferId`'s client, or has closed. */
async function openingAdvanced(handle: WorkflowHandle, openingId: string, previousOfferId: string): Promise<OpeningView> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = await handle.query(getSnapshot);
    const opening = snapshot.openings.find((o) => o.openingId === openingId)!;
    const moved = opening.status === "held" && opening.currentOfferId !== previousOfferId;
    if (moved || opening.status === "unfilled" || opening.status === "booked") return opening;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Opening ${openingId} never advanced.`);
}

const decline = (handle: WorkflowHandle, offerId: string) =>
  handle.executeUpdate(respondToOffer, { args: [{ offerId, answer: "decline" }] });
const accept = (handle: WorkflowHandle, offerId: string) =>
  handle.executeUpdate(respondToOffer, { args: [{ offerId, answer: "accept" }] });

describe("salon waitlist: decline and advancement", () => {
  test("declining keeps the client on the waitlist and moves the opening to the next client by join date", async () => {
    const handle = await startSalon();
    const ava = await add(handle, waitlister("Ava Chen", "2026-09-02T10:00:00.000Z"));
    // Joined between Ava and Ben, but needs Jo: skipped for Maria's opening.
    await add(handle, waitlister("Zoe Walsh", "2026-09-04T10:00:00.000Z", { stylistPreference: { kind: "requires", stylist: "Jo" } }));
    const ben = await add(handle, waitlister("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const dev = await add(handle, waitlister("Dev Rao", "2026-09-12T10:00:00.000Z"));
    const created = await handle.executeUpdate(createOpening, { args: [openingInput(MARIA_TUESDAY_2PM)] });
    const first = await openingSettled(handle, created.openingId);
    assert.equal(first.heldBy?.clientId, ava.clientId);

    const result = await decline(handle, first.currentOfferId!);
    assert.equal(result.outcome, "declined");

    const next = await openingAdvanced(handle, created.openingId, first.currentOfferId!);
    assert.equal(next.status, "held");
    assert.equal(next.heldBy?.clientId, ben.clientId, "next eligible by join date");
    assert.deepEqual(next.offers.map((o) => [o.clientName, o.outcome]), [["Ava Chen", "declined"], ["Ben Ortiz", "pending"]]);

    const snapshot = await handle.query(getSnapshot);
    const status = (id: string) => snapshot.clients.find((c) => c.clientId === id)!.status;
    assert.equal(status(ava.clientId), "waiting", "a decline keeps the client on the waitlist");
    assert.equal(status(dev.clientId), "waiting");
  });

  test("a client who declined is never offered that same opening again; when everyone passes it is unfilled", async () => {
    const { handle, ava, ben, openingId, offerId } = await salonWithHeldOpening();
    await decline(handle, offerId);
    const benHeld = await openingAdvanced(handle, openingId, offerId);
    assert.equal(benHeld.heldBy?.clientId, ben.clientId);

    await decline(handle, benHeld.currentOfferId!);
    const closed = await openingAdvanced(handle, openingId, benHeld.currentOfferId!);
    assert.equal(closed.status, "unfilled");
    assert.equal(closed.unfilledReason, "everyone-passed");
    assert.deepEqual(closed.offers.map((o) => o.clientId), [ava.clientId, ben.clientId], "Ava is not offered it again");
    assert.ok(closed.offers.every((o) => o.outcome === "declined"));

    const snapshot = await handle.query(getSnapshot);
    assert.ok(snapshot.clients.every((c) => c.status === "waiting"));
  });

  test("a client who declined one opening is still offered other openings", async () => {
    const { handle, ava, openingId, offerId } = await salonWithHeldOpening();
    await decline(handle, offerId);
    await openingAdvanced(handle, openingId, offerId);

    const later = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: tuesday2pm(1) })] });
    const opening = await openingSettled(handle, later.openingId);
    assert.equal(opening.status, "held");
    assert.equal(opening.heldBy?.clientId, ava.clientId, "Ava keeps her join-date place for other openings");
  });

  test("declining twice reports already declined and changes nothing", async () => {
    const { handle, openingId, offerId } = await salonWithHeldOpening();
    await decline(handle, offerId);
    await openingAdvanced(handle, openingId, offerId);
    const before = await handle.query(getSnapshot);

    const again = await decline(handle, offerId);
    assert.equal(again.outcome, "already-declined");
    assert.deepEqual(await handle.query(getSnapshot), before);
  });

  test("accepting after declining reports no longer available and books nothing", async () => {
    const { handle, ava, openingId, offerId } = await salonWithHeldOpening();
    await decline(handle, offerId);
    await openingAdvanced(handle, openingId, offerId);
    const before = await handle.query(getSnapshot);

    const late = await accept(handle, offerId);
    assert.equal(late.outcome, "no-longer-available");
    assert.notEqual(late.opening.bookedClientId, ava.clientId);
    assert.deepEqual(await handle.query(getSnapshot), before);
  });

  test("declining after booking reports already booked and keeps the booking", async () => {
    const { handle, ava, offerId } = await salonWithHeldOpening();
    await accept(handle, offerId);
    const before = await handle.query(getSnapshot);

    const late = await decline(handle, offerId);
    assert.equal(late.outcome, "already-booked");
    assert.equal(late.opening.bookedClientId, ava.clientId);
    assert.deepEqual(await handle.query(getSnapshot), before);
  });

  test("a simultaneous accept and decline produce exactly one terminal outcome", async () => {
    const { handle, ava, openingId, offerId } = await salonWithHeldOpening();
    const [yes, no] = await Promise.all([accept(handle, offerId), decline(handle, offerId)]);

    // Assert the invariant, not which request won.
    const pair = [yes.outcome, no.outcome].join("+");
    assert.ok(pair === "booked+already-booked" || pair === "no-longer-available+declined", pair);

    const opening = await openingAdvanced(handle, openingId, offerId);
    const answered = opening.offers.find((o) => o.offerId === offerId)!;
    if (yes.outcome === "booked") {
      assert.equal(answered.outcome, "accepted");
      assert.equal(opening.bookedClientId, ava.clientId);
    } else {
      assert.equal(answered.outcome, "declined");
      assert.notEqual(opening.bookedClientId, ava.clientId);
    }
  });

  test("an unknown answer is rejected and cannot change Workflow state", async () => {
    const { handle, offerId } = await salonWithHeldOpening();
    const before = await handle.query(getSnapshot);
    await assert.rejects(
      handle.executeUpdate(respondToOffer, { args: [{ offerId, answer: "maybe" as "accept" }] }),
      WorkflowUpdateFailedError,
    );
    assert.deepEqual(await handle.query(getSnapshot), before);
  });
});

// ---- Reply window and timeout ----

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** A fixed-offset IANA zone where it's around midday right now, so "an hour from now" is still today. */
function middayZone(): string {
  const n = new Date().getUTCHours() - 12; // Etc/GMT+n is UTC-n
  return n === 0 ? "Etc/GMT" : `Etc/GMT${n > 0 ? "+" : ""}${n}`;
}

const anytime = ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => ({ weekday, start: "00:00", end: "23:59" }));
const freeAnytime = (name: string, joinedAt: string) => waitlister(name, joinedAt, { availability: anytime });
/** A same-day opening an hour from now (whole minutes). */
const sameDayOpening = () => ({
  start: new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString(),
  stylist: "Maria",
  durationMin: 45,
});

async function sameDaySalon(sameDayReplyMs: number, names = ["Ava Chen", "Ben Ortiz"], taskQueue = TASK_QUEUE) {
  const zone = middayZone();
  const handle = await startSalon(testPolicy({ timeZone: zone, sameDayReplyMs }), taskQueue);
  const people = [];
  for (const [i, name] of names.entries()) people.push(await add(handle, freeAnytime(name, `2026-09-0${i + 1}T10:00:00.000Z`)));
  const created = await handle.executeUpdate(createOpening, { args: [openingInput(sameDayOpening(), testHours(zone))] });
  const held = await openingSettled(handle, created.openingId);
  assert.equal(held.status, "held");
  return { handle, people, openingId: created.openingId, offer: held.offers[0] };
}

async function offerNow(handle: WorkflowHandle, offerId: string) {
  const snapshot = await handle.query(getSnapshot);
  return snapshot.openings.flatMap((o) => o.offers).find((o) => o.offerId === offerId)!;
}

describe("salon waitlist: reply window and timeout", () => {
  test("no reply before the deadline: the offer expires and the opening moves to the next client by join date", async () => {
    const { handle, people: [ava, ben], openingId, offer } = await sameDaySalon(1500);
    const next = await openingAdvanced(handle, openingId, offer.offerId);

    assert.equal(next.heldBy?.clientId, ben.clientId);
    const first = next.offers[0];
    assert.equal(first.outcome, "expired");
    assert.equal(first.resolvedAt, first.expiresAt, "history is recorded at the deadline");
    const snapshot = await handle.query(getSnapshot);
    assert.equal(snapshot.clients.find((c) => c.clientId === ava.clientId)!.status, "waiting", "a timeout keeps the client on the waitlist");
  });

  test("a client who timed out is never offered that opening again; when no one accepts it is unfilled (no-one-accepted)", async () => {
    const { handle, people: [ava, ben], openingId, offer } = await sameDaySalon(1500);
    const benHeld = await openingAdvanced(handle, openingId, offer.offerId);
    const closed = await openingAdvanced(handle, openingId, benHeld.currentOfferId!);

    assert.equal(closed.status, "unfilled");
    assert.equal(closed.unfilledReason, "no-one-accepted");
    assert.deepEqual(closed.offers.map((o) => [o.clientId, o.outcome]), [[ava.clientId, "expired"], [ben.clientId, "expired"]]);
  });

  test("a decline followed by a timeout is 'no-one-accepted', not 'everyone has said no'", async () => {
    const { handle, openingId, offer } = await sameDaySalon(1500);
    await decline(handle, offer.offerId);
    const benHeld = await openingAdvanced(handle, openingId, offer.offerId);
    const closed = await openingAdvanced(handle, openingId, benHeld.currentOfferId!);
    assert.equal(closed.unfilledReason, "no-one-accepted");
    assert.deepEqual(closed.offers.map((o) => o.outcome), ["declined", "expired"]);
  });

  test("a client who timed out on one opening is still offered other openings", async () => {
    const { handle, people: [ava], openingId, offer } = await sameDaySalon(1500, ["Ava Chen"]);
    const closed = await openingAdvanced(handle, openingId, offer.offerId);
    assert.equal(closed.unfilledReason, "no-one-accepted");

    const later = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM })] });
    const opening = await openingSettled(handle, later.openingId);
    assert.equal(opening.heldBy?.clientId, ava.clientId);
  });

  test("a reply before the deadline still counts", async () => {
    const { handle, people: [ava], offer } = await sameDaySalon(60_000);
    const result = await accept(handle, offer.offerId);
    assert.equal(result.outcome, "booked");
    assert.equal(result.opening.bookedClientId, ava.clientId);
  });

  test("replies after the deadline are no longer available, and the offer stays expired", async () => {
    const { handle, people: [ava], openingId, offer } = await sameDaySalon(1500);
    await openingAdvanced(handle, openingId, offer.offerId);
    const before = await handle.query(getSnapshot);

    assert.equal((await accept(handle, offer.offerId)).outcome, "no-longer-available");
    assert.equal((await decline(handle, offer.offerId)).outcome, "no-longer-available");
    const after = await offerNow(handle, offer.offerId);
    assert.equal(after.outcome, "expired");
    assert.equal(after.resolvedAt, after.expiresAt);
    assert.notEqual((await handle.query(getSnapshot)).openings[0].bookedClientId, ava.clientId);
    assert.deepEqual(await handle.query(getSnapshot), before, "late replies change nothing");
  });

  test("the deadline decides lateness even if the reply is processed before the timer", async () => {
    // A dedicated worker we can stop: the timer fires while no worker is running, and the late
    // reply is delivered alongside it when a new worker starts. Either processing order must
    // give the same result.
    const queue = `juniper-deadline-test-${randomUUID()}`;
    const startWorker = async () => {
      const w = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: queue,
        workflowsPath: require.resolve("../src/workflows"),
        maxCachedWorkflows: 0, // no sticky cache, so the restarted worker picks the task up at once
      });
      return { w, run: w.run() };
    };
    let worker1 = await startWorker();
    const { handle, people: [ava], offer } = await sameDaySalon(1500, ["Ava Chen"], queue);
    worker1.w.shutdown();
    await worker1.run;

    await sleep(Date.parse(offer.expiresAt) - Date.now() + 500);
    const reply = accept(handle, offer.offerId); // waits for a worker
    await sleep(300);
    const worker2 = await startWorker();
    try {
      const result = await reply;
      assert.equal(result.outcome, "no-longer-available");
      const after = await offerNow(handle, offer.offerId);
      assert.equal(after.outcome, "expired", "expired exactly once");
      assert.equal(after.resolvedAt, offer.expiresAt);
      const snapshot = await handle.query(getSnapshot);
      assert.equal(snapshot.clients.find((c) => c.clientId === ava.clientId)!.status, "waiting");
      assert.equal(snapshot.openings[0].status, "unfilled");
      assert.equal(snapshot.openings[0].unfilledReason, "no-one-accepted");
    } finally {
      worker2.w.shutdown();
      await worker2.run;
    }
  });

  test("an accept racing the timer produces exactly one terminal outcome", async () => {
    const { handle, people: [ava], openingId, offer } = await sameDaySalon(1500, ["Ava Chen"]);
    await sleep(Date.parse(offer.expiresAt) - Date.now() - 5);
    const result = await accept(handle, offer.offerId);
    const opening = await openingAdvanced(handle, openingId, offer.offerId);
    const after = await offerNow(handle, offer.offerId);

    if (result.outcome === "booked") {
      assert.equal(after.outcome, "accepted");
      assert.equal(opening.bookedClientId, ava.clientId);
    } else {
      assert.equal(result.outcome, "no-longer-available");
      assert.equal(after.outcome, "expired");
      assert.equal(opening.status, "unfilled");
    }
  });

  test("expiresAt is shown in the snapshot and the client view, and matches the reply-window rules", async () => {
    // Later-day opening (default policy): expires at today's closing.
    const handle = await startSalon();
    await add(handle, waitlister("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const input = openingInput(MARIA_TUESDAY_2PM);
    const created = await handle.executeUpdate(createOpening, { args: [input] });
    const held = await openingSettled(handle, created.openingId);
    const offer = held.offers[0];

    // Recomputed from the recorded input (the calendar the API resolved), not from any time zone.
    assert.equal(offer.expiresAt, offerExpiresAt(offer.offeredAt, input, policy));
    const view = await handle.query(getOffer, offer.offerId);
    assert.equal(view?.expiresAt, offer.expiresAt);
    assert.equal(view?.timeZone, policy.timeZone);

    // Same-day opening: 15 minutes (here the shortened test window).
    const same = await sameDaySalon(60_000, ["Ava Chen"]);
    assert.equal(Date.parse(same.offer.expiresAt) - Date.parse(same.offer.offeredAt), 60_000);
  });

  test("an opening whose start has already passed gets no offer (too-late)", async () => {
    const handle = await startSalon();
    await add(handle, waitlister("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: "2026-09-29T14:00:00.000Z" })] });
    const opening = await openingSettled(handle, created.openingId);
    assert.equal(opening.status, "unfilled");
    assert.equal(opening.unfilledReason, "too-late");
    assert.equal(opening.offers.length, 0);
  });
});

// ---- Determinism refactor: recorded calendar, policy guard, replay ----

describe("salon waitlist: determinism and policy guard", () => {
  test("successive offers use their actual send times but only the recorded calendar", async () => {
    // A synthetic calendar that matches no real time zone, so only recorded instants can explain
    // the deadlines. Day A closes 2s from now; day B opens 4s from now.
    const now = Date.now(), S = 1000, H = 3_600_000;
    const calendar: SalonDay[] = [
      { date: "day-a", startsAt: now - H, endsAt: now + 3 * S, opensAt: now - H, closesAt: now + 2 * S },
      { date: "day-b", startsAt: now + 3 * S, endsAt: now + H, opensAt: now + 4 * S, closesAt: now + H - S },
      { date: "day-c", startsAt: now + H, endsAt: now + 3 * H, opensAt: now + H, closesAt: now + 3 * H - S },
    ];
    const handle = await startSalon(testPolicy({ minLaterReplyMs: 500 }));
    for (const [i, name] of ["Ava Chen", "Ben Ortiz", "Chloe Park"].entries()) {
      await add(handle, freeAnytime(name, `2026-09-0${i + 1}T10:00:00.000Z`));
    }
    const created = await handle.executeUpdate(createOpening, {
      args: [{ start: new Date(now + 2 * H).toISOString(), service: "haircut", stylist: "Maria", durationMin: 45, local: { date: "day-c", weekday: 3, minutes: 600 }, calendar }],
    });
    const first = await openingSettled(handle, created.openingId);
    const second = await openingAdvanced(handle, created.openingId, first.currentOfferId!);
    const third = await openingAdvanced(handle, created.openingId, second.currentOfferId!);
    const [a, b, c] = third.offers;

    assert.equal(Date.parse(a.expiresAt), calendar[0].closesAt, "sent on day A with time left: day A's recorded closing");
    assert.ok(Date.parse(b.offeredAt) >= Date.parse(a.expiresAt), "the second offer is sent when the first expires");
    assert.equal(Date.parse(b.expiresAt), calendar[1].opensAt, "sent at day A's closing: day B's recorded opening");
    assert.ok(Date.parse(c.offeredAt) >= Date.parse(b.expiresAt));
    assert.equal(Date.parse(c.expiresAt), calendar[1].closesAt, "sent during day B: day B's recorded closing");
  });

  test("a createOpening without a valid recorded calendar is rejected", async () => {
    const handle = await startSalon();
    const input = openingInput(MARIA_TUESDAY_2PM);
    await assert.rejects(handle.executeUpdate(createOpening, { args: [{ ...input, calendar: [] }] }), WorkflowUpdateFailedError);
    await assert.rejects(handle.executeUpdate(createOpening, { args: [{ ...input, calendar: input.calendar.slice(0, -1) }] }), WorkflowUpdateFailedError);
  });

  test("the startup guard detects a running salon whose reply window differs from the configuration", async () => {
    const workflowId = `salon-guard-${randomUUID()}`;
    const standard = testPolicy();
    // A salon started with the 1-minute demo window keeps it for its whole life (USE_EXISTING).
    await startOrAttachSalon(env.client, { ...standard, sameDayReplyMs: 60_000 }, { workflowId, taskQueue: TASK_QUEUE });

    await assert.rejects(
      startOrAttachSalon(env.client, standard, { workflowId, taskQueue: TASK_QUEUE }),
      (error: unknown) =>
        error instanceof IncompatibleSalonError &&
        error.reason === "policy-differs" &&
        /sameDayReplyMs: running 60000, configured 900000/.test(error.message),
    );
    // Not terminated or replaced: the running salon still has its own policy.
    const again = await startOrAttachSalon(env.client, { ...standard, sameDayReplyMs: 60_000 }, { workflowId, taskQueue: TASK_QUEUE });
    assert.equal((await again.describe()).status.name, "RUNNING");
  });

  test("a history captured from this implementation replays deterministically", async () => {
    // Decline, timeout and booking in one salon, then replay its full Event History.
    const { handle, openingId, offer } = await sameDaySalon(1500, ["Ava Chen", "Ben Ortiz", "Chloe Park"]);
    await decline(handle, offer.offerId);
    const ben = await openingAdvanced(handle, openingId, offer.offerId); // Ben: let it time out
    const chloe = await openingAdvanced(handle, openingId, ben.currentOfferId!);
    assert.equal((await accept(handle, chloe.currentOfferId!)).outcome, "booked");
    const done = (await handle.query(getSnapshot)).openings[0];
    assert.deepEqual(done.offers.map((o) => o.outcome), ["declined", "expired", "accepted"]);

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, history, handle.workflowId);
  });
});

// ---- Existing appointments and freed openings ----

const HOUR = 3_600_000;
const plusHours = (iso: string, h: number) => new Date(Date.parse(iso) + h * HOUR).toISOString();
/** An existing appointment as the API records it (local facts and calendar resolved outside the Workflow). */
const appointment = (start: string, service: "haircut" | "color" | "blowout", stylist: string, durationMin: number, zone = "UTC") =>
  resolveAppointment({ start, service, stylist, durationMin }, testHours(zone), Date.now());

describe("salon waitlist: existing appointments and freed openings", () => {
  // The accepted opening: a Tuesday 2:00 pm. Ava's existing appointment: that Thursday 3:00 pm, a 2-hour color.
  const TUE = () => tuesday2pm();
  const THU_3PM = () => plusHours(tuesday2pm(), 49);
  const avaWithColor = () =>
    freeAnytimeWith("Ava Chen", "2026-09-02T10:00:00.000Z", appointment(THU_3PM(), "color", "Maria", 120));
  function freeAnytimeWith(name: string, joinedAt: string, currentAppointment?: ReturnType<typeof appointment>) {
    return { ...freeAnytime(name, joinedAt), ...(currentAppointment ? { currentAppointment } : {}) };
  }
  /** A client waiting for a color (2 hours), free any time; Ava's freed Thursday slot is a color. */
  function colorClient(name: string, joinedAt: string, currentAppointment?: ReturnType<typeof appointment>) {
    return { ...freeAnytimeWith(name, joinedAt, currentAppointment), service: "color" as const };
  }
  const SAT_10AM = () => plusHours(tuesday2pm(), 92);

  test("accepting an earlier opening reserves it and frees the old appointment exactly once, with its own service, stylist, length and start", async () => {
    const handle = await startSalon();
    const ava = await add(handle, avaWithColor()); // waitlisted for a haircut; existing 2-hour color
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const held = await openingSettled(handle, created.openingId);
    assert.equal(held.heldBy?.clientId, ava.clientId, "an earlier opening is offered");

    const result = await accept(handle, held.currentOfferId!);
    assert.equal(result.outcome, "booked");
    assert.equal(result.opening.bookedClientId, ava.clientId, "the new slot is reserved for Ava");
    const freed = result.freedOpening!;
    assert.ok(freed, "freed in the same Update as the booking");
    assert.deepEqual(
      { start: freed.start, service: freed.service, stylist: freed.stylist, durationMin: freed.durationMin },
      { start: THU_3PM(), service: "color", stylist: "Maria", durationMin: 120 },
      "the vacated appointment, not the waitlist request",
    );
    assert.deepEqual(freed.source, { kind: "freed", fromClientId: ava.clientId, movedToOpeningId: created.openingId });
    assert.equal(result.opening.freedOpeningId, freed.openingId);
    assert.notEqual(freed.openingId, created.openingId);

    const snapshot = await handle.query(getSnapshot);
    assert.equal(snapshot.openings.length, 2, "exactly one freed opening");
    const after = snapshot.clients.find((c) => c.clientId === ava.clientId)!;
    assert.equal(after.status, "booked");
    assert.equal(after.movedFrom?.start, THU_3PM());
    assert.equal(after.movedFrom?.freedOpeningId, freed.openingId);
    assert.equal(after.currentAppointment?.start, TUE(), "the current appointment is now the accepted slot");
    assert.equal(after.currentAppointment?.service, "haircut");
    assert.equal("calendar" in after.currentAppointment!, false, "views never carry recorded calendars");
  });

  test("later openings and an opening at exactly the current appointment time are not offered", async () => {
    const handle = await startSalon();
    const ava = await add(handle, freeAnytimeWith("Ava Chen", "2026-09-02T10:00:00.000Z", appointment(TUE(), "haircut", "Maria", 45)));
    const ben = await add(handle, freeAnytime("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    // At exactly Ava's appointment time: not earlier, so Ben gets it.
    const same = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    assert.equal((await openingSettled(handle, same.openingId)).heldBy?.clientId, ben.clientId);
    // Later than Ava's appointment: still never Ava. (Ben is busy with the first offer, so this
    // one waits for Ben rather than being offered to anyone else.)
    const later = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: plusHours(TUE(), 24) })] });
    const waiting = await openingSettled(handle, later.openingId);
    assert.equal(waiting.waitingForAvailableClient, true);
    assert.ok(waiting.offers.every((o) => o.clientId !== ava.clientId));
  });

  test("the freed opening enters normal sequential matching and is never offered to the client who moved", async () => {
    const handle = await startSalon();
    const ava = await add(handle, avaWithColor());
    await add(handle, freeAnytime("Dev Patel", "2026-09-05T10:00:00.000Z")); // haircut: never offered the color slot
    const ben = await add(handle, colorClient("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const chloe = await add(handle, colorClient("Chloe Park", "2026-09-10T10:00:00.000Z"));
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const held = await openingSettled(handle, created.openingId);
    const { freedOpening } = await accept(handle, held.currentOfferId!);

    const freedHeld = await openingSettled(handle, freedOpening!.openingId);
    assert.equal(freedHeld.heldBy?.clientId, ben.clientId, "earliest-joined eligible client, by the same process");
    await decline(handle, freedHeld.currentOfferId!);
    const next = await openingAdvanced(handle, freedOpening!.openingId, freedHeld.currentOfferId!);
    assert.equal(next.heldBy?.clientId, chloe.clientId, "declines move it on like any opening");
    assert.ok(next.offers.every((o) => o.clientId !== ava.clientId), "never offered to Ava");
  });

  test("a freed opening that only the mover would fit is not offered to them (no-one-fits)", async () => {
    const handle = await startSalon();
    await add(handle, avaWithColor());
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const held = await openingSettled(handle, created.openingId);
    const { freedOpening } = await accept(handle, held.currentOfferId!);
    const closed = await openingSettled(handle, freedOpening!.openingId);
    assert.equal(closed.status, "unfilled");
    assert.equal(closed.unfilledReason, "no-one-fits");
    assert.equal(closed.offers.length, 0);
  });

  test("the freed opening gets normal deadlines and timeouts from its own recorded calendar", async () => {
    // Same-day salon (short window): Ava's appointment is later today; the accepted opening sooner.
    const zone = middayZone();
    const handle = await startSalon(testPolicy({ timeZone: zone, sameDayReplyMs: 2500 }));
    const soon = new Date(Math.ceil((Date.now() + HOUR) / 60_000) * 60_000).toISOString();
    const avaAppointment = appointment(plusHours(soon, 2), "haircut", "Maria", 45, zone);
    await add(handle, freeAnytimeWith("Ava Chen", "2026-09-01T10:00:00.000Z", avaAppointment));
    const ben = await add(handle, freeAnytime("Ben Ortiz", "2026-09-02T10:00:00.000Z"));
    const chloe = await add(handle, freeAnytime("Chloe Park", "2026-09-03T10:00:00.000Z"));
    const created = await handle.executeUpdate(createOpening, {
      args: [openingInput({ start: soon, stylist: "Maria", durationMin: 45 }, testHours(zone))],
    });
    const held = await openingSettled(handle, created.openingId);
    const { freedOpening } = await accept(handle, held.currentOfferId!);

    const benHeld = await openingSettled(handle, freedOpening!.openingId);
    assert.equal(benHeld.heldBy?.clientId, ben.clientId);
    const benOffer = benHeld.offers[0];
    assert.equal(benOffer.expiresAt, offerExpiresAt(benOffer.offeredAt, avaAppointment, testPolicy({ sameDayReplyMs: 2500 })));
    const next = await openingAdvanced(handle, freedOpening!.openingId, benOffer.offerId); // Ben doesn't reply
    assert.equal(next.offers[0].outcome, "expired");
    assert.equal(next.heldBy?.clientId, chloe.clientId);
  });

  test("a two-step cascade with service-compatible clients: Ava moves, Chloe takes Ava's old color, Chloe's old color opens for Priya", async () => {
    const handle = await startSalon();
    const ava = await add(handle, avaWithColor());
    await add(handle, freeAnytimeWith("Ben Ortiz", "2026-09-04T10:00:00.000Z")); // haircut: skipped for color slots
    const chloe = await add(handle, colorClient("Chloe Park", "2026-09-08T10:00:00.000Z", appointment(SAT_10AM(), "color", "Maria", 120)));
    const priya = await add(handle, colorClient("Priya Shah", "2026-09-10T10:00:00.000Z"));
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const first = await openingSettled(handle, created.openingId);
    const step1 = await accept(handle, first.currentOfferId!);

    const thursday = await openingSettled(handle, step1.freedOpening!.openingId);
    assert.equal(thursday.service, "color");
    assert.equal(thursday.heldBy?.clientId, chloe.clientId, "the earliest color client who fits");
    const step2 = await accept(handle, thursday.currentOfferId!);
    const saturday = await openingSettled(handle, step2.freedOpening!.openingId);
    assert.equal(saturday.heldBy?.clientId, priya.clientId);

    assert.deepEqual(
      { start: saturday.start, service: saturday.service, stylist: saturday.stylist, durationMin: saturday.durationMin },
      { start: SAT_10AM(), service: "color", stylist: "Maria", durationMin: 120 },
    );
    assert.deepEqual(saturday.source, { kind: "freed", fromClientId: chloe.clientId, movedToOpeningId: thursday.openingId });
    const snapshot = await handle.query(getSnapshot);
    assert.equal(snapshot.openings.length, 3);
    assert.equal(snapshot.openings.find((o) => o.openingId === thursday.openingId)!.freedOpeningId, saturday.openingId);
    const byId = (id: string) => snapshot.clients.find((c) => c.clientId === id)!;
    assert.equal(byId(ava.clientId).currentAppointment?.start, TUE());
    assert.equal(byId(chloe.clientId).currentAppointment?.start, THU_3PM());
    assert.equal(byId(chloe.clientId).movedFrom?.start, SAT_10AM());
  });

  test("service eligibility is the same for staff-added and freed openings: haircut to haircut, color to color", async () => {
    const handle = await startSalon();
    await add(handle, freeAnytime("Ben Ortiz", "2026-09-01T10:00:00.000Z")); // haircut, joined first
    const chloe = await add(handle, colorClient("Chloe Park", "2026-09-05T10:00:00.000Z"));
    const ava = await add(handle, avaWithColor());

    // A staff-added 2-hour color: a haircut fits the length, but Ben doesn't want color.
    const staffColor = await handle.executeUpdate(createOpening, {
      args: [openingInput({ start: plusHours(TUE(), 24), service: "color", stylist: "Maria", durationMin: 120 })],
    });
    assert.equal((await openingSettled(handle, staffColor.openingId)).heldBy?.clientId, chloe.clientId);

    // A staff-added haircut goes to the haircut clients; Ava (haircut, appointment later) is after Ben.
    const haircut = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const heldHaircut = await openingSettled(handle, haircut.openingId);
    assert.equal(heldHaircut.service, "haircut");
    await decline(handle, heldHaircut.currentOfferId!); // Ben says no; Ava is next
    const avaHeld = await openingAdvanced(handle, haircut.openingId, heldHaircut.currentOfferId!);
    assert.equal(avaHeld.heldBy?.clientId, ava.clientId);

    // Ava's freed color follows the same rule: Ben, the haircut client, is never offered it. Chloe
    // fits but holds the staff color offer, so the freed color waits for Chloe.
    const { freedOpening } = await accept(handle, avaHeld.currentOfferId!);
    const freedWaiting = await openingSettled(handle, freedOpening!.openingId);
    assert.equal(freedWaiting.waitingForAvailableClient, true);
    const staffHeld = (await handle.query(getSnapshot)).openings.find((o) => o.openingId === staffColor.openingId)!;
    await decline(handle, staffHeld.currentOfferId!);
    const freedHeld = await openingAdvanced(handle, freedOpening!.openingId, "");
    assert.equal(freedHeld.heldBy?.clientId, chloe.clientId);
    assert.ok(freedHeld.offers.every((o) => o.clientName !== "Ben Ortiz"));
  });

  test("duplicate and concurrent acceptances of the same offer free the old appointment only once", async () => {
    const handle = await startSalon();
    await add(handle, avaWithColor());
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const held = await openingSettled(handle, created.openingId);
    const results = await Promise.all([accept(handle, held.currentOfferId!), accept(handle, held.currentOfferId!)]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ["already-booked", "booked"]);
    assert.equal((await accept(handle, held.currentOfferId!)).outcome, "already-booked");
    assert.equal((await handle.query(getSnapshot)).openings.length, 2, "one freed opening, never two");
  });

  test("a client never holds two offers, so a second acceptance can't double-book them", async () => {
    // With one pending offer per client, Ava can't receive the second offer at all. The guard
    // against a second acceptance remains as defense (and for older recorded histories).
    const handle = await startSalon();
    const ava = await add(handle, avaWithColor());
    const a = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const b = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: plusHours(TUE(), 24) })] });
    const heldA = await openingSettled(handle, a.openingId);
    const waitingB = await openingSettled(handle, b.openingId);
    assert.equal(heldA.heldBy?.clientId, ava.clientId);
    assert.equal(waitingB.waitingForAvailableClient, true, "B waits: Ava fits but holds A");

    assert.equal((await accept(handle, heldA.currentOfferId!)).outcome, "booked");
    const closedB = await openingAdvanced(handle, b.openingId, "");
    assert.equal(closedB.status, "unfilled", "Ava is booked now; nobody else fits B");
    assert.equal(closedB.offers.length, 0);
    const snapshot = await handle.query(getSnapshot);
    assert.equal(snapshot.openings.filter((o) => o.bookedClientId === ava.clientId).length, 1, "no double booking");
    assert.equal(snapshot.openings.filter((o) => o.source.kind === "freed").length, 1, "nothing freed twice");
  });

  test("a late acceptance books nothing and frees nothing", async () => {
    const zone = middayZone();
    const handle = await startSalon(testPolicy({ timeZone: zone, sameDayReplyMs: 1500 }));
    const soon = new Date(Math.ceil((Date.now() + HOUR) / 60_000) * 60_000).toISOString();
    const ava = await add(handle, freeAnytimeWith("Ava Chen", "2026-09-01T10:00:00.000Z", appointment(plusHours(soon, 2), "haircut", "Maria", 45, zone)));
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ start: soon, stylist: "Maria", durationMin: 45 }, testHours(zone))] });
    const held = await openingSettled(handle, created.openingId);
    await openingAdvanced(handle, created.openingId, held.currentOfferId!);

    const late = await accept(handle, held.currentOfferId!);
    assert.equal(late.outcome, "no-longer-available");
    assert.equal(late.freedOpening, undefined);
    const snapshot = await handle.query(getSnapshot);
    assert.equal(snapshot.openings.length, 1);
    const after = snapshot.clients.find((c) => c.clientId === ava.clientId)!;
    assert.equal(after.status, "waiting");
    assert.equal(after.currentAppointment?.start, plusHours(soon, 2), "the existing appointment is untouched");
  });

  test("a client without a current appointment behaves exactly as before: nothing is freed", async () => {
    const { handle, offerId } = await salonWithHeldOpening();
    const result = await accept(handle, offerId);
    assert.equal(result.outcome, "booked");
    assert.equal(result.freedOpening, undefined);
    assert.equal(result.opening.freedOpeningId, undefined);
    const snapshot = await handle.query(getSnapshot);
    assert.equal(snapshot.openings.length, 1);
    const booked = snapshot.clients.find((c) => c.status === "booked")!;
    assert.equal(booked.currentAppointment, undefined);
    assert.equal(booked.movedFrom, undefined);
  });

  test("a declined offer leaves the existing appointment untouched", async () => {
    const handle = await startSalon();
    const ava = await add(handle, avaWithColor());
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const held = await openingSettled(handle, created.openingId);
    await decline(handle, held.currentOfferId!);
    const after = (await handle.query(getSnapshot)).clients.find((c) => c.clientId === ava.clientId)!;
    assert.equal(after.currentAppointment?.start, THU_3PM());
    assert.equal(after.movedFrom, undefined);
  });

  test("an appointment that has already started can't be recorded (A2), and malformed appointments are rejected", async () => {
    // A2 ("nothing is freed from an appointment that has already started") is also guarded in the
    // accept handler, but under I20 it can't be reached: an offered opening starts before the
    // appointment and offers expire by the opening start. The recordable boundary is tested here.
    const handle = await startSalon();
    const past = appointment(plusHours(new Date().toISOString(), 1), "haircut", "Maria", 45);
    await assert.rejects(add(handle, freeAnytimeWith("Ava Chen", "2026-09-02T10:00:00.000Z", { ...past, start: "2026-01-01T10:00:00.000Z" })), WorkflowUpdateFailedError);
    await assert.rejects(add(handle, freeAnytimeWith("Ava Chen", "2026-09-02T10:00:00.000Z", { ...past, calendar: [] })), WorkflowUpdateFailedError);
    await assert.rejects(add(handle, freeAnytimeWith("Ava Chen", "2026-09-02T10:00:00.000Z", { ...past, service: "perm" as "color" })), WorkflowUpdateFailedError);
  });

  test("a history with a move and a cascade replays deterministically", async () => {
    const handle = await startSalon();
    await add(handle, avaWithColor());
    await add(handle, colorClient("Chloe Park", "2026-09-08T10:00:00.000Z", appointment(SAT_10AM(), "color", "Maria", 120)));
    await add(handle, colorClient("Priya Shah", "2026-09-10T10:00:00.000Z"));
    const created = await handle.executeUpdate(createOpening, { args: [openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })] });
    const step1 = await accept(handle, (await openingSettled(handle, created.openingId)).currentOfferId!);
    const thursday = await openingSettled(handle, step1.freedOpening!.openingId);
    const step2 = await accept(handle, thursday.currentOfferId!);
    await openingSettled(handle, step2.freedOpening!.openingId);

    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, await handle.fetchHistory(), handle.workflowId);
  });
});

// ---- One pending offer per client (prototype assumption I17) ----

/** The one-pending-offer invariant, checked on a live snapshot: for every client, at most one pending offer. */
async function assertOnePendingPerClient(handle: WorkflowHandle): Promise<SalonSnapshot> {
  const snapshot = await handle.query(getSnapshot);
  const pending = new Map<string, number>();
  for (const o of snapshot.openings) for (const f of o.offers) if (f.outcome === "pending") pending.set(f.clientId, (pending.get(f.clientId) ?? 0) + 1);
  for (const [clientId, count] of pending) assert.ok(count <= 1, `${clientId} holds ${count} pending offers`);
  return snapshot;
}

describe("salon waitlist: one pending offer per client", () => {
  const TUE = () => tuesday2pm();
  const haircut = (start: string) => openingInput({ ...MARIA_TUESDAY_2PM, start });
  const color = (start: string) => openingInput({ start, service: "color", stylist: "Maria", durationMin: 120 });
  const colorClient = (name: string, joinedAt: string, currentAppointment?: ReturnType<typeof appointment>) =>
    ({ ...freeAnytime(name, joinedAt), service: "color" as const, ...(currentAppointment ? { currentAppointment } : {}) });
  async function create(handle: WorkflowHandle, input: ReturnType<typeof openingInput>) {
    const created = await handle.executeUpdate(createOpening, { args: [input] });
    const settled = await openingSettled(handle, created.openingId);
    await assertOnePendingPerClient(handle);
    return settled;
  }

  test("one client who fits two openings gets only the earlier-created one; the other waits (not unfilled)", async () => {
    const handle = await startSalon();
    const ava = await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const a = await create(handle, haircut(TUE()));
    const b = await create(handle, haircut(plusHours(TUE(), 24)));
    assert.equal(a.heldBy?.clientId, ava.clientId);
    assert.equal(b.status, "matching");
    assert.equal(b.waitingForAvailableClient, true);
    assert.equal(b.offers.length, 0);
  });

  test("the second opening goes to another eligible client", async () => {
    const handle = await startSalon();
    const ava = await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const ben = await add(handle, freeAnytime("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    assert.equal((await create(handle, haircut(TUE()))).heldBy?.clientId, ava.clientId);
    assert.equal((await create(handle, haircut(plusHours(TUE(), 24)))).heldBy?.clientId, ben.clientId);
  });

  test("a decline releases the client: the waiting opening offers them; the declined opening never re-offers", async () => {
    const handle = await startSalon();
    const ava = await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const a = await create(handle, haircut(TUE()));
    const b = await create(handle, haircut(plusHours(TUE(), 24)));
    await decline(handle, a.currentOfferId!);
    const bHeld = await openingAdvanced(handle, b.openingId, "");
    await assertOnePendingPerClient(handle);
    assert.equal(bHeld.heldBy?.clientId, ava.clientId, "B re-evaluated when Ava's offer on A ended");
    const aAfter = (await handle.query(getSnapshot)).openings.find((o) => o.openingId === a.openingId)!;
    assert.equal(aAfter.status, "unfilled");
    assert.equal(aAfter.unfilledReason, "everyone-passed", "Ava stays skipped for the opening she declined");
  });

  test("a timeout releases the client in the same way", async () => {
    const zone = middayZone();
    const handle = await startSalon(testPolicy({ timeZone: zone, sameDayReplyMs: 1500 }));
    const ava = await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const soon = new Date(Math.ceil((Date.now() + HOUR) / 60_000) * 60_000).toISOString();
    const a = await create(handle, openingInput({ start: soon, stylist: "Maria", durationMin: 45 }, testHours(zone)));
    const b = await create(handle, openingInput({ start: plusHours(soon, 1), stylist: "Maria", durationMin: 45 }, testHours(zone)));
    assert.equal(b.waitingForAvailableClient, true);
    const bHeld = await openingAdvanced(handle, b.openingId, ""); // Ava doesn't reply to A
    await assertOnePendingPerClient(handle);
    assert.equal(bHeld.heldBy?.clientId, ava.clientId);
    const aAfter = (await handle.query(getSnapshot)).openings.find((o) => o.openingId === a.openingId)!;
    assert.equal(aAfter.unfilledReason, "no-one-accepted");
  });

  test("an acceptance releases the client too; the waiting opening then closes truthfully because they're booked", async () => {
    const handle = await startSalon();
    const ava = await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const a = await create(handle, haircut(TUE()));
    const b = await create(handle, haircut(plusHours(TUE(), 24)));
    assert.equal((await accept(handle, a.currentOfferId!)).outcome, "booked");
    const bAfter = await openingAdvanced(handle, b.openingId, "");
    await assertOnePendingPerClient(handle);
    assert.equal(bAfter.status, "unfilled");
    assert.equal(bAfter.unfilledReason, "no-one-fits");
    assert.ok(bAfter.offers.every((o) => o.clientId !== ava.clientId));
  });

  test("a new client joining wakes a waiting opening", async () => {
    const handle = await startSalon();
    await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    await create(handle, haircut(TUE()));
    const b = await create(handle, haircut(plusHours(TUE(), 24)));
    assert.equal(b.waitingForAvailableClient, true);
    const ben = await add(handle, freeAnytime("Ben Ortiz", "2026-09-20T10:00:00.000Z"));
    const bHeld = await openingAdvanced(handle, b.openingId, "");
    await assertOnePendingPerClient(handle);
    assert.equal(bHeld.heldBy?.clientId, ben.clientId);
  });

  test("a freed opening goes through the same pass: it waits for a busy client, then offers", async () => {
    const handle = await startSalon();
    const chloe = await add(handle, colorClient("Chloe Park", "2026-09-01T10:00:00.000Z"));
    await add(handle, { ...freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"), currentAppointment: appointment(plusHours(TUE(), 49), "color", "Maria", 120) });
    const staffColor = await create(handle, color(plusHours(TUE(), 24)));
    assert.equal(staffColor.heldBy?.clientId, chloe.clientId);
    const a = await create(handle, haircut(TUE()));
    const { freedOpening } = await accept(handle, a.currentOfferId!);
    const freedWaiting = await openingSettled(handle, freedOpening!.openingId);
    await assertOnePendingPerClient(handle);
    assert.equal(freedWaiting.waitingForAvailableClient, true, "Chloe fits but holds the staff color offer");
    await decline(handle, staffColor.currentOfferId!);
    const freedHeld = await openingAdvanced(handle, freedOpening!.openingId, "");
    await assertOnePendingPerClient(handle);
    assert.equal(freedHeld.heldBy?.clientId, chloe.clientId);
  });

  test("a cascade never gives one client two pending offers", async () => {
    const handle = await startSalon();
    const chloe = await add(handle, colorClient("Chloe Park", "2026-09-01T10:00:00.000Z", appointment(plusHours(TUE(), 92), "color", "Maria", 120)));
    await add(handle, { ...freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"), currentAppointment: appointment(plusHours(TUE(), 49), "color", "Maria", 120) });
    const priya = await add(handle, colorClient("Priya Shah", "2026-09-10T10:00:00.000Z"));
    const staffColor = await create(handle, color(plusHours(TUE(), 24))); // Chloe
    const a = await create(handle, haircut(TUE())); // Ava
    const { freedOpening: thursday } = await accept(handle, a.currentOfferId!); // Ava's Thursday color: Chloe busy, Priya free
    const thursdayHeld = await openingSettled(handle, thursday!.openingId);
    await assertOnePendingPerClient(handle);
    assert.equal(thursdayHeld.heldBy?.clientId, priya.clientId);

    const { freedOpening: saturday } = await accept(handle, staffColor.currentOfferId!); // Chloe moves; Chloe's Saturday opens
    const saturdaySettled = await openingSettled(handle, saturday!.openingId);
    const snapshot = await assertOnePendingPerClient(handle);
    assert.equal(saturdaySettled.waitingForAvailableClient, true, "Priya fits Saturday but holds Thursday");
    assert.equal(snapshot.openings.flatMap((o) => o.offers).filter((f) => f.clientId === priya.clientId && f.outcome === "pending").length, 1);
    assert.equal(snapshot.clients.find((c) => c.clientId === chloe.clientId)!.status, "booked");
  });

  test("two openings created at the same moment: the earlier-created one deterministically gets the shared client", async () => {
    const handle = await startSalon();
    const ava = await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const [first, second] = await Promise.all([
      handle.executeUpdate(createOpening, { args: [haircut(plusHours(TUE(), 24))] }),
      handle.executeUpdate(createOpening, { args: [haircut(TUE())] }),
    ]);
    const [earlier, later] = [first, second].sort((x, y) => x.seq - y.seq);
    const held = await openingSettled(handle, earlier.openingId);
    const waiting = await openingSettled(handle, later.openingId);
    await assertOnePendingPerClient(handle);
    assert.equal(held.heldBy?.clientId, ava.clientId, "lower seq wins, regardless of start time");
    assert.equal(waiting.waitingForAvailableClient, true);
  });

  test("no terminal path leaves a client reserved: after a decline, a timeout with a late reply, or a booking elsewhere, ownership is gone", async () => {
    const zone = middayZone();
    const handle = await startSalon(testPolicy({ timeZone: zone, sameDayReplyMs: 1500 }));
    const ava = await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const soon = new Date(Math.ceil((Date.now() + HOUR) / 60_000) * 60_000).toISOString();
    const slot = (h: number) => openingInput({ start: plusHours(soon, h), stylist: "Maria", durationMin: 45 }, testHours(zone));

    const first = await create(handle, slot(0));
    await decline(handle, first.currentOfferId!);
    const second = await create(handle, slot(1));
    assert.equal(second.heldBy?.clientId, ava.clientId, "free after a decline");

    await openingAdvanced(handle, second.openingId, second.currentOfferId!); // times out
    assert.equal((await accept(handle, second.currentOfferId!)).outcome, "no-longer-available");
    const third = await create(handle, slot(2));
    assert.equal(third.heldBy?.clientId, ava.clientId, "free after a timeout and a late reply");
    await assertOnePendingPerClient(handle);
  });

  test("a waiting opening closes too-late at its start if the busy client never becomes free", async () => {
    const zone = middayZone();
    const handle = await startSalon(testPolicy({ timeZone: zone, sameDayReplyMs: 60_000 }));
    await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const soon = new Date(Math.ceil((Date.now() + HOUR) / 60_000) * 60_000).toISOString();
    await create(handle, openingInput({ start: soon, stylist: "Maria", durationMin: 45 }, testHours(zone)));
    const imminent = await create(handle, openingInput({ start: new Date(Date.now() + 3000).toISOString(), stylist: "Maria", durationMin: 45 }, testHours(zone)));
    assert.equal(imminent.waitingForAvailableClient, true);
    const closed = await openingAdvanced(handle, imminent.openingId, "");
    assert.equal(closed.status, "unfilled");
    assert.equal(closed.unfilledReason, "too-late");
    assert.equal(closed.offers.length, 0);
  });

  test("a contention history (wait, decline, re-offer) replays deterministically", async () => {
    const handle = await startSalon();
    await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const a = await create(handle, haircut(TUE()));
    const b = await create(handle, haircut(plusHours(TUE(), 24)));
    await decline(handle, a.currentOfferId!);
    const bHeld = await openingAdvanced(handle, b.openingId, "");
    await accept(handle, bHeld.currentOfferId!);
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, await handle.fetchHistory(), handle.workflowId);
  });
});

// ---- Staff inclusion of a "Prefers" client, and Mark as recorded in Square ----

describe("salon waitlist: staff inclusion and Mark as recorded", () => {
  const TUE = () => tuesday2pm();
  const jo = (start: string) => openingInput({ start, stylist: "Jo", durationMin: 45 });
  const prefersMaria = (name: string, joinedAt: string, extra = {}) =>
    ({ ...freeAnytime(name, joinedAt), stylistPreference: { kind: "prefers" as const, stylist: "Maria" }, ...extra });
  const include = (handle: WorkflowHandle, openingId: string, clientId: string) =>
    handle.executeUpdate(includePreferredClient, { args: [{ openingId, clientId }] });
  const markRecorded = (handle: WorkflowHandle, openingId: string) =>
    handle.executeUpdate(markRecordedInSquare, { args: [{ openingId }] });
  async function create(handle: WorkflowHandle, input: ReturnType<typeof openingInput>) {
    const created = await handle.executeUpdate(createOpening, { args: [input] });
    return openingSettled(handle, created.openingId);
  }
  const find = async (handle: WorkflowHandle, openingId: string) =>
    (await assertOnePendingPerClient(handle)).openings.find((o) => o.openingId === openingId)!;

  test("an unfilled opening that only a 'Prefers' client fits lists them; including reopens it and the allocator offers normally (that opening only)", async () => {
    const handle = await startSalon();
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const input = jo(TUE());
    const unfilled = await create(handle, input);
    assert.equal(unfilled.unfilledReason, "no-one-fits", "Ben prefers Maria, so he isn't matched automatically");
    assert.deepEqual(unfilled.includeCandidates, [{ clientId: ben.clientId, name: "Ben Ortiz", prefers: "Maria" }]);
    const other = await create(handle, jo(plusHours(TUE(), 24)));

    await include(handle, unfilled.openingId, ben.clientId);
    const held = await openingAdvanced(handle, unfilled.openingId, "");
    assert.equal(held.status, "held");
    assert.equal(held.heldBy?.clientId, ben.clientId);
    assert.equal(held.inclusions?.[0].clientName, "Ben Ortiz", "recorded in the opening's history");
    assert.equal(held.offers[0].expiresAt, offerExpiresAt(held.offers[0].offeredAt, input, policy), "normal deadline");
    const otherAfter = await find(handle, other.openingId);
    assert.equal(otherAfter.status, "unfilled", "the inclusion applies to that opening only");
    assert.equal(otherAfter.offers.length, 0);
  });

  test("including while another client holds the offer doesn't replace them; the included client follows in join order", async () => {
    const handle = await startSalon();
    const zoe = await add(handle, { ...freeAnytime("Zoe Walsh", "2026-09-01T10:00:00.000Z"), stylistPreference: { kind: "requires", stylist: "Jo" } });
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const held = await create(handle, jo(TUE()));
    assert.equal(held.heldBy?.clientId, zoe.clientId);
    await include(handle, held.openingId, ben.clientId);
    const still = await find(handle, held.openingId);
    assert.equal(still.currentOfferId, held.currentOfferId, "Zoe keeps her offer");
    assert.equal(still.heldBy?.clientId, zoe.clientId);
    await decline(handle, held.currentOfferId!);
    const next = await openingAdvanced(handle, held.openingId, held.currentOfferId!);
    await assertOnePendingPerClient(handle);
    assert.equal(next.heldBy?.clientId, ben.clientId);
  });

  test("a waiting opening re-evaluates after an inclusion", async () => {
    const handle = await startSalon();
    await add(handle, { ...freeAnytime("Zoe Walsh", "2026-09-01T10:00:00.000Z"), stylistPreference: { kind: "requires", stylist: "Jo" } });
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    await create(handle, jo(TUE())); // Zoe holds this
    const waiting = await create(handle, jo(plusHours(TUE(), 24)));
    assert.equal(waiting.waitingForAvailableClient, true);
    await include(handle, waiting.openingId, ben.clientId);
    const held = await openingAdvanced(handle, waiting.openingId, "");
    await assertOnePendingPerClient(handle);
    assert.equal(held.heldBy?.clientId, ben.clientId);
  });

  test("an included client who holds another pending offer stays unavailable until it ends", async () => {
    const handle = await startSalon();
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const maria = await create(handle, openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() }));
    assert.equal(maria.heldBy?.clientId, ben.clientId);
    const joOpening = await create(handle, jo(plusHours(TUE(), 24)));
    assert.equal(joOpening.status, "unfilled");
    await include(handle, joOpening.openingId, ben.clientId);
    const reopened = await openingSettled(handle, joOpening.openingId);
    await assertOnePendingPerClient(handle);
    assert.equal(reopened.waitingForAvailableClient, true, "reopened, but Ben is busy");
    await decline(handle, maria.currentOfferId!);
    const held = await openingAdvanced(handle, joOpening.openingId, "");
    await assertOnePendingPerClient(handle);
    assert.equal(held.heldBy?.clientId, ben.clientId);
  });

  test("inclusion can't resurrect a client who declined that opening", async () => {
    const handle = await startSalon();
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const opening = await create(handle, jo(TUE()));
    await include(handle, opening.openingId, ben.clientId);
    const held = await openingAdvanced(handle, opening.openingId, "");
    await decline(handle, held.currentOfferId!);
    const closed = await openingAdvanced(handle, opening.openingId, held.currentOfferId!);
    assert.equal(closed.unfilledReason, "everyone-passed");
    assert.equal(closed.includeCandidates, undefined);
    await assert.rejects(include(handle, opening.openingId, ben.clientId), WorkflowUpdateFailedError);
    assert.equal((await find(handle, opening.openingId)).status, "unfilled");
  });

  test("inclusion can't resurrect a client who timed out on that opening", async () => {
    const zone = middayZone();
    const handle = await startSalon(testPolicy({ timeZone: zone, sameDayReplyMs: 1500 }));
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const soon = new Date(Math.ceil((Date.now() + HOUR) / 60_000) * 60_000).toISOString();
    const opening = await create(handle, openingInput({ start: soon, stylist: "Jo", durationMin: 45 }, testHours(zone)));
    await include(handle, opening.openingId, ben.clientId);
    const held = await openingAdvanced(handle, opening.openingId, "");
    const closed = await openingAdvanced(handle, opening.openingId, held.currentOfferId!); // no reply
    assert.equal(closed.unfilledReason, "no-one-accepted");
    await assert.rejects(include(handle, opening.openingId, ben.clientId), WorkflowUpdateFailedError);
  });

  test("an opening that has already started doesn't reopen; 'Only with' and ill-fitting clients can't be included", async () => {
    const handle = await startSalon();
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const onlyMaria = await add(handle, { ...freeAnytime("Chloe Park", "2026-09-01T10:00:00.000Z"), stylistPreference: { kind: "requires", stylist: "Maria" } });
    const colorFan = await add(handle, prefersMaria("Priya Shah", "2026-09-10T10:00:00.000Z", { service: "color" }));
    const started = await create(handle, jo("2026-09-29T14:00:00.000Z"));
    assert.equal(started.unfilledReason, "too-late");
    await assert.rejects(include(handle, started.openingId, ben.clientId), WorkflowUpdateFailedError);
    const future = await create(handle, jo(TUE()));
    await assert.rejects(include(handle, future.openingId, onlyMaria.clientId), WorkflowUpdateFailedError);
    await assert.rejects(include(handle, future.openingId, colorFan.clientId), WorkflowUpdateFailedError, "service still applies");
    assert.deepEqual(future.includeCandidates?.map((c) => c.clientId), [ben.clientId], "only clients who fail just the preference");
  });

  test("a freed opening behaves identically: Ava's freed Jo haircut can be offered to an included 'Prefers Maria' client", async () => {
    const handle = await startSalon();
    await add(handle, { ...freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"), currentAppointment: appointment(plusHours(TUE(), 49), "haircut", "Jo", 45) });
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const a = await create(handle, openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() }));
    // A (Maria) goes to Ava, who joined first; Ben stays free.
    const { freedOpening } = await accept(handle, a.currentOfferId!);
    const freed = await openingSettled(handle, freedOpening!.openingId);
    assert.equal(freed.stylist, "Jo");
    assert.equal(freed.unfilledReason, "no-one-fits");
    assert.deepEqual(freed.includeCandidates?.map((c) => c.clientId), [ben.clientId]);
    await include(handle, freed.openingId, ben.clientId);
    const held = await openingAdvanced(handle, freed.openingId, "");
    await assertOnePendingPerClient(handle);
    assert.equal(held.heldBy?.clientId, ben.clientId);
  });

  test("Mark as recorded clears only that reminder, is idempotent, and changes no booking or matching state", async () => {
    const handle = await startSalon();
    await add(handle, { ...freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"), currentAppointment: appointment(plusHours(TUE(), 49), "haircut", "Maria", 45) });
    await add(handle, freeAnytime("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const a = await create(handle, openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() })); // Ava (a move)
    const b = await create(handle, openingInput({ ...MARIA_TUESDAY_2PM, start: plusHours(TUE(), 24) })); // Ben (a plain booking)
    const { freedOpening } = await accept(handle, a.currentOfferId!);
    await accept(handle, b.currentOfferId!);
    const before = await handle.query(getSnapshot);

    const moved = await markRecorded(handle, a.openingId); // the move reminder
    assert.equal(moved.recordedInSquare, true);
    const firstAt = moved.recordedInSquareAt;
    assert.ok(firstAt);
    const again = await markRecorded(handle, a.openingId);
    assert.equal(again.recordedInSquareAt, firstAt, "repeating changes nothing");

    const after = await handle.query(getSnapshot);
    const byId = (snap: typeof after, id: string) => snap.openings.find((o) => o.openingId === id)!;
    assert.equal(byId(after, b.openingId).recordedInSquare, false, "the other reminder is untouched");
    const strip = (snap: typeof after) => JSON.stringify({ ...snap, openings: snap.openings.map(({ recordedInSquare: _r, recordedInSquareAt: _at, ...o }) => o) });
    assert.equal(strip(after), strip(before), "bookings, offers, clients and the freed opening are unchanged");

    await markRecorded(handle, b.openingId);
    const done = await handle.query(getSnapshot);
    assert.ok(done.openings.filter((o) => o.status === "booked").every((o) => o.recordedInSquare), "the final reminder cleared");
    assert.ok(byId(done, freedOpening!.openingId), "the freed opening is still there");
  });

  test("only booked openings can be marked as recorded", async () => {
    const handle = await startSalon();
    await add(handle, freeAnytime("Ava Chen", "2026-09-02T10:00:00.000Z"));
    const held = await create(handle, openingInput({ ...MARIA_TUESDAY_2PM, start: TUE() }));
    const unfilled = await create(handle, jo(plusHours(TUE(), 24)));
    for (const openingId of [held.openingId, unfilled.openingId, "opening-999"]) {
      await assert.rejects(markRecorded(handle, openingId), WorkflowUpdateFailedError, openingId);
    }
  });

  test("a history with an inclusion, a reopen and a Mark as recorded replays deterministically", async () => {
    const handle = await startSalon();
    const ben = await add(handle, prefersMaria("Ben Ortiz", "2026-09-08T10:00:00.000Z"));
    const unfilled = await create(handle, jo(TUE()));
    await include(handle, unfilled.openingId, ben.clientId);
    const held = await openingAdvanced(handle, unfilled.openingId, "");
    await accept(handle, held.currentOfferId!);
    await markRecorded(handle, held.openingId);
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, await handle.fetchHistory(), handle.workflowId);
  });
});
