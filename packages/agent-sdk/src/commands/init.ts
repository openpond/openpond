import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CliOptions } from "../core/types";

const TEMPLATE_NAMES = ["blank-agent", "customer-reply-agent", "integration-heavy-agent"] as const;

export async function initCommand(options: CliOptions) {
  const templateName = options.templateName ?? "blank-agent";
  if (!isTemplateName(templateName)) {
    throw new Error(`Unknown template "${templateName}". Available templates: ${TEMPLATE_NAMES.join(", ")}`);
  }

  await assertWritableTarget(options.cwd, options.force === true);
  const sdkRoot = packageRoot();
  const templateDir = path.join(sdkRoot, "templates", templateName);
  await cp(templateDir, options.cwd, {
    recursive: true,
    errorOnExist: false,
    force: options.force === true,
  });
  await rewriteLocalSdkDependency(options.cwd, sdkRoot);

  if (options.json) {
    console.log(JSON.stringify({ template: templateName, cwd: options.cwd }, null, 2));
  } else {
    console.log(`Initialized ${templateName} in ${options.cwd}`);
  }
}

function isTemplateName(value: string): value is typeof TEMPLATE_NAMES[number] {
  return TEMPLATE_NAMES.includes(value as typeof TEMPLATE_NAMES[number]);
}

async function assertWritableTarget(cwd: string, force: boolean) {
  await mkdir(cwd, { recursive: true });
  if (force) return;
  const entries = await readdir(cwd);
  if (entries.length > 0) {
    throw new Error(`Target directory is not empty: ${cwd}. Re-run with --force to merge template files.`);
  }
}

function packageRoot() {
  const distRoot = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(distRoot) === "dist"
    ? path.dirname(distRoot)
    : path.resolve(distRoot, "..", "..");
}

async function rewriteLocalSdkDependency(cwd: string, sdkRoot: string) {
  const packageJsonPath = path.join(cwd, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    "openpond-agent-sdk": `file:${sdkRoot}`,
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}
