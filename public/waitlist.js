// Waitlist: people first, grouped Waiting / Booked from the waitlist, in join order.
// No global queue position: order applies per opening, among clients who fit it.
const summaryEl = document.querySelector("#summary");
const listsEl = document.querySelector("#lists");

const STYLIST_TEXT = {
  any: () => "Any stylist",
  prefers: (p) => `Prefers ${p.stylist}`,
  requires: (p) => `Only with ${p.stylist}`,
};

const joinOrder = (a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.seq - b.seq;

function waitlistSummary(clients, waiting, withOffer, booked) {
  const s = [`<b>${word(clients.length)} ${clients.length === 1 ? "person" : "people"} total.</b>`];
  if (waiting.length) {
    const n = withOffer.length;
    const offers = n
      ? `, and ${waiting.length === 1 ? "they have" : `${lower(word(n))} of them ${n === 1 ? "has" : "have"}`} an offer right now`
      : "";
    s.push(`${word(waiting.length)} ${waiting.length === 1 ? "remains" : "remain"} on the waitlist${offers}.`);
  }
  if (booked.length) s.push(`${word(booked.length)} ${booked.length === 1 ? "has" : "have"} been booked from the waitlist.`);
  return s.join(" ");
}

const COLS = `<colgroup><col style="width:24%"><col style="width:19%"><col style="width:25%"><col style="width:14%"><col></colgroup>`;
const HEAD = `${COLS}<thead><tr><th scope="col">Client</th><th scope="col">Would like</th><th scope="col">Free</th><th scope="col">Joined</th><th scope="col">Status</th></tr></thead>`;

function row(client, snapshot, heldOpening, bookedOpening) {
  const tz = snapshot.timeZone;
  const when = (o) => `${escapeHtml(nearDay(o.start, tz))}, ${formatTime(o.start, tz)}`;
  const pref = client.stylistPreference;
  const status = heldOpening
    ? `Has an offer<small>${when(heldOpening)}</small>`
    : bookedOpening
      ? `<span class="booked"><span aria-hidden="true">✓</span> Booked</span><small>${when(bookedOpening)}</small>`
      : `<span class="pencil">Waiting</span>`;
  // Quiet context: an existing appointment, or where a move came from.
  const appointmentLine = client.status === "waiting" && client.currentAppointment
    ? `<small>Has <span class="nowrap">${escapeHtml(whenText(client.currentAppointment.start, tz))}</span></small>`
    : client.movedFrom
      ? `<small>Moved from <span class="nowrap">${escapeHtml(whenText(client.movedFrom.start, tz))}</span></small>`
      : "";
  const cls = [heldOpening ? "has-offer" : "", client.status === "booked" ? "quiet" : ""].join(" ").trim();
  return `<tr class="${cls}">
    <td data-label="Client"><p class="name">${escapeHtml(client.name)}</p><small class="nowrap">${escapeHtml(client.mobile)}</small></td>
    <td data-label="Would like"><span class="nowrap">${SERVICE_NAMES[client.service]}, ${formatShortLength(client.serviceMinutes)}</span><small>${escapeHtml(STYLIST_TEXT[pref.kind](pref))}</small></td>
    <td data-label="Free">${escapeHtml(formatAvailability(client.availability))}</td>
    <td data-label="Joined" class="nowrap"><time datetime="${client.joinedAt}">${formatDay(client.joinedAt, tz).replace(/^\w+, /, "")}</time></td>
    <td data-label="Status">${status}${appointmentLine}</td>
  </tr>`;
}

async function seed(button) {
  button.disabled = true;
  button.textContent = "Adding…";
  await fetch("/api/demo/seed", { method: "POST" });
  refreshNow();
}

let refreshNow = () => {};

refreshNow = startPolling((snapshot) => {
  setToday(document.querySelector("#today"), snapshot.timeZone);
  const clients = [...snapshot.clients].sort(joinOrder);

  if (clients.length === 0) {
    summaryEl.textContent = "No one is on the waitlist yet.";
    listsEl.innerHTML = `
      <h2 class="display list-heading">Waiting</h2>
      <p class="empty-note">No one is on the waitlist yet.</p>
      <p class="empty-note"><button class="button" type="button" id="seed">Add the sample waitlist</button></p>`;
    listsEl.querySelector("#seed").addEventListener("click", (e) => seed(e.currentTarget));
    return;
  }

  const heldFor = new Map(snapshot.openings.filter((o) => o.status === "held").map((o) => [o.heldBy.clientId, o]));
  const bookedFor = new Map(snapshot.openings.filter((o) => o.status === "booked").map((o) => [o.bookedFor.clientId, o]));
  const waiting = clients.filter((c) => c.status === "waiting");
  const booked = clients.filter((c) => c.status === "booked");
  const withOffer = waiting.filter((c) => heldFor.has(c.clientId));
  summaryEl.innerHTML = waitlistSummary(clients, waiting, withOffer, booked);

  listsEl.innerHTML = `
    <h2 class="display list-heading">Waiting</h2>
    <p class="list-note">In the order they joined. For each opening, the earliest-joined person who fits is offered first.</p>
    ${waiting.length
      ? `<table class="people">${HEAD}<tbody>${waiting.map((c) => row(c, snapshot, heldFor.get(c.clientId), null)).join("")}</tbody></table>`
      : `<p class="empty-note">No one is waiting right now.</p>`}
    ${booked.length ? `
    <h2 class="display list-heading">Booked from the waitlist</h2>
    <table class="people">${HEAD}<tbody>${booked.map((c) => row(c, snapshot, null, bookedFor.get(c.clientId))).join("")}</tbody></table>` : ""}`;
});
