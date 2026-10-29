import type Database from "better-sqlite3";

export function recordPlanActivity(
  db: Database.Database,
  roomId: string,
  eventType: string,
  summary: string,
) {
  db.prepare("INSERT INTO plan_activity(room_id, event_type, summary, created_at) VALUES (?, ?, ?, ?)")
    .run(roomId, eventType, summary, Date.now());
}
