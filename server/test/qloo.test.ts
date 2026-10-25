import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchQloo } from "../src/qloo.js";

type SearchFixture = {
  request: { query: string; types: string; take: number; sort_by: string };
  response: { results: Record<string, unknown>[] };
};

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/qloo/search-radiohead.json"), "utf8"),
) as SearchFixture;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Qloo entity search fixture", () => {
  it("replays the captured Qloo response through the production mapper", async () => {
    vi.stubEnv("QLOO_API_KEY", "fixture-test-key");
    const fetch = vi.fn(async () => new Response(JSON.stringify(fixture.response), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const results = await searchQloo(fixture.request.query, "artist");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      id: fixture.response.results[0]?.entity_id,
      name: fixture.response.results[0]?.name,
      entityType: "artist",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("query")).toBe(fixture.request.query);
    expect(url.searchParams.get("types")).toBe(fixture.request.types);
    expect((options.headers as Record<string, string>)["X-Api-Key"]).toBe("fixture-test-key");
  });

  it("treats the Qloo no-results status as an empty search", async () => {
    vi.stubEnv("QLOO_API_KEY", "fixture-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(searchQloo("No matching entity", "artist")).resolves.toEqual([]);
  });

  it("rejects successful HTTP responses with an invalid result envelope", async () => {
    vi.stubEnv("QLOO_API_KEY", "fixture-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));

    await expect(searchQloo("Radiohead", "artist")).rejects.toThrow(
      "Qloo search response did not contain results",
    );
  });
});
