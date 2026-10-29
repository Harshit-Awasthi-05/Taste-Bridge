import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schema = readFileSync(resolve(root, "server/schema.sql"), "utf8");

export function migratePickCategoryConstraint(db: Database.Database) {
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'picks'").get() as { sql: string } | undefined;
  if (!definition || ["tv_show", "books", "podcasts"].every((category) => definition.sql.includes(`'${category}'`))) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE picks_new (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (category IN ('dining', 'music', 'film_tv', 'tv_show', 'books', 'podcasts')),
        rank INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'replaced')),
        created_version INTEGER NOT NULL,
        qloo_id TEXT NOT NULL,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        qloo_tags TEXT NOT NULL,
        member_affinity TEXT NOT NULL,
        overlap_score REAL NOT NULL CHECK (overlap_score BETWEEN 0 AND 100),
        qloo_source TEXT NOT NULL,
        agent_blurb TEXT,
        agent_reasons TEXT,
        agent_model TEXT,
        agent_fallback INTEGER NOT NULL DEFAULT 0 CHECK (agent_fallback IN (0, 1)),
        UNIQUE (room_id, category, qloo_id)
      );
      INSERT INTO picks_new SELECT * FROM picks;
      DROP TABLE picks;
      ALTER TABLE picks_new RENAME TO picks;
      CREATE INDEX idx_picks_room ON picks(room_id, state);`);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }

  const violations = db.pragma("foreign_key_check") as { table: string; rowid: number; parent: string }[];
  if (violations.length) throw new Error(`Database category migration left ${violations.length} foreign-key violations`);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

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
  migratePickCategoryConstraint(db);
  addColumnIfMissing(db, "favorites", "source", "TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'chat', 'demo'))");
  addColumnIfMissing(db, "member_search_results", "source", "TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'chat', 'demo'))");
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
