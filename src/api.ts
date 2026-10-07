import { readFileSync } from "node:fs";
import path from "node:path";
import { Client, Connection, WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { shouldShowFrontDesk } from "./frontDesk";
import { fromSalonLocal, resolveAppointment, resolveOpening, toSalonLocal } from "./salonCalendar";
import { resolveSalon, STANDARD_SAME_DAY_REPLY_MIN, type SalonConfig } from "./salonConfig";
import { IncompatibleSalonError, startOrAttachSalon } from "./salonGuard";
import type { NewClientInput, ServiceId } from "./types";
import {
  addClient,
  createOpening,
  getOffer,
  getSnapshot,
  includePreferredClient,
  markRecordedInSquare,
  respondToOffer,
  type salonWaitlistWorkflow,
} from "./workflows";

// Thin API: every business decision lives in the salon Workflow.

// Salon time zone, hours and reply windows come from configuration (config/salon.json,
// or JUNIPER_SALON_CONFIG). `policy` is the Workflow's input; `hours` stays here and is used to
// resolve each opening's salon-local facts and calendar before they enter the Workflow.
const configPath = process.env.JUNIPER_SALON_CONFIG ?? path.join(process.cwd(), "config", "salon.json");
const demoReplyMin = process.env.JUNIPER_SAME_DAY_REPLY_MIN;
const { policy, hours } = resolveSalon(JSON.parse(readFileSync(configPath, "utf8")) as SalonConfig, {
  sameDayReplyMin: demoReplyMin ? Number(demoReplyMin) : undefined,
});

const sameDayMin = policy.sameDayReplyMs / 60_000;
if (sameDayMin !== STANDARD_SAME_DAY_REPLY_MIN) {
  const line = "!".repeat(78);
  console.warn(
    `\n${line}\n` +
      `  DEMO OVERRIDE: same-day offers expire after ${sameDayMin} minute(s), not ${STANDARD_SAME_DAY_REPLY_MIN}.\n` +
      `  (JUNIPER_SAME_DAY_REPLY_MIN=${demoReplyMin ?? "unset"}; config ${configPath})\n` +
      `  This is not Lena's confirmed rule. Do not use it for the submitted build.\n` +
      `  A salon Workflow started now records this policy; the startup guard will refuse to\n` +
      `  attach to it later with the standard configuration.\n` +
      `${line}\n`,
  );
}

const app = express();
const publicDir = path.join(process.cwd(), "public");
app.use(express.json());

// Start the salon Workflow, or attach to the running one only if its recorded policy matches ours.
async function connectSalon(): Promise<WorkflowHandle<typeof salonWaitlistWorkflow>> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  // A neutral identity instead of the default "pid@hostname" (recorded with every Update request).
  const client = new Client({ connection, namespace: "default", identity: "juniper-api" });
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOrAttachSalon(client, policy);
    } catch (error) {
      // A policy mismatch is final. Anything else may just be the Worker still starting.
      if ((error instanceof IncompatibleSalonError && error.reason === "policy-differs") || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

const salonReady = connectSalon();
const salon = () => salonReady;

// ---- Staff pages ----
// The front desk shows only when it has something useful (src/frontDesk.ts); otherwise go to Openings.
app.get("/", async (_request, response) => {
  try {
    const handle = await salon();
    const snapshot = await handle.query(getSnapshot);
    if (!shouldShowFrontDesk(snapshot)) {
      response.redirect(302, "/openings");
      return;
    }
    response.sendFile(path.join(publicDir, "index.html"));
  } catch (error) {
    // Temporal unreachable: Openings shows the connection message and keeps retrying.
    console.error(error);
    response.redirect(302, "/openings");
  }
});
app.get("/openings", (_request, response) => response.sendFile(path.join(publicDir, "openings.html")));
app.get("/waitlist", (_request, response) => response.sendFile(path.join(publicDir, "waitlist.html")));
app.use(express.static(publicDir, { index: false }));

app.get("/api/state", async (_request, response) => {
  const handle = await salon();
  response.json(await handle.query(getSnapshot));
});

type AppointmentRequest = { date: string; time: string; service: ServiceId; stylist: string; durationMin?: number };

// A client's existing appointment, entered in salon-local terms. Its salon-local facts and calendar
// are resolved here, outside the Workflow, and recorded with addClient (as openings are).
function appointmentInput(request: AppointmentRequest) {
  const start = fromSalonLocal(request.date, request.time, hours.timeZone);
  const durationMin = Number(request.durationMin ?? policy.serviceMinutes[request.service]);
  return resolveAppointment({ start, service: request.service, stylist: request.stylist, durationMin }, hours, Date.now());
}

app.post("/api/clients", async (request, response) => {
  const handle = await salon();
  const { currentAppointment, ...client } = request.body ?? {};
  const input: NewClientInput = currentAppointment ? { ...client, currentAppointment: appointmentInput(currentAppointment) } : client;
  const created = await handle.executeUpdate(addClient, { args: [input] });
  response.status(201).json(created);
});

app.post("/api/openings", async (request, response) => {
  const { date, time, service, stylist, durationMin } = request.body ?? {};
  const handle = await salon();
  // Time-zone interpretation happens here, outside the Workflow; the result is recorded as Update input.
  const start = fromSalonLocal(date, time, hours.timeZone);
  const input = resolveOpening({ start, service, stylist, durationMin: Number(durationMin) }, hours, Date.now());
  const created = await handle.executeUpdate(createOpening, { args: [input] });
  response.status(201).json(created);
});

// Staff actions. Validators reject anything not allowed (400 via the error handler).
app.post("/api/openings/:openingId/include/:clientId", async (request, response) => {
  const handle = await salon();
  const { openingId, clientId } = request.params;
  response.json(await handle.executeUpdate(includePreferredClient, { args: [{ openingId, clientId }] }));
});

app.post("/api/openings/:openingId/recorded-in-square", async (request, response) => {
  const handle = await salon();
  response.json(await handle.executeUpdate(markRecordedInSquare, { args: [{ openingId: request.params.openingId }] }));
});

app.get("/api/offers/:offerId", async (request, response) => {
  const handle = await salon();
  const offer = await handle.query(getOffer, request.params.offerId);
  if (!offer) {
    response.status(404).json({ error: "We couldn't find this offer." });
    return;
  }
  response.json(offer);
});

app.post("/api/offers/:offerId/respond", async (request, response) => {
  const handle = await salon();
  const result = await handle.executeUpdate(respondToOffer, {
    args: [{ offerId: request.params.offerId, answer: request.body?.answer }],
  });
  response.json(result);
});

// Clearly fictional sample waitlist so reviewers can reproduce the flow.
const everyDay = (start: string, end: string) =>
  ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => ({ weekday, start, end }));

const SAMPLE_WAITLIST: NewClientInput[] = [
  {
    name: "Chloe Park",
    mobile: "(555) 010-2231",
    service: "color",
    stylistPreference: { kind: "requires", stylist: "Maria" },
    availability: everyDay("10:00", "16:00"),
    joinedAt: "2026-08-28T17:00:00.000Z",
  },
  {
    name: "Zoe Walsh",
    mobile: "(555) 010-4417",
    service: "haircut",
    stylistPreference: { kind: "requires", stylist: "Jo" },
    availability: everyDay("09:00", "19:00"),
    joinedAt: "2026-09-01T16:30:00.000Z",
  },
  {
    name: "Ava Chen",
    mobile: "(555) 010-3378",
    service: "haircut",
    stylistPreference: { kind: "any" },
    availability: everyDay("09:00", "19:00"),
    joinedAt: "2026-09-02T18:15:00.000Z",
  },
  {
    name: "Ben Ortiz",
    mobile: "(555) 010-5902",
    service: "haircut",
    stylistPreference: { kind: "prefers", stylist: "Maria" },
    availability: everyDay("12:00", "19:00"),
    joinedAt: "2026-09-08T15:45:00.000Z",
  },
  {
    name: "Dev Patel",
    mobile: "(555) 010-6644",
    service: "blowout",
    stylistPreference: { kind: "prefers", stylist: "Jo" },
    availability: everyDay("09:00", "19:00"),
    joinedAt: "2026-09-15T19:20:00.000Z",
  },
  {
    name: "Priya Shah",
    mobile: "(555) 010-8812",
    service: "color",
    stylistPreference: { kind: "any" },
    availability: everyDay("09:00", "17:00"),
    joinedAt: "2026-09-22T16:00:00.000Z",
  },
];

app.post("/api/demo/seed", async (_request, response) => {
  const handle = await salon();
  const snapshot = await handle.query(getSnapshot);
  if (snapshot.clients.length > 0) {
    response.status(409).json({ error: "The sample waitlist is already there." });
    return;
  }
  // Fictional existing appointments, relative to today, so moves and a cascade can be shown with
  // service-compatible clients: Ava (waiting for a haircut) has a 2-hour color with Maria in two days;
  // when Ava moves earlier, that color slot fits Chloe (color, only with Maria), whose own later color
  // appointment then opens for Priya (color). Ben has a haircut with Maria in three days.
  const inDays = (days: number) => toSalonLocal(new Date(Date.now() + days * 86_400_000).toISOString(), hours.timeZone).date;
  const SAMPLE_APPOINTMENTS: Record<string, AppointmentRequest> = {
    "Ava Chen": { date: inDays(2), time: "13:00", service: "color", stylist: "Maria" },
    "Chloe Park": { date: inDays(4), time: "10:00", service: "color", stylist: "Maria" },
    "Ben Ortiz": { date: inDays(3), time: "16:00", service: "haircut", stylist: "Maria" },
  };
  for (const client of SAMPLE_WAITLIST) {
    const appointment = SAMPLE_APPOINTMENTS[client.name];
    await handle.executeUpdate(addClient, {
      args: [appointment ? { ...client, currentAppointment: appointmentInput(appointment) } : client],
    });
  }
  response.status(201).json(await handle.query(getSnapshot));
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof WorkflowUpdateFailedError) {
    // A validator rejected the request (malformed input or an unknown offer).
    response.status(400).json({ error: error.cause?.message ?? error.message });
    return;
  }
  console.error(error);
  response.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected error",
  });
});

const port = Number(process.env.PORT ?? 3000);
salonReady.then(
  () => app.listen(port, () => console.log(`Juniper waitlist is available at http://localhost:${port}`)),
  (error) => {
    console.error(`\nJuniper API not started.\n${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  },
);
