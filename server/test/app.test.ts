import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import Database from "better-sqlite3";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { migratePickCategoryConstraint, openDb, sweepExpiredRooms } from "../src/db.js";
import { createApp } from "../src/app.js";

const origin = "http://localhost:5173";
const headers = { origin, "content-type": "application/json" };

function cookieFrom(response: { headers: OutgoingHttpHeaders }) {
  const value = response.headers["set-cookie"];
  const setCookie = Array.isArray(value) ? value[0] : value;
  expect(setCookie).toBeTruthy();
  return String(setCookie).split(";")[0]!;
}

function openTestApp(qloo: Client | null = null) {
  const db = openDb(":memory:");
  const app = createApp(db, qloo, { logger: false, webRoot: "missing-web-root" });
  return { db, app };
}

async function createRoom(app: ReturnType<typeof createApp>, nickname = "Host") {
  const response = await app.inject({
    method: "POST", url: "/api/rooms", headers,
    payload: { nickname, categories: ["music"], city: null },
  });
  expect(response.statusCode).toBe(201);
  const cookie = cookieFrom(response);
  const roomId = response.json().room.id as string;
  return { cookie, roomId };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("anonymous room flow", () => {
  it("opens the current schema with room-scoped state and chat tables", () => {
    const db = openDb(":memory:");
    const roomColumns = (db.prepare("PRAGMA table_info(rooms)").all() as { name: string }[]).map(({ name }) => name);
    const memberColumns = (db.prepare("PRAGMA table_info(members)").all() as { name: string }[]).map(({ name }) => name);
    const chatTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'").get();
    const activityTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_activity'").get();
    expect(roomColumns).toEqual(["id", "categories", "city_or_area", "status", "created_at", "expires_at"]);
    expect(memberColumns).toContain("token_hash");
    expect(memberColumns).not.toContain("session_id");
    expect(chatTable).toEqual({ name: "chat_messages" });
    expect(activityTable).toEqual({ name: "plan_activity" });
    db.close();
  });

  it("migrates existing pick tables to accept TV, books, and podcasts without losing votes", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY);
      CREATE TABLE members (id TEXT PRIMARY KEY);
      CREATE TABLE picks (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (category IN ('dining', 'music', 'film_tv')),
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
      CREATE INDEX idx_picks_room ON picks(room_id, state);
      CREATE TABLE votes (
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        pick_id TEXT NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
        voted_at INTEGER NOT NULL,
        PRIMARY KEY (member_id, pick_id)
      );
      INSERT INTO rooms VALUES ('room-one');
      INSERT INTO members VALUES ('member-one');
      INSERT INTO picks(id, room_id, category, rank, created_version, qloo_id, name, entity_type, qloo_tags, member_affinity, overlap_score, qloo_source)
        VALUES ('pick-one', 'room-one', 'music', 1, 1, 'artist-one', 'Artist One', 'artist', '[]', '{}', 75, '{}');
      INSERT INTO votes VALUES ('member-one', 'pick-one', 'up', 1);
    `);

    migratePickCategoryConstraint(db);

    expect(db.prepare("SELECT category FROM picks WHERE id = 'pick-one'").get()).toEqual({ category: "music" });
    expect(db.prepare("SELECT pick_id, direction FROM votes").get()).toEqual({ pick_id: "pick-one", direction: "up" });
    expect(() => db.prepare(`INSERT INTO picks(id, room_id, category, rank, created_version, qloo_id, name, entity_type, qloo_tags, member_affinity, overlap_score, qloo_source)
      VALUES ('pick-book', 'room-one', 'books', 1, 1, 'book-one', 'Book One', 'book', '[]', '{}', 50, '{}')`).run()).not.toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("creates an expiring room and sets an HttpOnly room-scoped cookie", async () => {
    const { app } = openTestApp();
    const { cookie, roomId } = await createRoom(app);
    const response = await app.inject({ method: "GET", url: `/api/rooms/${roomId}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.json().room.me).toMatchObject({ isHost: true });
    expect(response.json().room.expiresAt).toBeTruthy();
    const creation = await app.inject({
      method: "POST", url: "/api/rooms", headers,
      payload: { nickname: "Private", categories: ["music"], city: null },
    });
    expect(String(creation.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(creation.headers["set-cookie"])).toContain("SameSite=Lax");
    await app.close();
  });

  it("rate-limits the API by client address", async () => {
    const { app } = openTestApp();
    const { roomId } = await createRoom(app);
    for (let index = 0; index < 119; index += 1) {
      const response = await app.inject({ method: "GET", url: `/api/rooms/${roomId}` });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: `/api/rooms/${roomId}` });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBeTruthy();
    await app.close();
  });

  it("rejects state-changing requests without an allowed origin", async () => {
    const { app } = openTestApp();
    const response = await app.inject({
      method: "POST", url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { nickname: "Host", categories: ["music"], city: null },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_REQUIRED");
    await app.close();
  });

  it("rejects coordinate and street-address input for dining location", async () => {
    const { app } = openTestApp();
    const coordinates = await app.inject({
      method: "POST", url: "/api/rooms", headers,
      payload: { nickname: "Host", categories: ["dining"], city: "47.6062, -122.3321" },
    });
    const address = await app.inject({
      method: "POST", url: "/api/rooms", headers,
      payload: { nickname: "Host", categories: ["dining"], city: "123 Main Street" },
    });
    expect(coordinates.statusCode).toBe(400);
    expect(address.statusCode).toBe(400);
    await app.close();
  });

  it("returns only a coarse city from optional browser coordinates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      address: { house_number: "42", road: "Test Road", city: "Seattle", state: "Washington" },
    }), { status: 200 })));
    const { app } = openTestApp();
    const response = await app.inject({
      method: "POST", url: "/api/location/resolve", headers,
      payload: { latitude: 47.6, longitude: -122.3 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ city: "Seattle, Washington" });
    expect(response.body).not.toContain("Test Road");
    await app.close();
  });

  it("lets members confirm Qloo cuisine/style tags as favorites", async () => {
    const callTool = vi.fn(async () => ({
      isError: false,
      structuredContent: {
        status: "ok",
        results: [
          { tag_id: "tag:japanese", name: "Japanese cuisine" },
          { tag_id: "tag:noodles", name: "Noodles" },
        ],
      },
    }));
    const { app, db } = openTestApp({ callTool } as unknown as Client);
    const host = await createRoom(app);
    const search = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}/search?q=japanese&type=tag`,
      headers: { cookie: host.cookie },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results.map((item: { entityType: string }) => item.entityType)).toEqual(["tag", "tag"]);
    const saved = await app.inject({
      method: "PUT", url: `/api/rooms/${host.roomId}/favorites`,
      headers: { ...headers, cookie: host.cookie },
      payload: { qlooIds: ["tag:japanese", "tag:noodles"] },
    });
    expect(saved.statusCode).toBe(200);
    expect(db.prepare("SELECT DISTINCT entity_type AS type FROM favorites WHERE member_id = ?").all(saved.json().room.me.memberId)).toEqual([{ type: "tag" }]);
    await app.close();
  });

  it("limits room size and scopes searchable favorites to their member session", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ entity_id: "artist:one", name: "Test Artist", type: "urn:entity:artist" }],
    }), { status: 200 })));
    const { app } = openTestApp();
    const host = await createRoom(app);
    const search = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}/search?q=test&type=music`,
      headers: { cookie: host.cookie },
    });
    expect(search.statusCode).toBe(200);
    const guestResponse = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Friend" },
    });
    expect(guestResponse.statusCode).toBe(201);
    const guestCookie = cookieFrom(guestResponse);
    const stolenSelection = await app.inject({
      method: "PUT", url: `/api/rooms/${host.roomId}/favorites`,
      headers: { ...headers, cookie: guestCookie },
      payload: { qlooIds: ["artist:one", "artist:two"] },
    });
    expect(stolenSelection.statusCode).toBe(400);
    expect(stolenSelection.json().error.code).toBe("SEARCH_RESULT_REQUIRED");
    const duplicate = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "host" },
    });
    expect(duplicate.statusCode).toBe(409);
    await app.close();
  });

  it("limits Qloo searches per member", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { app } = openTestApp();
    const host = await createRoom(app);
    for (let index = 0; index < 20; index += 1) {
      const result = await app.inject({
        method: "GET", url: `/api/rooms/${host.roomId}/search?q=artist&type=music`,
        headers: { cookie: host.cookie },
      });
      expect(result.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}/search?q=artist&type=music`,
      headers: { cookie: host.cookie },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("SEARCH_RATE_LIMITED");
    expect(fetch).toHaveBeenCalledTimes(20);
    await app.close();
  });

  it("only searches entity categories selected for the room", async () => {
    const { app } = openTestApp();
    const host = await createRoom(app);
    const response = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}/search?q=book&type=books`,
      headers: { cookie: host.cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("CATEGORY_NOT_SELECTED");
    await app.close();
  });
});

