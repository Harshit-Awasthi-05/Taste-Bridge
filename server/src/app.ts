import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type Database from "better-sqlite3";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Category } from "@taste-bridge/shared";
import { authenticateMember, createMemberToken, issueMemberSession } from "./session.js";
import { searchQloo, searchQlooTags, entityTypes } from "./qloo.js";
import { generateRoomPlan } from "./plan-engine.js";

const roomIdSchema = /^[A-Za-z0-9_-]{8,32}$/;
const categorySchema = z.enum(["dining", "music", "film_tv"]);
const coarseCitySchema = z.string().trim().min(2).max(100).refine((value) =>
  !/^\d[\d .,+-]*$/.test(value) &&
  !/[-+]?\d{1,2}(?:\.\d+)?\s*,\s*[-+]?\d{1,3}(?:\.\d+)?/.test(value) &&
  !/\b\d+\s+.*\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd)\b/i.test(value),
);
const events = new EventEmitter();
events.setMaxListeners(0);
const versions = new Map<string, number>();
const timestamp = () => Date.now();
let lastLocationLookup = 0;
const apiRateLimitWindowMs = 60_000;
const apiRateLimitMax = 120;
const searchRateLimitMax = 20;
const generationCooldownMs = 30_000;
type RateLimitWindow = { startedAt: number; count: number };
const configuredTtl = Number(process.env.ROOM_TTL_HOURS ?? 72);
const roomTtlHours = Number.isInteger(configuredTtl) && configuredTtl >= 24 && configuredTtl <= 168 ? configuredTtl : 72;
const roomCategories = (value: string) => JSON.parse(value) as Category[];

function getRoom(db: Database.Database, id: string) {
  return db.prepare("SELECT * FROM rooms WHERE id = ? AND expires_at > ?").get(id, timestamp()) as
    | { id: string; categories: string; city_or_area: string | null; status: string; created_at: number; expires_at: number }
    | undefined;
}

function broadcast(roomId: string) {
  const version = (versions.get(roomId) ?? 0) + 1;
  versions.set(roomId, version);
  events.emit(roomId, JSON.stringify({ type: "room_updated", roomId, version }));
}

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

function consumeRateLimit(limits: Map<string, RateLimitWindow>, key: string, max: number, now = timestamp()) {
  let window = limits.get(key);
  if (!window || now - window.startedAt >= apiRateLimitWindowMs) {
    window = { startedAt: now, count: 0 };
    limits.set(key, window);
  }
  window.count += 1;
  if (limits.size > 10_000) {
    for (const [entryKey, entry] of limits) {
      if (now - entry.startedAt >= apiRateLimitWindowMs) limits.delete(entryKey);
    }
  }
  return {
    allowed: window.count <= max,
    retryAfter: Math.max(1, Math.ceil((window.startedAt + apiRateLimitWindowMs - now) / 1000)),
  };
}

function requireMember(request: FastifyRequest, reply: FastifyReply, db: Database.Database, roomId: string) {
  const member = authenticateMember(request, db, roomId);
  if (!member) {
    apiError(reply, 401, "MEMBER_SESSION_REQUIRED", "Join this room before continuing.");
    return null;
  }
  return member;
}

