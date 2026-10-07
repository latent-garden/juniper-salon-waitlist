// Shared formatting for salon-local dates and times (no dependencies).
const SERVICE_NAMES = { haircut: "Haircut", color: "Color", blowout: "Blowout" };

// All salon dates and times use the salon's named time zone (IANA, from the snapshot), via Intl,
// so daylight-saving changes are handled by the browser's time-zone data.
function formatTime(iso, timeZone) {
  return new Date(iso)
    .toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .replace("AM", "am")
    .replace("PM", "pm");
}

function formatDay(iso, timeZone) {
  return new Date(iso).toLocaleDateString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
}

/** "2026-10-06": the salon-local calendar date. */
function salonDateKey(iso, timeZone) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Whole salon days from one date key to another ("2026-10-06" -> "2026-10-07" is 1). */
function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(toKey) - Date.parse(fromKey)) / 86_400_000);
}

/**
 * A deadline with enough date context to be unambiguous:
 * "6:33 pm" today, "9:00 am tomorrow" (client) / "Wednesday, 9:00 am" (staff), else the weekday.
 */
function formatDeadline(iso, timeZone, { tomorrowWord = false } = {}) {
  const time = formatTime(iso, timeZone);
  const ahead = daysBetween(salonDateKey(new Date().toISOString(), timeZone), salonDateKey(iso, timeZone));
  if (ahead <= 0) return time;
  if (ahead === 1 && tomorrowWord) return `${time} tomorrow`;
  const weekday = new Date(iso).toLocaleDateString("en-US", { timeZone, weekday: "long" });
  return tomorrowWord ? `${time} ${weekday}` : `${weekday}, ${time}`;
}

function formatLength(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} minutes`;
  const hourText = hours === 1 ? "1 hour" : `${hours} hours`;
  return rest === 0 ? hourText : `${hourText} ${rest} minutes`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatShortLength(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

// "09:00" -> "9:00 am", "12:00" -> "noon"
function formatClock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === 12 && m === 0) return "noon";
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Weekly windows -> "Every day, 9:00 am to 7:00 pm" or "Mon, Wed, 9:00 am to noon; Sat, 10:00 am to 2:00 pm"
function formatAvailability(windows) {
  const byTimes = new Map();
  for (const w of windows) {
    const key = `${w.start}-${w.end}`;
    if (!byTimes.has(key)) byTimes.set(key, { start: w.start, end: w.end, days: new Set() });
    byTimes.get(key).days.add(w.weekday);
  }
  return [...byTimes.values()]
    .map(({ start, end, days }) => {
      const dayText = days.size === 7 ? "Every day" : [...days].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d]).join(", ");
      return `${dayText}, ${formatClock(start)} to ${formatClock(end)}`;
    })
    .join("; ");
}
