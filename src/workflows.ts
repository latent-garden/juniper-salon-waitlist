import { condition, defineQuery, defineUpdate, patched, setHandler, uuid4 } from "@temporalio/workflow";
import { isEligible, orderedEligible } from "./matching";
import { calendarProblem, isLate, offerExpiresAt } from "./replyWindow";
import { allocateOffers } from "./allocation";
import type {
  Appointment,
  Client,
  ClientOfferView,
  ClientView,
  NewClientInput,
  NewOpeningInput,
  Offer,
  OfferPolicy,
  Opening,
  OpeningStatus,
  OpeningSource,
  OpeningView,
  PersonRef,
  RespondInput,
  RespondResult,
  SalonInput,
  SalonSnapshot,
  ServiceId,
  UnfilledReason,
} from "./types";

// One long-lived Workflow owns the salon's waitlist, openings and offers
// (approved Architecture B). Update handlers only inspect state, apply one
// atomic transition and return; offering and waiting happen in runOpening.

export const addClient = defineUpdate<ClientView, [NewClientInput]>("addClient");
export const createOpening = defineUpdate<OpeningView, [NewOpeningInput]>("createOpening");
export const respondToOffer = defineUpdate<RespondResult, [RespondInput]>("respondToOffer");
export const getSnapshot = defineQuery<SalonSnapshot>("getSnapshot");
export const getOffer = defineQuery<ClientOfferView | null, [string]>("getOffer");
export const getPolicy = defineQuery<OfferPolicy>("getPolicy");
export const includePreferredClient = defineUpdate<OpeningView, [{ openingId: string; clientId: string }]>("includePreferredClient");
export const markRecordedInSquare = defineUpdate<OpeningView, [{ openingId: string }]>("markRecordedInSquare");

const SERVICES: ServiceId[] = ["haircut", "color", "blowout"];
const CLOCK = /^\d{2}:\d{2}$/;

