import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import vm from "node:vm";

// Loads the real browser scripts (format.js, staff.js, waitlist.js) into a sandbox with a minimal
// DOM stub, then checks what they render for a snapshot after a move. No browser needed.
function loadStaffScripts() {
  const element = () => ({ textContent: "", innerHTML: "", hidden: false, addEventListener() {}, querySelector: () => element() });
  const context = vm.createContext({ document: { querySelector: () => element() }, fetch: async () => ({}), setInterval() {}, setTimeout() {}, console, Date, Intl, Math });
  for (const file of ["format.js", "staff.js"]) vm.runInContext(readFileSync(`public/${file}`, "utf8"), context);
  vm.runInContext("startPolling = () => () => {};", context); // waitlist.js starts polling on load
  vm.runInContext(readFileSync("public/waitlist.js", "utf8"), context);
  return context as unknown as {
    row: (client: object, snapshot: object, held: object | null, booked: object | null) => string;
    openingRow: (opening: object, snapshot: object, clients: Map<string, object>) => string;
    renderNeeds: (el: { hidden: boolean; querySelector: () => { innerHTML: string } }, snapshot: object) => void;
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Ava moved from a 3:00 pm color (three days ahead) to 5:00 pm tomorrow; Ben waits with an appointment four days ahead.
const DAY = 86_400_000;
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const tue = at(1, 17), thu = at(3, 15), fri = at(4, 16);
const ava = {
  clientId: "client-1", name: "Ava Chen", mobile: "(555) 010-3378", service: "haircut", serviceMinutes: 45,
  stylistPreference: { kind: "any" }, availability: [{ weekday: 2, start: "09:00", end: "19:00" }], joinedAt: "2026-09-02T18:15:00.000Z",
  status: "booked", currentAppointment: { start: tue, service: "haircut", stylist: "Maria", durationMin: 45 },
  movedFrom: { start: thu, service: "color", stylist: "Maria", durationMin: 120, freedOpeningId: "opening-9" },
};
const ben = {
  ...ava, clientId: "client-2", name: "Ben Ortiz", status: "waiting", movedFrom: undefined,
  currentAppointment: { start: fri, service: "haircut", stylist: "Maria", durationMin: 45 },
};
const accepted = {
  openingId: "opening-8", start: tue, service: "haircut", stylist: "Maria", durationMin: 45, status: "booked", recordedInSquare: false,
  source: { kind: "added-by-staff" }, freedOpeningId: "opening-9", offers: [], bookedFor: { clientId: "client-1", name: "Ava Chen" },
};
const freed = {
  openingId: "opening-9", start: thu, stylist: "Maria", durationMin: 120, service: "color", status: "matching", recordedInSquare: false,
  source: { kind: "freed", fromClientId: "client-1", movedToOpeningId: "opening-8" }, offers: [],
};
const snapshot = { timeZone: "UTC", clients: [ava, ben], openings: [accepted, freed] };
const weekday = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });

describe("staff UI after a move (real browser scripts)", () => {
  const ui = loadStaffScripts();

  test("Waitlist: the moved client shows the new booking and where they moved from; a waiting client shows their appointment", () => {
    const avaRow = text(ui.row(ava, snapshot, null, accepted));
    assert.match(avaRow, new RegExp(`✓ Booked ${weekday(tue)}, 5:00 pm Moved from ${weekday(thu)}, 3:00 pm`));
    const benRow = text(ui.row(ben, snapshot, null, null));
    assert.match(benRow, new RegExp(`Waiting Has ${weekday(fri)}, 4:00 pm`));
  });

  test("Needs attention: the Square move reminder with old and new times", () => {
    const list = { innerHTML: "" };
    const panel = { hidden: true, querySelector: () => list };
    ui.renderNeeds(panel, snapshot);
    assert.equal(panel.hidden, false);
    assert.match(text(list.innerHTML), new RegExp(`Move Ava Chen's booking in Square From ${weekday(thu)}, 3:00 pm to ${weekday(tue)}, 5:00 pm, haircut with Maria`));
  });
});

