import { createInterface } from "node:readline/promises";
import { inspectCollectorBranches, selectCollectorBranch } from "@openpond/evals/native-conversations";
import { optionString, parseBooleanOption, promptConfirm } from "../cli/common";

export async function runImporterBranchCommand(directory: string, action: "branches" | "branch", connectionId: string | undefined, options: Record<string, string | boolean>) {
  const nativeSessionId = optionString(options, "session");
  if (!connectionId || !nativeSessionId) throw new Error("Use openpond import branches <connection-id> --session <native-session-id>.");
  const inspection = await inspectCollectorBranches(directory, connectionId, nativeSessionId);
  if (action === "branches") { console.log(JSON.stringify(inspection, null, 2)); return; }
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !parseBooleanOption(options.json);
  let leafId = optionString(options, "leaf");
  let revision = optionString(options, "revision");
  if (!leafId && interactive) {
    inspection.branches.forEach((branch, index) => console.log(`${index + 1}. ${branch.title || branch.leafId} (${branch.messages} messages; ${branch.updatedAt || "date unavailable"})`));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { leafId = inspection.branches[Number(await prompt.question("Choose the branch to sync: ")) - 1]?.leafId ?? ""; revision = inspection.revision; }
    finally { prompt.close(); }
  }
  if (!leafId || !revision) throw new Error("Supply --leaf and --revision from import branches, or choose interactively. No branch was selected.");
  if (!inspection.branches.some(branch => branch.leafId === leafId) || revision !== inspection.revision) throw new Error("Branch selection is stale or invalid. Run import branches again.");
  if (!parseBooleanOption(options.yes) && (!interactive || !await promptConfirm("Sync only this branch and its unambiguous future continuation for this conversation? Other branches stay excluded.", false))) throw new Error("Branch selection was not approved.");
  const result = await selectCollectorBranch(directory, connectionId, nativeSessionId, { leafId, revision });
  console.log(JSON.stringify({ ...result, next: `openpond import resume ${connectionId}` }, null, 2));
}
