import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectQloo, findTags } from "../server/src/qloo-client.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixturePath = resolve(
  repositoryRoot,
  "fixtures/qloo/find-tags-jazz.json",
);

async function main() {
  const client = await connectQloo();
  try {
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === "qloo_find_tags")) {
      throw new Error("The Qloo MCP server does not expose qloo_find_tags");
    }

    const result = await client.callTool({
      name: "qloo_capabilities",
      arguments: {},
    });
    if (result.isError) {
      throw new Error("Qloo MCP could not report credential readiness");
    }
    if (result.structuredContent?.adapter?.ready !== true) {
      throw new Error(
        "Qloo credential is not ready. Run `qloo setup --qloo`, then `qloo setup --status`.",
      );
    }

    const query = "jazz";
    const envelope = await findTags(client, query, 5);
    if (envelope.results.length === 0) {
      throw new Error(`Qloo returned no tags for "${query}"`);
    }

    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(
      fixturePath,
      `${JSON.stringify(
        {
          query,
          capturedAt: new Date().toISOString(),
          response: envelope,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    console.log(`Real Qloo tags for "${query}":`);
    console.log(JSON.stringify(envelope.results, null, 2));
    console.log(`Saved fixture: ${fixturePath}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