describe("opening rows describe the opening itself", () => {
  const ui = loadStaffScripts();
  const chloe = { ...ben, clientId: "client-3", name: "Chloe Park", service: "color", currentAppointment: undefined };
  const clients = new Map([ava, ben, chloe].map((c) => [c.clientId, c]));

  test("a freed color held for a color client reads as the color it is", () => {
    const held = { ...freed, status: "held", currentOfferId: "offer-1", heldBy: { clientId: "client-3", name: "Chloe Park" }, offers: [{ offerId: "offer-1", outcome: "pending", expiresAt: thu, clientName: "Chloe Park" }] };
    const html = text(ui.openingRow(held, { ...snapshot, clients: [ava, ben, chloe], openings: [accepted, held] }, clients));
    assert.match(html, /Held for Chloe Park Color with Maria, 2 hr Opened when Ava Chen moved to/);
    assert.doesNotMatch(html, /Haircut with Maria, 2 hr/);
  });

  test("the opening's service, stylist and length are used, never the booked client's request with the opening's length", () => {
    // Even if a row's client wanted something else, the label is the opening's own.
    const bookedColor = { ...freed, status: "booked", bookedFor: { clientId: "client-1", name: "Ava Chen" }, source: { kind: "added-by-staff" } };
    assert.match(text(ui.openingRow(bookedColor, snapshot, clients)), /Booked for Ava Chen Color with Maria, 2 hr/);
    const unheldHaircut = { ...accepted, status: "matching", bookedFor: undefined, freedOpeningId: undefined };
    assert.match(text(ui.openingRow(unheldHaircut, snapshot, clients)), /Haircut with Maria, 45 min/);
  });
});

describe("summaries (real page functions)", () => {
  // The summary functions are extracted from the page scripts (which otherwise wire up the DOM on load).
  function summaries() {
    const context = loadStaffScripts() as unknown as vm.Context;
    const source = (file: string, from: string, to: string) => {
      const js = readFileSync(`public/${file}`, "utf8");
      return js.slice(js.indexOf(from), js.indexOf(to, js.indexOf(from)));
    };
    vm.runInContext(source("openings.js", "function openingsSummary", "let refreshNow"), context);
    vm.runInContext(source("home.js", "function homeSummary", "startPolling("), context);
    return context as unknown as { openingsSummary: (s: object, days: number) => string; homeSummary: (s: object) => string };
  }
  const { openingsSummary, homeSummary } = summaries();
  const plain = (html: string) => html.replace(/<\/?b>/g, "");
  const held = { status: "held" }, waiting = { status: "matching", waitingForAvailableClient: true }, booked = { status: "booked", recordedInSquare: true };
  const noneFits = { status: "unfilled", unfilledReason: "no-one-fits" }, notAccepted = { status: "unfilled", unfilledReason: "no-one-accepted" };
  const openings = (...list: object[]) => ({ openings: list });

  test("a waiting opening is counted, with correct grammar", () => {
    assert.equal(plain(openingsSummary(openings(held, waiting), 1)), "Two openings across one day. One is held, and one is waiting for an eligible client.");
    assert.equal(plain(openingsSummary(openings(held, waiting, { ...waiting }), 1)), "Three openings across one day. One is held, and two are waiting for an eligible client.");
    assert.equal(plain(openingsSummary(openings(waiting), 1)), "One opening across one day. One is waiting for an eligible client.");
    assert.equal(plain(openingsSummary(openings(held, booked, waiting, noneFits), 2)),
      "Four openings across two days. One is held, one is booked, one is waiting for an eligible client, and one has no one on the waitlist who fits.");
    assert.equal(plain(homeSummary(openings(held, waiting))), "One opening is held for someone. One opening is waiting for an eligible client.");
  });

  test("an opening with only staff-includable candidates is 'no automatic match', not 'no one fits'", () => {
    const noAutoMatch = { ...noneFits, includeCandidates: [{ clientId: "client-2", name: "Noor Haddad", prefers: "Maria" }] };
    assert.equal(plain(openingsSummary(openings(held, noAutoMatch), 1)), "Two openings across one day. One is held, and one has no automatic match.");
    assert.equal(plain(openingsSummary(openings(held, noAutoMatch, noneFits), 1)),
      "Three openings across one day. One is held, one has no automatic match, and one has no one on the waitlist who fits.");
    assert.equal(plain(homeSummary(openings(held, noAutoMatch))), "One opening is held for someone. One has no automatic match.");
  });

  test("existing summaries are unchanged", () => {
    assert.equal(plain(openingsSummary(openings(held, booked), 1)), "Two openings across one day. One is held, one is booked.");
    assert.equal(plain(openingsSummary(openings(held, noneFits), 1)), "Two openings across one day. One is held, and one has no one on the waitlist who fits.");
    assert.equal(plain(openingsSummary(openings(held, notAccepted), 2)), "Two openings across two days. One is held, and no one who fits accepted the other.");
    assert.equal(plain(homeSummary(openings(held, noneFits))), "One opening is held for someone. One has no one on the waitlist who fits.");
  });
});

