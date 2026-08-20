import path from "node:path";

import { build } from "esbuild";

import { ARTIFACT_SCHEMAS, DEFAULT_AGENT_CONFIG } from "./constants";

export async function writeRuntimeBundle(cwd: string, artifactDir: string): Promise<string> {
  const relativeOutputPath = path.join(artifactDir, "runtime-bundle.mjs");
  await build({
    stdin: {
      contents: runtimeEntrySource(),
      loader: "ts",
      resolveDir: cwd,
      sourcefile: "openpond-agent-runtime.ts",
    },
    outfile: path.resolve(cwd, relativeOutputPath),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    banner: {
      js: 'import { createRequire as __openpondCreateRequire } from "node:module"; var require = __openpondCreateRequire(import.meta.url);',
    },
  });
  return relativeOutputPath;
}

function runtimeEntrySource(): string {
  return `import project from ${JSON.stringify(`./${DEFAULT_AGENT_CONFIG}`)};
import { createRunState, executeAction, writeTrace } from "openpond-agent-sdk/runtime";

export const schema = ${JSON.stringify(ARTIFACT_SCHEMAS.runtimeBundle)};

const [actionName, ...args] = process.argv.slice(2);
if (!actionName) throw new Error("Usage: runtime-bundle.mjs <action> [--input <json>]");

const input = parseInput(args);
const state = createRunState();
const result = await executeAction(project, actionName, input, state);
const traceArtifactRef = await writeTrace(process.cwd(), \`run-\${actionName}\`, state, ".openpond");
console.log(JSON.stringify({ result, traceArtifactRef }, null, 2));

function parseInput(args) {
  const inputIndex = args.indexOf("--input");
  const raw = inputIndex >= 0 ? args[inputIndex + 1] : process.env.OPENPOND_ACTION_INPUT;
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent action input must be a JSON object.");
  }
  return parsed;
}
`;
}
