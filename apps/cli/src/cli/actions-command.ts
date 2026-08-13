import { promises as fs, watch } from "node:fs";
import path from "node:path";

import {
  buildProjectActions,
  createLocalActionRunner,
  loadProjectActionConfiguration,
} from "openpond-sdk/actions/local";
import { parseBooleanOption } from "./common/options";

export async function runProjectActionsCommand(
  options: Record<string, string | boolean>,
  rest: string[],
): Promise<void> {
  const subcommand = rest[0] ?? "check";
  const projectRoot = path.resolve(stringOption(options, "cwd") ?? process.cwd());
  const sourceDirectory = stringOption(options, "sourceDirectory");
  const outputDirectory = stringOption(options, "outputDirectory");
  const json = parseBooleanOption(options.json);

  if (subcommand === "check" || subcommand === "build") {
    const result = await buildProjectActions({ projectRoot, sourceDirectory, outputDirectory });
    if (json) {
      console.log(JSON.stringify({
        status: "passed",
        actionCount: result.registry.actions.length,
        registry: result.registry,
        manifest: result.manifest,
        outputDirectory: result.outputDirectory,
      }, null, 2));
      return;
    }
    const verb = subcommand === "check" ? "Validated" : "Built";
    console.log(`${verb} ${result.registry.actions.length} Project Action${result.registry.actions.length === 1 ? "" : "s"}.`);
    console.log(`Registry: ${result.registryPath}`);
    console.log(`Bundle: ${result.bundlePath}`);
    return;
  }

  if (subcommand === "run") {
    const actionId = rest[1];
    if (!actionId) throw new Error("usage: openpond actions run <action-id> [--input JSON|--input-file PATH]");
    const runner = createLocalActionRunner({
      projectRoot,
      sourceDirectory,
      outputDirectory,
      build: "always",
    });
    const result = await runner.run({
      actionId,
      input: await actionInput(options, projectRoot),
      timeoutMs: integerOption(options, "timeoutMs"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "dev") {
    const actionId = rest[1] ?? null;
    await runDev({ projectRoot, sourceDirectory, outputDirectory, actionId, options, json });
    return;
  }

  throw new Error("usage: openpond actions <check|build|run|dev> [action-id]");
}

async function runDev(input: {
  projectRoot: string;
  sourceDirectory?: string;
  outputDirectory?: string;
  actionId: string | null;
  options: Record<string, string | boolean>;
  json: boolean;
}): Promise<void> {
  let running = false;
  let rerun = false;
  const execute = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const runner = createLocalActionRunner({
        projectRoot: input.projectRoot,
        sourceDirectory: input.sourceDirectory,
        outputDirectory: input.outputDirectory,
        build: "always",
      });
      if (input.actionId) {
        const result = await runner.run({
          actionId: input.actionId,
          input: await actionInput(input.options, input.projectRoot),
          timeoutMs: integerOption(input.options, "timeoutMs"),
        });
        console.log(JSON.stringify(result, null, 2));
      } else {
        const result = await runner.build();
        const message = {
          status: "ready",
          actionCount: result.registry.actions.length,
          bundleHash: result.manifest.bundleHash,
        };
        console.log(input.json ? JSON.stringify(message) : `Ready with ${message.actionCount} Project Action${message.actionCount === 1 ? "" : "s"}.`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        await execute();
      }
    }
  };
  await execute();
  const configuration = await loadProjectActionConfiguration(input.projectRoot);
  const sourceRoot = path.resolve(
    input.projectRoot,
    input.sourceDirectory ?? configuration.sourceDirectory ?? "openpond/actions",
  );
  console.log(`Watching ${sourceRoot}`);
  const watcher = watch(sourceRoot, { recursive: true }, () => {
    setTimeout(() => void execute(), 50);
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      watcher.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function actionInput(
  options: Record<string, string | boolean>,
  projectRoot: string,
): Promise<unknown> {
  const inline = stringOption(options, "input");
  const inputFile = stringOption(options, "inputFile");
  if (inline && inputFile) throw new Error("Use either --input or --input-file, not both.");
  if (inline) return JSON.parse(inline);
  if (inputFile) return JSON.parse(await fs.readFile(path.resolve(projectRoot, inputFile), "utf8"));
  return {};
}

function stringOption(
  options: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerOption(
  options: Record<string, string | boolean>,
  name: string,
): number | undefined {
  const value = stringOption(options, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}
