// Client offer note (approved design), opened from the simulated text message link.
// The written deadline comes from the Workflow (expiresAt). No live countdown: the server decides
// lateness, so a reply after the deadline simply comes back as "no longer available".
const note = document.querySelector("#note");
const offerId = new URLSearchParams(location.search).get("id");

const isToday = (iso, tz) => salonDateKey(iso, tz) === salonDateKey(new Date().toISOString(), tz);
const dayLine = (iso, tz) => `${isToday(iso, tz) ? "Today, " : ""}${formatDay(iso, tz)}`;
const seeYou = ({ opening, timeZone: o }) =>
  `See you ${isToday(opening.start, o) ? "today" : `on ${formatDay(opening.start, o)}`} at ${formatTime(opening.start, o)} with ${escapeHtml(opening.stylist)}.`;
const STILL_WAITING = "You're still on our waitlist, and we'll text you about the next opening that fits.";
/** "Thursday at 3:00 pm", or "today at 3:00 pm". */
const dayAt = (iso, tz) =>
  `${isToday(iso, tz) ? "today" : new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "long" })} at ${formatTime(iso, tz)}`;

function appointmentPanel(offer) {
  const { start, stylist } = offer.opening;
  const o = offer.timeZone;
  return `
    <div class="appointment">
      <p class="appt-day">${escapeHtml(dayLine(start, o))}</p>
      <p class="appt-time display"><time datetime="${start}">${formatTime(start, o)}</time></p>
      <p class="appt-what">${SERVICE_NAMES[offer.service]} with ${escapeHtml(stylist)}</p>
      <p class="appt-length">About ${formatLength(offer.serviceMinutes)}</p>
    </div>`;
}

function renderOpen(offer) {
  note.innerHTML = `
    <h1 class="display">Hi ${escapeHtml(offer.firstName)},</h1>
    <p class="lead">An opening just came up that fits what you asked for.</p>
    ${appointmentPanel(offer)}
    <p class="hold">We're holding it for you until <b>${formatDeadline(offer.expiresAt, offer.timeZone, { tomorrowWord: true })}</b>.</p>
    ${offer.currentAppointment
      ? `<p class="lead">If you take it, we'll move your appointment on ${dayAt(offer.currentAppointment.start, offer.timeZone)} to this time.</p>`
      : ""}
    <div class="answers">
      <button class="button button-primary" type="button" data-answer="accept">Yes, book me in</button>
      <button class="button button-quiet" type="button" data-answer="decline">No thanks</button>
    </div>
    <p id="problem" class="problem error" role="alert"></p>
    <p class="reassure">If you say no thanks, you'll stay on our waitlist for the next opening that fits.</p>`;
  for (const button of note.querySelectorAll("[data-answer]")) {
    button.addEventListener("click", () => respond(offer, button));
  }
}

// Result states: the heading takes focus so screen readers hear the outcome.
function renderResult(heading, lead, panel = "") {
  note.innerHTML = `
    <h1 class="display" tabindex="-1" id="result-heading">${heading}</h1>
    <p class="lead">${lead}</p>
    ${panel}`;
}

const CHECK = `<span class="check" aria-hidden="true">✓</span> `;
const STATES = {
  booked: (offer) => renderResult(`${CHECK}You're booked in.`, seeYou(offer), appointmentPanel(offer)),
  already: (offer) => renderResult(`${CHECK}You're already booked in for this one.`, seeYou(offer), appointmentPanel(offer)),
  declined: () => renderResult("No problem, thanks for letting us know.", STILL_WAITING),
  unavailable: () => renderResult("This opening is no longer available.", STILL_WAITING),
  missing: () => renderResult("We couldn't find this offer.", "Please check the link in your text."),
  // A move (Lena): the new time is reserved; the salon is updating Square. Never "fully confirmed".
  moved: (offer, fromStart) =>
    renderResult(
      "Your new time is reserved.",
      `We're updating your booking in Square from ${dayAt(fromStart, offer.timeZone)} to ${dayAt(offer.opening.start, offer.timeZone)}.`,
      appointmentPanel(offer),
    ),
  // This client already accepted another offer.
  reservedElsewhere: () => renderResult("This opening is no longer available.", "You already have a new time reserved with us."),
};

const RESPONSE_STATE = {
  booked: "booked",
  "already-booked": "already",
  declined: "declined",
  "already-declined": "declined",
  "no-longer-available": "unavailable",
  "already-reserved": "reservedElsewhere",
};

async function respond(offer, pressed) {
  const buttons = note.querySelectorAll("[data-answer]");
  const problem = document.querySelector("#problem");
  const label = pressed.textContent;
  buttons.forEach((b) => (b.disabled = true));
  pressed.textContent = pressed.dataset.answer === "accept" ? "Booking…" : "Sending…";
  problem.textContent = "";
  try {
    const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: pressed.dataset.answer }),
    });
    if (response.status === 400) {
      STATES.missing();
    } else {
      if (!response.ok) throw new Error(`Respond failed: ${response.status}`);
      const result = await response.json();
      // The freed opening (if any) is the client's old appointment: show the move wording.
      if ((result.outcome === "booked" || result.outcome === "already-booked") && result.freedOpening) {
        STATES.moved(offer, result.freedOpening.start);
      } else if (result.outcome === "already-booked" && offer.movedFrom) {
        STATES.moved(offer, offer.movedFrom.start);
      } else {
        STATES[RESPONSE_STATE[result.outcome] ?? "unavailable"](offer);
      }
    }
    document.querySelector("#result-heading")?.focus();
  } catch (error) {
    console.warn(error);
    buttons.forEach((b) => (b.disabled = false));
    pressed.textContent = label;
    problem.textContent = "We couldn't send your answer just now. Please try again.";
  }
}

async function load() {
  if (!offerId) return STATES.missing();
  const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}`);
  if (response.status === 404) return STATES.missing();
  if (!response.ok) {
    note.innerHTML = `<p class="lead error">We couldn't load this offer just now. Please refresh the page.</p>`;
    return;
  }
  const offer = await response.json();
  // Reopening the link later shows how this offer ended. An expired offer (no reply in time)
  // shows the approved "no longer available" state, never the word "expired".
  if (offer.bookedByThisOffer) offer.movedFrom ? STATES.moved(offer, offer.movedFrom.start) : STATES.booked(offer);
  else if (offer.outcome === "declined") STATES.declined();
  else if (offer.outcome === "pending" && offer.opening.status === "held") renderOpen(offer);
  else STATES.unavailable();
}

load();
