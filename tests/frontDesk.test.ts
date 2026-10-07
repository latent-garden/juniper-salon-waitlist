import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shouldShowFrontDesk } from "../src/frontDesk";

const opening = (status: "matching" | "held" | "booked" | "unfilled", recordedInSquare = false) => ({ status, recordedInSquare });

describe("front desk or redirect to Openings", () => {
  test("shows the front desk when an opening is held for someone", () => {
    assert.equal(shouldShowFrontDesk({ openings: [opening("held")] }), true);
  });

  test("shows the front desk when no one on the waitlist fits an opening", () => {
    assert.equal(shouldShowFrontDesk({ openings: [opening("unfilled")] }), true);
  });

  test("shows the front desk when an opening is still being matched", () => {
    assert.equal(shouldShowFrontDesk({ openings: [opening("matching")] }), true);
  });

  test("shows the front desk for a booked opening surfaced as a Square reminder", () => {
    assert.equal(shouldShowFrontDesk({ openings: [opening("booked", false)] }), true);
  });

  test("redirects when every opening is booked and marked recorded in Square", () => {
    assert.equal(shouldShowFrontDesk({ openings: [opening("booked", true), opening("booked", true)] }), false);
  });

  test("redirects when there are no openings", () => {
    assert.equal(shouldShowFrontDesk({ openings: [] }), false);
  });
});
