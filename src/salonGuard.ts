// Startup guard: the salon Workflow is long-lived and started with USE_EXISTING, so a running
// Workflow keeps the policy it was started with. Never let it silently differ from the policy the
// API is configured to use. This never terminates or replaces Workflow state: it fails clearly.
import type { Client, WorkflowHandle } from "@temporalio/client";
import { policyDifferences } from "./salonConfig";
import { TASK_QUEUE, WORKFLOW_ID, type OfferPolicy } from "./types";
import { getPolicy, salonWaitlistWorkflow } from "./workflows";

export class IncompatibleSalonError extends Error {
  constructor(
    message: string,
    /** "policy-differs" is final; "unreadable" may be transient (for example, no Worker yet). */
    readonly reason: "policy-differs" | "unreadable",
  ) {
    super(message);
    this.name = "IncompatibleSalonError";
  }
}

export async function startOrAttachSalon(
  client: Client,
  policy: OfferPolicy,
  options: { workflowId?: string; taskQueue?: string; queryTimeoutMs?: number } = {},
): Promise<WorkflowHandle<typeof salonWaitlistWorkflow>> {
  const workflowId = options.workflowId ?? WORKFLOW_ID;
  const handle = await client.workflow.start(salonWaitlistWorkflow, {
    workflowId,
    taskQueue: options.taskQueue ?? TASK_QUEUE,
    args: [{ policy }],
    workflowIdConflictPolicy: "USE_EXISTING",
  });

  let running: OfferPolicy;
  try {
    // Bounded: a salon whose history can't run on this code must fail clearly, not hang.
    running = await client.connection.withDeadline(Date.now() + (options.queryTimeoutMs ?? 10_000), () => handle.query(getPolicy));
  } catch (error) {
    throw new IncompatibleSalonError(
      `Couldn't read the running salon Workflow's policy (${workflowId}). It may predate this version. ` +
        `Cause: ${(error as Error).message}`,
      "unreadable",
    );
  }
  const differences = policyDifferences(running, policy);
  if (differences.length) {
    throw new IncompatibleSalonError(
      `The running salon Workflow (${workflowId}) was started with a different policy than this API is configured to use:\n` +
        differences.map((d) => `  - ${d}`).join("\n") +
        `\nRefusing to continue: it would silently keep the old policy. Start the API with the matching ` +
        `configuration, or (development data only) terminate that Workflow deliberately and restart.`,
      "policy-differs",
    );
  }
  return handle;
}
