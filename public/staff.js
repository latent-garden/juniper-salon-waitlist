// Shared staff-page code: polling, status language, Needs attention, staff actions.
// Depends on format.js. All content comes from the Workflow snapshot (GET /api/state).

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const word = (n) => WORDS[n] ?? String(n);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function todayKey(tz) {
  return salonDateKey(new Date().toISOString(), tz);
}

/** Day labels for an opening: long ("Today, Tuesday, October 6") and short ("Today"). */
function dayOf(iso, tz) {
  const key = salonDateKey(iso, tz);
  const name = formatDay(iso, tz);
  const isToday = key === todayKey(tz);
  return { key, long: isToday ? `Today, ${name}` : name, short: isToday ? "Today" : name };
}

// "Today", a weekday within the coming week ("Wednesday"), otherwise the full date.
function nearDay(iso, tz) {
  const day = dayOf(iso, tz);
  if (day.short === "Today") return "Today";
  const daysAhead = (Date.parse(day.key) - Date.parse(todayKey(tz))) / 86_400_000;
  return daysAhead > 0 && daysAhead < 7 ? formatDay(iso, tz).split(",")[0] : day.long;
}

/** "Thursday, 3:00 pm" (or "today, 3:00 pm" mid-sentence). */
const whenText = (iso, tz) => `${nearDay(iso, tz).replace(/^Today$/, "today")}, ${formatTime(iso, tz)}`;

function byStart(a, b) {
  return Date.parse(a.start) - Date.parse(b.start);
}

function groupByDay(openings, tz) {
  const days = new Map();
  for (const o of [...openings].sort(byStart)) {
    const day = dayOf(o.start, tz);
    if (!days.has(day.key)) days.set(day.key, { ...day, openings: [] });
    days.get(day.key).openings.push(o);
  }
  return [...days.values()];
}

function clientsIndex(snapshot) {
  return new Map(snapshot.clients.map((c) => [c.clientId, c]));
}

// Describes the opening itself: its service, stylist and length ("Color with Maria, 2 hr"), never
// the held or booked client's request combined with the opening's length.
function serviceLabel(opening, clients) {
  const length = formatShortLength(opening.durationMin);
  if (opening.service) return `${SERVICE_NAMES[opening.service]} with ${escapeHtml(opening.stylist)}, ${length}`;
  // Openings recorded before openings had a service: keep the earlier wording.
  const id = opening.bookedFor?.clientId ?? opening.heldBy?.clientId;
  const client = id ? clients.get(id) : undefined;
  return client
    ? `${SERVICE_NAMES[client.service]} with ${escapeHtml(opening.stylist)}, ${length}`
    : `With ${escapeHtml(opening.stylist)}, ${length}`;
}

function timeCell(opening, tz) {
  return `<span class="time"><time datetime="${opening.start}">${formatTime(opening.start, tz)}</time></span>`;
}

// Opening history: who said no thanks or didn't reply, and when. It belongs to the opening, not the waitlist.
// A timeout is never described as someone saying no.
function offerTrail(opening, tz) {
  const entries = opening.offers
    .filter((o) => o.outcome === "declined" || o.outcome === "expired")
    .map((o) => {
      const who = escapeHtml(o.clientName);
      const text = o.outcome === "declined"
        ? `${who} said no thanks · ${formatTime(o.resolvedAt, tz)}`
        : `No reply from ${who} by ${formatTime(o.resolvedAt, tz)}`;
      return { at: o.resolvedAt, text };
    });
  // Staff inclusions are part of the opening's history too.
  for (const i of opening.inclusions ?? []) {
    entries.push({ at: i.at, text: `${escapeHtml(i.clientName)} included by staff · ${formatTime(i.at, tz)}` });
  }
  return entries
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((e) => `<small>${e.text}</small>`)
    .join("");
}

// Clients who fail only because they prefer another stylist; staff may include them here.
function includeLines(opening, tz) {
  return (opening.includeCandidates ?? [])
    .map((c) => {
      const name = escapeHtml(c.name);
      return `<small>${name} prefers ${escapeHtml(c.prefers)} <button type="button" class="act act-button" data-include="${escapeHtml(opening.openingId)}" data-client="${escapeHtml(c.clientId)}" data-name="${name}" aria-label="Include ${name} for the ${whenText(opening.start, tz)} opening">Include for this opening</button></small>`;
    })
    .join("");
}

const UNFILLED_TEXT = {
  "no-one-fits": "No one on the waitlist fits",
  "everyone-passed": "Everyone who fits has said no",
  "no-one-accepted": "No one who fits accepted",
  "too-late": "Too late to offer",
};

/** The held offer's deadline, with the day when it isn't today ("Holding until Wednesday, 9:00 am"). */
function holdingUntil(opening, tz) {
  const offer = opening.offers.find((o) => o.offerId === opening.currentOfferId);
  return offer ? `<small>Holding until ${formatDeadline(offer.expiresAt, tz)}</small>` : "";
}