function roomState(db: Database.Database, roomId: string, request: FastifyRequest, session?: { id: string; isHost: boolean }) {
  const room = getRoom(db, roomId);
  if (!room) return null;
  const me = session ?? authenticateMember(request, db, roomId);
  const memberCount = db.prepare("SELECT COUNT(*) AS count FROM members WHERE room_id = ?").get(roomId) as { count: number };
  const readyCount = db.prepare("SELECT COUNT(*) AS count FROM members WHERE room_id = ? AND ready = 1").get(roomId) as { count: number };
  const members = me ? (db.prepare("SELECT id, nickname, is_host, ready FROM members WHERE room_id = ? ORDER BY joined_at").all(roomId) as
    { id: string; nickname: string; is_host: number; ready: number }[]).map((member) => {
    const favorites = db.prepare("SELECT qloo_id AS qlooId, name, entity_type AS entityType FROM favorites WHERE member_id = ? ORDER BY rowid").all(member.id);
    return { id: member.id, nickname: member.nickname, isHost: member.is_host === 1, ready: member.ready === 1, favorites };
  }) : [];
  const plan = db.prepare("SELECT version, status, error_code FROM plans WHERE room_id = ?").get(roomId) as
    | { version: number; status: string; error_code: string | null }
    | undefined;
  const picks = me && plan && plan.version > 0
    ? db.prepare(`SELECT id, category, rank, qloo_id AS entityId, name, entity_type AS type,
        qloo_tags AS tags, member_affinity AS memberAffinity, overlap_score AS overlapScore,
        qloo_source AS source, agent_blurb AS blurb, agent_reasons AS reasons,
        agent_model AS model, agent_fallback AS fallback
      FROM picks WHERE room_id = ? AND state = 'active' ORDER BY category, rank`).all(roomId).map((pick) => {
      const item = pick as Record<string, unknown>;
      const votes = db.prepare("SELECT direction, COUNT(*) AS count FROM votes WHERE pick_id = ? GROUP BY direction").all(item.id) as { direction: string; count: number }[];
      const mine = me ? db.prepare("SELECT direction FROM votes WHERE member_id = ? AND pick_id = ?").get(me.id, item.id) as { direction: "up" | "down" } | undefined : undefined;
      return {
        pickId: item.id,
        category: item.category,
        rank: item.rank,
        qloo: {
          entityId: item.entityId,
          name: item.name,
          type: item.type,
          tags: JSON.parse(String(item.tags)),
          memberAffinity: JSON.parse(String(item.memberAffinity)),
          overlapScore: item.overlapScore,
          scoreMethod: "normalized_qloo_recommendation_rank",
          source: JSON.parse(String(item.source)),
        },
        agent: {
          generatedBy: "ai",
          model: item.model,
          fallback: item.fallback === 1,
          blurb: item.blurb,
          reasons: JSON.parse(String(item.reasons)),
        },
        votes: {
          up: votes.find((vote) => vote.direction === "up")?.count ?? 0,
          down: votes.find((vote) => vote.direction === "down")?.count ?? 0,
          mine: mine?.direction ?? null,
        },
        state: "active",
      };
    })
    : [];
  const chatMessages = me
    ? (db.prepare(`SELECT chat_messages.id, chat_messages.member_id AS memberId,
        members.nickname, chat_messages.text, chat_messages.created_at AS createdAt
      FROM chat_messages JOIN members ON members.id = chat_messages.member_id
      WHERE chat_messages.room_id = ? ORDER BY chat_messages.created_at DESC LIMIT 100`).all(roomId) as
      { id: string; memberId: string; nickname: string; text: string; createdAt: number }[]).reverse()
    : [];
  return {
    id: room.id,
    categories: roomCategories(room.categories),
    city: room.city_or_area,
    status: room.status,
    createdAt: new Date(room.created_at).toISOString(),
    expiresAt: new Date(room.expires_at).toISOString(),
    memberCount: memberCount.count,
    readyCount: readyCount.count,
    members,
    planVersion: plan?.version ?? 0,
    planStatus: plan?.status ?? "gathering",
    planError: plan?.error_code ?? null,
    picks,
    chatMessages,
    me: me ? {
      memberId: me.id,
      isHost: me.isHost,
      ready: members.find((member) => member.id === me.id)?.ready ?? false,
    } : null,
  };
}

function verifyOrigin(request: FastifyRequest, reply: FastifyReply) {
  const origin = request.headers.origin;
  if (!origin) {
    apiError(reply, 403, "ORIGIN_REQUIRED", "A same-origin request is required.");
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    apiError(reply, 403, "INVALID_ORIGIN", "The request origin is invalid.");
    return false;
  }
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0];
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",")[0];
  const protocol = forwardedProtocol || (request.protocol === "https" ? "https" : "http");
  const expected = `${protocol}://${forwardedHost || request.headers.host}`;
  const developmentOrigins = process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4000", "http://127.0.0.1:4000"];
  if (origin !== expected && !developmentOrigins.includes(origin)) {
    apiError(reply, 403, "ORIGIN_NOT_ALLOWED", "The request origin is not allowed.");
    return false;
  }
  return true;
}

