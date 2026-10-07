# Requirements coverage

There's no separate grading rubric. This matrix covers:
- the assessment and starter requirements
- the rules the salon owner (the customer) confirmed in discovery
- the prototype assumptions this build adopted where the customer didn't specify

**Source and status key:**

| Label | Meaning |
|---|---|
| **Assessment** | Required by the assessment or starter |
| **Customer** | Confirmed by the salon owner |
| **Assumption** | A prototype decision, not customer-confirmed |
| **Simulated** | Integration stand-in |
| **Out of scope** | Deliberately not built |

**Test files:** `matching` = `tests/matching.test.ts`, `workflow` = `tests/workflow.test.ts`, `reply` = `tests/replyWindow.test.ts`, `alloc` = `tests/allocation.test.ts`, `determinism` = `tests/determinism.test.ts`, `ui` = `tests/ui.test.ts`, `frontDesk` = `tests/frontDesk.test.ts`.

## Assessment deliverables

| Requirement | Source / status | Implementation | Verification |
|---|---|---|---|
| Working Temporal application replacing the starter demo (API, Worker, browser UI) | Assessment | `src/workflows.ts`, `src/worker.ts`, `src/api.ts`, `public/` | `npm run dev`; `npm test` (Workflow tests on `TestWorkflowEnvironment.createLocal()`) |
| A new **public**, non-fork repository | Assessment | This repository | Repository page (Public, not "forked from") |
| `evidence/`: a Web UI screenshot showing Workflow ID, status and meaningful history, with no real personal data | Assessment | `evidence/` | `evidence/temporal-workflow-history.png` (fictional data) |

## Matching and offers

| Requirement | Source / status | Implementation | Verification |
|---|---|---|---|
| Offer an opening to **one client at a time**; nobody else is offered it while it's held | Customer | Allocation pass gives each opening at most one current offer (`src/allocation.ts`) | workflow: "the earliest eligible client receives the offer…", "simultaneous acceptances produce exactly one booking transition" |
| **Join order**: earliest-joined eligible client first; regulars get no priority | Customer | `orderedEligible` (`src/matching.ts`) | matching: "eligible clients are ordered by join date…"; workflow: "declining … moves the opening to the next client by join date" |
| Eligible only if they want the **service**, it **fits the length**, they're **available**, and the **stylist rule** allows it | Customer | `isEligible` (`src/matching.ts`) | matching: service, length, availability and stylist tests; "a haircut client is not eligible for a color opening…" |
| "**Only with**" a stylist is strict; "**Prefers**" matches that stylist automatically, and others only case by case by staff | Customer | Stylist check in `isEligible` | matching: "a client who only prefers a different stylist is not offered it automatically" |
| **Staff can include** a "Prefers" client for one opening. It relaxes only the stylist mismatch, never service, length, availability, "Only with", an earlier decline or timeout, booked status or a started opening | Customer (case by case) + Assumption (UI and ranking) | `includePreferredClient` Update; `includeProblem` (`src/workflows.ts`) | matching: inclusion tests; workflow: "an unfilled opening that only a 'Prefers' client fits…", "inclusion can't resurrect…" |
| Included clients get **no priority** (normal join order); including never replaces a client holding the offer | Assumption | Allocation pass | matching: "an included client keeps normal join-date order"; workflow: "including while another client holds the offer doesn't replace them…" |
| An opening with no automatic match but includable clients reads **"No automatic match"**, not "No one on the waitlist fits" | Assumption (presentation) | `public/staff.js` | ui: "an opening with only staff-includable candidates is 'no automatic match'…" |

## Replies, deadlines and timeouts

| Requirement | Source / status | Implementation | Verification |
|---|---|---|---|
| Client can **accept or decline** from the offer | Customer | `respondToOffer` Update; `public/offer.*` | workflow: accept and decline tests |
| A **decline** keeps them on the waitlist, skips them for **that** opening only, and moves to the next client | Customer | Per-opening skip in the allocation pass | workflow: "a client who declined is never offered that same opening again…", "…still offered other openings" |
| **No reply** in time: the same as a decline for that opening; they stay on the waitlist | Customer | `expireOffer`; per-opening skip | workflow: "no reply before the deadline: the offer expires…", "a client who timed out on one opening is still offered other openings" |
| **Same-day** opening: the offer expires **15 minutes** after it's sent | Customer | `offerExpiresAt` (`src/replyWindow.ts`); `config/salon.json` | reply: "same-day opening: expires 15 minutes after the offer is sent"; live evidence (a real 15-minute timer) |
| **Later-day** opening: expires at **closing time** on the send day; if sent near or after closing, at the **next opening time**; **never past the appointment start** | Customer | `offerExpiresAt` | reply: closing, next-morning and start-cap tests |
| "Too close to closing" means under 15 minutes; "next morning" skips closed days; no offer once the start has passed | Assumption | `offerExpiresAt` | reply: A1, A2, A4 tests |
| Salon **hours vary** by day; a named **time zone**, correct across daylight saving | Customer (hours vary) + Assumption (sample hours and zone) | `config/salon.json`; `src/salonCalendar.ts` | reply: "closing time varies by day…", "deadlines across the daylight-saving change…" |
| A **durable** deadline that survives restarts | Assessment (Temporal) | One Temporal timer per offer (`condition` with timeout) | Event History: `TimerStarted` / `TimerFired` (evidence) |
| A reply **at or after** the deadline is late, whether or not the timer has fired | Assumption (correctness) | `isLate` checked first in `respondToOffer` | reply: "a reply exactly at expiresAt is late…"; workflow: "the deadline decides lateness even if the reply is processed before the timer" |
| Repeated or conflicting replies are deterministic (decline twice, accept after decline, decline after booking, simultaneous replies) | Assumption (correctness) | `respondToOffer` outcomes | workflow: "declining twice…", "accepting after declining…", "a simultaneous accept and decline…" |
| The client sees a **written deadline**, no countdown | Assumption (design) | `public/offer.js` | Screenshot `evidence/client-offer-phone.png` |

