import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";

function cookieName(roomId: string) {
  return `tb_${roomId}`;
}

export function issueMemberSession(reply: FastifyReply, roomId: string, memberId: string, token: string) {
  reply.setCookie(cookieName(roomId), `${memberId}.${token}`, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function createMemberToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export function authenticateMember(
  request: FastifyRequest,
  db: Database.Database,
  roomId: string,
) {
  const value = request.cookies[cookieName(roomId)];
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator < 1) return null;
  const memberId = value.slice(0, separator);
  const token = value.slice(separator + 1);
  const row = db.prepare(
    "SELECT id, room_id, token_hash, is_host FROM members WHERE id = ? AND room_id = ?",
  ).get(memberId, roomId) as
    | { id: string; room_id: string; token_hash: string; is_host: number }
    | undefined;
  if (!row) return null;
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(row.token_hash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { id: row.id, isHost: row.is_host === 1 };
}
