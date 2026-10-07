// Shared domain types for the Juniper Salon waitlist.
// Terminology follows Lena: openings, offers, waitlist, stylists, clients.

export const WORKFLOW_ID = "juniper-waitlist";
export const TASK_QUEUE = "juniper-waitlist";

export type ServiceId = "haircut" | "color" | "blowout";

// "Requires" and "prefers" are both matched only to that stylist automatically.
// Offering a "prefers" client someone else is a staff decision (later slice).
export type StylistPreference =
  | { kind: "any" }
  | { kind: "prefers"; stylist: string }
  | { kind: "requires"; stylist: string };

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, salon time

export type WeeklyWindow = {
  weekday: Weekday;
  start: string; // "09:00", salon time
  end: string; // "17:00", salon time
};

export type Client = {
  clientId: string;
  seq: number;
  name: string;
  mobile: string;
  service: ServiceId;
  stylistPreference: StylistPreference;
  availability: WeeklyWindow[];
  joinedAt: string; // ISO
  status: "waiting" | "booked";
  // The client's existing appointment (A4: at most one). Only strictly earlier openings are offered (I20).
  // After a successful acceptance it becomes the accepted slot.
  currentAppointment?: Appointment;
  // Set when accepting moved an existing appointment: where they moved from, and the opening it became.
  movedFrom?: { start: string; service: ServiceId; stylist: string; durationMin: number; freedOpeningId: string };
};

/**
 * An existing appointment, as staff copied it from Square: enough to recreate the slot it vacates
 * (A3), plus the salon-local facts and calendar the API resolved when it was entered (A5).
 */
export type Appointment = {
  start: string; // ISO
  service: ServiceId;
  stylist: string;
  durationMin: number;
  local: OpeningLocal;
  calendar: SalonDay[];
};

export type OfferOutcome = "pending" | "accepted" | "declined" | "expired";

export type Offer = {
  offerId: string;
  openingId: string;
  clientId: string;
  offeredAt: string; // ISO
  expiresAt: string; // ISO; the authority for lateness (a reply at or after it is late)
  outcome: OfferOutcome;
  resolvedAt?: string; // for "expired", this is expiresAt
};

export type OpeningStatus = "matching" | "held" | "booked" | "unfilled";

/** The opening's start in salon-local terms, resolved by the API (outside the Workflow). */
export type OpeningLocal = {
  date: string; // "2026-10-06", salon calendar date
  weekday: Weekday; // 0 = Sunday, salon time
  minutes: number; // minutes after salon-local midnight
};

/**
 * One salon calendar day as absolute UTC instants (epoch ms), resolved by the API from the
 * configured time zone and weekly hours. The Workflow only compares these numbers.
 */
export type SalonDay = {
  date: string; // salon calendar date
  startsAt: number; // salon-local midnight
  endsAt: number; // next salon-local midnight (23 or 25 hours later across a DST change)
  opensAt: number | null; // null when the salon is closed that day
  closesAt: number | null;
};

export type Opening = {
  openingId: string;
  seq: number;
  start: string; // ISO
  local: OpeningLocal;
  calendar: SalonDay[]; // contiguous salon days from before creation through the opening's date
  stylist: string;
  durationMin: number;
  status: OpeningStatus;
  offerIds: string[];
  currentOfferId?: string;
  bookedClientId?: string;
  bookedOfferId?: string;
  recordedInSquare: boolean; // reminder only; the prototype never writes to Square
  recordedInSquareAt?: string; // when staff marked the Square reminder done (no undo: a prototype limitation)
  // "Prefers" clients staff included case by case for THIS opening. Inclusion relaxes only
  // the preferred-stylist mismatch; every other rule still applies. Also the opening's history.
  inclusions?: { clientId: string; at: string }[];
  source: OpeningSource;
  // The opening's service (R1/I3: a client must want it). Staff choose it; a freed opening inherits the
  // vacated appointment's (A3). Optional only for openings recorded before service matching existed.
  service?: ServiceId;
  freedOpeningId?: string; // on a booked opening: the opening its client's old appointment became
  createdAt: string;
  closedAt?: string;
  // Why an opening ended unfilled.
  unfilledReason?: UnfilledReason;
  // A-WAIT: someone fits, but everyone who fits currently holds another offer. The opening
  // stays active ("matching") and is re-evaluated when state changes. Not a new status.
  waitingForAvailableClient?: boolean;
};

