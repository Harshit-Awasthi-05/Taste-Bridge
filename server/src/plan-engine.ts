import type Database from "better-sqlite3";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Category } from "@taste-bridge/shared";
import { callQloo, entityTypes } from "./qloo.js";
import { recordPlanActivity } from "./activity.js";

export type MemberRow = { id: string; nickname?: string; favorites: { qloo_id: string; name: string; entity_type: string; source?: "manual" | "chat" | "demo" }[] };
export type Candidate = { id: string; name: string; entityType: string; category: Category; memberAffinity: Record<string, number>; tags: { id: string; name: string }[]; overlapScore: number; source: { workflows: string[]; fetchedAt: string } };
type RankedEntity = { id: string; name: string; entityType: string; rank: number };
type MemberRecommendations = { chat: RankedEntity[]; favorites: RankedEntity[] };
const now = () => Date.now();

function entityFrom(value: unknown, category: Category) {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const nested = obj.entity && typeof obj.entity === "object" ? obj.entity as Record<string, unknown> : obj;
  const id = nested.entity_id ?? nested.entityId ?? nested.qloo_id ?? nested.id;
  const name = nested.name ?? nested.title ?? nested.label;
  if (typeof id !== "string" || typeof name !== "string" || !name.trim()) return null;
  return { id, name: name.trim(), entityType: entityTypes[category] };
}

function getMembers(db: Database.Database, roomId: string): MemberRow[] {
  return (db.prepare("SELECT id, nickname FROM members WHERE room_id = ? ORDER BY joined_at").all(roomId) as { id: string; nickname: string }[])
    .map(({ id, nickname }) => ({
      id,
      nickname,
      favorites: db.prepare("SELECT qloo_id, name, entity_type, source FROM favorites WHERE member_id = ?").all(id) as MemberRow["favorites"],
    }));
}

function favoritesForCategory(member: MemberRow, category: Category) {
  const targetType = entityTypes[category];
  return member.favorites.filter((favorite) => favorite.entity_type === "tag" || favorite.entity_type === targetType);
}

async function recommendForMember(client: Client, db: Database.Database, roomId: string, member: MemberRow, favorites: MemberRow["favorites"], category: Category, city: string | null, signalSource: "chat" | "favorites") {
  const entitySignals = favorites.filter((favorite) => favorite.entity_type !== "tag").map((favorite) => favorite.qloo_id);
  const tagSignals = favorites.filter((favorite) => favorite.entity_type === "tag").map((favorite) => favorite.qloo_id);
  if (!entitySignals.length && !tagSignals.length) return [];
  const args: Record<string, unknown> = {
    target_type: entityTypes[category],
    limit: 20,
    explain: true,
  };
  if (entitySignals.length) args.signals = entitySignals;
  if (tagSignals.length) {
    args.signal_tags = tagSignals;
    args.signal_tags_operator = "union";
  }
  if (category === "dining" && city) args.filter_location = city;
  const key = JSON.stringify({ tool: "qloo_recommend", args });
  const cached = db.prepare("SELECT value FROM qloo_cache WHERE key = ? AND expires_at > ?").get(key, now()) as { value: string } | undefined;
  let results: unknown[];
  if (cached) {
    results = JSON.parse(cached.value) as unknown[];
    recordPlanActivity(db, roomId, "recommendation_cache", `Reused cached Qloo ${category} recommendations for ${member.nickname ?? "a member"} from ${signalSource} signals: entities [${entitySignals.map((id) => favorites.find((favorite) => favorite.qloo_id === id)?.name ?? id).join(", ")}], tags [${tagSignals.map((id) => favorites.find((favorite) => favorite.qloo_id === id)?.name ?? id).join(", ")}] (${results.length} results).`);
  }
  else {
    recordPlanActivity(db, roomId, "recommendation_request", `Called Qloo recommendations for ${member.nickname ?? "a member"}: ${category}, ${signalSource} signals, entity favorites [${entitySignals.map((id) => favorites.find((favorite) => favorite.qloo_id === id)?.name ?? id).join(", ")}], taste tags [${tagSignals.map((id) => favorites.find((favorite) => favorite.qloo_id === id)?.name ?? id).join(", ")}]${args.filter_location ? ` near ${String(args.filter_location)}` : ""}.`);
    const envelope = await callQloo(client, "qloo_recommend", args);
    results = envelope.results ?? [];
    db.prepare("INSERT OR REPLACE INTO qloo_cache(key, value, expires_at) VALUES (?, ?, ?)").run(key, JSON.stringify(results), now() + 10 * 60_000);
    recordPlanActivity(db, roomId, "recommendation_result", `Qloo returned ${results.length} ${category} recommendations from ${signalSource} signals for ${member.nickname ?? "a member"}.`);
  }
  return results.flatMap((result, index) => {
    const entity = entityFrom(result, category);
    if (!entity) return [];
    return [{ ...entity, rank: index + 1 }];
  });
}