describe("room chat", () => {
  it("allows joined members to chat and keeps messages private from visitors", async () => {
    const { app, db } = openTestApp();
    const host = await createRoom(app);
    const guestResponse = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Friend" },
    });
    const guestCookie = cookieFrom(guestResponse);
    const publicEvents = await app.inject({ method: "GET", url: `/api/rooms/${host.roomId}/events` });
    expect(publicEvents.statusCode).toBe(401);
    const sent = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/chat`,
      headers: { ...headers, cookie: host.cookie },
      payload: { text: "What should we do?" },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().room.chatMessages).toHaveLength(1);
    expect(sent.json().room.chatMessages[0]).toMatchObject({ nickname: "Host", text: "What should we do?" });

    const guestRoom = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}`, headers: { cookie: guestCookie },
    });
    expect(guestRoom.json().room.chatMessages).toHaveLength(1);
    const visitorRoom = await app.inject({ method: "GET", url: `/api/rooms/${host.roomId}` });
    expect(visitorRoom.json().room.chatMessages).toEqual([]);
    expect(visitorRoom.body).not.toContain("What should we do?");
    expect((db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE room_id = ?").get(host.roomId) as { count: number }).count).toBe(1);
    await app.close();
  });

  it("rejects unauthenticated, empty, and over-length messages", async () => {
    const { app } = openTestApp();
    const { roomId, cookie } = await createRoom(app);
    const unauthenticated = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/chat`, headers, payload: { text: "Hello" },
    });
    const empty = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/chat`, headers: { ...headers, cookie }, payload: { text: "  " },
    });
    const tooLong = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/chat`, headers: { ...headers, cookie }, payload: { text: "x".repeat(501) },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(empty.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  });

  it("returns up to three live Qloo entities from the member's recent messages without auto-saving them", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "query";
      return new Response(JSON.stringify({
        results: [1, 2].map((index) => ({ entity_id: `${query}:${index}`, name: `${query} pick ${index}` })),
      }), { status: 200 });
    }));
    const { app, db } = openTestApp();
    const host = await createRoom(app);
    for (const text of ["I want a relaxed evening", "Maybe something local", "I like live music"]) {
      await app.inject({
        method: "POST", url: `/api/rooms/${host.roomId}/chat`,
        headers: { ...headers, cookie: host.cookie }, payload: { text },
      });
    }

    const response = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/chat-suggestions`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toHaveLength(3);
    expect(response.json().keywordSource).toBe("messages");
    expect((db.prepare("SELECT COUNT(*) AS count FROM favorites").get() as { count: number }).count).toBe(0);
    expect(response.json().results[0].name).toContain("relaxed evening");
    const manualSearch = await app.inject({
      method: "GET",
      url: `/api/rooms/${host.roomId}/search?q=${encodeURIComponent("I want a relaxed evening")}&type=music`,
      headers: { ...headers, cookie: host.cookie },
    });
    expect(manualSearch.statusCode).toBe(200);
    const memberId = (db.prepare("SELECT id FROM members WHERE room_id = ?").get(host.roomId) as { id: string }).id;
    expect(db.prepare("SELECT source FROM member_search_results WHERE member_id = ? AND qloo_id = ?")
      .get(memberId, response.json().results[0].id)).toMatchObject({ source: "chat" });
    const confirmed = await app.inject({
      method: "PUT", url: `/api/rooms/${host.roomId}/favorites`,
      headers: { ...headers, cookie: host.cookie },
      payload: { qlooIds: response.json().results.map((result: { id: string }) => result.id).slice(0, 2) },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(db.prepare("SELECT DISTINCT source FROM favorites").all()).toEqual([{ source: "chat" }]);
    const state = await app.inject({ method: "GET", url: `/api/rooms/${host.roomId}`, headers: { cookie: host.cookie } });
    expect(state.json().room.members[0]).toMatchObject({ ready: true, hasChatted: true });
    await app.close();
  });

  it("falls back to raw recent messages when Gemini keyword extraction fails", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "generativelanguage.googleapis.com") {
        expect(String(init?.body)).not.toContain("Host");
        return new Response("Unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({
        results: [{ entity_id: `artist:${url.searchParams.get("query")}`, name: "Qloo artist" }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const { app } = openTestApp();
    const host = await createRoom(app);
    const messages = ["I enjoy jazz", "Host likes outdoor concerts", "Maybe a small venue"];
    for (const text of messages) {
      await app.inject({
        method: "POST", url: `/api/rooms/${host.roomId}/chat`,
        headers: { ...headers, cookie: host.cookie }, payload: { text },
      });
    }

    const response = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/chat-suggestions`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().keywordSource).toBe("messages");
    expect(response.json().results).toHaveLength(3);
    expect(fetch.mock.calls.slice(1).map(([input]) => new URL(String(input)).searchParams.get("query"))).toEqual([
      "I enjoy jazz", "likes outdoor concerts", "Maybe a small venue",
    ]);
    await app.close();
  });

  it("shares the Qloo search rate limit with chat suggestions", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { app } = openTestApp();
    const host = await createRoom(app);
    for (const text of ["first message", "second message", "third message"]) {
      await app.inject({
        method: "POST", url: `/api/rooms/${host.roomId}/chat`,
        headers: { ...headers, cookie: host.cookie }, payload: { text },
      });
    }
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({
        method: "POST", url: `/api/rooms/${host.roomId}/chat-suggestions`,
        headers: { ...headers, cookie: host.cookie }, payload: {},
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/chat-suggestions`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("SEARCH_RATE_LIMITED");
    expect(fetch).toHaveBeenCalledTimes(18);
    await app.close();
  });

  it("requires a room member and only uses that member's own messages for suggestions", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    const { app } = openTestApp();
    const host = await createRoom(app);
    for (const text of ["host one", "host two", "host three"]) {
      await app.inject({
        method: "POST", url: `/api/rooms/${host.roomId}/chat`,
        headers: { ...headers, cookie: host.cookie }, payload: { text },
      });
    }
    const visitorResponse = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/chat-suggestions`, headers, payload: {},
    });
    const guest = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers, payload: { nickname: "Friend" },
    });
    const guestResponse = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/chat-suggestions`,
      headers: { ...headers, cookie: cookieFrom(guest) }, payload: {},
    });
    expect(visitorResponse.statusCode).toBe(401);
    expect(visitorResponse.json().error.code).toBe("MEMBER_SESSION_REQUIRED");
    expect(guestResponse.statusCode).toBe(409);
    expect(guestResponse.json().error.code).toBe("CHAT_CONTEXT_REQUIRED");
    await app.close();
  });
});