/** Move context: "Moved from …" on the accepted opening, "Opened when … moved to …" on the freed one. */
function moveLines(opening, snapshot, clients) {
  const tz = snapshot.timeZone;
  const byId = (id) => snapshot.openings.find((o) => o.openingId === id);
  let lines = "";
  if (opening.source?.kind === "freed") {
    const mover = clients.get(opening.source.fromClientId);
    const movedTo = byId(opening.source.movedToOpeningId);
    if (mover && movedTo) lines += `<small>Opened when ${escapeHtml(mover.name)} moved to ${whenText(movedTo.start, tz)}</small>`;
  }
  const freed = opening.freedOpeningId && byId(opening.freedOpeningId);
  if (freed) lines += `<small>Moved from ${whenText(freed.start, tz)}</small>`;
  return lines;
}

function openingRow(opening, snapshot, clients) {
  const tz = snapshot.timeZone;
  const label = serviceLabel(opening, clients) + moveLines(opening, snapshot, clients);
  const trail = offerTrail(opening, tz) + includeLines(opening, tz);
  switch (opening.status) {
    case "held": {
      const name = escapeHtml(opening.heldBy.name);
      return `<li class="slot is-held">${timeCell(opening, tz)}
        <p class="what">Held for <b>${name}</b><small>${label}</small>${holdingUntil(opening, tz)}${trail}</p>
        <a class="act" href="/offer.html?id=${encodeURIComponent(opening.currentOfferId)}" target="_blank" rel="noopener" aria-label="Open the offer texted to ${name}">Open offer</a></li>`;
    }
    case "booked":
      // State only: the Square reminder lives in Needs attention.
      return `<li class="slot is-booked">${timeCell(opening, tz)}
        <p class="what"><span class="booked"><span aria-hidden="true">✓</span> Booked</span> for <b>${escapeHtml(opening.bookedFor.name)}</b><small>${label}</small>${trail}</p><span></span></li>`;
    case "matching":
      return `<li class="slot is-unfilled">${timeCell(opening, tz)}
        <p class="what">${opening.waitingForAvailableClient
          ? "Waiting for an eligible client to become available" // someone fits, but they hold another offer
          : "Finding someone on the waitlist…"}<small>${label}</small>${trail}</p><span></span></li>`;
    default:
      return `<li class="slot is-unfilled">${timeCell(opening, tz)}
        <p class="what">${unfilledText(opening)}<small>${label}</small>${trail}</p><span></span></li>`;
  }
}

// Summary clauses for openings that ended unfilled for a reason other than "no one fits" (lowercase).
function endedClauses(openings) {
  const count = (reason) => openings.filter((o) => o.status === "unfilled" && o.unfilledReason === reason).length;
  const n = (k) => `${lower(word(k))} ${k === 1 ? "opening" : "openings"}`;
  const passed = count("everyone-passed"), notAccepted = count("no-one-accepted"), tooLate = count("too-late");
  return [
    passed && `everyone who fits has said no to ${n(passed)}`,
    notAccepted && `no one who fits accepted ${n(notAccepted)}`,
    tooLate && `it's too late to offer ${n(tooLate)}`,
  ].filter(Boolean);
}
// Nobody fits automatically, but staff could include a "Prefers" client: say so, not "no one fits".
const hasNoAutomaticMatch = (o) =>
  o.status === "unfilled" && (o.unfilledReason ?? "no-one-fits") === "no-one-fits" && (o.includeCandidates?.length ?? 0) > 0;
const unfilledText = (o) => (hasNoAutomaticMatch(o) ? "No automatic match" : UNFILLED_TEXT[o.unfilledReason] ?? UNFILLED_TEXT["no-one-fits"]);
const noAutomaticMatchCount = (openings) => openings.filter(hasNoAutomaticMatch).length;
const noOneFitsCount = (openings) =>
  openings.filter((o) => o.status === "unfilled" && (o.unfilledReason ?? "no-one-fits") === "no-one-fits" && !hasNoAutomaticMatch(o)).length;

function slotsList(openings, snapshot, clients) {
  return `<ol class="slots" role="list">${openings.map((o) => openingRow(o, snapshot, clients)).join("")}</ol>`;
}

// Mirrors src/frontDesk.ts. Square items are reminders: Juniper can't see Square, and
// nothing can be cleared until markRecordedInSquare exists (no local-only "recorded" state).
const isActiveOpening = (o) => o.status === "matching" || o.status === "held" || o.status === "unfilled";
const isSquareReminder = (o) => o.status === "booked" && !o.recordedInSquare;

// "Mark as recorded" (markRecordedInSquare). No undo (prototype limitation).
const recordedButton = (o) =>
  `<button class="button" type="button" data-recorded="${escapeHtml(o.openingId)}" data-name="${escapeHtml(o.bookedFor.name)}" aria-label="Mark ${escapeHtml(o.bookedFor.name)}'s booking as recorded in Square">Mark as recorded</button>`;