export type UnfilledReason =
  | "no-one-fits" // no eligible client ever existed
  | "everyone-passed" // every eligible client explicitly said no
  | "no-one-accepted" // at least one didn't reply in time, and nobody accepted
  | "too-late"; // the appointment start had passed: no offer is issued (A4)

/** Salon hours for one weekday ("09:00" to "19:00", salon time), or null when closed. API-side only. */
export type DayHours = { opens: string; closes: string } | null;
export type WeeklyHours = Record<Weekday, DayHours>;

/**
 * The Workflow's policy: passed in as Workflow input (recorded in history), never read from disk.
 * Contains no time-zone rules: `timeZone` is only handed back to the browser for display.
 * Salon hours reach the Workflow per opening, as resolved calendar instants.
 */
/** Where an opening came from. Freed openings record who moved and which opening they moved to. */
export type OpeningSource =
  | { kind: "added-by-staff" }
  | { kind: "freed"; fromClientId: string; movedToOpeningId: string };

export type OfferPolicy = {
  timeZone: string; // IANA zone name, for display only; never interpreted inside the Workflow
  sameDayReplyMs: number; // Lena: 15 minutes
  minLaterReplyMs: number; // A1: "too close to closing" = less than this before closing
  serviceMinutes: Record<ServiceId, number>;
};

export type SalonInput = { policy: OfferPolicy };

// ---- Update inputs ----

export type NewClientInput = {
  name: string;
  mobile: string;
  service: ServiceId;
  stylistPreference: StylistPreference;
  availability: WeeklyWindow[];
  joinedAt?: string; // staff may copy the date from the existing sheet
  currentAppointment?: Appointment; // resolved by the API (local facts and calendar), recorded as Update input
};

export type NewOpeningInput = {
  start: string; // ISO
  service: ServiceId;
  stylist: string;
  durationMin: number;
  // Resolved by the API from the salon's time zone and hours; recorded in history as Update input.
  local: OpeningLocal;
  calendar: SalonDay[];
};

export type RespondInput = {
  offerId: string;
  answer: "accept" | "decline";
};

// ---- Views returned by Updates and Queries ----

export type PersonRef = { clientId: string; name: string };

export type OfferView = Offer & { clientName: string };

export type OpeningView = Omit<Opening, "calendar" | "inclusions"> & {
  offers: OfferView[];
  heldBy?: PersonRef;
  bookedFor?: PersonRef;
  inclusions?: { clientId: string; clientName: string; at: string }[];
  // Clients who fail ONLY because they prefer another stylist: staff may include them.
  includeCandidates?: (PersonRef & { prefers: string })[];
};

export type ClientView = Omit<Client, "currentAppointment"> & {
  serviceMinutes: number;
  currentAppointment?: Omit<Appointment, "calendar">; // views never carry recorded calendars
};

export type SalonSnapshot = {
  openings: OpeningView[];
  clients: ClientView[];
  timeZone: string;
};

export type ClientOfferView = {
  offerId: string;
  outcome: OfferOutcome;
  firstName: string;
  service: ServiceId;
  serviceMinutes: number;
  opening: Pick<Opening, "openingId" | "start" | "stylist" | "status">;
  expiresAt: string;
  bookedByThisOffer: boolean;
  // The client's existing appointment, if accepting would move it (before acceptance).
  currentAppointment?: { start: string; service: ServiceId; stylist: string };
  // Where this offer's booking moved the client from (after acceptance).
  movedFrom?: { start: string; service: ServiceId; stylist: string };
  timeZone: string;
};

export type RespondResult = {
  outcome:
    | "booked"
    | "declined"
    | "already-booked"
    | "already-declined"
    | "no-longer-available"
    | "already-reserved"; // the client already accepted another offer; nothing booked or freed
  opening: OpeningView;
  freedOpening?: OpeningView; // the opening the client's old appointment became, created atomically
};

export const DEFAULT_SERVICE_MINUTES: Record<ServiceId, number> = {
  haircut: 45,
  blowout: 45,
  color: 120,
};
