import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schema = readFileSync(resolve(root, "server/schema.sql"), "utf8");

export function openDb(configuredPath = process.env.DATABASE_PATH ?? resolve(root, "data/taste-bridge.db")): Database.Database {
  const path = configuredPath === ":memory:"
    ? configuredPath
    : isAbsolute(configuredPath) ? configuredPath : resolve(root, configuredPath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(schema);
  return db;
}

export function sweepExpiredRooms(db: Database.Database, now = Date.now()) {
  return db.transaction(() => {
    const rooms = db.prepare("DELETE FROM rooms WHERE expires_at <= ?").run(now).changes;
    db.prepare("DELETE FROM member_search_results WHERE searched_at <= ?").run(now - 24 * 60 * 60_000);
    db.prepare("DELETE FROM qloo_cache WHERE expires_at <= ?").run(now);
    return rooms;
  })();
}
