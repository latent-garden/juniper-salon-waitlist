import { NativeConnection, Worker } from "@temporalio/worker";
import { TASK_QUEUE } from "./types";

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    // A neutral identity: the default is "pid@hostname", which would put the machine name into
    // every Workflow history (and the Web UI).
    identity: "juniper-worker",
  });
  console.log(`Worker is polling the ${TASK_QUEUE} task queue.`);
  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

