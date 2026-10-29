import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
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
import { recordPlanActivity } from "./activity.js";

const roomIdSchema = /^[A-Za-z0-9_-]{8,32}$/;
const categorySchema = z.enum(["dining", "music", "film_tv", "tv_show", "books", "podcasts"]);
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
const demoNicknames = ["Demo Maya", "Demo Jordan"] as const;
const demoConversation = [
  { nickname: "Demo Maya", text: "I’m up for a relaxed plan with everyone." },
  { nickname: "Demo Jordan", text: "Sounds good. It’ll be fun to see what the group picks." },
  { nickname: "Demo Maya", text: "Agreed—let’s see what everyone likes." },
] as const;
const demoSearchTerms: Record<Category, [string, string, string]> = {
  dining: ["Japanese restaurant", "noodle restaurant", "Italian restaurant"],
  music: ["Radiohead", "Khruangbin", "Björk"],
  film_tv: ["Spirited Away", "Spider-Man: Into the Spider-Verse", "Everything Everywhere All at Once"],
  tv_show: ["The Bear", "Severance", "Abbott Elementary"],
  books: ["Project Hail Mary", "The Hobbit", "Pachinko"],
  podcasts: ["Planet Money", "99% Invisible", "Radiolab"],
};
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

function consumeRateLimit(limits: Map<string, RateLimitWindow>, key: string, max: number, cost = 1, now = timestamp()) {
  let window = limits.get(key);
  if (!window || now - window.startedAt >= apiRateLimitWindowMs) {
    window = { startedAt: now, count: 0 };
    limits.set(key, window);
  }
  window.count += cost;
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

function redactNicknames(text: string, nicknames: string[]) {
  return nicknames.reduce((result, nickname) => {
    const escaped = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return result.replace(new RegExp(escaped, "gi"), "");
  }, text);
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
  const members = me ? (db.prepare(`SELECT members.id, members.nickname, members.is_host, members.ready,
      EXISTS (SELECT 1 FROM chat_messages WHERE chat_messages.member_id = members.id) AS has_chatted
      FROM members WHERE members.room_id = ? ORDER BY members.joined_at`).all(roomId) as
    { id: string; nickname: string; is_host: number; ready: number; has_chatted: number }[]).map((member) => {
    const favorites = db.prepare("SELECT qloo_id AS qlooId, name, entity_type AS entityType, source FROM favorites WHERE member_id = ? ORDER BY rowid").all(member.id);
    return { id: member.id, nickname: member.nickname, isHost: member.is_host === 1, ready: member.ready === 1, hasChatted: member.has_chatted === 1, favorites };
  }) : [];
  const plan = db.prepare("SELECT version, status, error_code, updated_at FROM plans WHERE room_id = ?").get(roomId) as
    | { version: number; status: string; error_code: string | null; updated_at: number }
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
  const planActivity = me
    ? (db.prepare("SELECT id, event_type AS eventType, summary, created_at AS createdAt FROM plan_activity WHERE room_id = ? ORDER BY id DESC LIMIT 100").all(roomId) as
      { id: number; eventType: string; summary: string; createdAt: number }[]).reverse()
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
    planCooldownSeconds: plan && plan.status !== "generating"
      ? Math.max(0, Math.ceil((plan.updated_at + generationCooldownMs - timestamp()) / 1000))
      : 0,
    picks,
    planActivity,
    chatMessages,
    me: me ? {
      memberId: me.id,
      isHost: me.isHost,
      ready: members.find((member) => member.id === me.id)?.ready ?? false,
    } : null,
  };
}

