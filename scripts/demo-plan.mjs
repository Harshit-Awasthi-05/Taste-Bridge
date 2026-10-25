import { buildDemoPlan } from "../server/src/plan-engine.mjs";
import { connectQloo } from "../server/src/qloo-client.mjs";

async function main() {
  let qlooClient = null;
  let connectionError = null;
  try {
    qlooClient = await connectQloo();
  } catch (error) {
    connectionError =
      error.code === "ENOENT"
        ? "Qloo harness is not installed."
        : "The local Qloo MCP server could not start.";
    console.error(`${connectionError} The labeled sample-catalog fallback will be used.`);
  }

  try {
    const plan = await buildDemoPlan({ qlooClient });
    if (connectionError) {
      plan.qloo.status = "error";
      plan.qloo.error = connectionError;
    }

    console.log(`Taste Bridge demo plan — ${plan.city}`);
    console.log(
      `Members: ${plan.members.map((member) => member.nickname).join(", ")}`,
    );
    console.log(`Qloo: ${plan.qloo.status}`);
    if (plan.qloo.error) {
      console.log(`Qloo note: ${plan.qloo.error}`);
    }
    for (const error of plan.qloo.errors.slice(0, 2)) {
      console.log(`Qloo detail: ${error}`);
    }
    for (const pick of plan.qloo.picks) {
      console.log(
        `  Qloo · ${pick.categoryLabel}: ${pick.name} — ${pick.overlapScore}% (${pick.supportCount}/${pick.memberCount} profiles)`,
      );
    }

    console.log(`AI explanation: ${plan.ai.mode} (${plan.ai.status})`);
    if (plan.ai.warning) {
      console.log(`AI note: ${plan.ai.warning}`);
    }
    for (const pick of plan.ai.picks) {
      console.log(
        `  AI · ${pick.categoryLabel}: ${pick.name} — ${pick.overlapScore}% (${pick.supportCount}/${pick.memberCount} profiles)`,
      );
      console.log(`     ${pick.headline}`);
      for (const member of plan.members) {
        console.log(`     ${member.nickname}: ${pick.reasonsByMember[member.id]}`);
      }
    }

    if (!plan.qloo.picks.length) {
      console.log(
        "Qloo picks are empty: configure a valid Qloo credential to see live results. AI picks below are explicitly from the local demo catalog.",
      );
    }
  } finally {
    await qlooClient?.close();
  }
}

main().catch((error) => {
  console.error(`Demo plan failed: ${error.message}`);
  process.exitCode = 1;
});
