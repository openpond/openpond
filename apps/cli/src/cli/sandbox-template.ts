import { promises as fs, existsSync } from "node:fs";
import path from "node:path";

import {
  OPENPOND_MANIFEST_FILE_NAME,
  SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME,
  SANDBOX_TEMPLATE_BUILD_PLAN_KIND,
  formatSandboxTemplateDiagnostics,
  sandboxTemplateBuildMetadata,
  sandboxTemplateBuildPlan,
  sandboxTemplateExecutableEntries,
  sandboxTemplateJsonSchema,
  sandboxTemplateScaffoldFiles,
  validateSandboxTemplateYaml,
  type SandboxTemplateBuildPlan,
  type SandboxTemplateManifest,
} from "../sandbox-template/manifest";
import { parseBooleanOption } from "./common";
import {
  runSandboxTemplateExistingSandboxAction,
  runSandboxTemplateLocal,
} from "./sandbox-template-local";
import {
  resolveSandboxTemplateFilePath,
  resolveSandboxTemplateScaffoldPath,
  runSandboxTemplateStart,
} from "./sandbox-template-start";

export async function runSandboxTemplateCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "validate";

  if (subcommand === "validate") {
    const filePath = resolveSandboxTemplateFilePath(options);
    const source = await fs.readFile(filePath, "utf8");
    const result = validateSandboxTemplateYaml(source);
    if (!result.ok) {
      console.error(formatSandboxTemplateDiagnostics(result.diagnostics));
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          file: filePath,
          name: result.manifest.name,
          version: result.manifest.version,
          start: result.manifest.start.command,
          actions: result.manifest.actions.map((action) => action.name),
          services: result.manifest.services.map((service) => service.name),
          schedules: result.manifest.schedules.map((schedule) => schedule.name),
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "print-schema") {
    console.log(JSON.stringify(sandboxTemplateJsonSchema(), null, 2));
    return;
  }

  if (subcommand === "scaffold") {
    const outputPath = resolveSandboxTemplateScaffoldPath(options);
    const rawName =
      typeof options.name === "string" && options.name.trim().length > 0
        ? options.name.trim()
        : path.basename(outputPath);
    const description =
      typeof options.description === "string" &&
      options.description.trim().length > 0
        ? options.description.trim()
        : undefined;
    const files = sandboxTemplateScaffoldFiles({ name: rawName, description });
    const manifestPath = path.join(outputPath, OPENPOND_MANIFEST_FILE_NAME);
    if (existsSync(manifestPath)) {
      throw new Error(
        `${OPENPOND_MANIFEST_FILE_NAME} already exists at ${manifestPath}`
      );
    }
    await fs.mkdir(outputPath, { recursive: true });
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(outputPath, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          path: outputPath,
          files: Object.keys(files).sort((left, right) =>
            left.localeCompare(right)
          ),
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "build") {
    await runSandboxTemplateBuild(options);
    return;
  }

  if (subcommand === "run") {
    await runSandboxTemplateLocal(options, "run");
    return;
  }

  if (subcommand === "dev") {
    await runSandboxTemplateLocal(options, "dev");
    return;
  }

  if (subcommand === "action") {
    await runSandboxTemplateExistingSandboxAction(options, rest.slice(1));
    return;
  }

  if (subcommand === "start") {
    await runSandboxTemplateStart(options);
    return;
  }

  throw new Error(
    `usage: sandbox-template <validate|print-schema|scaffold|build|run|dev|start|action> [--file ${OPENPOND_MANIFEST_FILE_NAME}] [--path <dir>] [--name <name>]`
  );
}

export async function runSandboxTemplateBuild(
  options: Record<string, string | boolean>
): Promise<void> {
  const context = await loadSandboxTemplateManifestContext(options);
  const outputPath = resolveSandboxTemplateBuildOutputPath(
    options,
    context.projectPath
  );
  const plan = sandboxTemplateBuildPlan({
    manifest: context.manifest,
    manifestFile:
      path.relative(context.projectPath, context.filePath) ||
      OPENPOND_MANIFEST_FILE_NAME,
    projectRoot:
      path.relative(path.dirname(outputPath), context.projectPath) || ".",
  });
  const shouldWrite = !parseBooleanOption(options.noWrite);
  if (shouldWrite) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
      outputPath,
      `${JSON.stringify(plan, null, 2)}\n`,
      "utf8"
    );
  }
  const metadata = sandboxTemplateBuildMetadata(context.manifest);
  const executables = sandboxTemplateExecutableEntries(context.manifest);
  console.log(
    JSON.stringify(
      {
        ok: true,
        file: context.filePath,
        output: shouldWrite ? outputPath : null,
        ...metadata,
        startCommand: executables[0]?.command ?? null,
        plan,
      },
      null,
      2
    )
  );
}

export async function loadSandboxTemplateManifestContext(
  options: Record<string, string | boolean>
): Promise<{
  filePath: string;
  projectPath: string;
  manifest: SandboxTemplateManifest;
}> {
  const filePath = resolveSandboxTemplateFilePath(options);
  const source = await fs.readFile(filePath, "utf8");
  const result = validateSandboxTemplateYaml(source);
  if (!result.ok) {
    process.exitCode = 1;
    throw new Error(formatSandboxTemplateDiagnostics(result.diagnostics));
  }
  return {
    filePath,
    projectPath: path.dirname(filePath),
    manifest: result.manifest,
  };
}

export function resolveSandboxTemplateBuildOutputPath(
  options: Record<string, string | boolean>,
  projectPath: string
): string {
  const rawOutput =
    typeof options.output === "string" && options.output.trim()
      ? options.output.trim()
      : typeof options.out === "string" && options.out.trim()
      ? options.out.trim()
      : "";
  if (rawOutput) return path.resolve(process.cwd(), rawOutput);
  const rawOutputDir =
    typeof options.outputDir === "string" && options.outputDir.trim()
      ? options.outputDir.trim()
      : typeof options.outDir === "string" && options.outDir.trim()
      ? options.outDir.trim()
      : "dist";
  return path.resolve(
    projectPath,
    rawOutputDir,
    SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME
  );
}

export async function loadSandboxTemplateBuildPlan(
  options: Record<string, string | boolean>
): Promise<{
  plan: SandboxTemplateBuildPlan;
  filePath: string;
  projectPath: string;
}> {
  const rawBuild =
    typeof options.build === "string" && options.build.trim()
      ? options.build.trim()
      : typeof options.plan === "string" && options.plan.trim()
      ? options.plan.trim()
      : "";
  if (rawBuild) {
    const filePath = path.resolve(process.cwd(), rawBuild);
    const parsed = JSON.parse(
      await fs.readFile(filePath, "utf8")
    ) as SandboxTemplateBuildPlan;
    if (
      parsed.kind !== SANDBOX_TEMPLATE_BUILD_PLAN_KIND ||
      parsed.schemaVersion !== 1
    ) {
      throw new Error(`invalid sandbox template build plan: ${filePath}`);
    }
    return {
      plan: parsed,
      filePath,
      projectPath: path.resolve(path.dirname(filePath), parsed.projectRoot),
    };
  }

  const context = await loadSandboxTemplateManifestContext(options);
  return {
    plan: sandboxTemplateBuildPlan({
      manifest: context.manifest,
      manifestFile:
        path.relative(context.projectPath, context.filePath) ||
        OPENPOND_MANIFEST_FILE_NAME,
      projectRoot: context.projectPath,
    }),
    filePath: context.filePath,
    projectPath: context.projectPath,
  };
}