function beginPlanGeneration(db: Database.Database, qloo: Client, request: FastifyRequest, roomId: string, version: number) {
  if (version > 0) {
    db.transaction(() => {
      const active = db.prepare("SELECT category, qloo_id FROM picks WHERE room_id = ? AND state = 'active'").all(roomId) as { category: string; qloo_id: string }[];
      const reject = db.prepare("INSERT OR IGNORE INTO rejected_entities(room_id, category, qloo_id, rejected_at) VALUES (?, ?, ?, ?)");
      active.forEach((pick) => reject.run(roomId, pick.category, pick.qloo_id, timestamp()));
      if (active.length) {
        recordPlanActivity(db, roomId, "rejected_picks", `Excluded ${active.length} picks from the previous plan before regeneration.`);
      }
    })();
  }
  db.prepare("INSERT OR REPLACE INTO plans(room_id, version, status, error_code, updated_at) VALUES (?, ?, 'generating', NULL, ?)").run(roomId, version, timestamp());
  db.prepare("UPDATE rooms SET status = 'generating' WHERE id = ?").run(roomId);
  broadcast(roomId);
  void generateRoomPlan(db, qloo, roomId).then(() => {
    broadcast(roomId);
  }).catch((error: unknown) => {
    request.log.error({ err: error }, "Plan generation failed");
    recordPlanActivity(db, roomId, "plan_failed", "Plan generation failed; check Qloo availability and try again after the cooldown.");
    db.prepare("UPDATE plans SET status = 'failed', error_code = 'GENERATION_FAILED', updated_at = ? WHERE room_id = ?").run(timestamp(), roomId);
    db.prepare("UPDATE rooms SET status = 'failed' WHERE id = ?").run(roomId);
    broadcast(roomId);
  });
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
  const demoSeedingRooms = new Set<string>();
  app.register(helmet);
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
      categories: z.array(categorySchema).min(1).max(6).refine((items) => new Set(items).size === items.length),
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

  app.post("/api/rooms/:roomId/chat-suggestions", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    const room = getRoom(db, roomId);
    if (!room) return apiError(reply, 404, "ROOM_NOT_FOUND", "This room has expired or does not exist.");
    if (!process.env.QLOO_API_KEY) return apiError(reply, 503, "QLOO_CREDENTIAL_REQUIRED", "Configure the server's Qloo API key to suggest live Qloo entities.");

    const recentMessages = (db.prepare(`SELECT text FROM chat_messages
      WHERE room_id = ? AND member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5`).all(roomId, member.id) as { text: string }[])
      .reverse().map(({ text }) => text);
    if (recentMessages.length < 3) {
      return apiError(reply, 409, "CHAT_CONTEXT_REQUIRED", "Send at least three chat messages before asking for suggestions.");
    }

    const nicknames = (db.prepare("SELECT nickname FROM members WHERE room_id = ?").all(roomId) as { nickname: string }[])
      .map(({ nickname }) => nickname);
    const safeMessages = recentMessages.map((text) => redactNicknames(text, nicknames));
    if (safeMessages.every((text) => !text.trim())) {
      return apiError(reply, 422, "CHAT_CONTEXT_EMPTY", "Your recent messages do not contain any text to search.");
    }
    const fallbackKeywords = () => [...new Map(safeMessages.slice(-3)
      .map((text) => text.trim().slice(0, 100))
      .filter(Boolean)
      .map((text) => [text.toLocaleLowerCase(), text])).values()];
    let keywords = fallbackKeywords();
    let keywordSource: "gemini" | "messages" = "messages";
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(geminiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: JSON.stringify({
              messages: safeMessages,
              instruction: "Extract 1 to 3 concise public-interest keywords that could identify places, music artists, or movies. Return only JSON shaped as {\"keywords\":[\"...\"]}. Do not include personal names, nicknames, emails, phone numbers, or explanations.",
            }) }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0 },
          }),
          signal: AbortSignal.timeout(6_000),
        });
        if (!response.ok) throw new Error(`Gemini keyword extraction failed with HTTP ${response.status}`);
        const payload = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = payload.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
        if (!text) throw new Error("Gemini returned no keyword content");
        const parsed = z.object({
          keywords: z.array(z.string().trim().min(2).max(100))
            .min(1).max(3)
            .refine((items) => items.every((item) =>
              !/(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})|(?:\+?\d[\d\s().-]{7,}\d)/.test(item) &&
              !nicknames.some((nickname) => item.toLocaleLowerCase().includes(nickname.toLocaleLowerCase())))),
        }).safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error("Gemini returned invalid keywords");
        keywords = [...new Map(parsed.data.keywords.map((item) => [item.toLocaleLowerCase(), item])).values()];
        keywordSource = "gemini";
      } catch {
        request.log.warn("Gemini keyword extraction unavailable; searching recent messages directly");
      }
    }

    const tasks = keywords.flatMap((keyword) => roomCategories(room.categories).map((category) => ({
      keyword,
      category,
      entityType: entityTypes[category],
    })));
    const limit = consumeRateLimit(searchRequestWindows, member.id, searchRateLimitMax, tasks.length);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfter));
      return apiError(reply, 429, "SEARCH_RATE_LIMITED", "Too many searches. Please wait a minute before asking for suggestions.");
    }

    try {
      const responses = await Promise.all(tasks.map(async (task) => ({
        task,
        results: await searchQloo(task.keyword, task.entityType),
      })));
      const uniqueResults = new Map<string, Awaited<ReturnType<typeof searchQloo>>[number]>();
      const maxResults = Math.max(0, ...responses.map((response) => response.results.length));
      for (let rank = 0; rank < maxResults && uniqueResults.size < 3; rank += 1) {
        for (const response of responses) {
          const result = response.results[rank];
          if (result && !uniqueResults.has(result.id)) uniqueResults.set(result.id, result);
          if (uniqueResults.size === 3) break;
        }
      }
      const results = [...uniqueResults.values()];
      const now = timestamp();
      const saveSearch = db.prepare(`INSERT OR REPLACE INTO member_search_results
        (member_id, qloo_id, name, entity_type, subtitle, image_url, source, searched_at) VALUES (?, ?, ?, ?, ?, ?, 'chat', ?)`);
      db.transaction(() => results.forEach((result) =>
        saveSearch.run(member.id, result.id, result.name, result.entityType, result.description, result.imageUrl, now)))();
      return { results: results.map((item) => ({ ...item, subtitle: item.description })), keywords, keywordSource };
    } catch (error) {
      request.log.error({ err: error }, "Qloo chat suggestions failed");
      return apiError(reply, 502, "QLOO_SUGGESTIONS_FAILED", "Could not load Qloo suggestions from chat right now.");
    }
  });

  app.get("/api/rooms/:roomId/search", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    const query = z.object({ q: z.string().trim().min(2).max(100), type: z.enum(["dining", "music", "film_tv", "tv_show", "books", "podcasts", "tag"]) }).safeParse(request.query);
    if (!query.success) return apiError(reply, 400, "INVALID_SEARCH", "Enter at least two characters and choose a favorite type.");
    const room = getRoom(db, roomId);
    if (!room) return apiError(reply, 404, "ROOM_NOT_FOUND", "This room has expired or does not exist.");
    if (query.data.type !== "tag" && !roomCategories(room.categories).includes(query.data.type)) {
      return apiError(reply, 400, "CATEGORY_NOT_SELECTED", "Search only for categories selected for this room.");
    }
    if (/(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})|(?:\+?\d[\d\s().-]{7,}\d)/.test(query.data.q)) return apiError(reply, 400, "PERSONAL_DATA_BLOCKED", "Search for a public entity, not an email address or phone number.");
    const limit = consumeRateLimit(searchRequestWindows, member.id, searchRateLimitMax);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfter));
      return apiError(reply, 429, "SEARCH_RATE_LIMITED", "Too many searches. Please wait a minute before searching again.");
    }
    try {
      const searcher = db.prepare("SELECT nickname FROM members WHERE id = ?").get(member.id) as { nickname: string };
      recordPlanActivity(db, roomId, "qloo_search_request", `Searching Qloo for ${query.data.type} favorites for ${searcher.nickname}: “${query.data.q}”.`);
      let results: Awaited<ReturnType<typeof searchQloo>>;
      if (query.data.type === "tag") {
        if (!qloo) return apiError(reply, 503, "QLOO_UNAVAILABLE", "Qloo tag search is unavailable right now.");
        results = await searchQlooTags(qloo, query.data.q);
      } else {
        results = await searchQloo(query.data.q, entityTypes[query.data.type]);
      }
      recordPlanActivity(db, roomId, "qloo_search_result", `Qloo ${query.data.type} search for “${query.data.q}” returned ${results.length} results for ${searcher.nickname}.`);
      const upsert = db.prepare(`INSERT INTO member_search_results
        (member_id, qloo_id, name, entity_type, subtitle, image_url, source, searched_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)
        ON CONFLICT(member_id, qloo_id) DO UPDATE SET
          name = excluded.name, entity_type = excluded.entity_type, subtitle = excluded.subtitle,
          image_url = excluded.image_url,
          source = CASE WHEN member_search_results.source = 'chat' THEN 'chat' ELSE 'manual' END,
          searched_at = excluded.searched_at`);
      const now = timestamp();
      db.transaction(() => results.forEach((result) => upsert.run(member.id, result.id, result.name, result.entityType, result.description, result.imageUrl, now)))();
      broadcast(roomId);
      return { results: results.map((item) => ({ ...item, subtitle: item.description })) };
    } catch (error) {
      request.log.error({ err: error }, "Qloo search failed");
      broadcast(roomId);
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
    const selected = db.prepare(`SELECT qloo_id, name, entity_type, source FROM member_search_results WHERE member_id = ? AND qloo_id IN (${placeholders})`)
      .all(member.id, ...body.data.qlooIds) as { qloo_id: string; name: string; entity_type: string; source: "manual" | "chat" | "demo" }[];
    if (selected.length !== body.data.qlooIds.length) return apiError(reply, 400, "SEARCH_RESULT_REQUIRED", "Favorites must be selected from your own recent Qloo search results.");
    const save = db.transaction(() => {
      db.prepare("DELETE FROM favorites WHERE member_id = ?").run(member.id);
      const insert = db.prepare("INSERT INTO favorites(member_id, qloo_id, name, entity_type, source) VALUES (?, ?, ?, ?, ?)");
      selected.forEach((item) => insert.run(member.id, item.qloo_id, item.name, item.entity_type, item.source));
      db.prepare("UPDATE members SET ready = 1 WHERE id = ?").run(member.id);
    });
    save();
    broadcast(roomId);
    return { room: roomState(db, roomId, request) };
  });

  app.post("/api/rooms/:roomId/demo", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const member = requireMember(request, reply, db, roomId);
    if (!member) return;
    if (!member.isHost) return apiError(reply, 403, "HOST_REQUIRED", "Only the room creator can start the solo demo.");
    const room = getRoom(db, roomId);
    if (!room) return apiError(reply, 404, "ROOM_NOT_FOUND", "This room has expired or does not exist.");
    if (room.status === "generating" || room.status === "ready") return apiError(reply, 409, "ROOM_CLOSED", "The solo demo can only start before a plan is ready.");
    if (!qloo) return apiError(reply, 503, "QLOO_UNAVAILABLE", "The Qloo MCP connection is unavailable.");
    if (!process.env.QLOO_API_KEY) return apiError(reply, 503, "QLOO_CREDENTIAL_REQUIRED", "Configure the server's Qloo API key to create live-Qloo demo favorites.");
    if (demoSeedingRooms.has(roomId)) return apiError(reply, 409, "DEMO_IN_PROGRESS", "Demo friends are already being added.");
    const previousPlan = db.prepare("SELECT version, status, updated_at FROM plans WHERE room_id = ?").get(roomId) as
      { version: number; status: string; updated_at: number } | undefined;
    if (previousPlan && previousPlan.status !== "generating") {
      const remaining = generationCooldownMs - (timestamp() - previousPlan.updated_at);
      if (remaining > 0) {
        reply.header("Retry-After", String(Math.ceil(remaining / 1000)));
        return apiError(reply, 429, "PLAN_COOLDOWN", "Please wait briefly before trying the solo demo again.");
      }
    }

    const roster = db.prepare("SELECT COUNT(*) AS count FROM members WHERE room_id = ?").get(roomId) as { count: number };
    const existingDemos = db.prepare("SELECT id, nickname FROM members WHERE room_id = ? AND nickname IN (?, ?) ORDER BY nickname")
      .all(roomId, ...demoNicknames) as { id: string; nickname: string }[];
    if (existingDemos.length === 0 && roster.count !== 1) {
      return apiError(reply, 409, "DEMO_REQUIRES_SOLO_ROOM", "Start the demo before inviting other people.");
    }
    if (existingDemos.length !== 0 && existingDemos.length !== demoNicknames.length) {
      return apiError(reply, 409, "DEMO_STATE_INVALID", "This room has an incomplete demo setup. Create a fresh room to retry.");
    }
    if (roster.count + (existingDemos.length ? 0 : demoNicknames.length) > 6) {
      return apiError(reply, 409, "ROOM_FULL", "There is not enough room to add both demo friends.");
    }

    demoSeedingRooms.add(roomId);
    const reservation = db.prepare("UPDATE rooms SET status = 'generating' WHERE id = ? AND status IN ('gathering', 'failed')").run(roomId);
    if (reservation.changes !== 1) {
      demoSeedingRooms.delete(roomId);
      return apiError(reply, 409, "DEMO_IN_PROGRESS", "This room is already being updated.");
    }
    broadcast(roomId);
    try {
      const host = db.prepare("SELECT id, nickname FROM members WHERE id = ? AND room_id = ?").get(member.id, roomId) as { id: string; nickname: string };
      const profiles = [
        host,
        ...demoNicknames.map((nickname) => ({
          id: existingDemos.find((item) => item.nickname === nickname)?.id ?? randomUUID(),
          nickname,
        })),
      ];
      const demoProfiles = profiles.slice(1);
      const seedResults: {
        memberId: string;
        memberName: string;
        category: Category;
        query: string;
        result: Awaited<ReturnType<typeof searchQloo>>[number];
      }[] = [];
      const favoriteCounts = new Map(demoProfiles.map((profile) => [profile.id, 0]));
      const categoryCounts = new Map(demoProfiles.map((profile) => [profile.id, new Map<Category, number>()]));
      for (const profile of demoProfiles) {
        const existing = db.prepare("SELECT entity_type FROM favorites WHERE member_id = ?").all(profile.id) as { entity_type: string }[];
        favoriteCounts.set(profile.id, existing.length);
        for (const category of roomCategories(room.categories)) {
          categoryCounts.get(profile.id)?.set(category, existing.filter((item) => item.entity_type === entityTypes[category]).length);
        }
      }
      const tasks: { profile: typeof demoProfiles[number]; category: Category; query: string }[] = [];
      const categories = roomCategories(room.categories);
      const addTask = (profile: typeof demoProfiles[number], category: Category) => {
        const total = favoriteCounts.get(profile.id) ?? 0;
        if (total >= 4) throw new Error(`Cannot add more demo favorites for ${profile.nickname}`);
        const queryIndex = categoryCounts.get(profile.id)?.get(category) ?? 0;
        const term = demoSearchTerms[category][queryIndex];
        if (!term) throw new Error(`No unused ${category} search term for ${profile.nickname}`);
        const query = category === "dining" && room.city_or_area
          ? `${term} ${room.city_or_area}`
          : term;
        tasks.push({ profile, category, query });
        favoriteCounts.set(profile.id, total + 1);
        categoryCounts.get(profile.id)?.set(category, queryIndex + 1);
      };

      for (const category of categories) {
        const alreadyCovered = demoProfiles.some((profile) => (categoryCounts.get(profile.id)?.get(category) ?? 0) > 0);
        if (alreadyCovered) continue;
        const profile = [...demoProfiles].sort((a, b) =>
          (favoriteCounts.get(a.id) ?? 0) - (favoriteCounts.get(b.id) ?? 0))[0]!;
        addTask(profile, category);
      }
      for (const profile of demoProfiles) {
        while ((favoriteCounts.get(profile.id) ?? 0) < 2) {
          const category = categories.find((item) => (categoryCounts.get(profile.id)?.get(item) ?? 0) < demoSearchTerms[item].length);
          if (!category) throw new Error(`Could not add enough demo favorites for ${profile.nickname}`);
          addTask(profile, category);
        }
      }

      for (const task of tasks) {
        recordPlanActivity(db, roomId, "demo_search_request", `Searching live Qloo for ${task.category} favorites for ${task.profile.nickname}: “${task.query}”.`);
        const results = await searchQloo(task.query, entityTypes[task.category]);
        const existingIds = new Set((db.prepare("SELECT qloo_id FROM favorites WHERE member_id = ?").all(task.profile.id) as { qloo_id: string }[]).map((item) => item.qloo_id));
        const chosen = results.find((result) => !existingIds.has(result.id) &&
          !seedResults.some((item) => item.memberId === task.profile.id && item.result.id === result.id));
        if (!chosen) throw new Error(`Qloo did not return a new ${task.category} favorite for ${task.profile.nickname}`);
        recordPlanActivity(db, roomId, "demo_search_result", `Qloo returned ${results.length} ${task.category} results for ${task.profile.nickname}; selected ${chosen.name} as a live favorite.`);
        seedResults.push({
          memberId: task.profile.id,
          memberName: task.profile.nickname,
          category: task.category,
          query: task.query,
          result: chosen,
        });
      }

      const now = timestamp();
      db.transaction(() => {
        const insertMember = db.prepare("INSERT INTO members(id, room_id, nickname, token_hash, is_host, ready, joined_at) VALUES (?, ?, ?, ?, 0, 1, ?)");
        for (const profile of profiles.slice(1)) {
          if (existingDemos.some((demo) => demo.id === profile.id)) continue;
          const { hash } = createMemberToken();
          insertMember.run(profile.id, roomId, profile.nickname, hash, now);
        }
        const saveSearch = db.prepare(`INSERT OR REPLACE INTO member_search_results
          (member_id, qloo_id, name, entity_type, subtitle, image_url, source, searched_at) VALUES (?, ?, ?, ?, ?, ?, 'demo', ?)`);
        const saveFavorite = db.prepare("INSERT OR IGNORE INTO favorites(member_id, qloo_id, name, entity_type, source) VALUES (?, ?, ?, ?, 'demo')");
        for (const item of seedResults) {
          saveSearch.run(item.memberId, item.result.id, item.result.name, item.result.entityType, item.result.description, item.result.imageUrl, now);
          saveFavorite.run(item.memberId, item.result.id, item.result.name, item.result.entityType);
          recordPlanActivity(db, roomId, "demo_favorite_search", `Live Qloo ${item.category} search for ${item.memberName} found and added “${item.result.name}” from “${item.query}”.`);
        }
        const scriptedMessagesExist = db.prepare(`SELECT 1 FROM chat_messages
          WHERE member_id IN (?, ?) LIMIT 1`).get(...demoProfiles.map((profile) => profile.id));
        if (!scriptedMessagesExist) {
          const saveMessage = db.prepare("INSERT INTO chat_messages(id, room_id, member_id, text, created_at) VALUES (?, ?, ?, ?, ?)");
          demoConversation.forEach((message, index) => {
            const profile = profiles.find((item) => item.nickname === message.nickname);
            if (!profile) throw new Error(`Missing demo profile for ${message.nickname}`);
            saveMessage.run(randomUUID(), roomId, profile.id, message.text, now - (demoConversation.length - index) * 1000);
          });
        }
        db.prepare("UPDATE members SET ready = 1 WHERE room_id = ?").run(roomId);
        recordPlanActivity(db, roomId, "demo_profiles_ready", `Added live-Qloo favorites for ${demoNicknames.join(" and ")}; all room members are ready.`);
      })();

      beginPlanGeneration(db, qloo, request, roomId, previousPlan?.version ?? 0);
      return reply.code(202).send({ status: "generating" });
    } catch (error) {
      request.log.error({ err: error }, "Could not prepare live-Qloo demo profiles");
      db.prepare("UPDATE rooms SET status = ? WHERE id = ?").run(room.status, roomId);
      broadcast(roomId);
      if (error instanceof Error && error.message.includes("HTTP 429")) {
        reply.header("Retry-After", "60");
        return apiError(reply, 503, "QLOO_RATE_LIMITED", "Qloo is rate-limiting live searches. Wait briefly before starting the demo again.");
      }
      return apiError(reply, 502, "DEMO_QLOO_SEARCH_FAILED", "Could not find enough live Qloo favorites. Check Qloo setup and try again in a fresh room.");
    } finally {
      demoSeedingRooms.delete(roomId);
    }
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
    beginPlanGeneration(db, qloo, request, roomId, previousPlan?.version ?? 0);
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
