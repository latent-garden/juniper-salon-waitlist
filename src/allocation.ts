// One deterministic allocation pass (one pending offer per client, I17). Pure: no Temporal imports, no clock reads, no
// time-zone work. The Workflow's main loop runs it whenever state that affects eligibility or offer
// ownership changes, and applies the decisions.
//
// Prototype assumptions [A], not customer-confirmed:
// - A-I17: a client has at most one pending offer at a time. Ownership is DERIVED from offers whose
//   outcome is "pending"; there is no separate client→offer map that could go stale.
// - A-ORDER: openings are allocated in stable creation order (seq); candidates in join order
//   (orderedEligible). The earlier-created opening gets a contested client. No other priority.
// - A-WAIT: a client who fits but already holds a pending offer is temporarily UNAVAILABLE, not
//   ineligible. An opening whose fitting clients are all busy waits; it is not unfilled.
import { orderedEligible, type MatchOptions } from "./matching";
import { offerExpiresAt } from "./replyWindow";
import type { Client, Offer, OfferPolicy, Opening, UnfilledReason } from "./types";

export type AllocationDecision =
  | { openingId: string; kind: "offer"; clientId: string; expiresAt: string }
  | { openingId: string; kind: "wait" } // someone fits, but everyone who fits holds another offer
  | { openingId: string; kind: "close"; reason: UnfilledReason };

/** Why an opening that was offered to some clients ends with nobody left. */
export function unfilledReasonFor(earlier: Offer[]): UnfilledReason {
  if (earlier.length === 0) return "no-one-fits";
  return earlier.some((o) => o.outcome === "expired") ? "no-one-accepted" : "everyone-passed";
}

/**
 * Decides, for every opening that needs a client (status "matching", no current offer), whether to
 * offer it, wait, or close it. The result depends only on the inputs' contents, never on the order
 * of the collections passed in.
 */
export function allocateOffers(input: {
  openings: Opening[];
  clients: Client[];
  offers: Offer[];
  policy: OfferPolicy;
  now: string; // the Workflow's time: each offer's send time
  matchOptions: MatchOptions;
}): AllocationDecision[] {
  const offersById = new Map(input.offers.map((o) => [o.offerId, o]));
  // Busy = owns a pending offer anywhere, plus anyone claimed earlier in this same pass.
  const busy = new Set(input.offers.filter((o) => o.outcome === "pending").map((o) => o.clientId));
  const decisions: AllocationDecision[] = [];

  for (const opening of [...input.openings].sort((a, b) => a.seq - b.seq)) {
    const expiresAt = offerExpiresAt(input.now, opening, input.policy);
    if (expiresAt === null) {
      decisions.push({ openingId: opening.openingId, kind: "close", reason: "too-late" }); // A4
      continue;
    }
    // Per-opening skips, exactly as before: everyone already offered this opening (I19), and the
    // client who vacated a freed opening (I16).
    const earlier = opening.offerIds.map((id) => offersById.get(id)!);
    const skip = new Set(earlier.map((o) => o.clientId));
    if (opening.source.kind === "freed") skip.add(opening.source.fromClientId);

    const fitting = orderedEligible(input.clients, opening, input.policy, skip, input.matchOptions);
    const available = fitting.find((c) => !busy.has(c.clientId));
    if (available) {
      busy.add(available.clientId);
      decisions.push({ openingId: opening.openingId, kind: "offer", clientId: available.clientId, expiresAt });
    } else if (fitting.length > 0) {
      decisions.push({ openingId: opening.openingId, kind: "wait" });
    } else {
      decisions.push({ openingId: opening.openingId, kind: "close", reason: unfilledReasonFor(earlier) });
    }
  }
  return decisions;
}
