import { loadAgentProject } from "../core/load-project";
import type { CliOptions } from "../core/types";
import {
  formatValidationReport,
  validateAgentProject,
  writeValidationReport,
} from "../core/validation";

export async function validateCommand(options: CliOptions) {
  const project = await loadAgentProject(options.cwd);
  const validation = validateAgentProject(project, options.cwd);
  await writeValidationReport(options.cwd, validation, options.outDir);

  if (options.json) {
    console.log(JSON.stringify(validation, null, 2));
  } else {
    console.log(formatValidationReport(validation));
  }

  if (validation.errors.length > 0) process.exitCode = 1;
}
