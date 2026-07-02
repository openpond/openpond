import path from "node:path";

import { writeJson } from "../core/files";
import { loadAgentProject } from "../core/load-project";
import { createInspect } from "../core/manifest";
import type { CliOptions } from "../core/types";

export async function inspectCommand(options: CliOptions) {
  const project = await loadAgentProject(options.cwd);
  const inspect = createInspect(project, options.cwd, options.outDir);
  await writeJson(options.cwd, path.join(options.outDir, "agent-inspect.json"), inspect);
  if (options.json) {
    console.log(JSON.stringify(inspect, null, 2));
    return;
  }
  console.log(`Wrote ${path.join(options.outDir, "agent-inspect.json")}`);
}
