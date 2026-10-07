import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { temporal } from "@temporalio/proto";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";

// Workflow code must not interpret time zones: those results would be recomputed on replay with
// whatever ICU/tzdata the Worker runs. Time-zone rules live in src/salonCalendar.ts (API side).

const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} };

describe("determinism: no time-zone interpretation inside the Workflow", () => {
  test("the bundled Workflow code (exactly what the Worker runs) contains no time-zone machinery", async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: require.resolve("../src/workflows"),
      logger: quiet as never,
    });
    // "./src/salonCalendar.ts" would appear as a bundled module id if anything imported it.
    for (const forbidden of ["luxon", "./src/salonCalendar", "Intl.DateTimeFormat", "resolvedOptions", "toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
      assert.equal(code.includes(forbidden), false, `Workflow bundle must not contain ${forbidden}`);
    }
  });

  test("Workflow-side modules don't import time-zone code", () => {
    for (const file of ["src/workflows.ts", "src/matching.ts", "src/replyWindow.ts"]) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /from "luxon"|from "\.\/salonCalendar"|require\(|\bIntl\.|toLocale/, file);
    }
  });
});

describe("determinism: replay of a captured production-path history", () => {
  test("the Event History captured from the live demo run replays on this code", async () => {
    // Captured with scripts/capture-history.ts after the browser timeout flow: an offer that timed
    // out (TimerFired), a decline (TimerCanceled), and a later-day offer held until the next morning,
    // all created through the API with recorded calendars. (salon-demo-run.json is the same history
    // from `temporal workflow show --output json`, kept for reading.)
    const history = temporal.api.history.v1.History.decode(readFileSync("tests/histories/salon-demo-run.binpb"));
    const T = temporal.api.enums.v1.EventType;
    const types = history.events.map((e) => e.eventType);
    assert.ok(types.includes(T.EVENT_TYPE_TIMER_FIRED) && types.includes(T.EVENT_TYPE_TIMER_CANCELED));
    assert.ok(types.includes(T.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED));
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, history, "juniper-waitlist");
  });
});

describe("determinism: replay of a captured move and cascade", () => {
  test("a pre-fix history (no service-eligibility marker) still replays: patched() keeps the rule it ran with", async () => {
    // Captured with scripts/capture-history.ts after a browser run: sample waitlist with
    // existing appointments; Ava accepts an earlier opening (Ava's Thursday color is freed), Ben accepts
    // that slot (Ben's Friday haircut is freed), Mia is offered Friday.
    const history = temporal.api.history.v1.History.decode(readFileSync("tests/histories/salon-move-cascade.binpb"));
    const T = temporal.api.enums.v1.EventType;
    const updates = history.events.filter((e) => e.eventType === T.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_COMPLETED).length;
    assert.ok(updates >= 10, "seeded clients, an opening and two acceptances");
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, history, "juniper-waitlist");
  });
});

describe("determinism: replay after the service-eligibility fix", () => {
  test("the corrected live cascade (Ava, then Chloe, Priya offered; all color slots to color clients) replays", async () => {
    // Captured after the fix: the history carries the patched("service-eligibility") marker, so
    // replay uses the enforced service rule. The previous capture (salon-move-cascade.binpb) has no
    // marker and replays with the rule it originally ran with.
    const history = temporal.api.history.v1.History.decode(readFileSync("tests/histories/salon-service-cascade.binpb"));
    const markers = history.events.filter((e) => e.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED);
    assert.ok(markers.length >= 1, "the patch marker is recorded");
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, history, "juniper-waitlist");
  });
});

describe("determinism: replay of the allocation pass (one pending offer per client)", () => {
  test("the live history (Ava holds 10:00, 11:00 waits, Ava declines, 11:00 re-offers her) replays", async () => {
    // Captured after a browser run. It carries the "one-pending-offer" marker, so its
    // openings replay through the allocation pass; older captures (no marker) use the legacy path.
    const history = temporal.api.history.v1.History.decode(readFileSync("tests/histories/salon-one-pending.binpb"));
    const T = temporal.api.enums.v1.EventType;
    assert.ok(history.events.some((e) => e.eventType === T.EVENT_TYPE_MARKER_RECORDED));
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, history, "juniper-waitlist");
  });
});

describe("determinism: replay of the staff actions", () => {
  test("the live history (an inclusion reopens an unfilled opening, an inclusion on a held one, a Mark as recorded) replays", async () => {
    // Captured after a browser run. No new patch was needed: both actions are new Update
    // types that older histories can't contain, and every earlier capture still replays.
    const history = temporal.api.history.v1.History.decode(readFileSync("tests/histories/salon-include-recorded.binpb"));
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, history, "juniper-waitlist");
  });
});
