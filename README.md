# Juniper Salon waitlist

**Juniper** is a front-desk waitlist for a small salon. When an appointment is cancelled, staff add the opening. Juniper offers it to waitlisted clients **one at a time**, in the order they joined, to the first person who fits:
- the service
- the length
- their availability
- their stylist rule

Each client has a written reply deadline. If they say no or don't reply in time, the next person is offered it automatically. Two people are never promised the same slot.

It replaces the salon's spreadsheet-and-texting routine, where follow-ups were forgotten and freed slots were never re-offered.

**Why Temporal:** the process runs for minutes or days and must survive restarts without double-booking anyone. One long-running salon Workflow owns all openings, offers and clients:
- every reply is an atomic Update
- every reply deadline is a durable timer
- the event history shows exactly what happened

## Run it (one command)

Requirements: **Node.js 20+** (tested on 26) and **Docker** (Docker Desktop, or Colima on macOS). **Docker must already be running.**

```bash
npm install && npm run dev
```

This installs dependencies, then starts Temporal (in Docker), the Worker and the API.

- **App:** <http://localhost:3000>
- **Temporal Web UI:** <http://localhost:8233> (Workflow ID `juniper-waitlist`)

```bash
npm test           # unit, Workflow (local Temporal test server), replay and rendering tests
npm run typecheck
npm run stop       # stop Temporal (data is kept)
```

**To start completely fresh** (fictional development data only): `docker compose down -v`, then `npm run dev`.

## Demo walkthrough (about 5 minutes, plus one optional 15-minute wait)
1. **Add the sample waitlist.** On **Waitlist**, choose **Add the sample waitlist**. Everyone is fictional; some clients already have a later appointment.
2. **Add an opening.** On **Openings**, choose **Add opening**: tomorrow 10:00 am, Haircut, Maria, 45 minutes. It's offered to Ava Chen, the earliest-joined client who fits.
3. **One client, one offer.** Add a second opening (tomorrow 11:00 am, same details). Ava already holds an offer, so it shows **"Waiting for an eligible client to become available"**.
4. **Decline.** Use **Open offer** on Ava's row (this simulates the text link) and choose **No thanks**. The 11:00 opening is offered to Ava straight away.
5. **Accept and move.** Accept the 11:00 offer. Ava's page says **"Your new time is reserved"**. Ava's existing appointment (a 2-hour color, two days out) becomes a **new opening** and is offered to the next client who fits it (Chloe, who wants a color). On the **front desk** (`/`), **Needs attention** shows **"Move Ava Chen's booking in Square"**. Choose **Mark as recorded** once it's done.
6. **No reply (optional, real time):** add an opening for **today**, a little later than now. The offer holds for **15 minutes**. Leave it, and when the timer fires, the next client is offered it ("No reply from … by …").
7. **Staff inclusion:** add tomorrow 10:00 am, **Blowout**, Maria. Only Dev Patel wants a blowout, and Dev *prefers* Jo, so the row shows **"No automatic match"** and **"Dev Patel prefers Jo"** with a quiet **"Include for this opening"** action. Including Dev offers it through the normal process.

## Configuration

`config/salon.json` holds the salon's **time zone** and **weekly hours**. These are **sample prototype values**, since we don't have the real salon's hours. It also holds the reply windows.

**Reply rules:**
- **Same-day openings:** 15 minutes.
- **Later-day openings:** until closing on the day the offer is sent.
- **Sent near or after closing:** until the next morning's opening time.
- **Never past the appointment start.**

The API resolves time-zone facts outside the Workflow (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

**Environment variables:**
- `JUNIPER_SALON_CONFIG`: an alternative config file.
- `JUNIPER_SAME_DAY_REPLY_MIN`: **for demos only**. It prints a warning, and the startup guard won't attach a standard-configuration API to a salon started with it.

## Simulated, and out of scope
- **Text messages are simulated:** the client "text" is the offer page link. No SMS is sent.
- **Square isn't integrated:** Juniper never reads or writes Square. Staff update Square and mark the reminder done.
- **Not built:**
  - an add-client form (the sample waitlist and API only)
  - cancelling openings
  - editing or removing clients
  - client cancellations after booking

## More
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works, determinism, and known limitations
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md): every requirement, its source (customer-confirmed or prototype assumption), and how it's verified
- [evidence/](evidence/): the Temporal Web UI screenshot and product screenshots
