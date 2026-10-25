import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const ENTITY_TYPES_BY_CATEGORY = Object.freeze({
  dining: "place",
  music: "artist",
  film_tv: "movie",
});

const ENTITY_SEARCH_TYPES = new Set(Object.values(ENTITY_TYPES_BY_CATEGORY));

function createTransport() {
  if (process.platform === "win32") {
    return new StdioClientTransport({
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "qloo mcp"],
      env: { ...process.env },
    });
  }

  return new StdioClientTransport({
    command: "qloo",
    args: ["mcp"],
    env: { ...process.env },
  });
}

export async function connectQloo() {
  const client = new Client({ name: "taste-bridge", version: "0.1.0" });
  try {
    await client.connect(createTransport());
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "Cannot start qloo. Install it with: npm install --global @qloo/qloo-harness",
        { cause: error },
      );
    }
    throw error;
  }
  return client;
}

export async function callQlooTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });

  let envelope = result.structuredContent;
  if (!envelope || typeof envelope !== "object") {
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (text) {
      try {
        envelope = JSON.parse(text);
      } catch (error) {
        if (result.isError) {
          throw new Error(text);
        }
        throw new Error(`Qloo ${name} response text was not valid JSON`, {
          cause: error,
        });
      }
    }
  }
  if (!envelope || typeof envelope !== "object") {
    throw new Error(`Qloo ${name} response did not include structured content`);
  }
  if (result.isError || envelope.status === "error") {
    throw new Error(
      [
        envelope.error?.code ?? "QLOO_ERROR",
        envelope.summary,
        envelope.error?.recovery,
      ]
        .filter(Boolean)
        .join(": "),
    );
  }

  return envelope;
}

export async function findTags(client, query, limit = 5) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new TypeError("A non-empty Qloo tag query is required");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new RangeError("Tag limit must be an integer between 1 and 20");
  }

  const envelope = await callQlooTool(client, "qloo_find_tags", {
    query: query.trim(),
    limit,
  });
  if (!Array.isArray(envelope.results)) {
    throw new Error("Qloo find-tags response did not include a results array");
  }

  return envelope;
}

export async function searchEntities(
  query,
  type,
  { apiKey = process.env.QLOO_API_KEY, baseUrl = process.env.QLOO_BASE_URL } = {},
) {
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
    throw new TypeError("Search text must contain between 2 and 100 characters");
  }
  if (!ENTITY_SEARCH_TYPES.has(type)) {
    throw new TypeError("Unsupported Qloo entity type");
  }
  if (!apiKey) {
    throw new Error("QLOO_API_KEY is required for Qloo entity search");
  }

  const url = new URL("/search", baseUrl || "https://hackathon.api.qloo.com");
  url.searchParams.set("query", normalizedQuery);
  url.searchParams.set("types", `urn:entity:${type}`);
  url.searchParams.set("take", "10");
  url.searchParams.set("sort_by", "match");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Api-Key": apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    const error = new Error(`Qloo entity search failed with HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const payload = await response.json();
  if (!Array.isArray(payload.results)) {
    throw new Error("Qloo entity search response did not include a results array");
  }

  return payload.results
    .map((entity) => {
      const id = entity.entity_id ?? entity.id ?? entity.qloo_id;
      const name = entity.name ?? entity.title;
      if (typeof id !== "string" || typeof name !== "string") {
        return null;
      }
      const rawTypeLabel = entity.type ?? entity.subtype ?? type;
      return {
        id,
        name,
        type,
        typeLabel: rawTypeLabel.startsWith("urn:entity:")
          ? rawTypeLabel.slice("urn:entity:".length).replaceAll("_", " ")
          : rawTypeLabel,
        description:
          entity.properties?.short_description ??
          entity.short_description ??
          entity.description ??
          "",
        popularity: Number.isFinite(entity.popularity) ? entity.popularity : null,
      };
    })
    .filter(Boolean);
}