function renderNeeds(el, snapshot) {
  const clients = clientsIndex(snapshot);
  const items = snapshot.openings.filter(isSquareReminder).sort(byStart);
  el.hidden = items.length === 0;
  if (!items.length) return;
  el.querySelector("ul").innerHTML = items
    .map((o) => {
      const client = clients.get(o.bookedFor.clientId);
      const service = o.service ?? client?.service;
      const what = service ? lower(SERVICE_NAMES[service]) : "appointment";
      const tz = snapshot.timeZone;
      const freed = o.freedOpeningId && snapshot.openings.find((x) => x.openingId === o.freedOpeningId);
      if (freed) {
        // A move: staff change the existing booking in Square. Juniper can't see whether that's done.
        return `<li><p>Move ${escapeHtml(o.bookedFor.name)}'s booking in Square<small>From ${whenText(freed.start, tz)} to ${whenText(o.start, tz)}, ${what} with ${escapeHtml(o.stylist)}</small></p>${recordedButton(o)}</li>`;
      }
      return `<li><p>Record ${escapeHtml(o.bookedFor.name)}'s booking in Square<small>${escapeHtml(dayOf(o.start, tz).short)}, ${formatTime(o.start, tz)}, ${what} with ${escapeHtml(o.stylist)}</small></p>${recordedButton(o)}</li>`;
    })
    .join("");
}

function setToday(el, tz) {
  el.textContent = formatDay(new Date().toISOString(), tz);
}

// ---- Polling and announcements ----

let lastStates = new Map();
function announceChanges(snapshot, announcer) {
  if (!announcer) return;
  const next = new Map();
  for (const o of snapshot.openings) {
    const state = `${o.status}:${o.currentOfferId ?? ""}`;
    next.set(o.openingId, state);
    const before = lastStates.get(o.openingId);
    if (before === undefined || before === state) continue;
    const time = formatTime(o.start, snapshot.timeZone);
    // What happened to the previous offer, if the opening just moved on from one.
    const last = [...o.offers].reverse().find((x) => x.outcome === "declined" || x.outcome === "expired");
    const passed = before.startsWith("held:") && last
      ? (last.outcome === "declined" ? `${last.clientName} said no thanks. ` : `No reply from ${last.clientName}. `)
      : "";
    if (o.status === "held") announcer.textContent = `${passed}The ${time} opening is held for ${o.heldBy.name}.`;
    if (o.status === "booked") {
      const freed = o.freedOpeningId && snapshot.openings.find((x) => x.openingId === o.freedOpeningId);
      announcer.textContent = `${o.bookedFor.name} booked the ${time} opening.` +
        (freed ? ` ${o.bookedFor.name}'s ${whenText(freed.start, snapshot.timeZone)} appointment is now an opening.` : "");
    }
    if (o.status === "unfilled") {
      const ended = {
        "everyone-passed": `Everyone who fits has said no to the ${time} opening.`,
        "no-one-accepted": `No one who fits accepted the ${time} opening.`,
        "too-late": `It's too late to offer the ${time} opening.`,
      }[o.unfilledReason] ?? (hasNoAutomaticMatch(o) ? `No automatic match for the ${time} opening.` : `No one on the waitlist fits the ${time} opening.`);
      announcer.textContent = passed + ended;
    }
  }
  lastStates = next;
}

function startPolling(render) {
  const connection = document.querySelector("#connection");
  const announcer = document.querySelector("#announcer");
  let lastJson = "";
  async function refresh() {
    try {
      const response = await fetch("/api/state");
      if (!response.ok) throw new Error(`State request failed: ${response.status}`);
      const json = await response.text();
      if (connection) connection.hidden = true;
      if (json === lastJson) return;
      lastJson = json;
      const snapshot = JSON.parse(json);
      announceChanges(snapshot, announcer);
      render(snapshot);
    } catch (error) {
      console.warn(error);
      if (connection) connection.hidden = false;
    }
  }
  wireStaffActions(refresh, announcer);
  refresh();
  setInterval(refresh, 2000);
  return refresh;
}

// Staff actions (event delegation, so re-rendered rows keep working).
function wireStaffActions(refresh, announcer) {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-include], [data-recorded]");
    if (!button || button.disabled) return;
    button.disabled = true;
    const include = button.dataset.include;
    const url = include
      ? `/api/openings/${encodeURIComponent(include)}/include/${encodeURIComponent(button.dataset.client)}`
      : `/api/openings/${encodeURIComponent(button.dataset.recorded)}/recorded-in-square`;
    try {
      const response = await fetch(url, { method: "POST" });
      if (!response.ok) throw new Error((await response.json()).error ?? `Request failed: ${response.status}`);
      if (announcer) {
        announcer.textContent = include
          ? `${button.dataset.name} is included for this opening.`
          : `${button.dataset.name}'s booking is marked as recorded.`;
      }
      await refresh();
    } catch (error) {
      console.warn(error);
      button.disabled = false;
      if (announcer) announcer.textContent = error.message;
    }
  });
}