async function recommendForGroup(client: Client, db: Database.Database, roomId: string, members: MemberRow[], category: Category, city: string | null): Promise<MemberRecommendations[]> {
  const results: MemberRecommendations[] = [];
  for (let index = 0; index < members.length; index += 3) {
    const batch = members.slice(index, index + 3);
    results.push(...await Promise.all(batch.map(async (member) => {
      const categoryFavorites = favoritesForCategory(member, category);
      const chatFavorites = categoryFavorites.filter((favorite) => favorite.source === "chat");
      const otherFavorites = categoryFavorites.filter((favorite) => favorite.source !== "chat");
      const [chat, favorites] = await Promise.all([
        chatFavorites.length ? recommendForMember(client, db, roomId, member, chatFavorites.slice(0, 10), category, city, "chat") : [],
        otherFavorites.length ? recommendForMember(client, db, roomId, member, otherFavorites.slice(0, 10), category, city, "favorites") : [],
      ]);
      return { chat, favorites };
    })));
  }
  return results;
}

function rankAffinities(recommendations: RankedEntity[]) {
  const maxRank = Math.max(1, ...recommendations.map((result) => result.rank - 1));
  return new Map(recommendations.map((result) => [
    result.id,
    recommendations.length === 1 ? 1 : 1 - ((result.rank - 1) / maxRank),
  ]));
}

export function combineRecommendationAffinities(chatAffinity: number, favoriteAffinity: number, hasChatSignals: boolean, hasOtherFavorites: boolean) {
  if (hasChatSignals && hasOtherFavorites) return 0.7 * chatAffinity + 0.3 * favoriteAffinity;
  return hasChatSignals ? chatAffinity : favoriteAffinity;
}

export function calculateOverlap(affinities: number[]) {
  if (!affinities.length) return 0;
  return Math.round((0.5 * (affinities.reduce((sum, value) => sum + value, 0) / affinities.length) + 0.5 * Math.min(...affinities)) * 100);
}

function fallbackReasons(candidate: Candidate, members: MemberRow[]) {
  return Object.fromEntries(members.map((member) => {
    const favorite = member.favorites[0];
    const surfaced = (candidate.memberAffinity[member.id] ?? 0) > 0;
    const anchor = member.favorites.find((item) => item.entity_type === candidate.entityType) ?? favorite;
    return [member.id, surfaced && anchor
      ? `Qloo included this among recommendations shaped by your confirmed tastes, including ${anchor.name}.`
      : "Qloo did not directly connect this pick to your confirmed favorites; check whether it works for you."];
  }));
}