describe("plan generation", () => {
  it("does not pass unrelated entity types as Qloo recommendation signals", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const callTool = vi.fn(async ({ arguments: args }: { arguments: { target_type: string; signals?: string[] } }) => ({
      isError: false,
      structuredContent: {
        status: "ok",
        results: [{ entity_id: `${args.target_type}:pick`, name: "Artist pick" }],
      },
    }));
    const { app, db } = openTestApp({ callTool } as unknown as Client);
    const host = await createRoom(app);
    const friend = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Friend" },
    });
    await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Third" },
    });
    const members = db.prepare("SELECT id FROM members WHERE room_id = ? ORDER BY joined_at").all(host.roomId) as { id: string }[];
    for (const [index, member] of members.entries()) {
      db.prepare("INSERT INTO favorites(member_id, qloo_id, name, entity_type) VALUES (?, ?, ?, ?)")
        .run(member.id, index === 1 ? "book:signal" : `artist:${index}`, "Favorite", index === 1 ? "book" : "artist");
      db.prepare("UPDATE members SET ready = 1 WHERE id = ?").run(member.id);
    }

    const response = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/plan`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status FROM plans WHERE room_id = ?").get(host.roomId)).toEqual({ status: "ready" });
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    for (const [call] of callTool.mock.calls) {
      expect(call.arguments).toMatchObject({ target_type: "artist" });
      expect(call.arguments.signals).not.toContain("book:signal");
    }
    const state = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}`, headers: { cookie: host.cookie },
    });
    expect(state.json().room.picks[0].qloo.overlapScore).toBe(33);
    expect(friend.statusCode).toBe(201);
    await app.close();
  });

  it("completes a plan when a selected category has no matching favorite signals", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const callTool = vi.fn(async () => ({
      isError: false,
      structuredContent: {
        status: "ok",
        results: [{ entity_id: "artist:pick", name: "Artist pick" }],
      },
    }));
    const { app, db } = openTestApp({ callTool } as unknown as Client);
    const created = await app.inject({
      method: "POST", url: "/api/rooms", headers,
      payload: { nickname: "Host", categories: ["music", "film_tv"], city: null },
    });
    const hostCookie = cookieFrom(created);
    const roomId = created.json().room.id as string;
    await app.inject({ method: "POST", url: `/api/rooms/${roomId}/join`, headers, payload: { nickname: "Friend" } });
    await app.inject({ method: "POST", url: `/api/rooms/${roomId}/join`, headers, payload: { nickname: "Third" } });
    const members = db.prepare("SELECT id FROM members WHERE room_id = ?").all(roomId) as { id: string }[];
    for (const member of members) {
      db.prepare("INSERT INTO favorites(member_id, qloo_id, name, entity_type) VALUES (?, ?, 'Favorite', 'artist')")
        .run(member.id, `artist:${member.id}`);
      db.prepare("UPDATE members SET ready = 1 WHERE id = ?").run(member.id);
    }

    const started = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/plan`,
      headers: { ...headers, cookie: hostCookie }, payload: {},
    });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status FROM plans WHERE room_id = ?").get(roomId)).toEqual({ status: "ready" });
    });
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(db.prepare("SELECT event_type AS eventType, summary FROM plan_activity WHERE room_id = ? AND event_type = 'category_skipped'")
      .all(roomId)).toEqual([{
      eventType: "category_skipped",
      summary: "Skipped film_tv: no confirmed favorites or Qloo taste tags match this category.",
    }]);
    const state = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}`, headers: { cookie: hostCookie },
    });
    expect(state.json().room.picks.map((pick: { category: string }) => pick.category)).toEqual(["music"]);
    await app.close();
  });

  it("uses chat-derived favorites as the primary recommendation signal", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const callTool = vi.fn(async ({ arguments: args }: { arguments: { signals?: string[] } }) => {
      const isChatSignal = args.signals?.[0]?.startsWith("chat:") ?? false;
      const id = isChatSignal ? "artist:chat-pick" : "artist:other-pick";
      const name = isChatSignal ? "Chat-first pick" : "Other-favorites pick";
      return {
        isError: false,
        structuredContent: { status: "ok", results: [{ entity_id: id, name }] },
      };
    });
    const { app, db } = openTestApp({ callTool } as unknown as Client);
    const host = await createRoom(app);
    await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Friend" },
    });
    await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Third" },
    });
    const members = db.prepare("SELECT id FROM members WHERE room_id = ? ORDER BY joined_at").all(host.roomId) as { id: string }[];
    for (const member of members) {
      db.prepare(`INSERT INTO favorites(member_id, qloo_id, name, entity_type, source)
        VALUES (?, ?, 'Chat signal', 'artist', 'chat'), (?, ?, 'Other signal', 'artist', 'manual')`)
        .run(member.id, `chat:${member.id}`, member.id, `manual:${member.id}`);
      db.prepare("UPDATE members SET ready = 1 WHERE id = ?").run(member.id);
    }

    const started = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/plan`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status FROM plans WHERE room_id = ?").get(host.roomId)).toEqual({ status: "ready" });
    });

    const state = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}`, headers: { cookie: host.cookie },
    });
    const picks = state.json().room.picks as { qloo: { entityId: string; overlapScore: number } }[];
    expect(picks.map((pick) => pick.qloo.entityId)).toEqual(["artist:chat-pick", "artist:other-pick"]);
    expect(picks.map((pick) => pick.qloo.overlapScore)).toEqual([70, 30]);
    expect(callTool).toHaveBeenCalledTimes(6);
    await app.close();
  });

  it("fills a solo host room with live-Qloo demo favorites and generates a plan", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    vi.stubEnv("QLOO_BASE_URL", "https://qloo.test");
    vi.stubEnv("GEMINI_API_KEY", "");
    const searchFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("query") ?? "unknown";
      const type = url.searchParams.get("types")?.replace("urn:entity:", "") ?? "entity";
      return new Response(JSON.stringify({
        results: [{ entity_id: `${type}:${query}`, name: `${query} pick` }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", searchFetch);
    const callTool = vi.fn(async ({ arguments: args }: { arguments: { target_type: string } }) => ({
      isError: false,
      structuredContent: {
        status: "ok",
        results: [
          { entity_id: `${args.target_type}:recommendation-one`, name: `${args.target_type} recommendation one` },
          { entity_id: `${args.target_type}:recommendation-two`, name: `${args.target_type} recommendation two` },
          { entity_id: `${args.target_type}:recommendation-three`, name: `${args.target_type} recommendation three` },
        ],
      },
    }));
    const { app, db } = openTestApp({ callTool } as unknown as Client);
    const created = await app.inject({
      method: "POST", url: "/api/rooms", headers,
      payload: { nickname: "Judge", categories: ["dining", "music", "film_tv", "tv_show", "books", "podcasts"], city: "Seattle" },
    });
    expect(created.statusCode).toBe(201);
    const hostCookie = cookieFrom(created);
    const roomId = created.json().room.id as string;

    const response = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/demo`,
      headers: { ...headers, cookie: hostCookie }, payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(searchFetch).toHaveBeenCalledTimes(6);
    await vi.waitFor(() => {
      const plan = db.prepare("SELECT status FROM plans WHERE room_id = ?").get(roomId) as { status: string };
      expect(plan.status).toBe("ready");
    });

    const state = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}`, headers: { cookie: hostCookie },
    });
    expect(state.json().room.members.map((item: { nickname: string; ready: boolean }) => [item.nickname, item.ready])).toEqual([
      ["Judge", true],
      ["Demo Maya", true],
      ["Demo Jordan", true],
    ]);
    expect(state.json().room.chatMessages.map((message: { nickname: string; text: string }) => message.nickname)).toEqual([
      "Demo Maya", "Demo Jordan", "Demo Maya",
    ]);
    expect(state.json().room.chatMessages.every((message: { text: string }) =>
      !/recommendation|favorite|qloo/i.test(message.text))).toBe(true);
    expect(state.json().room.members.find((item: { nickname: string }) => item.nickname === "Judge").hasChatted).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS count FROM member_search_results").get() as { count: number }).count).toBe(6);
    const demoFavoriteCounts = db.prepare(`SELECT members.nickname, COUNT(favorites.qloo_id) AS count
      FROM members LEFT JOIN favorites ON favorites.member_id = members.id
      WHERE members.room_id = ? AND members.is_host = 0 GROUP BY members.id`).all(roomId) as { nickname: string; count: number }[];
    expect(demoFavoriteCounts.every((item) => item.count >= 2 && item.count <= 4)).toBe(true);
    expect(state.json().room.picks).toHaveLength(18);
    expect(new Set(state.json().room.picks.map((pick: { category: string }) => pick.category))).toEqual(new Set(["dining", "music", "film_tv", "tv_show", "books", "podcasts"]));
    expect(new Set(callTool.mock.calls.map(([input]) => input.arguments.target_type))).toEqual(new Set(["place", "artist", "movie", "tv_show", "book", "podcast"]));
    expect(state.json().room.planActivity.some((item: { summary: string }) => item.summary.includes("Live Qloo dining search"))).toBe(true);
    expect(state.json().room.planActivity.some((item: { summary: string }) => item.summary.includes("Called Qloo recommendations"))).toBe(true);
    expect(state.json().room.planActivity.some((item: { summary: string }) => item.summary.includes("Selected place recommendation"))).toBe(true);
    await app.close();
  });

  it("prevents new members joining while live-Qloo demo favorites are being seeded", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    vi.stubEnv("QLOO_BASE_URL", "https://qloo.test");
    vi.stubEnv("GEMINI_API_KEY", "");
    let releaseSearch!: () => void;
    const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve; });
    const searchFetch = vi.fn(async (input: URL | RequestInfo) => {
      await searchGate;
      const url = new URL(String(input));
      const query = url.searchParams.get("query") ?? "unknown";
      const type = url.searchParams.get("types")?.replace("urn:entity:", "") ?? "entity";
      return new Response(JSON.stringify({
        results: [{ entity_id: `${type}:${query}`, name: `${query} pick` }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", searchFetch);
    const callTool = vi.fn(async () => ({
      isError: false,
      structuredContent: {
        status: "ok",
        results: [
          { entity_id: "artist:one", name: "Artist One" },
          { entity_id: "artist:two", name: "Artist Two" },
          { entity_id: "artist:three", name: "Artist Three" },
        ],
      },
    }));
    const { app } = openTestApp({ callTool } as unknown as Client);
    const host = await createRoom(app);
    const demoRequest = app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/demo`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    await vi.waitFor(() => expect(searchFetch).toHaveBeenCalled());

    const joinResponse = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Late Friend" },
    });
    expect(joinResponse.statusCode).toBe(409);
    expect(joinResponse.json().error.code).toBe("ROOM_CLOSED");

    releaseSearch();
    expect((await demoRequest).statusCode).toBe(202);
    await app.close();
  });

  it("requires the host and a configured live Qloo search key for the solo demo", async () => {
    vi.stubEnv("QLOO_API_KEY", "");
    const callTool = vi.fn();
    const { app } = openTestApp({ callTool } as unknown as Client);
    const host = await createRoom(app);
    const guest = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Friend" },
    });
    const guestResponse = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/demo`,
      headers: { ...headers, cookie: cookieFrom(guest) }, payload: {},
    });
    const hostResponse = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/demo`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(guestResponse.statusCode).toBe(403);
    expect(guestResponse.json().error.code).toBe("HOST_REQUIRED");
    expect(hostResponse.statusCode).toBe(503);
    expect(hostResponse.json().error.code).toBe("QLOO_CREDENTIAL_REQUIRED");
    await app.close();
  });

  it("ranks shared Qloo recommendations, explains them, and accepts room votes", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    let generation = 0;
    const callTool = vi.fn(async () => ({
        isError: false,
        structuredContent: {
          status: "ok",
          results: generation === 0
            ? [
              { entity_id: "artist:pick", name: "A Group Artist" },
              { entity_id: "artist:second", name: "Another Artist" },
              { entity_id: "artist:third", name: "A Third Artist" },
            ]
            : [
              { entity_id: "artist:pick", name: "A Group Artist" },
              { entity_id: "artist:second", name: "Another Artist" },
              { entity_id: "artist:third", name: "A Third Artist" },
              { entity_id: "artist:new-one", name: "A New Group Artist" },
              { entity_id: "artist:new-two", name: "Another New Artist" },
              { entity_id: "artist:new-three", name: "A Third New Artist" },
            ],
        },
      }));
    const client = { callTool } as unknown as Client;
    const { app, db } = openTestApp(client);
    const host = await createRoom(app);
    const friend = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Friend" },
    });
    const third = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/join`, headers,
      payload: { nickname: "Third" },
    });
    const nonHostPlan = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/plan`,
      headers: { ...headers, cookie: cookieFrom(friend) }, payload: {},
    });
    expect(nonHostPlan.statusCode).toBe(403);
    expect(nonHostPlan.json().error.code).toBe("HOST_REQUIRED");
    const members = db.prepare("SELECT id FROM members WHERE room_id = ? ORDER BY joined_at").all(host.roomId) as { id: string }[];
    for (const [index, member] of members.entries()) {
      db.prepare("INSERT INTO favorites(member_id, qloo_id, name, entity_type) VALUES (?, ?, ?, 'artist'), (?, ?, ?, 'tag')")
        .run(member.id, `favorite:${index}:a`, `Favorite ${index} A`, member.id, `favorite:${index}:b`, `Favorite ${index} B`);
      db.prepare("UPDATE members SET ready = 1 WHERE id = ?").run(member.id);
    }
    expect(friend.statusCode).toBe(201);
    expect(third.statusCode).toBe(201);
    const response = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/plan`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => {
      const plan = db.prepare("SELECT status FROM plans WHERE room_id = ?").get(host.roomId) as { status: string };
      expect(plan.status).toBe("ready");
    });
    const state = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}`, headers: { cookie: host.cookie },
    });
    expect(state.json().room.picks[0].qloo.overlapScore).toBe(100);
    expect(state.json().room.picks[0].agent.fallback).toBe(true);
    expect(state.json().room.picks[0].agent.reasons[members[0]!.id]).toEqual(expect.any(String));
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "qloo_recommend",
      arguments: expect.objectContaining({ signal_tags_operator: "union" }),
    }));
    const pickId = state.json().room.picks[0].pickId as string;
    const voted = await app.inject({
      method: "PUT", url: `/api/rooms/${host.roomId}/picks/${pickId}/vote`,
      headers: { ...headers, cookie: host.cookie }, payload: { direction: "up" },
    });
    expect(voted.statusCode).toBe(200);
    expect(voted.json().room.picks[0].votes).toMatchObject({ up: 1, mine: "up" });
    const publicPlan = await app.inject({ method: "GET", url: `/api/rooms/${host.roomId}` });
    expect(publicPlan.json().room.me).toBeNull();
    expect(publicPlan.json().room.memberCount).toBe(3);
    expect(publicPlan.json().room.readyCount).toBe(3);
    expect(publicPlan.json().room.members).toEqual([]);
    expect(publicPlan.json().room.picks).toEqual([]);
    expect(publicPlan.json().room.planActivity).toEqual([]);
    expect(publicPlan.body).not.toContain("Host");
    expect(publicPlan.body).not.toContain("Friend");
    expect(publicPlan.body).not.toContain("Favorite");
    const hostPlan = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}`, headers: { cookie: host.cookie },
    });
    expect(hostPlan.json().room.planCooldownSeconds).toBeGreaterThan(0);
    const originalIds = hostPlan.json().room.picks.map((pick: { qloo: { entityId: string } }) => pick.qloo.entityId);

    generation = 1;
    db.prepare("DELETE FROM qloo_cache").run();
    const cooldown = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/plan`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(cooldown.statusCode).toBe(429);
    expect(cooldown.json().error.code).toBe("PLAN_COOLDOWN");
    expect(Number(cooldown.headers["retry-after"])).toBeGreaterThan(0);
    db.prepare("UPDATE plans SET updated_at = ? WHERE room_id = ?").run(Date.now() - 31_000, host.roomId);
    const regenerate = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/plan`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(regenerate.statusCode).toBe(202);
    await vi.waitFor(() => {
      const plan = db.prepare("SELECT status FROM plans WHERE room_id = ?").get(host.roomId) as { status: string };
      expect(plan.status).toBe("ready");
    });
    expect((db.prepare("SELECT COUNT(*) AS count FROM rejected_entities WHERE room_id = ?").get(host.roomId) as { count: number }).count).toBe(3);
    const regeneratedPlan = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}`, headers: { cookie: host.cookie },
    });
    const newIds = regeneratedPlan.json().room.picks.map((pick: { qloo: { entityId: string } }) => pick.qloo.entityId);
    expect(regeneratedPlan.json().room.planVersion).toBe(2);
    expect(newIds).toEqual(["artist:new-one", "artist:new-two", "artist:new-three"]);
    expect(newIds.some((id: string) => originalIds.includes(id))).toBe(false);
    expect(regeneratedPlan.json().room.planActivity.some((item: { summary: string }) => item.summary.includes("previously rejected"))).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(6);
    await app.close();
  });
});

it("sweeps expired rooms and their dependent member data", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO rooms(id, categories, status, created_at, expires_at) VALUES ('expired01', '[\"music\"]', 'gathering', 0, 10)").run();
  db.prepare("INSERT INTO members(id, room_id, nickname, token_hash, joined_at) VALUES ('member01', 'expired01', 'A', 'hash', 0)").run();
  expect(sweepExpiredRooms(db, 10)).toBe(1);
  expect(db.prepare("SELECT COUNT(*) AS count FROM members").get()).toMatchObject({ count: 0 });
  db.close();
});