export async function salonWaitlistWorkflow({ policy }: SalonInput): Promise<void> {
  const clients = new Map<string, Client>();
  const openings = new Map<string, Opening>();
  const offers = new Map<string, Offer>();
  const openingsToStart: string[] = [];
  // Bumped by every change that can free a client or make one newly eligible (a client
  // joins, an offer is declined, accepted or expires). The main loop re-runs the allocation pass
  // when it changes; openings waiting for a busy client are re-evaluated there.
  let revision = 0;
  let allocatedRevision = 0;
  const changed = () => void revision++;
  let nextSeq = 1;

  const now = () => new Date().toISOString();

  const clientView = ({ currentAppointment, ...client }: Client): ClientView => {
    const view: ClientView = { ...client, serviceMinutes: policy.serviceMinutes[client.service] };
    if (currentAppointment) {
      const { calendar: _calendar, ...appointment } = currentAppointment;
      view.currentAppointment = appointment;
    }
    return view;
  };

  const personRef = (clientId: string | undefined) => {
    const client = clientId ? clients.get(clientId) : undefined;
    return client ? { clientId: client.clientId, name: client.name } : undefined;
  };

  const openingView = (full: Opening): OpeningView => {
    const { calendar: _calendar, inclusions, ...opening } = full;
    const current = opening.currentOfferId ? offers.get(opening.currentOfferId) : undefined;
    const candidates = includeCandidates(full);
    return {
      ...opening,
      ...(inclusions ? { inclusions: inclusions.map((i) => ({ ...i, clientName: clients.get(i.clientId)?.name ?? "" })) } : {}),
      ...(candidates.length ? { includeCandidates: candidates } : {}),
      offerIds: [...opening.offerIds],
      offers: opening.offerIds.map((offerId) => {
        const offer = offers.get(offerId)!;
        return { ...offer, clientName: clients.get(offer.clientId)?.name ?? "" };
      }),
      heldBy: opening.status === "held" ? personRef(current?.clientId) : undefined,
      bookedFor: personRef(opening.bookedClientId),
    };
  };

  /**
   * The one expiry transition, shared by the timer path and the reply handler. Idempotent:
   * an offer that's no longer pending is left alone, so it can expire exactly once.
   */
  function expireOffer(offer: Offer): void {
    if (offer.outcome !== "pending") return;
    offer.outcome = "expired";
    offer.resolvedAt = offer.expiresAt; // recorded at the deadline, not when it was noticed
    const opening = openings.get(offer.openingId)!;
    if (opening.currentOfferId === offer.offerId) {
      opening.currentOfferId = undefined;
      opening.status = "matching"; // the opening moves on to the next eligible client
    }
    changed(); // the client is free again
  }

  const copyAppointment = (a: Appointment): Appointment => ({
    start: new Date(a.start).toISOString(),
    service: a.service,
    stylist: a.stylist.trim(),
    durationMin: a.durationMin,
    local: { ...a.local },
    calendar: a.calendar.map((day) => ({ ...day })),
  });

  /** Checks a slot (opening or appointment) and its recorded salon-local facts and calendar. */
  function slotProblem(slot: Pick<Opening, "start" | "stylist" | "durationMin" | "local" | "calendar">): string | null {
    if (Number.isNaN(Date.parse(slot.start))) return "The opening needs a valid start.";
    if (!slot.stylist?.trim()) return "The opening needs a stylist.";
    if (!Number.isInteger(slot.durationMin) || slot.durationMin <= 0) return "The opening needs a length in minutes.";
    const local = slot.local;
    if (!local || !(local.weekday >= 0 && local.weekday <= 6) || !(local.minutes >= 0 && local.minutes < 1440)) {
      return "The opening needs its salon-local day and time.";
    }
    return calendarProblem({ start: new Date(slot.start).toISOString(), local, calendar: slot.calendar });
  }

  /**
   * The one way an opening comes into being: staff-added (createOpening) or freed by a client who
   * moved earlier (accept). Both get an ID from the same sequence, their own history, and the same
   * orchestration: runOpening picks them up from openingsToStart.
   */
  function addOpening(
    slot: Pick<Opening, "start" | "stylist" | "durationMin" | "local" | "calendar"> & { service?: ServiceId },
    source: OpeningSource,
  ): Opening {
    const seq = nextSeq++;
    const opening: Opening = {
      openingId: `opening-${seq}`,
      seq,
      start: new Date(slot.start).toISOString(),
      // Salon-local facts and calendar instants, resolved by the API and recorded as Update input.
      local: { ...slot.local },
      calendar: slot.calendar.map((day) => ({ ...day })),
      stylist: slot.stylist.trim(),
      durationMin: slot.durationMin,
      status: "matching",
      offerIds: [],
      recordedInSquare: false,
      source,
      createdAt: now(),
    };
    if (slot.service) opening.service = slot.service;
    openings.set(opening.openingId, opening);
    openingsToStart.push(opening.openingId); // offering happens in orchestration
    return opening;
  }

  /**
   * Why `client` can't be included for `opening`, or null if they can. Inclusion relaxes
   * ONLY the preferred-stylist mismatch: the client must otherwise be eligible right now (service,
   * length, availability, earlier-than-appointment, waiting), not already offered this opening
   * (declined or timed out), not the freed slot's mover, and the opening must not be booked or started.
   * Holding another pending offer doesn't block inclusion; the allocator treats them as busy.
   */
  function includeProblem(opening: Opening, client: Client): string | null {
    if (opening.status === "booked") return "This opening is already booked.";
    if (!(Date.parse(opening.start) > Date.now())) return "This opening has already started.";
    if (client.status !== "waiting") return "This client is no longer waiting.";
    const pref = client.stylistPreference;
    if (pref.kind !== "prefers") return "Only a client who prefers another stylist can be included.";
    if (pref.stylist === opening.stylist) return "This client already matches this stylist.";
    if (opening.inclusions?.some((i) => i.clientId === client.clientId)) return "Already included for this opening.";
    if (opening.offerIds.some((id) => offers.get(id)!.clientId === client.clientId)) return "This client was already offered this opening.";
    if (opening.source.kind === "freed" && opening.source.fromClientId === client.clientId) return "This client vacated this opening.";
    const withInclusion = { ...opening, inclusions: [...(opening.inclusions ?? []), { clientId: client.clientId, at: "" }] };
    if (!isEligible(client, withInclusion, policy)) return "This client doesn't fit this opening apart from the stylist.";
    return null;
  }

  function includeCandidates(opening: Opening): (PersonRef & { prefers: string })[] {
    return [...clients.values()]
      .filter((c) => includeProblem(opening, c) === null)
      .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.seq - b.seq)
      .map((c) => ({ clientId: c.clientId, name: c.name, prefers: (c.stylistPreference as { stylist: string }).stylist }));
  }

  // ---- Updates ----

  setHandler(
    addClient,
    (input) => {
      const seq = nextSeq++;
      const client: Client = {
        clientId: `client-${seq}`,
        seq,
        name: input.name.trim(),
        mobile: input.mobile.trim(),
        service: input.service,
        stylistPreference: input.stylistPreference,
        availability: input.availability,
        joinedAt: input.joinedAt ?? now(),
        status: "waiting",
        // Resolved by the API (salon-local facts and calendar) and recorded here as Update input.
        currentAppointment: input.currentAppointment && copyAppointment(input.currentAppointment),
      };
      if (!client.currentAppointment) delete client.currentAppointment;
      clients.set(client.clientId, client);
      changed(); // waiting openings may now have someone
      return clientView(client);
    },
    {
      validator: (input) => {
        if (!input.name?.trim()) throw new Error("A client needs a name.");
        if (!input.mobile?.trim()) throw new Error("A client needs a mobile number.");
        if (!SERVICES.includes(input.service)) throw new Error(`Unknown service: ${input.service}`);
        const pref = input.stylistPreference;
        if (pref?.kind !== "any" && !(pref?.kind === "prefers" || pref?.kind === "requires")) {
          throw new Error("Unknown stylist preference.");
        }
        if (pref.kind !== "any" && !pref.stylist?.trim()) throw new Error("Name the stylist.");
        if (!Array.isArray(input.availability) || input.availability.length === 0) {
          throw new Error("A client needs at least one time they're free.");
        }
        for (const w of input.availability) {
          if (!(w.weekday >= 0 && w.weekday <= 6) || !CLOCK.test(w.start) || !CLOCK.test(w.end)) {
            throw new Error("Availability needs a weekday and times like 09:00.");
          }
        }
        if (input.joinedAt !== undefined && Number.isNaN(Date.parse(input.joinedAt))) {
          throw new Error("Joined date is not a valid date.");
        }
        const appointment = input.currentAppointment;
        if (appointment !== undefined) {
          if (!SERVICES.includes(appointment.service)) throw new Error("The current appointment needs a known service.");
          const problem = slotProblem(appointment);
          if (problem) throw new Error(`Current appointment: ${problem}`);
          if (!(Date.parse(appointment.start) > Date.now())) throw new Error("The current appointment must be in the future.");
        }
      },
    },
  );

  setHandler(
    createOpening,
    (input) => openingView(addOpening(input, { kind: "added-by-staff" })),
    {
      validator: (input) => {
        if (!SERVICES.includes(input.service)) throw new Error("The opening needs a service.");
        const problem = slotProblem(input);
        if (problem) throw new Error(problem);
      },
    },
  );

  setHandler(
    respondToOffer,
    ({ offerId, answer }): RespondResult => {
      const offer = offers.get(offerId)!;
      const opening = openings.get(offer.openingId)!;
      const result = (outcome: RespondResult["outcome"]): RespondResult => ({ outcome, opening: openingView(opening) });

      // Repeated or conflicting replies to an offer that's already answered change nothing.
      if (offer.outcome === "accepted") return result("already-booked"); // yes twice, or no after yes
      if (offer.outcome === "declined") {
        return result(answer === "decline" ? "already-declined" : "no-longer-available"); // no twice, or yes after no
      }
      if (offer.outcome === "expired") return result("no-longer-available");
      // The deadline decides lateness, whether or not the timer has fired yet. Exactly at expiresAt is late.
      if (isLate(Date.now(), offer.expiresAt)) {
        expireOffer(offer);
        return result("no-longer-available");
      }
      // Only the opening's current pending offer can be answered (I1, I2, I8).
      if (opening.status !== "held" || opening.currentOfferId !== offerId) return result("no-longer-available");
      const client = clients.get(offer.clientId)!;
      // A client who already accepted another offer can't accept a second one. Checked before
      // anything changes, so nothing is booked or freed twice. With one pending offer per client
      // (I17) this can't arise for new offers; it remains as a guard and for older histories.
      if (answer === "accept" && client.status === "booked") return result("already-reserved");

      const at = now();
      offer.resolvedAt = at;
      opening.currentOfferId = undefined;

      if (answer === "decline") {
        // The client stays on the waitlist (I19). runOpening advances to the next client.
        offer.outcome = "declined";
        opening.status = "matching";
        changed(); // the client is free again
        return result("declined");
      }

      // Accept: everything below happens in this one synchronous handler, so the booking and the
      // freed opening are never visible apart.
      offer.outcome = "accepted";
      opening.status = "booked";
      opening.bookedClientId = offer.clientId;
      opening.bookedOfferId = offerId;
      opening.closedAt = at;
      client.status = "booked";

      const previous = client.currentAppointment;
      let freed: Opening | undefined;
      if (previous) {
        // R9: the vacated appointment becomes a new opening, built from the appointment itself (A3).
        // A2: an appointment that has already started frees nothing.
        if (Date.parse(previous.start) > Date.parse(at)) {
          freed = addOpening(previous, { kind: "freed", fromClientId: client.clientId, movedToOpeningId: opening.openingId });
          opening.freedOpeningId = freed.openingId;
          client.movedFrom = {
            start: previous.start,
            service: previous.service,
            stylist: previous.stylist,
            durationMin: previous.durationMin,
            freedOpeningId: freed.openingId,
          };
        }
        // Their current appointment is now the slot they just accepted.
        client.currentAppointment = {
          start: opening.start,
          service: client.service,
          stylist: opening.stylist,
          durationMin: policy.serviceMinutes[client.service],
          local: { ...opening.local },
          calendar: opening.calendar.map((day) => ({ ...day })),
        };
      }
      changed(); // the client's pending offer has ended; openings waiting for them re-evaluate
      return { ...result("booked"), ...(freed ? { freedOpening: openingView(freed) } : {}) };
    },
    {
      // Validators reject malformed input only; rejections are not recorded in history.
      validator: ({ offerId, answer }) => {
        if (answer !== "accept" && answer !== "decline") throw new Error(`Unsupported answer: ${answer}`);
        if (!offers.has(offerId)) throw new Error("Unknown offer.");
      },
    },
  );

  setHandler(
    includePreferredClient,
    ({ openingId, clientId }) => {
      const opening = openings.get(openingId)!;
      (opening.inclusions ??= []).push({ clientId, at: now() });
      if (opening.status === "unfilled") {
        // An unfilled opening that hasn't started becomes active again and re-enters the normal
        // allocation pass (its timer driver restarts). The allocator, not this handler, picks the client.
        delete opening.unfilledReason;
        delete opening.closedAt;
        opening.status = "matching";
        openingsToStart.push(opening.openingId);
      }
      // A held opening keeps its current offer (no preemption); the included client joins the
      // normal join-date order for when it ends. Waiting or matching openings re-evaluate now.
      changed();
      return openingView(opening);
    },
    {
      validator: ({ openingId, clientId }) => {
        const opening = openings.get(openingId);
        const client = clients.get(clientId);
        if (!opening) throw new Error("Unknown opening.");
        if (!client) throw new Error("Unknown client.");
        const problem = includeProblem(opening, client);
        if (problem) throw new Error(problem);
      },
    },
  );

  setHandler(
    markRecordedInSquare,
    ({ openingId }) => {
      const opening = openings.get(openingId)!;
      // Idempotent; changes only the reminder state (no booking, matching, offer or allocation change).
      if (!opening.recordedInSquare) {
        opening.recordedInSquare = true;
        opening.recordedInSquareAt = now();
      }
      return openingView(opening);
    },
    {
      validator: ({ openingId }) => {
        const opening = openings.get(openingId);
        if (!opening) throw new Error("Unknown opening.");
        if (opening.status !== "booked") throw new Error("Only a booked opening can be marked as recorded in Square.");
      },
    },
  );

  // ---- Queries ----

  setHandler(getSnapshot, () => ({
    openings: [...openings.values()].map(openingView),
    clients: [...clients.values()].map(clientView),
    timeZone: policy.timeZone,
  }));

  setHandler(getPolicy, () => policy);

  setHandler(getOffer, (offerId) => {
    const offer = offers.get(offerId);
    if (!offer) return null;
    const opening = openings.get(offer.openingId)!;
    const client = clients.get(offer.clientId)!;
    const bookedByThisOffer = opening.bookedOfferId === offerId;
    const brief = (a: { start: string; service: ServiceId; stylist: string }) => ({ start: a.start, service: a.service, stylist: a.stylist });
    // Move context for the client page: what accepting would move (while the offer is open),
    // or what this booking moved them from (after it).
    const moveContext =
      bookedByThisOffer && client.movedFrom && client.movedFrom.freedOpeningId === opening.freedOpeningId
        ? { movedFrom: brief(client.movedFrom) }
        : offer.outcome === "pending" && client.status === "waiting" && client.currentAppointment
          ? { currentAppointment: brief(client.currentAppointment) }
          : {};
    return {
      offerId,
      outcome: offer.outcome,
      firstName: client.name.split(" ")[0],
      service: client.service,
      serviceMinutes: policy.serviceMinutes[client.service],
      opening: {
        openingId: opening.openingId,
        start: opening.start,
        stylist: opening.stylist,
        status: opening.status,
      },
      expiresAt: offer.expiresAt,
      bookedByThisOffer,
      timeZone: policy.timeZone,
      ...moveContext,
    };
  });

  // ---- Orchestration ----

  function closeUnfilled(opening: Opening, reason: UnfilledReason): void {
    delete opening.waitingForAvailableClient;
    opening.status = "unfilled";
    opening.unfilledReason = reason;
    opening.closedAt = now();
  }

  // LEGACY (before one-pending-offer allocation) orchestration, kept unchanged only so histories recorded before the
  // "one-pending-offer" patch replay exactly as they ran: each opening selects for itself.
  async function runOpeningLegacy(openingId: string): Promise<void> {
    const opening = openings.get(openingId)!;
    for (;;) {
      const sentAt = now();
      // Uses this offer's actual send time and only the opening's recorded calendar.
      const expiresAt = offerExpiresAt(sentAt, opening, policy);
      if (expiresAt === null) return closeUnfilled(opening, "too-late"); // A4: the start has passed

      // Everyone already offered this opening declined or didn't reply in time (I19): skip them all.
      const earlier = opening.offerIds.map((id) => offers.get(id)!);
      const offered = new Set(earlier.map((o) => o.clientId));
      // I16: never offer a freed opening to the client who vacated it (defensive; they're booked anyway).
      if (opening.source.kind === "freed") offered.add(opening.source.fromClientId);
      // Versioning: histories recorded before service matching was enforced have no
      // "service-eligibility" marker and replay with the old rule; new executions record it.
      const serviceMustMatch = patched("service-eligibility");
      const [next] = orderedEligible(clients.values(), opening, policy, offered, { serviceMustMatch });
      if (!next) {
        const reason: UnfilledReason =
          earlier.length === 0 ? "no-one-fits" : earlier.some((o) => o.outcome === "expired") ? "no-one-accepted" : "everyone-passed";
        return closeUnfilled(opening, reason);
      }

      const offer: Offer = {
        offerId: uuid4(),
        openingId,
        clientId: next.clientId,
        offeredAt: sentAt,
        expiresAt,
        outcome: "pending",
      };
      offers.set(offer.offerId, offer);
      opening.offerIds.push(offer.offerId);
      opening.currentOfferId = offer.offerId;
      opening.status = "held";

      // One durable timer per offer (cancelled if the client answers first).
      const answered = await condition(() => offer.outcome !== "pending", Math.max(1, Date.parse(expiresAt) - Date.now()));
      if (!answered) expireOffer(offer); // no-op if a late reply already expired it
      // The status was changed by the respondToOffer handler or expireOffer while we waited.
      if ((opening.status as OpeningStatus) === "booked") return;
    }
  }

  // ---- One allocation pass for every opening that needs a client (I17) ----

  const allocated = new Set<string>(); // openings handled by the allocation pass (patch marker present)

  function allocationPass(): void {
    const needing = [...openings.values()].filter(
      (o) => allocated.has(o.openingId) && o.status === "matching" && o.currentOfferId === undefined,
    );
    if (needing.length === 0) return;
    const serviceMustMatch = patched("service-eligibility");
    const decisions = allocateOffers({
      openings: needing,
      clients: [...clients.values()],
      offers: [...offers.values()],
      policy,
      now: now(),
      matchOptions: { serviceMustMatch },
    });
    for (const decision of decisions) {
      const opening = openings.get(decision.openingId)!;
      if (decision.kind === "close") {
        closeUnfilled(opening, decision.reason);
      } else if (decision.kind === "wait") {
        opening.waitingForAvailableClient = true;
      } else {
        const offer: Offer = {
          offerId: uuid4(),
          openingId: opening.openingId,
          clientId: decision.clientId,
          offeredAt: now(),
          expiresAt: decision.expiresAt,
          outcome: "pending",
        };
        offers.set(offer.offerId, offer);
        opening.offerIds.push(offer.offerId);
        opening.currentOfferId = offer.offerId;
        opening.status = "held";
        delete opening.waitingForAvailableClient;
      }
    }
  }

  // Drives one opening's timers; offers are decided by the allocation pass, never here.
  async function driveOpening(openingId: string): Promise<void> {
    const opening = openings.get(openingId)!;
    const closed = () => opening.status === "unfilled" || opening.status === "booked";
    for (;;) {
      await condition(() => allocatedRevision === revision); // let the allocation pass run first
      if (closed()) return;
      if (opening.currentOfferId === undefined) {
        // Waiting for a fitting client to become free. Also wake at the start: then it's too late.
        const assigned = await condition(
          () => opening.currentOfferId !== undefined || closed(),
          Math.max(1, Date.parse(opening.start) - Date.now()),
        );
        if (closed()) return;
        if (!assigned) return closeUnfilled(opening, "too-late");
      }
      const offer = offers.get(opening.currentOfferId!)!;
      // One durable timer per offer (cancelled if the client answers first).
      const answered = await condition(() => offer.outcome !== "pending", Math.max(1, Date.parse(offer.expiresAt) - Date.now()));
      if (!answered) expireOffer(offer); // no-op if a late reply already expired it
      if ((opening.status as OpeningStatus) === "booked") return;
    }
  }

  for (;;) {
    await condition(() => openingsToStart.length > 0 || allocatedRevision !== revision);
    const started = openingsToStart.splice(0);
    // Versioning: histories recorded before allocation existed have no "one-pending-offer" marker; their
    // openings run the legacy orchestration exactly as recorded.
    for (const openingId of started) if (patched("one-pending-offer")) allocated.add(openingId);
    const target = revision;
    allocationPass();
    allocatedRevision = target;
    for (const openingId of started) void (allocated.has(openingId) ? driveOpening(openingId) : runOpeningLegacy(openingId));
  }
}
