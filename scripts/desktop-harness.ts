import { pathToFileURL } from "node:url";
import {
  DesktopHarnessHelpRequested,
  desktopHarnessUsage,
  parseDesktopHarnessArgs,
} from "./desktop-harness/cli.js";
import { runDesktopHarness } from "./desktop-harness/runner.js";

export { desktopScenario } from "./desktop-harness/scenario.js";
export type {
  DesktopHarness,
  DesktopHarnessRunReport,
  DesktopHarnessScenarioDefinition,
  DesktopHarnessScenarioReport,
} from "./desktop-harness/types.js";

async function main(): Promise<void> {
  const options = parseDesktopHarnessArgs(process.argv.slice(2));
  const report = await runDesktopHarness(options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    if (error instanceof DesktopHarnessHelpRequested) {
      console.log(desktopHarnessUsage());
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