describe("staff actions UI (real browser scripts)", () => {
  const ui = loadStaffScripts();
  const clients = new Map([ava, ben].map((c) => [c.clientId, c]));

  test("Needs attention: each reminder has the 'Mark as recorded' button with an accessible name", () => {
    const list = { innerHTML: "" };
    ui.renderNeeds({ hidden: true, querySelector: () => list }, snapshot);
    assert.match(list.innerHTML, /data-recorded="opening-8"/);
    assert.match(list.innerHTML, /aria-label="Mark Ava Chen's booking as recorded in Square">Mark as recorded<\/button>/);
  });

  test("Needs attention hides once every reminder is recorded", () => {
    const list = { innerHTML: "" };
    const panel = { hidden: false, querySelector: () => list };
    ui.renderNeeds(panel, { ...snapshot, openings: [{ ...accepted, recordedInSquare: true }, freed] });
    assert.equal(panel.hidden, true);
  });

  test("an opening shows the quiet inclusion line only for candidates, then the history line", () => {
    const unfilled = { ...freed, stylist: "Jo", service: "haircut", durationMin: 45, status: "unfilled", unfilledReason: "no-one-fits", source: { kind: "added-by-staff" },
      includeCandidates: [{ clientId: "client-2", name: "Ben Ortiz", prefers: "Maria" }] };
    const row = ui.openingRow(unfilled, snapshot, clients);
    assert.match(text(row), /No automatic match Haircut with Jo, 45 min Ben Ortiz prefers Maria Include for this opening/);
    assert.doesNotMatch(text(row), /No one on the waitlist fits/, "never contradicted by an include option");
    assert.match(row, /data-include="opening-9" data-client="client-2"/);
    const plain = text(ui.openingRow({ ...unfilled, includeCandidates: undefined }, snapshot, clients));
    assert.doesNotMatch(plain, /Include for this opening/);
    assert.match(plain, /^.*No one on the waitlist fits/, "no candidates at all");
    const included = { ...unfilled, status: "held", includeCandidates: undefined, heldBy: { clientId: "client-2", name: "Ben Ortiz" }, currentOfferId: "o1",
      offers: [{ offerId: "o1", outcome: "pending", expiresAt: thu, clientName: "Ben Ortiz" }], inclusions: [{ clientId: "client-2", clientName: "Ben Ortiz", at: tue }] };
    assert.match(text(ui.openingRow(included, snapshot, clients)), /Ben Ortiz included by staff · 5:00 pm/);
  });

  test("approved copy: the panel note and the front-desk summary", () => {
    for (const page of ["index.html", "openings.html"]) {
      assert.match(readFileSync(`public/${page}`, "utf8"), /Juniper can't see Square\. Mark each one when it's done\./);
    }
    const home = readFileSync("public/home.js", "utf8");
    assert.match(home, /to record in Square\.`/);
    assert.doesNotMatch(home, /if not already done/);
  });
});
