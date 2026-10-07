// Front desk: active openings preview, Square reminders, derived summary.
const summaryEl = document.querySelector("#summary");
const openingsEl = document.querySelector("#openings");
const needsEl = document.querySelector("#needs");

function homeSummary(snapshot) {
  const held = snapshot.openings.filter((o) => o.status === "held").length;
  const unfilled = noOneFitsCount(snapshot.openings);
  const reminders = snapshot.openings.filter(isSquareReminder).length;
  const parts = [];
  if (held) parts.push(`<b>${word(held)} ${held === 1 ? "opening is" : "openings are"} held for someone.</b>`);
  const waiting = snapshot.openings.filter((o) => o.status === "matching" && o.waitingForAvailableClient).length;
  if (waiting) parts.push(`${word(waiting)} ${waiting === 1 ? "opening is" : "openings are"} waiting for an eligible client.`);
  if (unfilled) parts.push(`${word(unfilled)} ${unfilled === 1 ? "has" : "have"} no one on the waitlist who fits.`);
  const noAutoMatch = noAutomaticMatchCount(snapshot.openings);
  if (noAutoMatch) parts.push(`${word(noAutoMatch)} ${noAutoMatch === 1 ? "has" : "have"} no automatic match.`);
  for (const clause of endedClauses(snapshot.openings)) parts.push(`${clause.replace(/^./, (c) => c.toUpperCase())}.`);
  // Reminders, not tracked state: Juniper can't see Square.
  if (reminders) parts.push(`${word(reminders)} ${reminders === 1 ? "booking" : "bookings"} to record in Square.`);
  return parts.length ? parts.join(" ") : "Nothing needs you right now.";
}

startPolling((snapshot) => {
  const tz = snapshot.timeZone;
  const clients = clientsIndex(snapshot);
  setToday(document.querySelector("#today"), tz);
  summaryEl.innerHTML = homeSummary(snapshot);

  const days = groupByDay(snapshot.openings.filter(isActiveOpening), tz);
  openingsEl.innerHTML = days.length
    ? days.map((d) => `<p class="day-label">${escapeHtml(d.short)}</p>${slotsList(d.openings, snapshot, clients)}`).join("")
    : `<p class="empty-note">No openings are being offered right now.</p>`;

  renderNeeds(needsEl, snapshot);
});