export function createApp(db: Database.Database, qloo: Client | null, options: { webRoot?: string; logger?: boolean } = {}) {
  const logger = options.logger === false ? false : {
    redact: {
      paths: ["req.url", "req.headers.cookie", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
  };
  const app = Fastify({ logger, bodyLimit: 32 * 1024 });
  const webRoot = options.webRoot ?? resolve(process.cwd(), "web", "dist");
  const apiRequestWindows = new Map<string, RateLimitWindow>();
  const searchRequestWindows = new Map<string, RateLimitWindow>();
  app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !verifyOrigin(request, reply)) return reply;
    if (!request.url.startsWith("/api/") || request.url === "/api/health") return;
    const limit = consumeRateLimit(apiRequestWindows, request.ip, apiRateLimitMax);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfter));
      return apiError(reply, 429, "RATE_LIMITED", "Too many requests. Please wait before trying again.");
    }
  });

  app.get("/api/health", async () => ({ status: "ok", qlooConnected: Boolean(qloo) }));

  app.post("/api/location/resolve", async (request, reply) => {
    const body = z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }).safeParse(request.body);
    if (!body.success) return apiError(reply, 400, "INVALID_LOCATION", "A valid browser location is required.");
    const wait = 1_000 - (timestamp() - lastLocationLookup);
    if (wait > 0) return apiError(reply, 429, "LOCATION_LOOKUP_RATE_LIMITED", "Wait a moment before trying location lookup again.");
    lastLocationLookup = timestamp();
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "10");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("lat", String(body.data.latitude));
    url.searchParams.set("lon", String(body.data.longitude));
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "TasteBridge/0.1.0 (coarse city lookup)" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return apiError(reply, 502, "LOCATION_LOOKUP_FAILED", "Could not turn that location into a city. Enter one instead.");
      const result = await response.json() as { address?: Record<string, unknown> };
      const address = result.address ?? {};
      const locality = address.city ?? address.town ?? address.village ?? address.municipality ?? address.county;
      if (typeof locality !== "string" || !locality.trim()) return apiError(reply, 422, "CITY_NOT_FOUND", "No city or area was found. Enter one instead.");
      const region = typeof address.state === "string" ? address.state : null;
      return { city: [locality, region].filter(Boolean).join(", ") };
    } catch {
      request.log.warn({ code: "LOCATION_LOOKUP_FAILED" }, "Coarse location lookup did not complete");
      return apiError(reply, 502, "LOCATION_LOOKUP_FAILED", "Could not turn that location into a city. Enter one instead.");
    }
  });

  app.post("/api/rooms", async (request, reply) => {
    const body = z.object({
      nickname: z.string().trim().min(1).max(24).regex(/^[^\u0000-\u001f\u007f]+$/),
      categories: z.array(categorySchema).min(1).max(3).refine((items) => new Set(items).size === items.length),
      city: coarseCitySchema.nullable().optional(),
    }).safeParse(request.body);
    if (!body.success) return apiError(reply, 400, "INVALID_ROOM", "Add a nickname, at least one category, and a valid city when planning dining.");
    if (body.data.categories.includes("dining") && !body.data.city) return apiError(reply, 400, "CITY_REQUIRED", "Add a city or area for dining plans.");
    const roomId = randomUUID().replaceAll("-", "").slice(0, 16);
    const memberId = randomUUID();
    const { token, hash } = createMemberToken();
    const now = timestamp();
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO rooms(id, categories, city_or_area, status, created_at, expires_at) VALUES (?, ?, ?, 'gathering', ?, ?)")
          .run(roomId, JSON.stringify(body.data.categories), body.data.city ?? null, now, now + roomTtlHours * 60 * 60_000);
        db.prepare("INSERT INTO members(id, room_id, nickname, token_hash, is_host, ready, joined_at) VALUES (?, ?, ?, ?, 1, 0, ?)")
          .run(memberId, roomId, body.data.nickname, hash, now);
      })();
    } catch (error) {
      request.log.error(error);
      return apiError(reply, 409, "ROOM_CREATE_FAILED", "Could not create the room.");
    }
    issueMemberSession(reply, roomId, memberId, token);
    broadcast(roomId);
    return reply.code(201).send({ room: roomState(db, roomId, request, { id: memberId, isHost: true }), shareUrl: `/r/${roomId}` });
  });

  app.post("/api/rooms/:roomId/join", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const body = z.object({ nickname: z.string().trim().min(1).max(24).regex(/^[^\u0000-\u001f\u007f]+$/) }).safeParse(request.body);
    if (!roomIdSchema.test(roomId) || !body.success) return apiError(reply, 400, "INVALID_JOIN", "Check the room link and nickname.");
    const room = getRoom(db, roomId);
    if (!room) return apiError(reply, 404, "ROOM_NOT_FOUND", "This room has expired or does not exist.");
    if (room.status !== "gathering") return apiError(reply, 409, "ROOM_CLOSED", "This room is no longer accepting members.");
    const count = db.prepare("SELECT COUNT(*) AS count FROM members WHERE room_id = ?").get(roomId) as { count: number };
    if (count.count >= 6) return apiError(reply, 409, "ROOM_FULL", "This room already has six members.");
    const memberId = randomUUID();
    const { token, hash } = createMemberToken();
    try {
      db.prepare("INSERT INTO members(id, room_id, nickname, token_hash, joined_at) VALUES (?, ?, ?, ?, ?)").run(memberId, roomId, body.data.nickname, hash, timestamp());
    } catch (error) {
      if (String(error).includes("UNIQUE")) return apiError(reply, 409, "NICKNAME_TAKEN", "That nickname is already in use in this room.");
      throw error;
    }
    issueMemberSession(reply, roomId, memberId, token);
    broadcast(roomId);
    return reply.code(201).send({ room: roomState(db, roomId, request, { id: memberId, isHost: false }) });
  });

  app.get("/api/rooms/:roomId", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    if (!roomIdSchema.test(roomId)) return apiError(reply, 400, "INVALID_ROOM_ID", "Invalid room link.");
    const state = roomState(db, roomId, request);
    return state ? { room: state } : apiError(reply, 404, "ROOM_NOT_FOUND", "This room has expired or does not exist.");
  });

  app.get("/api/rooms/:roomId/events", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    if (!roomIdSchema.test(roomId)) return apiError(reply, 404, "ROOM_NOT_FOUND", "Room not found.");
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    if (!getRoom(db, roomId)) return apiError(reply, 404, "ROOM_NOT_FOUND", "Room not found.");
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (payload: string) => response.write(`event: room_updated\ndata: ${payload}\n\n`);
    const listener = (payload: string) => send(payload);
    events.on(roomId, listener);
    send(JSON.stringify({ type: "room_updated", roomId, version: versions.get(roomId) ?? 0 }));
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      events.off(roomId, listener);
      if (!getRoom(db, roomId) && events.listenerCount(roomId) === 0) versions.delete(roomId);
    };
    const heartbeat = setInterval(() => {
      if (!getRoom(db, roomId)) {
        send(JSON.stringify({ type: "room_expired", roomId }));
        response.end();
        cleanup();
        return;
      }
      response.write(": keep-alive\n\n");
    }, 20_000);
    response.on("close", cleanup);
  });

  app.post("/api/rooms/:roomId/chat", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    if (!getRoom(db, roomId)) return apiError(reply, 404, "ROOM_NOT_FOUND", "This room has expired or does not exist.");
    const body = z.object({ text: z.string().trim().min(1).max(500) }).safeParse(request.body);
    if (!body.success) return apiError(reply, 400, "INVALID_CHAT_MESSAGE", "Messages must contain 1 to 500 characters.");
    db.prepare("INSERT INTO chat_messages(id, room_id, member_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), roomId, member.id, body.data.text, timestamp());
    broadcast(roomId);
    return { room: roomState(db, roomId, request) };
  });

  app.get("/api/rooms/:roomId/search", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    const query = z.object({ q: z.string().trim().min(2).max(100), type: z.enum(["dining", "music", "film_tv", "tag"]) }).safeParse(request.query);
    if (!query.success) return apiError(reply, 400, "INVALID_SEARCH", "Enter at least two characters and choose a favorite type.");
    if (/(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})|(?:\+?\d[\d\s().-]{7,}\d)/.test(query.data.q)) return apiError(reply, 400, "PERSONAL_DATA_BLOCKED", "Search for a public entity, not an email address or phone number.");
    const limit = consumeRateLimit(searchRequestWindows, member.id, searchRateLimitMax);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfter));
      return apiError(reply, 429, "SEARCH_RATE_LIMITED", "Too many searches. Please wait a minute before searching again.");
    }
    try {
      let results: Awaited<ReturnType<typeof searchQloo>>;
      if (query.data.type === "tag") {
        if (!qloo) return apiError(reply, 503, "QLOO_UNAVAILABLE", "Qloo tag search is unavailable right now.");
        results = await searchQlooTags(qloo, query.data.q);
      } else {
        results = await searchQloo(query.data.q, entityTypes[query.data.type]);
      }
      const upsert = db.prepare(`INSERT OR REPLACE INTO member_search_results
        (member_id, qloo_id, name, entity_type, subtitle, image_url, searched_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const now = timestamp();
      db.transaction(() => results.forEach((result) => upsert.run(member.id, result.id, result.name, result.entityType, result.description, result.imageUrl, now)))();
      return { results: results.map((item) => ({ ...item, subtitle: item.description })) };
    } catch (error) {
      request.log.error({ err: error }, "Qloo search failed");
      return apiError(reply, 502, "QLOO_SEARCH_FAILED", "Qloo search is unavailable right now.");
    }
  });

  app.put("/api/rooms/:roomId/favorites", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    const body = z.object({ qlooIds: z.array(z.string().min(1).max(200)).min(2).max(4).refine((items) => new Set(items).size === items.length) }).safeParse(request.body);
    if (!body.success) return apiError(reply, 400, "INVALID_FAVORITES", "Confirm two to four different Qloo matches.");
    const room = getRoom(db, roomId);
    if (!room || room.status !== "gathering") return apiError(reply, 409, "ROOM_CLOSED", "Favorites can no longer be changed.");
    const placeholders = body.data.qlooIds.map(() => "?").join(",");
    const selected = db.prepare(`SELECT qloo_id, name, entity_type FROM member_search_results WHERE member_id = ? AND qloo_id IN (${placeholders})`)
      .all(member.id, ...body.data.qlooIds) as { qloo_id: string; name: string; entity_type: string }[];
    if (selected.length !== body.data.qlooIds.length) return apiError(reply, 400, "SEARCH_RESULT_REQUIRED", "Favorites must be selected from your own recent Qloo search results.");
    const save = db.transaction(() => {
      db.prepare("DELETE FROM favorites WHERE member_id = ?").run(member.id);
      const insert = db.prepare("INSERT INTO favorites(member_id, qloo_id, name, entity_type) VALUES (?, ?, ?, ?)");
      selected.forEach((item) => insert.run(member.id, item.qloo_id, item.name, item.entity_type));
      db.prepare("UPDATE members SET ready = 1 WHERE id = ?").run(member.id);
    });
    save();
    broadcast(roomId);
    return { room: roomState(db, roomId, request) };
  });

  app.post("/api/rooms/:roomId/plan", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    if (!member.isHost) return apiError(reply, 403, "HOST_REQUIRED", "Only the room creator can make or regenerate a plan.");
    if (!qloo) return apiError(reply, 503, "QLOO_UNAVAILABLE", "The Qloo MCP connection is unavailable.");
    const room = getRoom(db, roomId);
    if (!room) return apiError(reply, 404, "ROOM_NOT_FOUND", "This room has expired or does not exist.");
    const roster = db.prepare("SELECT COUNT(*) AS count, SUM(ready) AS ready FROM members WHERE room_id = ?").get(roomId) as { count: number; ready: number };
    if (roster.count < 3 || roster.ready !== roster.count) return apiError(reply, 409, "MEMBERS_NOT_READY", "At least three people must join and confirm favorites before making a plan.");
    if (room.status === "generating") return apiError(reply, 409, "PLAN_IN_PROGRESS", "The plan is already being generated.");
    const previousPlan = db.prepare("SELECT version, status, updated_at FROM plans WHERE room_id = ?").get(roomId) as
      { version: number; status: string; updated_at: number } | undefined;
    if (previousPlan && previousPlan.status !== "generating") {
      const remaining = generationCooldownMs - (timestamp() - (previousPlan?.updated_at ?? 0));
      if (remaining > 0) {
        reply.header("Retry-After", String(Math.ceil(remaining / 1000)));
        return apiError(reply, 429, "PLAN_COOLDOWN", "Please wait briefly before generating another plan.");
      }
    }
    const isRegeneration = (previousPlan?.version ?? 0) > 0;
    if (isRegeneration) {
      db.transaction(() => {
        const active = db.prepare("SELECT category, qloo_id FROM picks WHERE room_id = ? AND state = 'active'").all(roomId) as { category: string; qloo_id: string }[];
        const reject = db.prepare("INSERT OR IGNORE INTO rejected_entities(room_id, category, qloo_id, rejected_at) VALUES (?, ?, ?, ?)");
        active.forEach((pick) => reject.run(roomId, pick.category, pick.qloo_id, timestamp()));
      })();
    }
    db.prepare("INSERT OR REPLACE INTO plans(room_id, version, status, error_code, updated_at) VALUES (?, ?, 'generating', NULL, ?)").run(roomId, previousPlan?.version ?? 0, timestamp());
    db.prepare("UPDATE rooms SET status = 'generating' WHERE id = ?").run(roomId);
    broadcast(roomId);
    void generateRoomPlan(db, qloo, roomId).then(() => {
      broadcast(roomId);
    }).catch((error: unknown) => {
      request.log.error({ err: error }, "Plan generation failed");
      db.prepare("UPDATE plans SET status = 'failed', error_code = 'GENERATION_FAILED', updated_at = ? WHERE room_id = ?").run(timestamp(), roomId);
      db.prepare("UPDATE rooms SET status = 'failed' WHERE id = ?").run(roomId);
      broadcast(roomId);
    });
    return reply.code(202).send({ status: "generating" });
  });

  app.put("/api/rooms/:roomId/picks/:pickId/vote", async (request, reply) => {
    const { roomId, pickId } = request.params as { roomId: string; pickId: string };
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    const body = z.object({ direction: z.enum(["up", "down"]).nullable() }).safeParse(request.body);
    if (!body.success) return apiError(reply, 400, "INVALID_VOTE", "Choose an upvote, downvote, or remove your vote.");
    const pick = db.prepare("SELECT id FROM picks WHERE id = ? AND room_id = ? AND state = 'active'").get(pickId, roomId);
    if (!pick) return apiError(reply, 404, "PICK_NOT_FOUND", "That plan pick is no longer active.");
    if (body.data.direction === null) db.prepare("DELETE FROM votes WHERE member_id = ? AND pick_id = ?").run(member.id, pickId);
    else db.prepare("INSERT OR REPLACE INTO votes(member_id, pick_id, direction, voted_at) VALUES (?, ?, ?, ?)").run(member.id, pickId, body.data.direction, timestamp());
    broadcast(roomId);
    return { room: roomState(db, roomId, request) };
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/") && existsSync(resolve(webRoot, "index.html"))) return reply.sendFile("index.html");
    return apiError(reply, 404, "NOT_FOUND", "Route not found.");
  });
  if (existsSync(webRoot)) app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  return app;
}
