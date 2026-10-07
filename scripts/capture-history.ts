// Captures a salon Workflow's Event History as a replay-test fixture (binary protobuf, decoded in
// tests with @temporalio/proto). Worker identities and sticky queue names, which contain the
// machine's hostname and aren't used by replay, are replaced with neutral values.
// Usage: npx tsx scripts/capture-history.ts <workflowId> <out.binpb>
import { writeFileSync } from "node:fs";
import { Client, Connection } from "@temporalio/client";
import { temporal } from "@temporalio/proto";

const [workflowId = "juniper-waitlist", out = "tests/histories/salon-demo-run.binpb"] = process.argv.slice(2);

function scrub(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    if (key === "identity" && typeof v === "string") (value as Record<string, unknown>)[key] = "juniper-dev-worker";
    else if (typeof v === "string" && /^\d+@.+-[0-9a-f]{32}$/.test(v)) (value as Record<string, unknown>)[key] = `juniper-dev-worker-${v.slice(-32)}`;
    else scrub(v);
  }
}

(async () => {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  const history = await new Client({ connection }).workflow.getHandle(workflowId).fetchHistory();
  scrub(history);
  writeFileSync(out, temporal.api.history.v1.History.encode(history).finish());
  console.log(`Wrote ${history.events?.length} events to ${out}`);
  await connection.close();
})();