export async function explainCandidates(candidates: Candidate[], members: MemberRow[]) {
  const apiKey = process.env.GEMINI_API_KEY;
  const picks = [...new Set(candidates.map((item) => item.category))].flatMap((category) =>
    candidates.filter((item) => item.category === category)
      .sort((a, b) => b.overlapScore - a.overlapScore).slice(0, 6));
  const fallback = (reason: string) => {
    console.warn(`Gemini explanation fallback: ${reason}`);
    return picks.map((candidate) => ({
      candidate,
      headline: `${candidate.overlapScore}% taste overlap, based on group-wide Qloo recommendations. AI explanation fallback: ${reason}.`,
      reasons: fallbackReasons(candidate, members),
      model: null as string | null,
      fallback: true,
    }));
  };
  if (!apiKey) return fallback("GEMINI_API_KEY is not configured");

  const memberKeys = new Map(members.map((member, index) => [member.id, `m${index + 1}`]));
  const candidateKeys = new Map(picks.map((candidate, index) => [candidate.id, `c${index + 1}`]));
  const prompt = {
    members: members.map((member) => ({
      key: memberKeys.get(member.id),
      favorites: member.favorites.map((favorite) => favorite.name),
    })),
    candidates: picks.map((candidate) => ({
      key: candidateKeys.get(candidate.id), category: candidate.category, name: candidate.name,
      overlap: candidate.overlapScore, qlooRecommendedFor: members.flatMap((member) =>
        (candidate.memberAffinity[member.id] ?? 0) > 0 ? [memberKeys.get(member.id)] : []),
    })),
    instruction: "Write one concise, specific reason for every member for every candidate. Return JSON {picks:[{candidateKey,reasons:{memberKey:text}}]}. Never invent facts. Ground every reason in that person's listed favorites and recommendation evidence. Do not include names other than candidate and favorites.",
  };
  let response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: JSON.stringify(prompt) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      if (attempt === 3) {
        return fallback(error instanceof Error && error.name === "TimeoutError"
          ? "Gemini request timed out"
          : "Gemini request failed");
      }
    }
    if (response?.ok) break;
    if (response && ![429, 500, 502, 503, 504].includes(response.status)) {
      return fallback(`Gemini returned HTTP ${response.status}`);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000 * (2 ** attempt)));
  }
  if (!response) return fallback("Gemini request failed");
  if (!response.ok) return fallback(`Gemini returned HTTP ${response.status}`);

  let payload: { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    return fallback("Gemini returned invalid response JSON");
  }
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!text) return fallback("Gemini returned no explanation text");

  let parsed: { picks?: { candidateKey?: string; reasons?: Record<string, string> }[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return fallback("Gemini explanation was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.picks) || parsed.picks.length !== picks.length) {
    return fallback("Gemini explanation did not match the expected format");
  }
  const used = new Set<string>();
  const validated = parsed.picks.flatMap((proposed) => {
    if (!proposed || typeof proposed !== "object") return [];
    const candidate = picks.find((item) => candidateKeys.get(item.id) === proposed.candidateKey);
    if (!candidate || used.has(candidate.id)) return [];
    const reasons = Object.fromEntries(members.map((member) => {
      const key = memberKeys.get(member.id)!;
      const reason = proposed.reasons?.[key];
      const grounded = typeof reason === "string" && reason.trim().length >= 8 && reason.length <= 300 &&
        member.favorites.some((favorite) => reason.toLocaleLowerCase().includes(favorite.name.toLocaleLowerCase()));
      return [member.id, grounded ? reason.trim() : ""];
    }));
    if (Object.values(reasons).some((reason) => !reason)) return [];
    used.add(candidate.id);
    return [{
      candidate,
      headline: `${candidate.name} — ${candidate.overlapScore}% group taste overlap.`,
      reasons,
      model: "gemini-3.6-flash",
      fallback: false,
    }];
  });
  return used.size === picks.length ? validated : fallback("Gemini explanation failed grounding or validation");
}

export async function generateRoomPlan(db: Database.Database, client: Client, roomId: string) {
  const room = db.prepare("SELECT categories, city_or_area FROM rooms WHERE id = ?").get(roomId) as { categories: string; city_or_area: string | null } | undefined;
  if (!room) throw new Error("Room not found");
  const members = getMembers(db, roomId);
  const categories = JSON.parse(room.categories) as Category[];
  const rejected = new Set((db.prepare("SELECT category, qloo_id FROM rejected_entities WHERE room_id = ?").all(roomId) as { category: Category; qloo_id: string }[]).map((item) => `${item.category}:${item.qloo_id}`));
  const candidates: Candidate[] = [];
  recordPlanActivity(db, roomId, "plan_started", `Started plan generation for ${categories.join(", ")} using ${members.length} confirmed member profiles.`);

  for (const category of categories) {
    const relevantMembers = members.filter((member) => favoritesForCategory(member, category).length > 0);
    if (!relevantMembers.length) {
      recordPlanActivity(db, roomId, "category_skipped", `Skipped ${category}: no confirmed favorites or Qloo taste tags match this category.`);
      continue;
    }
    const perMember = await recommendForGroup(client, db, roomId, relevantMembers, category, room.city_or_area);
    const byId = new Map<string, Candidate>();
    let rejectedCount = 0;
    let favoriteCount = 0;
    for (const [index, member] of relevantMembers.entries()) {
      const memberRecommendations = perMember[index] ?? { chat: [], favorites: [] };
      const chatAffinity = rankAffinities(memberRecommendations.chat);
      const favoriteAffinity = rankAffinities(memberRecommendations.favorites);
      const hasChatSignals = memberRecommendations.chat.length > 0;
      const hasOtherFavorites = memberRecommendations.favorites.length > 0;
      const merged = new Map<string, RankedEntity>();
      for (const result of [...memberRecommendations.chat, ...memberRecommendations.favorites]) {
        if (!merged.has(result.id)) merged.set(result.id, result);
      }
      for (const result of merged.values()) {
        if (rejected.has(`${category}:${result.id}`)) {
          rejectedCount += 1;
          continue;
        }
        if (member.favorites.some((favorite) => favorite.qloo_id === result.id)) {
          favoriteCount += 1;
          continue;
        }
        let candidate = byId.get(result.id);
        if (!candidate) {
          candidate = { id: result.id, name: result.name, entityType: result.entityType, category, memberAffinity: {}, tags: [], overlapScore: 0, source: { workflows: ["qloo_recommend"], fetchedAt: new Date(now()).toISOString() } };
          byId.set(result.id, candidate);
        }
        const affinity = combineRecommendationAffinities(
          chatAffinity.get(result.id) ?? 0,
          favoriteAffinity.get(result.id) ?? 0,
          hasChatSignals,
          hasOtherFavorites,
        );
        candidate.memberAffinity[member.id] = Math.max(candidate.memberAffinity[member.id] ?? 0, affinity);
      }
    }
    for (const candidate of byId.values()) {
      const affinity = members.map((member) => candidate.memberAffinity[member.id] ?? 0);
      candidate.overlapScore = calculateOverlap(affinity);
      candidates.push(candidate);
    }
    if (!byId.size) throw new Error(`Qloo returned no eligible ${category} picks`);
    const chatSignalMembers = relevantMembers.filter((member) =>
      favoritesForCategory(member, category).some((favorite) => favorite.source === "chat")).length;
    recordPlanActivity(db, roomId, "candidates_filtered", `Prioritized confirmed chat-derived favorites (70% when combined with other favorites) for ${chatSignalMembers}/${relevantMembers.length} members; filtered ${rejectedCount} previously rejected and ${favoriteCount} already-favorited ${category} results, leaving ${byId.size} eligible candidates.`);
  }

  if (!candidates.length) throw new Error("No selected planning category has matching confirmed favorites");

  const explained = await explainCandidates(candidates, members);
  const fallbackCount = explained.filter((item) => item.fallback).length;
  recordPlanActivity(db, roomId, "explanations_ready", fallbackCount
    ? `${fallbackCount} picks use grounded fallback explanations; ${explained.length - fallbackCount} received validated Gemini reasons.`
    : `Gemini returned validated reasons for all ${explained.length} picks.`);
  const timestamp = now();
  const oldVersion = db.prepare("SELECT version FROM plans WHERE room_id = ?").get(roomId) as { version: number } | undefined;
  const version = (oldVersion?.version ?? 0) + 1;
  const save = db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO plans(room_id, version, status, error_code, updated_at) VALUES (?, ?, 'ready', NULL, ?)").run(roomId, version, timestamp);
    db.prepare("UPDATE rooms SET status = 'ready' WHERE id = ?").run(roomId);
    db.prepare("UPDATE picks SET state = 'replaced' WHERE room_id = ? AND state = 'active'").run(roomId);
    for (const category of categories) {
      const selected = explained.filter((entry) => entry.candidate.category === category).sort((a, b) => b.candidate.overlapScore - a.candidate.overlapScore).slice(0, 3);
      selected.forEach((entry, index) => {
        const { candidate } = entry;
        const supportCount = members.filter((member) => (candidate.memberAffinity[member.id] ?? 0) > 0).length;
        recordPlanActivity(db, roomId, "pick_selected", `Selected ${candidate.name} for ${category} at rank ${index + 1}: ${candidate.overlapScore}% group overlap (equal weighting of average and weakest-member affinity), surfaced by Qloo for ${supportCount}/${members.length} members.`);
        db.prepare(`INSERT OR IGNORE INTO picks
          (id, room_id, category, rank, state, created_version, qloo_id, name, entity_type, qloo_tags, member_affinity, overlap_score, qloo_source, agent_blurb, agent_reasons, agent_model, agent_fallback)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`${roomId}_${version}_${category}_${index + 1}`, roomId, category, index + 1, version, candidate.id, candidate.name, candidate.entityType, JSON.stringify(candidate.tags), JSON.stringify(candidate.memberAffinity), candidate.overlapScore, JSON.stringify(candidate.source), entry.headline, JSON.stringify(entry.reasons), entry.model, entry.fallback ? 1 : 0);
      });
    }
  });
  save();
}
