import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candidate, MemberRow } from "../src/plan-engine.js";
import { calculateOverlap, explainCandidates } from "../src/plan-engine.js";

const members: MemberRow[] = [
  { id: "member-a", favorites: [{ qloo_id: "favorite:a", name: "Radiohead", entity_type: "artist" }] },
  { id: "member-b", favorites: [{ qloo_id: "favorite:b", name: "Björk", entity_type: "artist" }] },
];

const candidate: Candidate = {
  id: "artist:shared",
  name: "The Smile",
  entityType: "artist",
  category: "music",
  memberAffinity: { "member-a": 1, "member-b": 0.5 },
  tags: [],
  overlapScore: 63,
  source: { workflows: ["qloo_recommend"], fetchedAt: "2026-10-23T00:00:00.000Z" },
};

function geminiResponse(picks: unknown[]) {
  return new Response(JSON.stringify({
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify({ picks }) }],
      },
    }],
  }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("group overlap score", () => {
  it("uses the average and weakest member affinity, then rounds to an integer", () => {
    expect(calculateOverlap([1, 0.5, 0])).toBe(25);
    expect(calculateOverlap([0.9, 0.8, 0.7])).toBe(75);
    expect(calculateOverlap([0.2, 0])).toBe(5);
  });

  it("returns zero when there are no member affinities", () => {
    expect(calculateOverlap([])).toBe(0);
  });
});

describe("Gemini explanations", () => {
  it("accepts grounded reasons and replaces the generated headline with a grounded one", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetch = vi.fn(async () => geminiResponse([{
      candidateKey: "c1",
      headline: "This pick will make the group happier than any other option.",
      reasons: {
        m1: "Qloo connects this pick to Radiohead in your favorites.",
        m2: "Qloo connects this pick to Björk in your favorites.",
      },
    }]));
    vi.stubGlobal("fetch", fetch);

    const result = (await explainCandidates([candidate], members))[0];
    if (!result) throw new Error("Expected a Gemini explanation.");

    expect(result).toMatchObject({
      headline: "The Smile — 63% group taste overlap.",
      reasons: {
        "member-a": "Qloo connects this pick to Radiohead in your favorites.",
        "member-b": "Qloo connects this pick to Björk in your favorites.",
      },
      model: "gemini-3.6-flash",
      fallback: false,
    });
  });

  it("falls back when a reason is not grounded in that member's favorites", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => geminiResponse([{
      candidateKey: "c1",
      headline: "A Qloo-connected pick for the group.",
      reasons: {
        m1: "This sounds like a great choice for your group.",
        m2: "Qloo connects this pick to Björk in your favorites.",
      },
    }])));

    const result = (await explainCandidates([candidate], members))[0];
    if (!result) throw new Error("Expected a fallback explanation.");

    expect(result.fallback).toBe(true);
    expect(result.model).toBeNull();
    expect(result.headline).toContain("AI explanation fallback");
    expect(result.reasons["member-a"]).toContain("Qloo included this");
    expect(result.reasons["member-b"]).toContain("Qloo included this");
  });

  it("ignores an unsupported generated headline when the member reasons are grounded", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => geminiResponse([{
      candidateKey: "c1",
      headline: "A guaranteed perfect choice that everyone will love.",
      reasons: {
        m1: "Qloo connects this pick to Radiohead in your favorites.",
        m2: "Qloo connects this pick to Björk in your favorites.",
      },
    }])));

    const result = (await explainCandidates([candidate], members))[0];
    if (!result) throw new Error("Expected a fallback explanation.");

    expect(result.fallback).toBe(false);
    expect(result.headline).toBe("The Smile — 63% group taste overlap.");
  });

  it("retries transient Gemini errors before accepting a valid explanation", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    let attempts = 0;
    const fetch = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("temporarily unavailable", { status: 503 })
        : geminiResponse([{
          candidateKey: "c1",
          headline: "A Qloo-connected pick for the group.",
          reasons: {
            m1: "Qloo connects this pick to Radiohead in your favorites.",
            m2: "Qloo connects this pick to Björk in your favorites.",
          },
        }]);
    });
    vi.stubGlobal("fetch", fetch);

    const result = (await explainCandidates([candidate], members))[0];
    if (!result) throw new Error("Expected a Gemini explanation.");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.fallback).toBe(false);
    expect(result.model).toBe("gemini-3.6-flash");
  });

  it("uses evidence-based explanations when the Gemini key is missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = (await explainCandidates([candidate], members))[0];
    if (!result) throw new Error("Expected a fallback explanation.");

    expect(fetch).not.toHaveBeenCalled();
    expect(result.fallback).toBe(true);
    expect(result.headline).toContain("GEMINI_API_KEY is not configured");
  });
});
