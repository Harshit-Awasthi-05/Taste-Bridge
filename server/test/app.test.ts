import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { openDb, sweepExpiredRooms } from "../src/db.js";
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
    expect(roomColumns).toEqual(["id", "categories", "city_or_area", "status", "created_at", "expires_at"]);
    expect(memberColumns).toContain("token_hash");
    expect(memberColumns).not.toContain("session_id");
    expect(chatTable).toEqual({ name: "chat_messages" });
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
});

describe("plan generation", () => {
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
    expect(publicPlan.body).not.toContain("Host");
    expect(publicPlan.body).not.toContain("Friend");
    expect(publicPlan.body).not.toContain("Favorite");
    const hostPlan = await app.inject({
      method: "GET", url: `/api/rooms/${host.roomId}`, headers: { cookie: host.cookie },
    });
    const originalIds = hostPlan.json().room.picks.map((pick: { qloo: { entityId: string } }) => pick.qloo.entityId);

    generation = 1;
    db.prepare("DELETE FROM qloo_cache").run();
    const cooldown = await app.inject({
      method: "POST", url: `/api/rooms/${host.roomId}/plan`,
      headers: { ...headers, cookie: host.cookie }, payload: {},
    });
    expect(cooldown.statusCode).toBe(429);
    expect(cooldown.json().error.code).toBe("PLAN_COOLDOWN");
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
