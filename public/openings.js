// Openings: every opening by day, the existing add-opening form, Square reminders.
const summaryEl = document.querySelector("#summary");
const firstDayEl = document.querySelector("#first-day");
const ledgerEl = document.querySelector("#ledger");
const needsEl = document.querySelector("#needs");
const dialog = document.querySelector("#add-dialog");
const form = document.querySelector("#add-form");
const toggle = document.querySelector("#add-toggle");
const cancel = document.querySelector("#add-cancel");
const formResult = document.querySelector("#form-result");
const formError = document.querySelector("#form-error");

function openingsSummary(snapshot, dayCount) {
  const o = snapshot.openings;
  if (o.length === 0) return "No openings right now.";
  const count = (s) => o.filter((x) => x.status === s).length;
  const held = count("held"), booked = count("booked");
  const unfilled = noOneFitsCount(o);
  const parts = [`<b>${word(o.length)} ${o.length === 1 ? "opening" : "openings"} across ${lower(word(dayCount))} ${dayCount === 1 ? "day" : "days"}.</b>`];
  // Two openings, one held and one no one accepted: read as a pair rather than counting again.
  if (o.length === 2 && held === 1 && o.some((x) => x.status === "unfilled" && x.unfilledReason === "no-one-accepted")) {
    return `${parts[0]} One is held, and no one who fits accepted the other.`;
  }
  const waiting = o.filter((x) => x.status === "matching" && x.waitingForAvailableClient).length;
  const clauses = [];
  if (held) clauses.push(`${lower(word(held))} ${held === 1 ? "is" : "are"} held`);
  if (booked) clauses.push(`${lower(word(booked))} ${booked === 1 ? "is" : "are"} booked`);
  clauses.push(...endedClauses(o));
  // Trailing clauses take "and" when something comes before them.
  const tail = [];
  if (waiting) tail.push(`${lower(word(waiting))} ${waiting === 1 ? "is" : "are"} waiting for an eligible client`);
  const noAutoMatch = noAutomaticMatchCount(o);
  if (noAutoMatch) tail.push(`${lower(word(noAutoMatch))} ${noAutoMatch === 1 ? "has" : "have"} no automatic match`);
  if (unfilled) tail.push(`${lower(word(unfilled))} ${unfilled === 1 ? "has" : "have"} no one on the waitlist who fits`);
  const all = [...clauses, ...tail];
  if (all.length) {
    if (tail.length && all.length > 1) all[all.length - 1] = `and ${all[all.length - 1]}`;
    parts.push(all.join(", ").replace(/^./, (c) => c.toUpperCase()) + ".");
  }
  return parts.join(" ");
}

let refreshNow = () => {};

refreshNow = startPolling((snapshot) => {
  const tz = snapshot.timeZone;
  const clients = clientsIndex(snapshot);
  const days = groupByDay(snapshot.openings, tz);
  setToday(document.querySelector("#today"), tz);
  summaryEl.innerHTML = openingsSummary(snapshot, days.length);

  if (days.length === 0) {
    firstDayEl.textContent = `Today, ${formatDay(new Date().toISOString(), tz)}`;
    const noWaitlist = snapshot.clients.length === 0
      ? ` No one is on the waitlist yet; add people on the <a href="/waitlist">Waitlist</a> page.`
      : "";
    ledgerEl.innerHTML = `<p class="empty-note">No openings right now. When an appointment is canceled, add it here and we'll offer it to the waitlist.${noWaitlist}</p>`;
  } else {
    // The first day's heading lives in the collection header row (with "Add opening").
    firstDayEl.textContent = days[0].long;
    ledgerEl.innerHTML = days
      .map((d, i) => `${i === 0 ? "" : `<h2 class="display list-heading">${escapeHtml(d.long)}</h2>`}${slotsList(d.openings, snapshot, clients)}`)
      .join("");
  }
  renderNeeds(needsEl, snapshot);
});

// ---- Add opening: a modal dialog (same fields, same API) ----
// Native <dialog>.showModal() makes the page behind inert (focus stays inside) and handles Escape.

let defaults = "";
const formValues = () => [form.date.value, form.time.value, form.service.value, form.stylist.value, form.durationMin.value].join("|");
// The usual length for each service (matches the salon's service lengths); staff can still change it.
const SERVICE_LENGTH = { haircut: "45", color: "120", blowout: "45" };
form.service.addEventListener("change", () => (form.durationMin.value = SERVICE_LENGTH[form.service.value]));

function setFormDefaults() {
  const next = new Date(Math.ceil(Date.now() / (30 * 60_000)) * 30 * 60_000);
  const pad = (n) => String(n).padStart(2, "0");
  form.reset();
  form.date.value = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
  form.time.value = `${pad(next.getHours())}:${pad(next.getMinutes())}`;
  defaults = formValues();
}

function openDialog() {
  setFormDefaults();
  formError.textContent = "";
  formResult.textContent = "";
  dialog.showModal();
  form.date.focus();
}

function closeDialog() {
  if (dialog.open) dialog.close();
}

// Always return focus to the trigger, however the dialog closed (Cancel, Escape, backdrop, submit).
dialog.addEventListener("close", () => toggle.focus());

// Backdrop click closes only when nothing has been changed, so typed input isn't lost by accident.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog && formValues() === defaults) closeDialog();
});

toggle.addEventListener("click", openDialog);
cancel.addEventListener("click", closeDialog);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  if (!form.date.value || !form.time.value) {
    formError.textContent = "Choose a date and time for the opening.";
    return;
  }
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const response = await fetch("/api/openings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: form.date.value,
        time: form.time.value,
        service: form.service.value,
        stylist: form.stylist.value,
        durationMin: Number(form.durationMin.value),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "The opening wasn't added.");
    closeDialog();
    formResult.textContent = "Opening added.";
    await refreshNow();
  } catch (error) {
    formError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
