#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { buildTrainingBundle, inspectTrainingBundle, validateTrainingBundle } from "./bundle.js";
import { createTrainingBundleExport, unpackTrainingBundleExport, writeTrainingBundleExport } from "./bundle-export.js";

const [command, ...args] = process.argv.slice(2);
if (command === "build") {
  const [tasksetFile, planFile, directory] = args; requireArgs(command, [tasksetFile, planFile, directory]);
  console.log(JSON.stringify(await buildTrainingBundle({ taskset: JSON.parse(await readFile(tasksetFile!, "utf8")), plan: JSON.parse(await readFile(planFile!, "utf8")), directory: directory! }), null, 2));
} else if (command === "inspect") {
  requireArgs(command, [args[0]]); console.log(JSON.stringify(await inspectTrainingBundle(args[0]!), null, 2));
} else if (command === "validate") {
  requireArgs(command, [args[0]]); const result = await validateTrainingBundle(args[0]!); console.log(JSON.stringify(result, null, 2)); if (!result.valid) process.exitCode = 1;
} else if (command === "export") {
  requireArgs(command, [args[0], args[1]]); console.log(JSON.stringify(await writeTrainingBundleExport(args[0]!, args[1]!), null, 2));
} else if (command === "inspect-export") {
  requireArgs(command, [args[0]]); console.log(JSON.stringify(await createTrainingBundleExport(args[0]!), null, 2));
} else if (command === "unpack-export") {
  requireArgs(command, [args[0], args[1]]); console.log(JSON.stringify(await unpackTrainingBundleExport(JSON.parse(await readFile(args[0]!, "utf8")), args[1]!), null, 2));
} else {
  console.error("Usage: training-bundle <build|inspect|validate|export|inspect-export|unpack-export> ..."); process.exitCode = 1;
}

function requireArgs(commandName: string | undefined, values: Array<string | undefined>) { if (values.some((value) => !value)) throw new Error(`${commandName ?? "command"} is missing required arguments.`); }
