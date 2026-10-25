import type Database from "better-sqlite3";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Category } from "@taste-bridge/shared";
import { callQloo, entityTypes } from "./qloo.js";

export type MemberRow = { id: string; favorites: { qloo_id: string; name: string; entity_type: string }[] };
export type Candidate = { id: string; name: string; entityType: string; category: Category; memberAffinity: Record<string, number>; tags: { id: string; name: string }[]; overlapScore: number; source: { workflows: string[]; fetchedAt: string } };
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
  return (db.prepare("SELECT id FROM members WHERE room_id = ? ORDER BY joined_at").all(roomId) as { id: string }[])
    .map(({ id }) => ({
      id,
      favorites: db.prepare("SELECT qloo_id, name, entity_type FROM favorites WHERE member_id = ?").all(id) as MemberRow["favorites"],
    }));
}

async function recommendForMember(client: Client, db: Database.Database, roomId: string, member: MemberRow, category: Category, city: string | null) {
  const favorites = member.favorites.slice(0, 10);
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
  if (cached) results = JSON.parse(cached.value) as unknown[];
  else {
    const envelope = await callQloo(client, "qloo_recommend", args);
    results = envelope.results ?? [];
    db.prepare("INSERT OR REPLACE INTO qloo_cache(key, value, expires_at) VALUES (?, ?, ?)").run(key, JSON.stringify(results), now() + 10 * 60_000);
  }
  return results.flatMap((result, index) => {
    const entity = entityFrom(result, category);
    if (!entity) return [];
    return [{ ...entity, rank: index + 1 }];
  });
}

async function recommendForGroup(client: Client, db: Database.Database, roomId: string, members: MemberRow[], category: Category, city: string | null) {
  const results: Awaited<ReturnType<typeof recommendForMember>>[] = [];
  for (let index = 0; index < members.length; index += 3) {
    const batch = members.slice(index, index + 3);
    results.push(...await Promise.all(batch.map((member) => recommendForMember(client, db, roomId, member, category, city))));
  }
  return results;
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

  for (const category of categories) {
    const relevantMembers = members.filter((member) => member.favorites.length > 0);
    if (!relevantMembers.length) throw new Error(`No confirmed ${category} favorites`);
    const perMember = await recommendForGroup(client, db, roomId, relevantMembers, category, room.city_or_area);
    const byId = new Map<string, Candidate>();
    for (const [index, member] of relevantMembers.entries()) {
      const recommendations = perMember[index] ?? [];
      const maxRank = Math.max(1, ...recommendations.map((result) => result.rank - 1));
      for (const result of recommendations) {
        if (rejected.has(`${category}:${result.id}`) || member.favorites.some((favorite) => favorite.qloo_id === result.id)) continue;
        let candidate = byId.get(result.id);
        if (!candidate) {
          candidate = { id: result.id, name: result.name, entityType: result.entityType, category, memberAffinity: {}, tags: [], overlapScore: 0, source: { workflows: ["qloo_recommend"], fetchedAt: new Date(now()).toISOString() } };
          byId.set(result.id, candidate);
        }
        const affinity = recommendations.length === 1 ? 1 : 1 - ((result.rank - 1) / maxRank);
        candidate.memberAffinity[member.id] = Math.max(candidate.memberAffinity[member.id] ?? 0, affinity);
      }
    }
    for (const candidate of byId.values()) {
      const affinity = members.map((member) => candidate.memberAffinity[member.id] ?? 0);
      candidate.overlapScore = calculateOverlap(affinity);
      candidates.push(candidate);
    }
    if (!byId.size) throw new Error(`Qloo returned no eligible ${category} picks`);
  }

  const explained = await explainCandidates(candidates, members);
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
        db.prepare(`INSERT OR IGNORE INTO picks
          (id, room_id, category, rank, state, created_version, qloo_id, name, entity_type, qloo_tags, member_affinity, overlap_score, qloo_source, agent_blurb, agent_reasons, agent_model, agent_fallback)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`${roomId}_${version}_${category}_${index + 1}`, roomId, category, index + 1, version, candidate.id, candidate.name, candidate.entityType, JSON.stringify(candidate.tags), JSON.stringify(candidate.memberAffinity), candidate.overlapScore, JSON.stringify(candidate.source), entry.headline, JSON.stringify(entry.reasons), entry.model, entry.fallback ? 1 : 0);
      });
    }
  });
  save();
}
