import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, sweepExpiredRooms } from "./db.js";
import { createApp } from "./app.js";
import { connectQloo } from "./qloo.js";

const db = openDb();
const removed = sweepExpiredRooms(db);
if (removed) console.info(`Removed ${removed} expired room(s).`);
const cleanup = setInterval(() => {
  const count = sweepExpiredRooms(db);
  if (count) console.info(`Removed ${count} expired room(s).`);
}, 60 * 60_000);
cleanup.unref();

let qloo: Awaited<ReturnType<typeof connectQloo>> | null = null;
try {
  qloo = await connectQloo();
  console.info("Qloo MCP connected.");
} catch (error) {
  console.warn("Qloo MCP is unavailable; search and plan generation will report unavailable.", error);
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const app = createApp(db, qloo, { webRoot });
app.addHook("onClose", async () => {
  clearInterval(cleanup);
  db.close();
  if (qloo) await qloo.close();
});

const port = Number(process.env.PORT ?? 4000);
try {
  await app.listen({ host: process.env.HOST ?? "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
