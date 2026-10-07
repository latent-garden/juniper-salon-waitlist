# Evidence

All screenshots use **fictional** clients only. They're from one fresh salon Workflow running the **standard configuration**: 15-minute same-day reply window, no overrides.

| File | Shows |
|---|---|
| `temporal-workflow-history.png` | Temporal Web UI for Workflow `juniper-waitlist` (Event History filtered to Timer and Update events): Running status, the recorded policy, Updates (`createOpening`, `respondToOffer`) and a **real 15-minute timer**. Mia's same-day offer: `TimerStarted` (15 minutes) at 8:39:07 pm, then the same Timer ID 1 `TimerFired` at 8:54:07 pm, and the opening advances to the next client. Neutral identities only (`juniper-worker`) |
| `front-desk.png` | Staff front desk after the timeout: "No reply from Mia Lopez by 8:54 pm" and the next client holding; a declined opening; Ava's freed color held for Chloe; **Needs attention** with the Square move reminder and **Mark as recorded** |
| `openings-orchestration.png` | Openings: a same-day offer with its written deadline; Ava holding the 10:00 opening while the 11:00 opening **waits** (one pending offer per client) |
| `client-offer-phone.png` | Client offer page at phone width: the opening, the written deadline, the "we'll move your appointment" note, **Yes, book me in** / **No thanks** |
| `client-reserved-phone.png` | After accepting: **"Your new time is reserved"** and "We're updating your booking in Square from … to …" |