## Booking, moves and staff follow-up

| Requirement | Source / status | Implementation | Verification |
|---|---|---|---|
| An accepted opening is **reserved immediately** and can't be given to anyone else | Customer | Accept transition in `respondToOffer` | workflow: "a second acceptance cannot claim an already-booked opening…" |
| A client with a **current appointment** is only offered **earlier** openings | Customer | Check in `isEligible` | matching: "an opening at exactly the current appointment time is not offered"… |
| Accepting **moves** the appointment; the old slot becomes a **new opening** through the same process, never offered back to the mover | Customer | Same handler creates the freed opening via `addOpening` | workflow: "accepting an earlier opening … frees the old appointment exactly once…", "…never offered to the client who moved", cascade test |
| The freed opening copies the old appointment's service, stylist, length and start | Assumption | `Appointment` on the client | workflow: same test; "service eligibility is the same for staff-added and freed openings" |
| Client confirmation for a move says the time is **reserved** and that the salon is **updating Square** (not "fully confirmed") | Customer | `public/offer.js` | Screenshot `evidence/client-reserved-phone.png` |
| **One pending offer per client**; an opening whose only fitting clients are busy **waits** and is re-evaluated | Assumption | Allocation pass; ownership derived from pending offers | alloc: all; workflow: one-pending-offer scenarios (the invariant is checked after each transition) |
| When one client fits several openings, the **earlier-created** opening wins | Assumption | Allocation order | alloc: "the result doesn't depend on the order…"; workflow: "two openings created at the same moment…" |
| Staff are reminded to **record or move bookings in Square**, and can **mark them done** | Customer (staff update Square) + Assumption (mark done, no undo) | Needs attention; `markRecordedInSquare` | workflow: "Mark as recorded clears only that reminder…"; ui: Needs attention tests |
| A **front desk** that shows only when something is active or needs attention; otherwise go to Openings | Customer | `src/frontDesk.ts`; `GET /` | frontDesk: all |

## Reliability and determinism

| Requirement | Source / status | Implementation | Verification |
|---|---|---|---|
| Workflow code is deterministic under replay (no runtime time-zone data in the Workflow) | Assessment (Temporal correctness) | Time-zone facts resolved in the API and recorded as Update input | determinism: bundle test; reply: "deadlines use only the recorded calendar…" |
| Behavior changes are compatible with recorded histories | Assessment (Temporal correctness) | `patched("service-eligibility")`, `patched("one-pending-offer")` | determinism: five captured live histories replay; removing either gate makes older ones fail |
| A running salon can't silently keep a stale policy (for example a demo reply window) | Assumption (operations) | `src/salonGuard.ts` | workflow: "the startup guard detects a running salon whose reply window differs…" |

## Simulated, and out of scope

| Item | Status |
|---|---|
| Text messages to clients (the offer link is opened directly) | Simulated |
| Square calendar (never read or written; staff update it and mark the reminder done) | Simulated |
| Add-client form (sample waitlist and `POST /api/clients` only) | Out of scope |
| Cancel opening; edit or remove client; client cancels after booking; undo "recorded" | Out of scope |
| Real salon hours and time zone (sample values in `config/salon.json`) | Assumption, to replace |

## Rule tags used in code comments and test names

| Tag | Meaning | Source |
|---|---|---|
| R1, I3 | Eligibility: wants the service, length fits, available, stylist rule | Customer |
| R9 | Accepting moves an existing appointment; the old slot becomes a new opening | Customer |
| I1, I2, I8 | One booking per opening; only the opening's current pending offer can be answered | Customer (no double promises) |
| I4 | Join order among eligible clients | Customer |
| I15 | Reply windows (same day, later day, start cap) | Customer |
| I16 | A freed opening is never offered to the client who vacated it | Customer |
| I19 | A decline or no-reply skips the client for that opening only | Customer |
| I20 | Only openings earlier than the client's current appointment | Customer |
| I17, A-I17 | At most one pending offer per client | Assumption |
| A-ORDER | Contested client: the earlier-created opening wins, then join order | Assumption |
| A-WAIT | An opening whose fitting clients are all busy waits instead of closing | Assumption |
| A1 | "Too close to closing" means under 15 minutes | Assumption |
| A2 | "Next morning" means the next day the salon opens; an appointment that has already started frees nothing | Assumption |
| A3 | Sample salon hours and time zone; a freed opening copies the old appointment | Assumption |
| A4 | No offer once the opening's start has passed | Assumption |
| A5 | Recorded calendar facts stay authoritative if hours change later | Assumption (limitation) |
