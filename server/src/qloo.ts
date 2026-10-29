import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const entityTypes = {
  dining: "place",
  music: "artist",
  film_tv: "movie",
  tv_show: "tv_show",
  books: "book",
  podcasts: "podcast",
} as const;

type Envelope = { status?: string; results?: unknown[]; summary?: string; error?: { code?: string; recovery?: string } };
type Entity = { id: string; name: string; entityType: string; description: string; imageUrl: string | null };

function makeTransport() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === "win32") {
    return new StdioClientTransport({
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "qloo mcp"],
      env,
    });
  }
  return new StdioClientTransport({ command: "qloo", args: ["mcp"], env });
}

export async function connectQloo() {
  const client = new Client({ name: "taste-bridge", version: "0.1.0" });
  await client.connect(makeTransport());
  return client;
}

export async function callQloo(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args }) as unknown as {
    isError?: boolean;
    structuredContent?: Envelope;
    content?: { type: string; text?: string }[];
  };
  let envelope = response.structuredContent;
  if (!envelope) {
    const text = response.content?.find((item) => item.type === "text")?.text;
    if (text) {
      try {
        envelope = JSON.parse(text) as Envelope;
      } catch (error) {
        throw new Error(`Qloo ${name} returned invalid JSON`, { cause: error });
      }
    }
  }
  if (response.isError || !envelope || envelope.status === "error") {
    throw new Error([envelope?.error?.code, envelope?.summary, envelope?.error?.recovery].filter(Boolean).join(": ") || `Qloo ${name} failed`);
  }
  if (!Array.isArray(envelope.results)) throw new Error(`Qloo ${name} did not return results`);
  return envelope;
}

export async function searchQloo(query: string, entityType: string): Promise<Entity[]> {
  if (!process.env.QLOO_API_KEY) throw new Error("QLOO_API_KEY is not configured");
  const url = new URL("/search", process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com");
  url.searchParams.set("query", query);
  url.searchParams.set("types", `urn:entity:${entityType}`);
  url.searchParams.set("take", "10");
  url.searchParams.set("sort_by", "match");
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Api-Key": process.env.QLOO_API_KEY },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Qloo search failed with HTTP ${response.status}`);
  const payload = await response.json() as { results?: Record<string, unknown>[] };
  if (!Array.isArray(payload.results)) throw new Error("Qloo search response did not contain results");
  return payload.results.flatMap((item) => {
    const id = item.entity_id ?? item.id ?? item.qloo_id;
    const name = item.name ?? item.title;
    if (typeof id !== "string" || typeof name !== "string") return [];
    const props = item.properties as Record<string, unknown> | undefined;
    return [{
      id,
      name,
      entityType,
      description: String(props?.short_description ?? item.short_description ?? ""),
      imageUrl: typeof item.image === "string" ? item.image : null,
    }];
  });
}

export async function searchQlooTags(client: Client, query: string): Promise<Entity[]> {
  const envelope = await callQloo(client, "qloo_find_tags", { query, limit: 10 });
  return (envelope.results ?? []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const tag = item as Record<string, unknown>;
    const id = tag.tag_id ?? tag.id ?? tag.entity_id;
    const name = tag.name ?? tag.label;
    if (typeof id !== "string" || typeof name !== "string") return [];
    return [{
      id,
      name,
      entityType: "tag",
      description: String(tag.description ?? tag.type ?? "Taste tag"),
      imageUrl: null,
    }];
  });
}
